import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { wakeDelay } from "../src/wake-policy.mjs";
import { wakeText, markContextSeen } from "../src/role-context.mjs";
import { installTools, installedToolsVersion } from "../adapters/dsh/tool-registration.mjs";
import { prepareCheck, artifactsIntact } from "../src/check-preparation.mjs";
import { inspectRole } from "../src/patrol.mjs";
import { reconcileRoleDuplicates } from "../src/role-duplicates.mjs";

test("resumeTask retains original evidence, waits for fresh idle heartbeat and rejects running retry", async t => {
  const f = await fixture(t);
  const old = f.store.read().tasks[0];
  f.store.change(s => { const task=s.tasks[0]; task.state="rework"; task.deliveredAt=Date.now(); task.deliveryIssue={reason:"continuation-limit",detail:"limit"}; });
  assert.equal(f.call("Lead","diagnoseTask",{taskId:old.id}).nextAction.command,"resumeTask");
  const args={taskId:old.id,reason:"host restored"};
  const result=f.call("Lead","resumeTask",args,"resume-one");
  assert.equal(result.state,"stored");
  assert.equal(f.store.read().tasks[0].state,"queued");
  assert.deepEqual(f.store.read().tasks[0].baseline,old.baseline);
  assert.deepEqual(f.call("Lead","resumeTask",args,"resume-one"),result);
  f.wf.heartbeat(f.roles.map(role=>({id:role.name,state:role.kind==="developer"?"running":"idle",pending:0,jobs:0})));
  assert.equal(f.store.read().tasks[0].state,"queued");
  f.wf.heartbeat(f.roles.map(role=>({id:role.name,state:"idle",pending:0,jobs:0})));
  assert.equal(f.store.read().tasks[0].state,"rework");
  f.store.change(s=>s.roles.find(role=>role.kind==="developer").state="running");
  assert.throws(()=>f.call("Lead","resumeTask",args),/责任正在执行/);
});

test("patrol continuation limit persists task deliveryIssue", () => {
  const now=1000000, task={id:"t",projectId:"p",assignee:"r",state:"rework",revision:1,questions:[]};
  const role={id:"r",projectId:"p",enabled:true,sessionId:"s",connectedAt:now,enabledAt:1,pending:0,jobs:0,
    observation:{state:"idle",since:1,activityAt:1,at:now},patrolEpisode:{scope:"t:1:0",startedAt:1,attempts:2,alerts:[]}};
  inspectRole({s:{tasks:[task],checkJobs:[],notices:[],wakes:[]},role,project:{},lead:{id:"lead"},now,live:true,notify(){}});
  assert.equal(task.deliveryIssue.reason,"continuation-limit");
});

test("wake acknowledgement marks actual recipient, later wake is compact",async t=>{
  const f=await fixture(t);
  f.store.change(s=>{const role=s.roles.find(role=>role.kind==="controller");delete role.seenContextRevision;delete role.seenSupervisionPolicy; f.wf.notice(s,role.id,"custom:1","one");});
  const sessions=f.roles.map(role=>({id:role.name,state:"idle",pending:0,jobs:0}));
  const wake=f.wf.heartbeat(sessions).deliveries.find(w=>w.sessionId==="Lead");
  assert.match(wake.text,/角色身份/);
  f.wf.acknowledge(wake.id,"Lead");
  const role=f.store.read().roles.find(role=>role.kind==="controller");
  assert.equal(role.seenContextRevision,1);
  const compact=wakeText(f.store.read().projects[0],role,true,"one");
  assert.ok(compact.length<800);assert.doesNotMatch(compact,/角色身份/);
  const changed=wakeText(f.store.read().projects[0],role,true,"two");
  assert.equal(compact.slice(0,compact.indexOf("当前事项")),changed.slice(0,changed.indexOf("当前事项")));
});

test("tools use stable sorted names and survive repeated installation on same registry",()=>{
  const calls=[], effects=[], agent={ctx:{tools:{register:def=>{calls.push(def.name);return()=>{};}}}};
  const defs=[{name:"z"},{name:"a"}];const effect=fn=>effects.push(fn());
  installTools(agent,defs,effect);installTools(agent,defs,effect);
  assert.deepEqual(calls,["a","z"]);assert.equal(typeof installedToolsVersion,"string");
  for(const dispose of effects)dispose();installTools(agent,defs,effect);assert.equal(calls.length,4);
});

test("five routine events share a fixed 25 second window",()=>{
  const role={};markContextSeen(role);
  const notices=Array.from({length:5},(_,i)=>({key:"check:"+i,at:1000+i*4000}));
  assert.equal(wakeDelay(notices,role,25000),1000);
  assert.equal(wakeDelay(notices,role,26000),0);
});

test("five status receipts stay in inbox and merge with one actionable report after the window",async t=>{
  const f=await fixture(t); const now=Date.now(),lead=f.roles.find(role=>role.kind==="controller");
  f.store.change(s=>{ for(let i=0;i<5;i++) { f.wf.notice(s,lead.id,"check:case-"+i,"check done",f.taskId); s.notices.at(-1).at=now+i*1000; } });
  const sessions=f.roles.map(role=>({id:role.name,state:"idle",pending:0,jobs:0}));
  assert.equal(f.wf.heartbeat(sessions,now+20000).deliveries.filter(w=>w.roleId===lead.id).length,0);
  assert.equal(f.wf.heartbeat(sessions,now+26000).deliveries.filter(w=>w.roleId===lead.id).length,0);
  f.store.change(s=>{ f.wf.notice(s,lead.id,'report:ready','report ready',f.taskId);s.notices.at(-1).at=now+6000; });
  const deliveries=f.wf.heartbeat(sessions,now+26000).deliveries.filter(w=>w.roleId===lead.id);
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].noticeIds.length,6);assert.match(deliveries[0].text,/actionable: true/);
});

test("same-name roles merge only when identity matches and no history references the duplicate",()=>{
  const state={projects:[],tasks:[],notices:[],wakes:[],roles:[{id:"a",name:"Dev",projectId:"p",kind:"developer",enabled:true},
    {id:"b",name:"Dev",projectId:"p",kind:"developer"},{id:"c",name:"Dev",projectId:"p",kind:"reviewer"}]};
  reconcileRoleDuplicates(state);assert.equal(state.roles[1].mergedInto,"a");
  assert.equal(state.roles[2].archivedAt,undefined);assert.equal(state.roleDuplicateDiagnostics[1].state,"needs-review");
});

test("message errors distinguish member target, missing reply and wrong message id",async t=>{
  const f=await fixture(t);
  for(const [args,pattern] of [
    [{roleId:f.roles.find(role=>role.kind==="developer").id,text:"resume"},/resumeTask/],
    [{text:"reply"},/replyTo/],
    [{replyTo:"notification-id",text:"reply"},/通知 id/],
    [{roleId:"missing-role",text:"reply"},/roleId/],
  ])assert.throws(()=>f.call("Lead","message",args),pattern);
});

test("missing artifacts fail explicitly; declared build steps create hashed evidence",async t=>{
  const f=await fixture(t);const output="apps/web/dist";
  await assert.rejects(prepareCheck(f.root,{requiredArtifacts:[output]}),/缺少构建产物 apps\/web\/dist/);
  const code="require('node:fs').mkdirSync('apps/web/dist',{recursive:true});require('node:fs').writeFileSync('apps/web/dist/app.js','build');";
  const receipt=await prepareCheck(f.root,{timeoutMs:10000,requiredArtifacts:[output],preSteps:[{argv:["node","-e",code],outputs:[output],timeoutMs:5000}]});
  assert.equal(receipt.steps[0].exitCode,0);assert.match(receipt.artifacts[0].hash,/^[a-f0-9]{64}$/);
  assert.equal(artifactsIntact(f.root,receipt),true);
  writeFileSync(path.join(f.root,output,"app.js"),"changed");assert.equal(artifactsIntact(f.root,receipt),false);
});

test("real check worker refuses missing build products and records successful pre-build evidence",async t=>{
  const f=await fixture(t);
  f.put(f.testFile,"require('node:assert/strict').equal(require('../implementation.cjs'),'new');");
  const outputs=["apps/web/dist"];
  f.store.change(s=>{s.tasks[0].verification.checks.find(c=>c.id==="red").requiredArtifacts=outputs;});
  const missing=await f.run("red");
  assert.equal(missing.state,"failed");assert.equal(missing.receipt.failureOutputSeen,false);
  assert.match(missing.receipt.preparationError,/缺少构建产物/);
  const argv=["node","-e","const fs=require('node:fs');fs.mkdirSync('apps/web/dist',{recursive:true});fs.writeFileSync('apps/web/dist/app.js',fs.readFileSync('implementation.cjs'))"];
  f.store.change(s=>{for(const check of s.tasks[0].verification.checks) {check.requiredArtifacts=outputs;check.preSteps=[{argv,outputs,timeoutMs:5000}];}});
  const red=await f.run("red");assert.equal(red.state,"passed",JSON.stringify(red));
  assert.equal(red.receipt.preparation.steps[0].exitCode,0);assert.equal(red.receipt.preparation.artifacts.length,1);
  f.put("implementation.cjs","module.exports='new';");
  assert.equal((await f.run("green")).state,"passed");
  assert.equal((await f.run("full")).state,"passed", "New build products must not invalidate historical baseline red");
});
