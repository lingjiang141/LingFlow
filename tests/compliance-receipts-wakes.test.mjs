import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/evidence-fixture.mjs';
import { writeCommands } from '../src/compliance-errors.mjs';
import { selectWakeNotices } from '../src/controller-notices.mjs';
import { inspectRole } from '../src/patrol.mjs';
import { startServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import path from 'node:path';

test('all business writes require a stable operationId before store access, and schema/guide declare it', async t => {
  const f = await fixture(t);
  for (const command of writeCommands) {
    const signature = f.call('Lead', 'schema', { command });
    assert.equal(signature.operationId.required, true, command);
    assert.ok(f.call('Lead','guide').guide.includes(command + '：operationId 必填'));
  }
  assert.match(f.call('Lead', 'guide').guide, /decision.*testReview/);
  t.mock.method(f.store, 'read', () => assert.fail('missing operationId must not read the store'));
  for (const command of writeCommands) {
    const error = f.wf.call('Lead', command, {});
    assert.equal(error.error, 'missing-argument'); assert.equal(error.path, 'operationId');
    assert.equal(error.acceptedShape, '字符串，同一内容重试必须沿用同一 id'); assert.ok(error.remedy);
  }
});

test('summarize exposes decision.testReview constraints and succeeds once with real checked evidence', async t => {
  const source = "require('node:assert/strict').equal(require('../implementation.cjs'),'new');";
  const f = await fixture(t, 'AssertionError', { existingTest: source, risk: 'medium' });
  f.put(f.testFile, source + '\n// An added regression comment for the existing test file.');
  assert.equal((await f.run('red')).state, 'passed');
  f.put('implementation.cjs', "module.exports='new';");
  assert.equal((await f.run('green')).state, 'passed');
  assert.equal((await f.run('full')).state, 'passed');
  f.call('Dev', 'report', { taskId: f.taskId, summary: '实现和整文件测试已核对', dimensions: Object.fromEntries(['requirements','implementation','system'].map(name => [name,{state:'pass',evidence:'已核对实际候选',checkIds:['full']}])) });
  assert.equal((await f.run('independent', false, 'Lead')).state, 'passed');
  const task = f.store.read().tasks[0]; assert.equal(task.state, 'ready');
  const args = { taskId: task.id, instructions: '按验收条款试用', decision: { candidate: task.candidate,
    acceptance: [{ id: 'AC1', evidence: '已核对原候选与通过回执', checkIds: ['full'] }], limits: '无' } };
  const missing = f.call('Lead', 'summarize', args);
  assert.equal(missing.path, 'decision.testReview'); assert.ok(missing.remedy);
  assert.equal(missing.expected.maxLength, 16000); assert.equal(missing.trigger.path, 'report.manifest.testChanges');
  assert.deepEqual(missing.trigger.files, [f.testFile]);
  const wrong = f.call('Lead', 'summarize', { ...args, decision: { ...args.decision, testReview: { claim:'reviewed' } } });
  assert.equal(wrong.error, 'invalid-argument-type'); assert.equal(wrong.path, 'decision.testReview'); assert.equal(wrong.code, 'contract-invalid');
  const long = f.call('Lead','summarize',{...args,decision:{...args.decision,testReview:'x'.repeat(16001)}});
  assert.equal(long.path, 'decision.testReview'); assert.ok(long.violations[0].remedy);
  const valid = { ...args, decision: { ...args.decision, testReview: '仅新增注释，没有删除或削弱既有断言；整文件回归通过' } };
  assert.equal(f.wf.call('Lead', 'summarize', valid).path, 'operationId');
  assert.equal(f.store.read().tasks[0].state, 'ready');
  assert.equal(f.call('Lead', 'summarize', valid, 'summarize-reviewed-candidate').state, 'awaiting_user');
});

test('ten large jobs fit 10KB by default; explicit detail and inspect sections retain history', async t => {
  const f = await fixture(t);
  f.store.change(s => {
    s.tasks[0].baseline.other = Array.from({length:7000},(_,n)=>['other-'+n,'a'.repeat(64)]);
    s.checkJobs = Array.from({length:10},(_,n)=>({id:'job-'+n,taskId:f.taskId,projectId:s.tasks[0].projectId,revision:1,state:'failed',classification:'environment-failed',
      check:{id:'check-'+n,stage:'green',argv:['node','x'.repeat(5000)],inputs:['large.test.cjs']},files:Array(100).fill('large-file-path'),ownership:{payload:'x'.repeat(24000)},
      receipt:{exitCode:1,failureOutputSeen:false,testCountSeen:false,environmentFailure:true,elapsedMs:123,payload:'x'.repeat(24000)}}));
  });
  const jobs = f.call('Lead','checkStatus',{taskId:f.taskId});
  assert.equal(jobs.length,10); assert.ok(Buffer.byteLength(JSON.stringify(jobs)) <= 10000);
  for(const job of jobs) {
    assert.equal(job.files,undefined); assert.equal(job.check.argv,undefined);
    for(const key of ['exitCode','failureOutputSeen','testCountSeen','environmentFailure','elapsedMs']) assert.ok(Object.hasOwn(job.receipt,key));
  }
  const page=f.call('Lead','checkStatus',{taskId:f.taskId,detail:'full',offset:0,limit:1});
  assert.equal(page.items[0].receipt.payload.length,24000); assert.equal(page.scanned,10); assert.equal(page.truncated,true);
  const task=f.call('Lead','inspect',{taskId:f.taskId});
  assert.equal(task.baseline,undefined); assert.equal(task.checkJobs,undefined); assert.equal(task.checks.length,10);
  assert.equal(task.scanned.baselineOther,7000); assert.ok(task.truncated); assert.ok(Buffer.byteLength(JSON.stringify(task))<=190000);
  const history=f.call('Lead','inspect',{taskId:f.taskId,section:'checkJobs',offset:0,limit:1});
  assert.equal(history.items[0].receipt.payload.length,24000); assert.equal(history.scanned,10);
  assert.equal(f.store.read().tasks[0].baseline.other.length,7000);
  console.log(JSON.stringify({jobs:10,checkStatusBytes:Buffer.byteLength(JSON.stringify(jobs)),inspectBytes:Buffer.byteLength(JSON.stringify(task)),fullHistoryBytes:task.totalBytes}));
});

test('pure controller status receipts never independently wake; read facts suppress repeated reports but real blockers still wake', async t => {
  const f=await fixture(t); f.wf.execution={wakeCoalesceMs:0};
  const lead=f.roles.find(role=>role.kind==='controller');
  const heartbeat=()=>f.wf.heartbeat(f.roles.map(role=>({id:role.name,state:'idle',pending:0,jobs:0}))).deliveries.filter(wake=>wake.roleId===lead.id);
  f.call('Lead','inbox');
  f.store.change(s=>f.wf.notice(s,lead.id,'check:job-status:passed','check passed',f.taskId));
  assert.equal(heartbeat().length,0);
  for(let i=0;i<2;i++) {
    f.store.change(s=>f.wf.notice(s,lead.id,'report:report-'+i,'报告待核对',f.taskId));
    f.call('Lead','inspect',{taskId:f.taskId});
    assert.equal(heartbeat().length,0);
    assert.ok(f.call('Lead','inbox').notices.some(notice=>notice.key==='report:report-'+i));
  }
  f.store.change(s=>{s.tasks[0].questions.push({id:'blocker',text:'需要主控答复',answer:null});f.wf.notice(s,lead.id,'question:blocker','需要主控答复',f.taskId);});
  f.call('Lead','list');
  const [wake]=heartbeat(); assert.ok(wake); assert.match(wake.text,/actionable: true/); assert.match(wake.text,/主控已自查: true/);
});

test('a new fact after an inspection remains actionable; healthy controller patrol stays quiet', () => {
  const role={id:'lead',kind:'controller',projectId:'p',lastInboxAt:1};
  const task={id:'task',projectId:'p',state:'ready',questions:[],developerId:'dev'};
  const s={roles:[role],tasks:[task],checkJobs:[],wakes:[],controllerReads:{lead:{sinceInbox:1,tasks:{task:20},jobs:{job:20}}}};
  const report={id:'notice',roleId:'lead',key:'report:r',taskId:'task',at:30,summary:'report'};
  assert.equal(selectWakeNotices(s,role,[report]).actionable,true);
  assert.equal(selectWakeNotices(s,role,[{...report,at:10}]).actionable,false);
  Object.assign(role,{enabled:true,sessionId:'Lead',connectedAt:100000,enabledAt:1,pending:0,jobs:0,observation:{state:'idle',since:1,activityAt:1,at:100000}});
  const notices=[];
  inspectRole({s,role,project:{id:'p'},lead:role,now:100000,live:true,notify:(...args)=>notices.push(args)});
  assert.equal(notices.length,0); assert.equal(role.patrolStatus.state,'idle-duty');
});

test('reader-worker inspections persist via the writer and do not expose tracking in snapshots', async t => {
  const f=await fixture(t); const lead=f.store.read().roles.find(role=>role.kind==='controller'); f.close();
  const app=await startServer({dataDir:f.dir,port:0}); t.after(()=>app.close());
  await app.workflow.call('ui','enable',{roleId:lead.id,enabled:true},'tracking-enable');
  await app.workflow.call('Lead','inbox',{});
  await app.workflow.call('Lead','inspect',{taskId:f.taskId});
  // A writer fence verifies the real cross-worker handoff, not just the helper.
  await app.workflow.heartbeat([]);
  const reader=new Store(path.join(f.dir,'workflow.sqlite'),{readOnly:true});
  try { assert.ok(reader.read().controllerReads[lead.id].tasks[f.taskId]); } finally {reader.close();}
  assert.equal((await app.workflow.snapshot()).controllerReads,undefined);
});

test('inspection snapshots cannot swallow a newer notice even with the same wall-clock timestamp', async t => {
  const f=await fixture(t);f.wf.execution={wakeCoalesceMs:0}; const lead=f.roles.find(role=>role.kind==='controller');
  f.call('Lead','inbox');
  f.store.change(s=>f.wf.notice(s,lead.id,'report:old','old report',f.taskId));
  const old=f.store.read().notices.at(-1);
  f.call('Lead','inspect',{taskId:f.taskId});
  f.store.change(s=>{f.wf.notice(s,lead.id,'report:new','new report',f.taskId);s.notices.at(-1).at=old.at;});
  const state=f.store.read(), role=state.roles.find(role=>role.id===lead.id);
  const selected=selectWakeNotices(state,role,state.notices.filter(notice=>notice.roleId===role.id&&!notice.readAt));
  assert.ok(selected.actionable);
  assert.equal(selected.notices.some(notice=>notice.key==='report:old'),false);
  assert.equal(selected.notices.some(notice=>notice.key==='report:new'),true);
});
