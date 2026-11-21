import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";

const readTask = (f, taskId = f.taskId) => f.store.read().tasks.find(task => task.id === taskId);
const beat = (f, devState) => f.wf.heartbeat(f.roles.map(role => ({
  id: role.name, state: role.name === "Dev" ? devState : "idle", pending: 0, jobs: 0,
})));
const revise = (f, taskId, args) => f.call("Lead", "reviseSchedule", { taskId, reason: "已核对原范围与新增文件", ...args });
const added = "historical-export.test.ts";
const fail = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";

test("running expansion preserves a multi-file ticket and lists the exact red receipt invalidated", async t => {
  const f = await fixture(t, "AssertionError", { initialFiles: { [added]: "test('old export', () => {});" } });
  const original = readTask(f);
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "停止占用测试文件" });
  f.call("Lead", "releaseSchedule", { taskId: f.taskId, reason: "登记测试后继票" });
  f.put("export-ticket.md", "# 票 R8-03：导出\n\nAC1: adjust export\n");
  f.put("other-ticket.md", "# 票 R8-04：后续\n\nAC1: future work\n");
  const verification = structuredClone(original.verification);
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  const plan = f.call("Lead", "dispatchPlan", { requirementId: original.requirementId,
    sources: { spec: "spec.md", tickets: ["export-ticket.md", "other-ticket.md"], attempts: "attempts.md" },
    tickets: [{ key: "R8-03", title: "导出", description: "调整导出", risk: "high", riskReason: "修改权限", writes: original.writes,
      reads: [], developerId: original.developerId, verification }] });
  const taskId = plan.tasks[0].taskId;
  assert.ok(f.store.read().plans.find(item => item.id === readTask(f, taskId).planId).documents["ticket:0"]);
  f.put(f.testFile, fail);
  const red = await f.run("red", false, "Dev", taskId);
  assert.equal(red.state, "passed");
  beat(f, "running");
  const before = readTask(f, taskId);
  const updated = revise(f, taskId, { writes: [...before.writes, added] });
  assert.equal(updated.state, "applied");
  assert.equal(updated.redBaselineRealigned, true);
  assert.deepEqual(updated.rerunRed, ["red"]);
  assert.deepEqual(updated.invalidatedChecks.map(item => [item.checkId, item.jobId]), [["red", red.id]]);
  const event = f.store.db.prepare("SELECT data FROM events WHERE kind='schedule.writes-widened'").get();
  assert.deepEqual(JSON.parse(event.data).added, [added]);
  const after = readTask(f, taskId);
  assert.deepEqual(after.sources, before.sources);
  assert.deepEqual(after.verification, before.verification);
  assert.equal(after.state, before.state);
  assert.equal(after.assignee, before.assignee);
  assert.throws(() => revise(f, taskId, { writes: before.writes }), /成员存在进行中的回合/);
  assert.throws(() => revise(f, taskId, { writes: [...before.writes, "other-ticket.md"] }), /成员存在进行中的回合/);
});

test("fresh idle evidence permits a scheduling edit without a persisted silence flag", async t => {
  const f = await fixture(t);
  beat(f, "idle");
  f.store.change(s => { delete s.tasks[0].ownerState; });
  const updated = revise(f, f.taskId, { after: [] });
  assert.equal(updated.state, "stored");
  assert.equal(updated.previousOwnerState, "silent");
});

test("explicitly adding an already covered test keeps an identical red snapshot and receipt", async t => {
  const f = await fixture(t, "AssertionError", { existingTest: fail });
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "确认目录范围后恢复" });
  revise(f, f.taskId, { writes: ["implementation.cjs", "e2e"] });
  beat(f, "idle");
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  const before = readTask(f);
  beat(f, "running");
  const updated = revise(f, f.taskId, { writes: [...before.writes, f.testFile] });
  assert.equal(updated.state, "stored");
  assert.equal(updated.redBaselineRealigned, undefined);
  assert.equal(updated.rerunRed, undefined);
  assert.equal(updated.invalidatedChecks, undefined);
  assert.equal(readTask(f).redBaseline.sources, before.redBaseline.sources);
  assert.ok(!f.store.read().checkJobs.find(job => job.id === red.id).invalidated);
});
