import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/evidence-fixture.mjs';
import { selectWakeNotices } from '../src/controller-notices.mjs';
import { checkEvidenceFacts } from '../src/check-evidence.mjs';
import { reconcileRoleDuplicates } from '../src/role-duplicates.mjs';
import { assertStoppedTask } from '../src/task-scope.mjs';

const sessions = f => f.roles.map(role => ({id:role.name,state:'idle',pending:0,jobs:0,toolsVersion:'fixture-tools-v1'}));
async function delivered(t) {
  const f = await fixture(t, 'AssertionError', {risk:'medium'});
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'),'new');");
  assert.equal((await f.run('red')).state,'passed');
  f.put('implementation.cjs',"module.exports='new';");
  assert.equal((await f.run('green')).state,'passed');
  assert.equal((await f.run('full')).state,'passed');
  const dimensions=Object.fromEntries(['requirements','implementation','system'].map(key=>[key,{state:'pass',evidence:'实际检查通过',checkIds:['full']}]));
  f.call('Dev','report',{taskId:f.taskId,summary:'checked candidate',dimensions});
  return f;
}

test('remaining F14/F15 fields expose a copyable missing-id example, omission counts and stable event pages', async t => {
  const f=await fixture(t);
  const missing=f.wf.call('Lead','summarize',{taskId:f.taskId,instructions:'try'});
  assert.equal(missing.error,'missing-argument');assert.equal(missing.example.command,'summarize');assert.ok(missing.example.operationId);
  f.call('Dev','progress',{taskId:f.taskId,text:'first'});
  f.call('Dev','progress',{taskId:f.taskId,text:'second'});
  f.call('Dev','progress',{taskId:f.taskId,text:'third'});
  f.call('Dev','progress',{taskId:f.taskId,text:'fourth'});
  f.store.change(s=>s.tasks[0].baseline.other=Array.from({length:2451},(_,n)=>['outside-'+n,'a'.repeat(64)]));
  const view=f.call('Lead','inspect',{taskId:f.taskId});
  assert.equal(view.events.length,3);
  const omitted=view.omitted.find(item=>item.section==='baseline.other');assert.equal(omitted.items,2451);
  const page=f.call('Lead',omitted.nextAction.command,{...omitted.nextAction.args,limit:50});
  assert.equal(page.items.length,50);assert.equal(page.total,2451);
  assert.deepEqual(f.call('Lead','inspect',{taskId:f.taskId,section:'events',limit:2}),f.call('Lead','inspect',{taskId:f.taskId,section:'events',limit:2}));
  assert.ok(Buffer.byteLength(JSON.stringify(view))<190000);
});

test('context updates stay in the ledger until the next business wake leads to inbox', async t => {
  const f=await fixture(t);f.wf.execution={wakeCoalesceMs:0};
  const lead=f.roles.find(role=>role.kind==='controller');
  f.store.change(s=>{s.roles.find(role=>role.id===lead.id).contextRevision=2;f.wf.notice(s,lead.id,'context:2','context updated');});
  assert.equal(f.wf.heartbeat(sessions(f)).deliveries.filter(wake=>wake.roleId===lead.id).length,0);
  const note=f.store.read().notices.find(note=>note.key==='context:2');assert.equal(note.actionable,false);
  f.call('Dev','question',{taskId:f.taskId,text:'real blocker'});
  const wake=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  assert.equal(wake.contextRevision,2);assert.equal(wake.noticeIds.length,2);
  assert.match(wake.text,/real blocker/);assert.doesNotMatch(wake.text,/context:v|context updated|actionable/);
  assert.equal(f.store.read().roles.find(role=>role.id===lead.id).seenContextRevision,1);
});

test('never-delivered queued scope can be superseded or abandoned; active delivered work stays protected', async t => {
  const f=await fixture(t);const dev=f.roles.find(role=>role.kind==='developer');
  f.store.change(s=>{
    const old=s.tasks[0];old.state='queued';old.deliveredAt=null;old.admittedAt=null;old.baseline=null;old.assignee=null;
    s.notices=s.notices.filter(note=>note.taskId!==old.id);
    s.tasks.push({...structuredClone(old),id:'replacement',ticketKey:'NEXT',dependencies:[],dependencyStages:{}});
  });
  const before=f.store.read().tasks[0];
  const result=f.call('Lead','supersede',{taskId:f.taskId,supersededBy:'replacement',reason:'never delivered replacement'});
  assert.equal(result.state,'superseded');
  const old=f.call('Lead','inspect',{taskId:f.taskId});assert.equal(old.supersededBy,'replacement');assert.ok(old.supersession.reason);
  assert.deepEqual(f.store.read().tasks[0].reports,before.reports);
  f.store.change(s=>{const task=s.tasks.find(task=>task.id==='replacement');task.state='queued';task.deliveredAt=null;task.admittedAt=null;task.assignee=null;task.baseline=null;s.notices=s.notices.filter(note=>note.taskId!=='replacement');});
  assert.equal(f.call('Lead','abandonTask',{taskId:'replacement',reason:'no remaining work'}).state,'abandoned');
  assert.equal(f.call('Lead','inspect',{taskId:'replacement'}).abandonment.reason,'no remaining work');
  f.store.change(s=>{const task=s.tasks[0];task.state='assigned';task.deliveredAt=Date.now();task.assignee=dev.id;delete task.supersededBy;s.roles.find(role=>role.id===dev.id).state='running';});
  assert.throws(()=>f.call('Lead','abandonTask',{taskId:f.taskId,reason:'must reject'}),/已投递|yield|运行/);
});

test('controller confirms an equivalent commit once and keeps report, candidate, checks and dependency declarations', async t => {
  const f=await delivered(t);const old=f.store.read().tasks[0];
  f.git('add','implementation.cjs',f.testFile);f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','controller commit');
  const head=f.wf.ownershipGit(f.store.read(),old).head;
  const args={taskId:f.taskId,expectedBase:old.baseline.head,expectedHead:head,paths:old.writes,reason:'主控核对已通过候选与提交内容完全相同'};
  const result=f.call('Lead','confirmCommit',args,'confirm-exact-commit');
  assert.equal(result.state,'applied');assert.equal(result.preservedChecks.length,3);
  const current=f.store.read().tasks[0];assert.equal(current.candidate,old.candidate);assert.equal(current.state,old.state);
  assert.deepEqual(current.scheduleHistory.at(-1).previous.writes,old.writes);
  assert.deepEqual(current.dependencies,old.dependencies);assert.deepEqual(current.reports,old.reports);
  assert.deepEqual(f.call('Lead','confirmCommit',args,'confirm-exact-commit'),result);
  assert.equal((await f.run('independent',false,'Lead')).state,'passed');
  assert.equal(f.store.read().tasks[0].state,'ready');
  f.put('implementation.cjs',"module.exports='different';");
  f.git('add','implementation.cjs');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','changed content');
  const nextHead=f.wf.ownershipGit(f.store.read(),current).head;
  assert.throws(()=>f.call('Lead','confirmCommit',{...args,expectedBase:head,expectedHead:nextHead,paths:['implementation.cjs']}),/候选|指纹|输入|等价/);
});

test('an admitted dependency keeps its historical proof on rescheduling but rejects a changed predecessor revision', async t => {
  const f=await delivered(t);await f.run('independent',false,'Lead');
  f.store.change(s=>{const source=s.tasks[0];s.tasks.push({...structuredClone(source),id:'dependent',ticketKey:'DEP',readOnly:true,verification:null,baseline:null,candidate:null,reports:[],reviews:[],state:'queued',writes:[],reads:[],assignee:null,admittedAt:null,deliveredAt:null,firstDeliveredAt:null,scheduleHistory:[],dependencies:[source.id],dependencyStages:{[source.id]:'verified'}});});
  f.wf.heartbeat(sessions(f));
  assert.equal(f.store.read().tasks[1].state,'assigned');assert.ok(f.store.read().tasks[1].dependencyReceipts[f.taskId]);
  f.store.change(s=>{s.tasks[1].state='paused';s.tasks[1].assignee=null;delete s.tasks[1].dependencyReceipts;});
  f.put('implementation.cjs',"module.exports='a downstream change';");
  f.call('Lead','reviseSchedule',{taskId:'dependent',reason:'resume original dependency'});
  assert.equal(f.store.read().tasks[1].state,'assigned');
  assert.equal(f.store.read().tasks[1].dependencyReceipts[f.taskId].recoveredFrom,'historical-admission');
  f.store.change(s=>{s.tasks[1].state='queued';s.tasks[1].assignee=null;s.tasks[0].revision++;s.tasks[0].state='rework';});
  f.wf.heartbeat(sessions(f));assert.equal(f.store.read().tasks[1].state,'queued');
});

test('cache diagnostics count actual short-card admissions and their bytes before inbox is read', async t => {
  const f=await fixture(t);f.wf.execution={wakeCoalesceMs:0};const lead=f.roles.find(role=>role.kind==='controller');
  f.store.change(s=>{const role=s.roles.find(role=>role.id===lead.id);delete role.seenContextRevision;delete role.seenSupervisionPolicy;f.wf.notice(s,lead.id,'message:first','user message');});
  const first=f.wf.heartbeat(sessions(f)).deliveries.find(wake=>wake.roleId===lead.id);
  assert.equal(first.contextFull,false);assert.equal(first.promptBytes,Buffer.byteLength(first.text));assert.ok(first.stableBytes>0);assert.ok(first.toolsVersion);
  f.wf.acknowledge(first.id,'Lead');f.wf.acknowledge(first.id,'Lead');
  const member=f.store.read().roles.find(role=>role.id===lead.id);
  assert.equal(member.seenContextRevision,undefined);
  const diagnostic=f.call('Lead','cacheDiagnostics',{roleId:lead.id,last24h:true});
  assert.equal(diagnostic.deliveries,1);assert.equal(diagnostic.contextFullCount,0);assert.equal(diagnostic.averagePromptBytes,first.promptBytes);
  assert.equal(f.call('Dev','cacheDiagnostics',{roleId:lead.id}).error,undefined);
});

test('test evidence cannot pass on zero cases; compile and probe receipts explain why no case scan applies', async t => {
  const f=await fixture(t);f.put(f.testFile,"require('node:assert/strict').equal(require('../implementation.cjs'),'new');");await f.run('red');f.put('implementation.cjs',"module.exports='new';");
  const request=f.call('Dev','check',{taskId:f.taskId,checkId:'green',async:true});const job=f.wf.claimCheck(request.jobId);
  // Model the real Playwright no-match receipt through the production completion seam.
  job.check.argv=['node','node_modules/@playwright/test/cli.js','test','--grep','missing'];
  f.store.change(s=>s.checkJobs.find(item=>item.id===job.id).check=job.check);
  const output='Running 0 tests\nError: No tests found.';const file=path.join(f.dir,'zero-tests.txt');writeFileSync(file,output);
  f.wf.finishCheck(job.id,{id:job.id,exitCode:0,expectedOutputSeen:true,outputHash:createHash('sha256').update(output).digest('hex'),startedAt:1,finishedAt:3000},file);
  const failed=f.call('Dev','checkStatus',{jobId:job.id});assert.equal(failed.state,'failed');assert.equal(failed.classification,'evidence-missing');assert.equal(failed.receipt.evidenceKind,'test');assert.match(failed.reason,/no.*match|zero|用例|测试/i);
  const probe=await f.run('green');assert.equal(probe.state,'passed');assert.equal(probe.receipt.evidenceKind,'probe');assert.deepEqual(probe.receipt.argv,probe.check.argv);assert.equal(probe.receipt.testCaseSeen,null);
});

test('compile, lint and parser-missed evidence have explicit meanings',()=>{
  const compile=checkEvidenceFacts({argv:['node','node_modules/typescript/bin/tsc','--noEmit']},{exitCode:0},'');
  assert.equal(compile.evidenceKind,'compile');assert.equal(compile.testCaseSeen,null);assert.equal(compile.testCountSeen,null);
  assert.equal(checkEvidenceFacts({argv:['npm','run','lint']},{exitCode:0},'').evidenceKind,'lint');
  const missing=checkEvidenceFacts({argv:['node','node_modules/@playwright/test/cli.js','test']},{exitCode:0},'done');
  assert.equal(missing.testCaseSeen,false);assert.match(missing.evidenceReason,/parser missed/);
  const empty=checkEvidenceFacts({argv:['npm','test']},{exitCode:1,environmentFailure:true,environmentFailureReason:'failed-before-tests'},'No tests found.');
  assert.equal(empty.environmentFailure,false);assert.match(empty.evidenceReason,/no --grep match/);
});

test('duplicate role ids cannot remain ambiguous; conflicting history is retained without reassigning work',()=>{
  const role={id:'r',projectId:'p',kind:'developer',name:'Dev',sessionId:'s',enabled:false};
  const state={roles:[role,{...role}],tasks:[{developerId:'r'}],notices:[],wakes:[],projects:[]};
  reconcileRoleDuplicates(state);assert.equal(state.roles.length,1);assert.equal(state.tasks[0].developerId,'r');assert.equal(state.roleDuplicateDiagnostics[0].state,'id-deduplicated');
  state.roles.push({...role,kind:'reviewer'});reconcileRoleDuplicates(state);
  assert.equal(state.roles.length,1);assert.equal(state.roleIdentityConflicts[0].record.kind,'reviewer');assert.equal(state.roles[0].enabled,false);
});

test('old check history does not trap a never-redelivered queued version, and live ownership still blocks release',()=>{
  const task={id:'t',state:'queued',revision:2,scheduleVersion:3,developerId:'d',deliveredAt:null,firstDeliveredAt:1,reports:[{revision:1}],reviews:[]};
  const member={id:'d',state:'idle',connectedAt:Date.now(),pending:0,jobs:0};
  const state={roles:[member],checkJobs:[{taskId:'t',state:'failed'}],notices:[],wakes:[]};
  assert.doesNotThrow(()=>assertStoppedTask(state,task));member.state='running';assert.throws(()=>assertStoppedTask(state,task),/已停写/);
  member.state='idle';state.notices.push({id:'n',taskId:'t',key:'dispatch:t:2:3',readAt:1});assert.throws(()=>assertStoppedTask(state,task),/已停写/);
});
