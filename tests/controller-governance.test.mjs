import { reviewedDimensions } from "./helpers/evidence-fixture.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/evidence-fixture.mjs';
import { readGit } from '../src/quality.mjs';

const taskOf = f => f.store.read().tasks.find(task => task.id === f.taskId);
const stop = f => f.call('Dev', 'yieldForSchedule', {taskId:f.taskId, reason:'原票检查定义需更正，已停写'});
const dirty = f => f.put('implementation.cjs', "module.exports = 'new';");
const commit = f => {f.git('add','implementation.cjs');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','unverified work');};
const dimensions = Object.fromEntries(['requirements','implementation','system'].map(key=>[key,{state:'pass',evidence:'核对实现及冻结用例',checkIds:['full']}]));
function planFor(f, changes={}) {
  const task=taskOf(f);
  const plan={requirementId:task.requirementId,sources:{spec:'spec.md',tickets:'tickets.md',attempts:'attempts.md'},tickets:[{
    key:'SUCCESSOR',developerId:task.developerId,title:task.title,description:task.description,risk:task.risk,riskReason:'原票承接',
    writes:task.writes,reads:task.reads,verification:task.verification,...changes,
  }]};
  for(const check of plan.tickets[0].verification?.checks??[])if(!check.expectedOutput)delete check.expectedOutput;
  return plan;
}

test('F25 dirty abandoned work returns an executable ownedDirty handoff and a distinct diagnosis',async t=>{
  const f=await fixture(t);stop(f);dirty(f);
  const before=readFileSync(path.join(f.root,'implementation.cjs'),'utf8');
  const released=f.call('Lead','abandonTask',{taskId:f.taskId,reason:'错误检查作废，保留成员改动'});
  assert.equal(released.state,'abandoned');
  assert.deepEqual(released.handoff.ownedDirty,['implementation.cjs']);
  assert.deepEqual(released.handoff.writes,taskOf(f).writes);
  assert.equal(released.nextAction.command,'dispatchPlan');
  assert.equal(released.nextAction.args.tickets[0].developerId,taskOf(f).developerId);
  const diagnosis=f.call('Lead','diagnoseTask',{taskId:f.taskId});
  assert.equal(diagnosis.classification,'controller-takeover-risk');
  assert.match(diagnosis.message,/这些改动属于原票成员的劳动成果，不能由主控提交，请登记承接票/);
  assert.deepEqual(diagnosis.nextAction.args.tickets[0].ownedDirty,['implementation.cjs']);
  assert.equal(f.call('Lead','previewPlan',released.nextAction.args).state,'valid');
  const accepted=f.call('Lead','dispatchPlan',released.nextAction.args);
  assert.match(accepted.turnRule,/主控不得写业务代码/);
  assert.match(accepted.turnRule,/rework \+ evidence/);
  const successor=f.store.read().tasks.find(task=>task.id===accepted.tasks[0].taskId);
  assert.deepEqual(successor.ownedDirty,['implementation.cjs']);
  assert.equal(readFileSync(path.join(f.root,'implementation.cjs'),'utf8'),before);
});

test('F25 clean release omits handoff, while released confirmations always reject',async t=>{
  const f=await fixture(t);stop(f);
  const result=f.call('Lead','releaseSchedule',{taskId:f.taskId,reason:'收尾退出'});
  assert.equal(result.handoff,undefined);
  for (const command of ['confirmCommit','rebindCommittedWork']) assert.throws(()=>f.call('Lead',command,{
    taskId:f.taskId,expectedBase:'a'.repeat(40),expectedHead:'b'.repeat(40),paths:[],confirmPaths:[],reason:'尝试原票兜底',
  }),/该票已释放.*登记承接票.*ownedDirty/);
  dirty(f);
  const diagnostic=f.call('Lead','diagnoseTask',{taskId:f.taskId});
  assert.equal(diagnostic.classification,'controller-takeover-risk');
  assert.ok(diagnostic.nextAction.args.tickets[0].writes.includes('implementation.cjs'));
});

test('F25 dirty releaseSchedule and supersede preserve history and expose handoff',async t=>{
  for (const command of ['releaseSchedule','supersede']) await t.test(command,async t=>{
    const f=await fixture(t);stop(f);
    const successor=command==='supersede'?f.call('Lead','dispatchPlan',planFor(f)).tasks[0].taskId:undefined;
    dirty(f);
    const result=f.call('Lead',command,{taskId:f.taskId,supersededBy:successor,reason:'由责任开发承接'});
    assert.deepEqual(result.handoff.ownedDirty,['implementation.cjs']);
    assert.equal(result.nextAction.command,'dispatchPlan');
    assert.ok(taskOf(f).scheduleHistory.length);
  });
});

test('F25 active tickets still cannot be released or transferred',async t=>{
  const f=await fixture(t);dirty(f);
  for (const command of ['abandonTask','releaseSchedule']) assert.throws(()=>f.call('Lead',command,{taskId:f.taskId,reason:'不能抢正在执行的责任'}),/停写|paused|active/);
});

test('F25/F26 governance finds released and in-flight commits with bounded, project-scoped read-only results',async t=>{
  const f=await fixture(t);dirty(f);commit(f);
  const before=f.store.read();
  let result=f.wf.call('Lead','governance',{});
  assert.deepEqual(f.store.read(),before,'governance is read-only even without operationId');
  assert.equal(result.limit,50);
  assert.equal(f.call('Lead','governance',{limit:1}).projects[0].scannedCommits,1);
  assert.throws(()=>f.call('Lead','governance',{projectId:'another-project'}),/跨项目/);
  assert.ok(result.records.some(row=>row.ticketKey==='NEW-TEST'&&row.kind==='in-flight-work-committed'&&row.files.includes('implementation.cjs')&&row.commit&&row.at));
  const originalHead=taskOf(f).baseline.head;
  const movedHead=readGit(f.root,['rev-parse','HEAD']).trim();
  f.store.change(s=>{s.tasks[0].baseline.deliveryBase=originalHead;s.tasks[0].baseline.head=movedHead;});
  assert.ok(f.call('Lead','governance',{}).records.some(row=>row.commit===movedHead),'a baseline rebind must not hide an in-flight commit');
  stop(f);f.call('Lead','abandonTask',{taskId:f.taskId,reason:'结束旧票'});
  f.put('implementation.cjs',"module.exports = 'another';");commit(f);
  result=f.call('Lead','governance',{});
  assert.ok(result.records.some(row=>row.kind==='released-work-committed'&&row.ticketKey==='NEW-TEST'));
  assert.ok(result.records.some(row=>row.kind==='in-flight-work-committed'),'release must not rewrite historical commit timing');
  f.store.change(s=>s.tasks[0].trialInstructions='already summarized');
  assert.deepEqual(f.call('Lead','governance',{}).records,[]);
  assert.equal(f.call('Lead','schema',{command:'governance'}).operationId.required,false);
});

test('F26 preview rejects cloned developer commands, complete full-input replicas and process wrappers',async t=>{
  const f=await fixture(t);
  const full=taskOf(f).verification.checks.find(check=>check.stage==='full');
  for (const probe of [
    {...full,id:'probe',stage:'independent'},
    {...full,id:'probe',stage:'independent',argv:['node','-e','console.log("renamed full")']},
    {...full,id:'probe',stage:'independent',inputs:['implementation.cjs'],argv:[...full.argv,'--other']},
    {...full,id:'probe',stage:'independent',inputs:['implementation.cjs'],argv:['node','./e2e/new-case.cjs','--other']},
    {...full,id:'probe',stage:'independent',inputs:['implementation.cjs'],argv:['node','-e',"require('node:child_process').spawnSync('node',['e2e/new-case.cjs'])"]},
  ]) {
    const plan=planFor(f,{risk:'medium',verification:{...taskOf(f).verification,checks:[...taskOf(f).verification.checks,{...probe,timeoutMs:15000}]}});
    const result=f.call('Lead','previewPlan',plan);
    assert.equal(result.state,'invalid');
    assert.match(result.violations.map(issue=>issue.message).join('\n'),/主控探针不得|该验证属于开发 full/);
  }
});

async function delivered(t) {
  const testFile='e2e/new-case.cjs';
  const checks=['red','green','full'].map(stage=>({id:stage,stage,argv:['node',testFile],inputs:[testFile,'implementation.cjs'],covers:['AC1'],...(stage==='red'&&{expectedOutput:'AssertionError'})}));
  checks.push({id:'probe',stage:'independent',argv:['node','-e',"require('node:assert/strict').equal(require('./implementation.cjs'),'new')"],inputs:['implementation.cjs'],covers:['AC1']});
  const f=await fixture(t,'AssertionError',{risk:'medium',checks});
  f.put(testFile,"require('node:assert/strict').equal(require('../implementation.cjs'),'new');console.log('confirmed');");
  assert.equal((await f.run('red')).state,'passed');dirty(f);
  assert.equal((await f.run('green')).state,'passed');assert.equal((await f.run('full')).state,'passed');
  f.call('Dev','report',{taskId:f.taskId,summary:'实现完成',dimensions});
  return f;
}

test('F26 evidence failures route to the original developer, rework inbox lists evidence, successful rerun clears it',async t=>{
  const f=await delivered(t);
  const heartbeat = () => f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: 'idle', pending: 0, jobs: 0 })));
  f.store.change(s=>{const job=s.checkJobs.findLast(job=>job.check.id==='full');job.state='failed';job.classification='evidence-missing';job.error='缺少完整断言回执';});
  const diagnosis=f.call('Lead','diagnoseTask',{taskId:f.taskId});
  assert.equal(diagnosis.nextAction.command,'rework');
  assert.equal(diagnosis.reference.ownerRole,'developer');
  assert.equal(diagnosis.reference.ownerId,taskOf(f).developerId);
  assert.equal(diagnosis.reference.args.ticketKey,'NEW-TEST');
  assert.equal(diagnosis.recovery.candidate.command, 'rework');
  assert.deepEqual(diagnosis.recovery.candidate.args.evidence, ['full']);
  const partial=f.wf.call('Lead','diagnoseTask',{taskId:f.taskId},undefined,'dsh','evidence-busy');
  assert.equal(partial.nextAction, null);
  assert.equal(partial.reference.ownerRole,'developer');assert.equal(partial.reference.ownerId,taskOf(f).developerId);
  assert.match(diagnosis.reference.message,/主控不得在本机执行该命令后自称已验/);
  f.store.change(s=>{const job=s.checkJobs.findLast(job=>job.check.id==='full');job.classification='environment-failed';job.environmentFailure=true;job.environmentFailureReason='webserver-start-failed';});
  const environment=f.call('Lead','diagnoseTask',{taskId:f.taskId});
  assert.equal(environment.classification,'environment-failed');
  assert.equal(environment.nextAction.command,'rework');
  assert.equal(environment.reference.ownerId,taskOf(f).developerId);
  f.store.change(s=>{const job=s.checkJobs.findLast(job=>job.check.id==='full');job.classification='evidence-missing';job.environmentFailure=false;delete job.environmentFailureReason;});
  assert.throws(()=>f.call('Lead','rework',{taskId:f.taskId,reason:'证据需补齐',evidence:['probe','invented']}),/full|可选|非主控/);
  heartbeat();
  const rework = f.call('Lead','rework',{taskId:f.taskId,reason:'重跑指定检查并补真实断言证据',evidence:['full']});
  assert.match(rework.controllerBoundary, /亲自实现或修复/);
  assert.deepEqual(taskOf(f).reworkEvidence,['full']);
  const inbox=f.call('Dev','inbox');
  assert.match(inbox.notices.map(n=>n.summary).join('\n'),/full.*evidence-missing.*缺少完整断言回执/);
  assert.equal((await f.run('full')).state,'passed');
  assert.deepEqual(taskOf(f).reworkEvidence,[]);
  f.call('Dev','report',{taskId:f.taskId,summary:'已补指定检查',dimensions});
  const oldJob=f.store.read().checkJobs.findLast(job=>job.check.id==='full');
  heartbeat();
  f.call('Lead','rework',{taskId:f.taskId,reason:'不信任已通过的回执，要求新回执',evidence:['full']});
  const newJob=await f.run('full');
  assert.equal(newJob.state,'passed');assert.notEqual(newJob.id,oldJob.id,'explicit evidence requests must not reuse older green receipts');
});

test('F25/F26 deliveryEvidence to controller probe to summarize remains valid',async t=>{
  const f=await delivered(t);
  assert.ok(f.call('Lead','deliveryEvidence',{taskId:f.taskId}));
  for(const id of ['red','green','full']) assert.throws(()=>f.call('Lead','check',{taskId:f.taskId,checkId:id}),/责任|权限|主控|角色/);
  assert.equal((await f.run('probe',false,'Lead')).state,'passed');
  const task=taskOf(f);
  const result=f.call('Lead','summarize',{taskId:f.taskId,instructions:'试用新行为',decision:{candidate:task.candidate,acceptance:[{id:'AC1',evidence:'检查实际回执',checkIds:['full','probe']}],limits:'无',dimensions:reviewedDimensions('full'),testReview:'仅新增真实行为断言，未削弱既有测试'}});
  assert.ok(result);
  assert.equal(taskOf(f).state,'trial');
  const guide=f.call('Lead','guide',{topic:'controller'}).guide;
  assert.match(guide,/主控不得写业务代码/);assert.match(guide,/rework.*evidence/);
});
