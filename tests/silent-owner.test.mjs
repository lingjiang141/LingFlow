import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/evidence-fixture.mjs";

test("fresh idle heartbeat overrides stale running observation and recovers exactly once", async t => {
  const f = await fixture(t);
  f.store.change(s => {
    s.tasks[0].state="rework";s.tasks[0].deliveredAt=Date.now();
    const m=s.roles.find(r=>r.kind==="developer");m.state="idle";m.pending=0;m.jobs=0;m.connectedAt=Date.now();
    m.observation={state:"running",at:Date.now()-60000,turn:{id:"old",startedAt:Date.now()-60000}};
  });
  const args={taskId:f.taskId,reason:"silent recovery"};
  const result=f.call("Lead","resumeTask",args,"recover-once");
  assert.equal(result.recoveredBy,"resume");assert.equal(result.previousOwnerState,"silent");
  assert.deepEqual(f.call("Lead","resumeTask",args,"recover-once"),result);
  const deliveries=f.wf.heartbeat(f.roles.map(r=>({id:r.name,state:"idle",pending:0,jobs:0}))).deliveries;
  const wake=deliveries.find(w=>w.sessionId==="Dev");assert.ok(wake);
  f.wf.acknowledge(wake.id,"Dev");
  assert.ok(f.store.read().tasks[0].deliveredAt);
  assert.equal(f.store.read().tasks[0].scheduleHistory.filter(h=>h.resumed).length,1);
});

test("busy recovery errors identify running turn, queued input or background job",async t=>{
  for(const [field,value,pattern] of [["state","running",/回合/],["pending",1,/排队输入/],["jobs",1,/后台作业/]]){
    const f=await fixture(t);f.store.change(s=>{s.roles.find(r=>r.kind==="developer")[field]=value;});
    assert.throws(()=>f.call("Lead","resumeTask",{taskId:f.taskId,reason:"retry"}),pattern);
  }
});

test("silent delivered task can redeliver and list exposes growing silence",async t=>{
  const f=await fixture(t);const now=Date.now();
  f.store.change(s=>{s.tasks[0].state="rework";s.tasks[0].deliveredAt=now-700000;});
  const sessions=f.roles.map(r=>({id:r.name,state:"idle",pending:0,jobs:0}));
  f.wf.heartbeat(sessions,now);
  for(let elapsed=10000;elapsed<=610000;elapsed+=10000)f.wf.heartbeat(sessions,now+elapsed);
  const task=f.call("Lead","list").tasks.find(t=>t.id===f.taskId);
  assert.ok(task.ownerSilentForMs>=600000);assert.ok(task.lastHeartbeatAt);assert.equal(task.ownerState,"silent");
  assert.ok(f.store.read().notices.some(n=>n.taskId===f.taskId&&n.key.startsWith("owner-silent:")));
  for(const command of ["reviseSchedule","rework"]) {
    assert.throws(()=>f.call("Lead",command,{taskId:f.taskId,reason:"recover"}),/成员已静默.*resumeTask.*yieldForSchedule/);
  }
  const result=f.call("Lead","redeliver",{taskId:f.taskId});assert.equal(result.recoveredBy,"resume");
});

test("unknown telemetry, stale heartbeat and a live turn never become a silent override",async t=>{
  const f=await fixture(t);
  const memberId=f.roles.find(r=>r.kind==="developer").id;
  f.store.change(s=>{s.roles.find(r=>r.id===memberId).jobs=null;});
  assert.throws(()=>f.call("Lead","resumeTask",{taskId:f.taskId,reason:"recover"}),/未知/);
  f.store.change(s=>{const m=s.roles.find(r=>r.id===memberId);m.jobs=0;m.connectedAt=Date.now()-60000;});
  assert.throws(()=>f.call("Lead","resumeTask",{taskId:f.taskId,reason:"recover"}),/心跳过期/);
  f.store.change(s=>{const m=s.roles.find(r=>r.id===memberId);m.connectedAt=Date.now();m.observation={state:"running",at:m.connectedAt+1};});
  assert.throws(()=>f.call("Lead","resumeTask",{taskId:f.taskId,reason:"recover"}),/进行中的回合/);
});

test("recovered ticket still fails normal admission when baseline drifted",async t=>{
  const f=await fixture(t);f.store.change(s=>{s.tasks[0].deliveredAt=Date.now();});
  f.put("implementation.cjs","module.exports = 'in-flight commit';");f.git("add","implementation.cjs");
  f.git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","drift");
  assert.throws(() => f.call("Lead","resumeTask",{taskId:f.taskId,reason:"recover"}), /冻结范围.*implementation/);
  assert.equal(f.store.read().tasks[0].state,"assigned");
});

test("inspect bounds a large baseline, with explicit paging and no persisted truncation",async t=>{
  const f=await fixture(t);f.store.change(s=>{s.tasks[0].baseline.other=Array.from({length:7000},(_,i)=>["outside/"+i+".txt","a".repeat(64)]);});
  const result=f.call("Lead","inspect",{taskId:f.taskId});
  assert.equal(result.truncated,true);assert.ok(result.totalBytes>200000);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=200000);
  const page=f.call("Lead","inspect",{taskId:f.taskId,section:"baseline.other",offset:500,limit:20});
  assert.equal(page.items.length,20);assert.equal(page.offset,500);assert.equal(page.total,7000);
  assert.equal(f.store.read().tasks[0].baseline.other.length,7000);
});
