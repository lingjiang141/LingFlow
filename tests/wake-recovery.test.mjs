import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers/evidence-fixture.mjs';
import { createRelay } from '../adapters/dsh/relay.mjs';
import { startServer } from '../src/server.mjs';
import { normalizeWake, consumeWake } from '../src/wake-state.mjs';

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

test('A: an enqueued controller wake merges a new report within 30 seconds and rejects stale ACKs',async t=>{
  const f=await fixture(t);const {lead,now}=seed(f);report(f,lead,now);
  const wake=f.wf.heartbeat(sessions(f),now+26000).deliveries.find(wake=>wake.roleId===lead.id);
  assert.ok(wake,'new report must not stay behind enqueued context');
  assert.equal(wake.id,'old-enqueued');assert.equal(wake.state,'pending');assert.ok(wake.mergedNoticeIds.length);
  assert.match(wake.text,/actionable: true/);assert.ok(wake.text.includes('R35-04')&&wake.text.includes(f.taskId)&&wake.text.includes('abcdef012345'));
  assert.equal(f.wf.acknowledge(wake.id,'Lead','dsh',{generation:0,attempt:1}).state,'obsolete');
  assert.equal(f.store.read().wakes.find(item=>item.id===wake.id).state,'pending');
  console.log('A '+JSON.stringify({elapsedHeartbeatMs:26000,wakeId:wake.id,generation:wake.deliveryRetry,actionable:true,ticket:'R35-04',candidate:'abcdef012345'}));
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
  const listedBefore=f.call('Lead','list'),before=listedBefore.roles.find(role=>role.id===lead.id).wakeHealth;
  assert.equal(before.stuck,1);assert.ok(before.oldestStuckAgeMs>=130000);
  assert.equal(listedBefore.tasks[0].wakeHealth.stuck,1);
  const wake=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  assert.ok(wake);assert.ok(wake.handedOffAt);assert.ok(wake.deliveryAttempts>=1);
  const lost=events(f,'wake.delivery_lost').find(event=>event.wakeId===wake.id);assert.ok(lost.ageMs>=130000);
  assert.match(wake.text,/actionable: true/);
  f.wf.acknowledge(wake.id,'Lead','dsh',{generation:wake.deliveryRetry,attempt:1});
  const current=f.store.read().wakes.find(item=>item.id===wake.id);assert.ok(current.handedOffAt);assert.equal(current.deliveryAttempts,2);
  const listedAfter=f.call('Lead','list'),after=listedAfter.roles.find(role=>role.id===lead.id).wakeHealth;assert.equal(after.stuck,0);assert.ok(after.lastDeliveredAt);
  assert.equal(listedAfter.tasks[0].wakeHealth.stuck,0);
  console.log('C/E '+JSON.stringify({event:'wake.delivery_lost',wakeId:lost.wakeId,ageMs:lost.ageMs,
    stuckBefore:before.stuck,stuckAfter:after.stuck,deliveryAttempts:current.deliveryAttempts}));
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
  assert.equal(b.calls.length,2);assert.notEqual(b.calls[0].requestId,b.calls[1].requestId);assert.match(b.calls[1].content[0].text,/abcdef012345/);
  assert.equal(f.call('Lead','cacheDiagnostics',{roleId:lead.id}).deliveries,2);
  console.log('relay '+JSON.stringify({prompts:b.calls.length,requestIds:b.calls.map(call=>call.requestId)}));
});

test('a delayed old payload validation cannot authorize a changed pending body',async t=>{
  const f=await fixture(t);f.wf.execution={wakeCoalesceMs:0};const lead=f.roles.find(role=>role.kind==='controller');
  f.store.change(s=>f.wf.notice(s,lead.id,'message:one','one'));
  const first=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  report(f,lead);const next=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  assert.ok(next.deliveryRetry> (first.deliveryRetry??0));
  assert.equal(f.wf.validWake(first.id,'Lead',first.deliveryRetry??0).valid,false);
  assert.equal(f.wf.validWake(next.id,'Lead',next.deliveryRetry).valid,true);
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
  await b.relay.accept([next]);assert.equal(b.calls.length,2);assert.match(b.calls[1].content[0].text,/abcdef012345/);
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
  const first=(await app.workflow.heartbeat(sessions(f))).deliveries.find(wake=>wake.roleId===lead.id);assert.ok(first);
  await api('ack',{wakeId:first.id,sessionId:'Lead',delivery:{generation:first.deliveryRetry,attempt:1}});
  await api('call',{sessionId:'Dev',command:'question',operationId:'epoch-question',args:{taskId:f.taskId,text:'需要答复的新问题'}});
  const next=(await app.workflow.heartbeat(sessions(f))).deliveries.find(wake=>wake.roleId===lead.id);assert.ok(next);
  assert.equal((await api('valid',{wakeId:first.id,sessionId:'Lead',generation:first.deliveryRetry})).valid,false);
  assert.equal((await api('valid',{wakeId:next.id,sessionId:'Lead',generation:next.deliveryRetry})).valid,true);
  assert.equal((await api('ack',{wakeId:first.id,sessionId:'Lead',delivery:{generation:first.deliveryRetry,attempt:1}})).state,'obsolete');
  assert.equal((await api('ack',{wakeId:next.id,sessionId:'Lead',delivery:{generation:next.deliveryRetry,attempt:1}})).state,'stored');
});

test('legacy closed wake timestamps stay unknown until there is an actual close observation',()=>{
  const wake={state:'consumed',noticeIds:[],at:1};normalizeWake(wake,1000);assert.equal(wake.consumedAt,null);
  consumeWake(wake,2000);normalizeWake(wake,3000);assert.equal(wake.consumedAt,2000);
});
