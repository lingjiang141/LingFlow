import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers/evidence-fixture.mjs';
import { createRelay } from '../adapters/dsh/relay.mjs';
import { startServer } from '../src/server.mjs';
import { normalizeWake, consumeWake, wakeGeneration } from '../src/wake-state.mjs';
import { roleDeliveryPresentation } from '../ui/role-delivery.js';

const sessions=f=>f.roles.map(role=>({id:role.name,state:'idle',pending:0,jobs:0}));
const events=(f,kind)=>f.store.db.prepare('SELECT data FROM events WHERE kind=? ORDER BY seq').all(kind).map(row=>JSON.parse(row.data));
function seed(f,ageMs=0) {
  const lead=f.roles.find(role=>role.kind==='controller'),now=Date.now();
  f.store.change(s=>{
    f.wf.notice(s,lead.id,'context:3','角色上下文已更新');
    const notice=s.notices.at(-1);
    s.wakes.push({id:'old-enqueued',roleId:lead.id,sessionId:'Lead',state:'enqueued',noticeIds:[notice.id],
      at:now-ageMs,admittedAt:now-ageMs,text:'old context',contextIncluded:false});
  });
  return {lead,now};
}
function report(f,lead,at=Date.now()) {
  f.store.change(s=>{
    const task=s.tasks[0];task.state='waiting_verification';task.ticketKey='R35-04';task.candidate='abcdef0123456789';
    task.reports.push({id:'new-report',revision:task.revision,candidate:task.candidate,summary:'新报告等待独立验证',at});
    f.wf.notice(s,lead.id,'report:new-report','免审候选待独立验证',task.id);s.notices.at(-1).at=at;
  });
}
function bridge(f) {
  const calls=[],events=[];
  const agent={id:'Lead',status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>events}};
  const options={file:path.join(f.dir,'bridge-ledger.json'),agents:new Map([['Lead',agent]]),activeJobs:()=>0,
    controller:{prompt:async request=>{calls.push(request);events.push({type:'user/message',data:{source:{rpcId:request.requestId}}});return {accepted:true};}},
    api:async(action,body)=>action==='valid'?f.wf.validWake(body.wakeId,body.sessionId,body.generation):f.wf.acknowledge(body.wakeId,body.sessionId,'dsh',body.delivery)};
  return {calls,agent,options,relay:createRelay(options)};
}

test("E1/E4 a failed wake is rearmed once and the host admits a fresh generation", async t => {
  const f = await fixture(t);
  const lead = f.roles.find(role => role.kind === "controller");
  const link = bridge(f);
  f.store.change(s => f.wf.notice(s,lead.id,"message:restore","保留责任"));
  const first = f.wf.heartbeat(sessions(f)).deliveries.find(wake => wake.roleId === lead.id);
  await link.relay.accept([first]);
  f.store.change(s => Object.assign(s.wakes.find(wake => wake.id === first.id),
    {state:"failed",closeReason:"delivery-loss-limit",failedAt:Date.now()-1000,deliveryLosses:3}));
  const restored = f.wf.heartbeat(sessions(f)).deliveries.find(wake => wake.roleId === lead.id);
  assert.equal(restored.id,first.id);
  assert.equal(restored.deliveryLosses,0);
  assert.ok(restored.deliveryRetry > first.deliveryRetry);
  assert.equal(restored.lastCloseReason,"delivery-loss-limit");
  await link.relay.accept([restored]);
  const state = f.store.read();
  assert.equal(state.wakes.find(wake => wake.id === restored.id).state,"enqueued");
  assert.equal(state.wakes.filter(wake => ["pending","enqueued"].includes(wake.state) &&
    wake.noticeIds.includes(restored.noticeIds[0])).length,1);
  assert.equal(state.notices.find(notice => notice.id === restored.noticeIds[0]).readAt,null);
  assert.equal(new Set(link.calls.map(call => call.requestId)).size,2);
  await link.relay.accept([restored]);
  assert.equal(link.calls.length,2);
  assert.equal(events(f,"wake.rearmed").length,1);
  assert.ok(f.call("Lead","inbox").notices.some(notice => notice.id === restored.noticeIds[0]));
});

test("E2/E3 the operator can recover a suppressed notice and the role card exposes its command", async t => {
  const f = await fixture(t);
  const lead = f.roles.find(role => role.kind === "controller");
  let noticeId;
  f.store.change(s => {
    f.wf.notice(s,lead.id,"message:manual-wake","恢复原责任");
    noticeId=s.notices.at(-1).id;
    s.wakes.push({id:"manual-failed-wake",roleId:lead.id,sessionId:"Lead",state:"failed",closeReason:"delivery-loss-limit",
      failedAt:Date.now()-1000,autoRearmedAt:Date.now()-2000,deliveryLosses:3,deliveryRetry:4,noticeIds:[noticeId]});
  });
  const role = f.wf.snapshot().roles.find(role => role.id === lead.id);
  const diagnostic = role.deliveryDiagnostic;
  assert.deepEqual(diagnostic.actions,["rearmWake","resumeTask","inbox-from-original-session"]);
  assert.equal(role.resumeStatus,"delivery-issue");
  const card = roleDeliveryPresentation(role);
  assert.match(card.status,/已开启 · 投递异常 · 空闲/);
  assert.deepEqual(card.rearm,diagnostic.nextAction);
  assert.throws(() => f.call("Review","rearmWake",card.rearm.args),/主控/);
  const receipt=f.call("Lead",card.rearm.command,card.rearm.args,"manual-rearm");
  assert.deepEqual(receipt.noticeIds,[noticeId]);
  assert.equal(receipt.wakeId,"manual-failed-wake");
  assert.deepEqual(f.call("Lead",card.rearm.command,card.rearm.args,"manual-rearm"),receipt);
  const wakes=f.wf.heartbeat(sessions(f)).deliveries.filter(wake => wake.roleId===lead.id);
  assert.equal(wakes.length,1);
  await bridge(f).relay.accept(wakes);
  assert.notEqual(f.wf.snapshot().roles.find(role => role.id===lead.id).deliveryDiagnostic?.reason,"delivery-loss-limit");
});

test("E4 an idle heartbeat restores failed responsibility into the existing active wake", async t => {
  const f=await fixture(t);
  const {lead,now}=seed(f);
  let restoredId;
  f.store.change(s=>{
    f.wf.notice(s,lead.id,"message:restore-with-active","恢复被放弃的责任");
    restoredId=s.notices.at(-1).id;
    s.wakes.push({id:"previously-failed",roleId:lead.id,sessionId:"Lead",state:"failed",closeReason:"delivery-loss-limit",
      failedAt:now-1000,deliveryLosses:3,deliveryRetry:4,noticeIds:[restoredId]});
  });
  const deliveries=f.wf.heartbeat(sessions(f),now+10).deliveries.filter(wake=>wake.roleId===lead.id);
  assert.equal(deliveries.length,1);
  assert.equal(deliveries[0].id,"old-enqueued");
  assert.ok(deliveries[0].noticeIds.includes(restoredId));
  await bridge(f).relay.accept(deliveries);
  const state=f.store.read();
  assert.equal(state.wakes.find(wake=>wake.id==="previously-failed").rearmedInto,"old-enqueued");
  assert.equal(state.wakes.filter(wake=>["pending","enqueued"].includes(wake.state)&&wake.noticeIds.includes(restoredId)).length,1);
  assert.notEqual(f.wf.snapshot().roles.find(role=>role.id===lead.id).deliveryDiagnostic?.reason,"delivery-loss-limit");
});

test('A: an enqueued controller wake merges a new report within 30 seconds and rejects stale ACKs',async t=>{
  const f=await fixture(t);const {lead,now}=seed(f);report(f,lead,now);
  const wake=f.wf.heartbeat(sessions(f),now+26000).deliveries.find(wake=>wake.roleId===lead.id);
  assert.ok(wake,'new report must not stay behind enqueued context');
  assert.equal(wake.id,'old-enqueued');assert.equal(wake.state,'pending');assert.ok(wake.mergedNoticeIds.length);
  assert.match(wake.text,/R35-04[\s\S]*新报告等待独立验证/);
  assert.doesNotMatch(wake.text,/abcdef012345|taskId=/);
  assert.equal(f.wf.acknowledge(wake.id,'Lead','dsh',{generation:0,attempt:1}).state,'obsolete');
  assert.equal(f.store.read().wakes.find(item=>item.id===wake.id).state,'pending');
  console.log('A '+JSON.stringify({elapsedHeartbeatMs:26000,wakeId:wake.id,generation: wakeGeneration(wake),actionable:true,ticket:'R35-04',candidate:'abcdef012345'}));
});

test('B: blocked new notifications have one explicit suppression event and never stall another role',async t=>{
  const f=await fixture(t);const {lead}=seed(f);report(f,lead);
  f.store.change(s=>f.wf.notice(s,f.roles.find(role=>role.kind==='developer').id,'message:other-role','用户消息'));
  const live=sessions(f).map(session=>session.id==='Lead'?{...session,state:'running'}:session);
  const result=f.wf.heartbeat(live);
  const audit=events(f,'wake.suppressed').find(event=>event.blockingWakeId==='old-enqueued');
  assert.ok(audit);assert.ok(audit.noticeIds.length);assert.match(audit.reason,/running|busy/);
  assert.ok(result.deliveries.some(wake=>wake.sessionId==='Dev'));
  const count=events(f,'wake.suppressed').length;f.wf.heartbeat(live);assert.equal(events(f,'wake.suppressed').length,count);
  console.log('B '+JSON.stringify(audit));
});

test('C/E: a 130-second unconsumed admission is retried automatically and wake health clears on handoff',async t=>{
  const f=await fixture(t);const {lead}=seed(f,130000);
  f.store.change(state => {
    const wake = state.wakes.find(item => item.id === 'old-enqueued');
    state.notices.find(notice => wake.noticeIds.includes(notice.id)).key = 'message:unconsumed';
  });
  const listedBefore=f.call('Lead','list'),before=listedBefore.roles.find(role=>role.id===lead.id).wakeHealth;
  assert.equal(before.stuck,1);assert.ok(before.oldestStuckAgeMs>=130000);
  assert.equal(listedBefore.tasks[0].wakeHealth.stuck,1);
  const wake=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  assert.ok(wake);assert.ok(wake.handedOffAt);assert.ok(wake.deliveryAttempts>=1);
  const lost=events(f,'wake.delivery_lost').find(event=>event.wakeId===wake.id);assert.ok(lost.ageMs>=130000);
  assert.match(wake.text,/团队消息/);
  f.wf.acknowledge(wake.id,'Lead','dsh',{generation: wakeGeneration(wake),attempt:1});
  const current=f.store.read().wakes.find(item=>item.id===wake.id);assert.ok(current.handedOffAt);assert.equal(current.deliveryAttempts,2);
  const listedAfter=f.call('Lead','list'),after=listedAfter.roles.find(role=>role.id===lead.id).wakeHealth;assert.equal(after.stuck,0);assert.ok(after.lastDeliveredAt);
  assert.equal(listedAfter.tasks[0].wakeHealth.stuck,0);
  console.log('C/E '+JSON.stringify({event:'wake.delivery_lost',wakeId:lost.wakeId,ageMs:lost.ageMs,
    stuckBefore:before.stuck,stuckAfter:after.stuck,deliveryAttempts:current.deliveryAttempts}));
});

test('a successful frozen check acknowledges the assigned dispatch without reading inbox', async t => {
  const f = await fixture(t);
  const first = f.wf.heartbeat(sessions(f)).deliveries.find(wake => wake.sessionId === 'Dev');
  assert.ok(first);
  f.wf.acknowledge(first.id, 'Dev', 'dsh', { generation: wakeGeneration(first), attempt: 1 });
  const receipt = f.call('Dev', 'check', { taskId: f.taskId, checkId: 'red', async: true }, 'start-original-ticket');
  assert.ok(receipt.jobId);
  const after = f.store.read();
  const wake = after.wakes.find(item => item.id === first.id);
  const dispatch = after.notices.find(note => first.noticeIds.includes(note.id) && note.key.startsWith('dispatch:'));
  assert.equal(wake.closeReason, 'work-confirmed');
  assert.equal(dispatch.readAt, null);
  assert.ok(dispatch.workConfirmedAt);
  assert.equal(f.call('Dev', 'check', { taskId: f.taskId, checkId: 'red', async: true }, 'start-original-ticket').jobId, receipt.jobId);
  assert.equal(events(f, 'wake.work-confirmed').length, 1);
  f.wf.heartbeat(sessions(f), wake.handedOffAt + 130000);
  assert.equal(events(f, 'wake.delivery_lost').some(event => event.wakeId === wake.id), false);
});

test('reading the assigned ticket confirms only its dispatch and leaves unrelated notices eligible', async t => {
  const f = await fixture(t);
  const developer = f.roles.find(role => role.kind === 'developer');
  f.store.change(s => f.wf.notice(s, developer.id, 'message:separate', '另一条仍需处理的消息'));
  const first = f.wf.heartbeat(sessions(f)).deliveries.find(wake => wake.sessionId === 'Dev');
  assert.ok(first);
  f.call('Review', 'inspect', { taskId: f.taskId });
  assert.equal(events(f, 'wake.work-confirmed').length, 0);
  f.call('Dev', 'inspect', { taskId: f.taskId, section: 'events' });
  assert.equal(events(f, 'wake.work-confirmed').length, 0);
  f.call('Dev', 'inspect', { taskId: f.taskId });
  assert.equal(f.wf.validWake(first.id, 'Dev', wakeGeneration(first)).valid, false);
  const replacement = f.wf.heartbeat(sessions(f)).deliveries.find(wake => wake.sessionId === 'Dev');
  assert.ok(replacement);
  const message = f.store.read().notices.find(note => note.key === 'message:separate');
  assert.deepEqual(replacement.payloadNoticeIds, [message.id]);
  const inbox = f.call('Dev', 'inbox');
  assert.ok(inbox.notices.some(note => note.key.startsWith('dispatch:') && note.workConfirmedAt));
  assert.ok(inbox.notices.some(note => note.key === 'message:separate'));
});

test('a reviewer reading the assigned candidate stops the wake through the worker API', async t => {
  const f = await fixture(t);
  const reviewer = f.roles.find(role => role.kind === 'reviewer');
  f.store.change(s => {
    const task = s.tasks[0];
    Object.assign(task, { state: 'reviewing', assignee: reviewer.id, candidate: 'frozen-candidate' });
    f.wf.notice(s, reviewer.id, 'review:' + task.id + ':' + task.revision, '审查当前候选', task.id);
  });
  const first = f.wf.heartbeat(sessions(f)).deliveries.find(wake => wake.sessionId === 'Review');
  assert.ok(first);
  f.wf.acknowledge(first.id, 'Review', 'dsh', { generation: wakeGeneration(first), attempt: 1 });
  f.close();
  const app = await startServer({ dataDir: f.dir, port: 0 });
  t.after(() => app.close());
  await app.workflow.call('ui', 'enable', { roleId: reviewer.id, enabled: true }, 'enable-reviewer-for-fixture');
  const inspected = await app.workflow.call('Review', 'inspect', { taskId: f.taskId });
  assert.equal(inspected.candidate, 'frozen-candidate');
  await app.workflow.heartbeat(sessions(f), Date.now() + 130000);
  const snapshot = await app.workflow.snapshot();
  const wake = snapshot.wakes.find(item => item.id === first.id);
  assert.equal(wake.closeReason, 'work-confirmed');
  assert.equal(wake.deliveryLosses, 0);
  assert.equal((await app.workflow.call('Review', 'inbox')).notices.find(note =>
    first.noticeIds.includes(note.id)).workConfirmedAt, wake.consumedAt);
});

test('an unread answer in a mixed card remains pending while its developer is working', async t => {
  const f = await fixture(t);
  const developer = f.roles.find(role => role.kind === 'developer');
  f.store.change(s => f.wf.notice(s, developer.id, 'answer:unread', '原票答复', f.taskId));
  const first = f.wf.heartbeat(sessions(f)).deliveries.find(wake => wake.sessionId === 'Dev');
  assert.ok(first);
  f.wf.acknowledge(first.id, 'Dev', 'dsh', { generation: wakeGeneration(first), attempt: 1 });
  f.call('Dev', 'progress', { taskId: f.taskId, text: '正在处理原票' });
  const busy = sessions(f).map(session => session.id === 'Dev' ? { ...session, state: 'running' } : session);
  const later = Date.now() + 130000;
  assert.equal(f.wf.heartbeat(busy, later).deliveries.some(wake => wake.sessionId === 'Dev'), false);
  assert.equal(events(f, 'wake.delivery_lost').length, 0);
  const next = f.wf.heartbeat(sessions(f), later + 1000).deliveries.find(wake => wake.sessionId === 'Dev');
  const answer = f.store.read().notices.find(note => note.key === 'answer:unread');
  assert.deepEqual(next.payloadNoticeIds, [answer.id]);
  assert.equal(answer.readAt, null);
});

test('D/F: inbox returns uncovered report and check notices, marks all read, and closes wakes with timestamps',async t=>{
  const f=await fixture(t);const {lead}=seed(f);
  report(f,lead);f.store.change(s=>{
    f.wf.notice(s,lead.id,'check:orphan:passed','检查已完成',f.taskId);
    s.notices.push({id:'legacy-report',roleId:lead.id,key:'report:legacy',summary:'旧通知',taskId:f.taskId,readAt:null,at:Date.now()});
  });
  const inbox=f.call('Lead','inbox');
  assert.ok(inbox.notices.some(note=>note.key==='report:new-report'));
  assert.ok(inbox.notices.some(note=>note.key==='check:orphan:passed'));
  assert.ok(inbox.notices.every(note=>typeof note.actionable==='boolean'&&note.readAt));
  const old=f.store.read().wakes.find(wake=>wake.id==='old-enqueued');assert.equal(old.state,'consumed');assert.ok(old.consumedAt);
  assert.equal(f.store.read().notices.filter(note=>note.roleId===lead.id&&!note.readAt).length,0);
  console.log('D/F '+JSON.stringify({returned:inbox.notices.length,uncoveredVisible:true,allRead:true,actionableBoolean:true,consumedAt:old.consumedAt}));
});

test('the actual relay sends a fresh generation once instead of acknowledging the old admitted payload',async t=>{
  const f=await fixture(t);f.wf.execution={wakeCoalesceMs:0};const lead=f.roles.find(role=>role.kind==='controller');
  f.store.change(s=>f.wf.notice(s,lead.id,'message:first','first'));
  const b=bridge(f),first=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  await b.relay.accept([first]);assert.equal(b.calls.length,1);
  assert.equal(f.wf.heartbeat(sessions(f)).deliveries.some(wake=>wake.roleId===lead.id),false);
  report(f,lead);
  const next=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);assert.ok(next);
  await b.relay.accept([next]);await b.relay.accept([next]);
  assert.equal(b.calls.length,2);assert.notEqual(b.calls[0].requestId,b.calls[1].requestId);assert.match(b.calls[1].content[0].text,/新报告等待独立验证/);
  assert.equal(f.call('Lead','cacheDiagnostics',{roleId:lead.id}).deliveries,2);
  console.log('relay '+JSON.stringify({prompts:b.calls.length,requestIds:b.calls.map(call=>call.requestId)}));
});

test('a delayed old payload validation cannot authorize a changed pending body',async t=>{
  const f=await fixture(t);f.wf.execution={wakeCoalesceMs:0};const lead=f.roles.find(role=>role.kind==='controller');
  f.store.change(s=>f.wf.notice(s,lead.id,'message:one','one'));
  const first=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  report(f,lead);const next=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  assert.ok(wakeGeneration(next) > wakeGeneration(first));
  assert.equal(next.deliveryRetry, first.deliveryRetry);
  assert.equal(f.wf.validWake(first.id,'Lead',wakeGeneration(first)).valid,false);
  assert.equal(f.wf.validWake(next.id,'Lead',wakeGeneration(next)).valid,true);
});

test('a real in-flight old ACK cannot consume a report merged during its network round trip',async t=>{
  const f=await fixture(t);f.wf.execution={wakeCoalesceMs:0};const lead=f.roles.find(role=>role.kind==='controller');
  f.store.change(s=>f.wf.notice(s,lead.id,'message:start','start'));
  const b=bridge(f),api=b.options.api;let release,arrived;
  const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>arrived=resolve);
  b.options.api=async(action,body)=>{if(action==='ack'&&body.delivery.generation===0){arrived();await gate;}return api(action,body);};
  b.relay=createRelay(b.options);
  const first=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id),inFlight=b.relay.accept([first]);
  await waiting;report(f,lead);
  const next=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  release();await inFlight;assert.equal(f.store.read().wakes.find(wake=>wake.id===next.id).state,'pending');
  await b.relay.accept([next]);assert.equal(b.calls.length,2);assert.match(b.calls[1].content[0].text,/新报告等待独立验证/);
});

test('HTTP and reader/writer workers carry the delivery generation through validation and ACK',async t=>{
  const f=await fixture(t);const lead=f.roles.find(role=>role.kind==='controller'),dev=f.roles.find(role=>role.kind==='developer');f.close();
  const app=await startServer({dataDir:f.dir,port:0});t.after(()=>app.close());
  const config=JSON.parse(readFileSync(path.join(f.dir,'config.json'),'utf8'));
  const api=async(action,body)=>{
    const response=await fetch(`http://127.0.0.1:${app.port}/api/bridge/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.bridgeToken},body:JSON.stringify(body)});
    assert.equal(response.status,200);return response.json();
  };
  await app.workflow.call('ui','enable',{roleId:lead.id,enabled:true},'epoch-enable-lead');
  await app.workflow.call('ui','enable',{roleId:dev.id,enabled:true},'epoch-enable-dev');
  await api('call',{sessionId:'Dev',command:'question',operationId:'epoch-initial-question',args:{taskId:f.taskId,text:'第一个真实待办'}});
  const first=(await app.workflow.heartbeat(sessions(f))).deliveries.find(wake=>wake.roleId===lead.id);assert.ok(first);
  await api('ack',{wakeId:first.id,sessionId:'Lead',delivery:{generation: wakeGeneration(first),attempt:1}});
  await api('call',{sessionId:'Dev',command:'question',operationId:'epoch-question',args:{taskId:f.taskId,text:'需要答复的新问题'}});
  const next=(await app.workflow.heartbeat(sessions(f))).deliveries.find(wake=>wake.roleId===lead.id);assert.ok(next);
  assert.equal((await api('valid',{wakeId:first.id,sessionId:'Lead',generation: wakeGeneration(first)})).valid,false);
  assert.equal((await api('valid',{wakeId:next.id,sessionId:'Lead',generation: wakeGeneration(next)})).valid,true);
  assert.equal((await api('ack',{wakeId:first.id,sessionId:'Lead',delivery:{generation: wakeGeneration(first),attempt:1}})).state,'obsolete');
  assert.equal((await api('ack',{wakeId:next.id,sessionId:'Lead',delivery:{generation: wakeGeneration(next),attempt:1}})).state,'stored');
});

test('legacy closed wake timestamps stay unknown until there is an actual close observation',()=>{
  const wake={state:'consumed',noticeIds:[],at:1};normalizeWake(wake,1000);assert.equal(wake.consumedAt,null);
  consumeWake(wake,2000);normalizeWake(wake,3000);assert.equal(wake.consumedAt,2000);
});
