import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers/evidence-fixture.mjs';
import { detectEnvironmentFailure } from '../src/environment-failure.mjs';

function uncertain(f) {
  f.put(f.testFile,"throw new Error('not executed');");
  const {jobId}=f.call('Dev','check',{taskId:f.taskId,checkId:'red',async:true});
  f.wf.claimCheck(jobId);f.wf.finishCheck(jobId,{uncertain:true},null);
  return jobId;
}
const getTask=f=>f.store.read().tasks.find(task=>task.id===f.taskId);

test('F27 controller reconciles an uncertain job with attribution, then the owner can yield without granting evidence',async t=>{
  const f=await fixture(t),jobId=uncertain(f);
  assert.throws(()=>f.call('Dev','yieldForSchedule',{taskId:f.taskId,reason:'已停写'}),/检查|对账/);
  assert.throws(()=>f.call('Dev','reconcileCheck',{jobId,evidence:'not authorized'}),/主控|工作台/);
  const result=f.call('Lead','reconcileCheck',{jobId,evidence:'已按宿主进程列表确认检查已退出，未保留测试占用'});
  assert.equal(result.state,'interrupted');assert.equal(result.reconciledBy,'controller');
  const job=f.call('Lead','checkStatus',{jobId});
  assert.equal(job.reconciledBy,'controller');assert.equal(job.reconciledById,f.roles.find(role=>role.kind==='controller').id);
  assert.ok(job.reconciliation);assert.equal(job.state,'interrupted');
  assert.equal(f.wf.validCheck(f.store.read(),getTask(f),job.check),undefined);
  assert.equal(f.call('Dev','yieldForSchedule',{taskId:f.taskId,reason:'对账后交回'}).state,'paused');
});

test('F27 UI reconciliation keeps its original response and non-uncertain jobs remain protected',async t=>{
  const f=await fixture(t),jobId=uncertain(f);
  assert.deepEqual(f.call('ui','reconcileCheck',{jobId,evidence:'用户已确认作业退出及资源可复用'}),{state:'interrupted'});
  assert.throws(()=>f.call('Lead','reconcileCheck',{jobId,evidence:'不能重复对账'}),/只有待对账/);
});

test('F27 controller reconciliation cannot cross project boundaries',async t=>{
  const f=await fixture(t),jobId=uncertain(f);
  f.store.change(s=>s.checkJobs.find(job=>job.id===jobId).projectId='another-project');
  assert.throws(()=>f.call('Lead','reconcileCheck',{jobId,evidence:'越界对账'}),/本项目|跨项目/);
  assert.equal(f.store.read().checkJobs.find(job=>job.id===jobId).state,'uncertain');
});

test('F27 a real timed-out preStep records elapsed time and proposes a new ticket without editing frozen checks',async t=>{
  const preparation={timeoutMs:200,preSteps:[{argv:['node','-e','setTimeout(()=>{},5000)'],outputs:['build-cache'],timeoutMs:200}]};
  const checks=['red','green','full'].map(stage=>({id:stage,stage,argv:['node','e2e/new-case.cjs'],inputs:['e2e/new-case.cjs','implementation.cjs'],covers:['AC1'],...preparation,...(stage==='red'&&{expectedOutput:'AssertionError'})}));
  const f=await fixture(t,'AssertionError',{checks});
  f.put(f.testFile,"throw new Error('main check must not run');");
  const frozen=structuredClone(getTask(f).verification);
  const job=await f.run('red');
  assert.equal(job.state,'uncertain');assert.equal(job.classification,'preparation-timeout');
  assert.equal(job.matchedRule,'preparation-timeout');assert.equal(job.receipt.classification,'preparation-timeout');
  assert.ok(job.receipt.preparation.elapsedMs>=160);
  assert.equal(job.receipt.failureOutputSeen,false);assert.notEqual(job.redEvidenceValid,true);
  assert.doesNotMatch(readFileSync(job.output,'utf8'),/main check must not run/);
  assert.equal(job.nextAction.command,'dispatchPlan');
  assert.match(job.nextAction.message,/按构建实测耗时提高 timeoutMs 后重建承接票/);
  const nextCheck=job.nextAction.args.tickets[0].verification.checks.find(check=>check.id==='red');
  assert.ok(nextCheck.timeoutMs>200);
  assert.deepEqual(getTask(f).verification,frozen);
  const diagnosis=f.call('Lead','diagnoseTask',{taskId:f.taskId});
  assert.equal(diagnosis.classification,'preparation-timeout');assert.equal(diagnosis.nextAction.command,'dispatchPlan');
  const developer=f.roles.find(role=>role.kind==="developer");
  f.store.change(s=>{s.roles.find(role=>role.id===developer.id).enabled=false;});
  const blocked=f.call("Lead","checkStatus",{jobId:job.id}).nextAction;
  assert.equal(blocked.command,"list");
  assert.deepEqual(blocked.blockedBy,[{roleId:developer.id,reason:"disabled"}]);
  f.store.change(s=>{s.roles.find(role=>role.id===developer.id).enabled=true;});
  assert.equal(f.call('Lead','previewPlan',job.nextAction.args).state,'valid');
  for(const action of job.nextAction.before) {
    const args={...action.args,...(action.command==='reconcileCheck'&&{evidence:'worker 已记录构建超时后的子进程 close 事件，测试确认进程已退出'})};
    f.call(action.ownerRole==='developer'?'Dev':'Lead',action.command,args);
    const current=f.call('Lead','checkStatus',{jobId:job.id});
    assert.ok(!current.nextAction.before.some(step=>step.command===action.command),'completed recovery steps must not be suggested again');
  }
  const accepted=f.call('Lead','dispatchPlan',job.nextAction.args);
  const successor=f.store.read().tasks.find(task=>task.id===accepted.tasks[0].taskId);
  assert.ok(successor.ownedDirty.includes(f.testFile));
  assert.equal(successor.state,'assigned');
  assert.deepEqual(getTask(f).verification,frozen,'only the new contract may use the proposed budget');
});

test("C1/C3 a prior genuine red enables only original-ticket budget repair",async t=>{
  const prep={timeoutMs:10000,preSteps:[{argv:["node","-e","const fs=require('node:fs');fs.mkdirSync('node_modules/.cache',{recursive:true});fs.writeFileSync('node_modules/.cache/build-proof','prepared');"],
    outputs:["node_modules/.cache/build-proof"],timeoutMs:5000}]};
  const checks=["red","green","full"].map(stage=>({id:stage,stage,argv:["node","e2e/new-case.cjs"],
    inputs:["e2e/new-case.cjs","implementation.cjs"],covers:["AC1"],...prep,...(stage==="red"&&{expectedOutput:"AssertionError"})}));
  const f=await fixture(t,"AssertionError",{checks});
  f.put(f.testFile,"require('node:assert/strict').equal(require('../implementation.cjs'),'new');");
  const red=await f.run("red");
  assert.equal(red.state,"passed",red.error);
  f.put("implementation.cjs","module.exports='new';");
  f.call("Dev","yieldForSchedule",{taskId:f.taskId,reason:"停写修订预算"});
  f.store.change(s=>{
    const task=s.tasks[0],check=task.verification.checks.find(check=>check.id==="green");
    s.checkJobs.push({id:"over-budget",taskId:task.id,projectId:task.projectId,check,state:"interrupted",finishedAt:Date.now(),
      classification:"preparation-timeout",receipt:{timedOut:true,preparation:{elapsedMs:7400,steps:[{timedOut:true,elapsedMs:7200}]}}});
  });
  const finding=f.call("Lead","diagnoseTask",{taskId:f.taskId});
  assert.equal(finding.nextAction.args.allowCheckRevision,true);
  assert.equal(finding.shortfallMs,2200);
  assert.equal(finding.suggestedTimeoutMs,9360);
  const entry=f.call("Lead","checkStatus",{taskId:f.taskId}).find(item=>item.id==="over-budget");
  assert.equal(entry.shortfallMs,finding.shortfallMs);
  assert.equal(entry.suggestedTimeoutMs,finding.suggestedTimeoutMs);
  const receipt=f.call("Lead",finding.nextAction.command,finding.nextAction.args);
  assert.equal(receipt.nextAction.command,"registerChecks");
  const args=structuredClone(receipt.nextAction.args);
  args.checks[0].argv=["node","-e","0"];
  assert.throws(()=>f.call("Dev","registerChecks",args),/只允许提高/);
  assert.equal(f.call("Dev",receipt.nextAction.command,receipt.nextAction.args).state,"stored");
  const revised=getTask(f),newRed=revised.verification.checks.find(check=>check.id==="red");
  assert.ok(newRed.preSteps[0].timeoutMs>=9360);
  assert.equal(f.wf.validCheck(f.store.read(),revised,newRed).id,red.id);
});

test('F27 preparation-heavy timeouts differ from execution timeouts',()=>{
  const check={argv:['node','probe.cjs'],timeoutMs:1000};
  assert.equal(detectEnvironmentFailure({timedOut:true,preparation:{elapsedMs:850}},'',0,check).environmentFailureReason,'preparation-timeout');
  assert.equal(detectEnvironmentFailure({timedOut:true,preparation:{elapsedMs:100}},'',0,check).environmentFailureReason,'check-timeout');
});

test('F27 preview warns about a two-minute total budget with preSteps and leaves the plan valid',async t=>{
  const f=await fixture(t);
  const task=getTask(f),verification=structuredClone(task.verification);
  for(const check of verification.checks) {
    if(!check.expectedOutput)delete check.expectedOutput;
    Object.assign(check,{timeoutMs:120000,preSteps:[{argv:['node','-e','console.log("prepare")'],outputs:['build-cache'],timeoutMs:100000}]});
  }
  const result=f.call('Lead','previewPlan',{requirementId:task.requirementId,sources:{spec:'spec.md',tickets:'tickets.md',attempts:'attempts.md'},tickets:[{
    key:'PREPARATION',developerId:task.developerId,title:task.title,description:task.description,risk:'high',riskReason:'original behavior',writes:task.writes,reads:task.reads,verification,
  }]});
  assert.equal(result.state,'valid');
  assert.ok(result.warnings.some(warning=>warning.path.endsWith('.timeoutMs')&&/构建前置可能占满预算/.test(warning.message)));
});
