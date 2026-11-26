import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";

const taskOf = f => f.store.read().tasks.find(task => task.id === f.taskId);
const dispatches = f => f.store.read().notices.filter(notice =>
  notice.taskId === f.taskId && notice.key.startsWith("dispatch:"));
const heartbeat = (f, state) => f.wf.heartbeat(f.roles.map(role => ({
  id: role.name, state: role.name === "Dev" ? state : "idle", pending: 0, jobs: 0,
})));

async function pausedTask(t) {
  const f = await fixture(t);
  f.call("Dev", "inbox");
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');");
  heartbeat(f, "running");
  const pause = f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "停写后请主控核对取红基线" });
  assert.equal(pause.state, "paused");
  return f;
}

test("realigning a paused red baseline queues one fresh dispatch and lets the developer run red", async t => {
  const f = await pausedTask(t);
  const before = taskOf(f);
  const args = { taskId: f.taskId };
  f.put("tickets.md", "更新票面记录");
  const sourceReview = f.call("Lead", "diagnoseTask", args).nextAction;
  assert.equal(sourceReview.args.refreshSourceDigest, true);
  assert.equal(f.call("Lead", sourceReview.command, sourceReview.args).state, "applied");
  assert.equal(taskOf(f).state, "paused");
  const reason = "已核对取红提交";
  const realign = {
    ...args, realignRedBaseline: true, expectedHead: before.baseline.head, redBaselineHead: before.baseline.head, reason,
  };
  const receipt = f.call("Lead", "reviseSchedule", realign, "realign-once");
  assert.deepEqual(f.call("Lead", "reviseSchedule", realign, "realign-once"), receipt);
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.redBaselineRealigned, true);
  assert.deepEqual(receipt.rerunRed, ["red"]);
  const queued = taskOf(f);
  assert.equal(queued.state, "queued");
  assert.equal(queued.scheduleVersion, (before.scheduleVersion ?? 0) + 1);
  assert.equal(queued.deliveredAt, null);
  assert.equal(queued.scheduleHistory.at(-1).previous.state, "paused");
  assert.equal(queued.scheduleHistory.at(-1).reason, reason);
  assert.equal(queued.scheduleHistory.at(-1).resumed, true);
  assert.equal(dispatches(f).length, 1);
  assert.notEqual(f.call("Lead", "diagnoseTask", args).nextAction?.command, "check");
  heartbeat(f, "running");
  assert.equal(taskOf(f).state, "queued");
  assert.equal(dispatches(f).length, 1);
  heartbeat(f, "idle");
  assert.equal(taskOf(f).state, "rework");
  assert.equal(dispatches(f).length, 2);
  f.call("Dev", "inbox");
  const next = f.call("Lead", "diagnoseTask", args).nextAction;
  assert.equal(next.command, "check");
  assert.equal(next.ownerRole, "developer");
  assert.equal((await f.run(next.args.checkId)).state, "passed");
});

test("a paused developer can confirm yielding repeatedly without changing the task or notices", async t => {
  const f = await pausedTask(t);
  const before = f.store.read();
  const args = { taskId: f.taskId, reason: "确认已停写" };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(f.call("Dev", "yieldForSchedule", args), { state: "paused", taskId: f.taskId, noop: true });
  }
  assert.deepEqual(f.store.read().tasks, before.tasks);
  assert.deepEqual(f.store.read().notices, before.notices);
  assert.throws(() => f.call("Review", "yieldForSchedule", args), /责任成员/);
});

test("a running developer blocks takeover of an active task but can have a paused task queued", async t => {
  const f = await pausedTask(t);
  const args = { taskId: f.taskId, reason: "恢复原票" };
  assert.equal(f.call("Lead", "diagnoseTask", args).nextAction?.command, "resumeTask");
  assert.equal(f.call("Lead", "resumeTask", args).state, "stored");
  assert.equal(taskOf(f).state, "queued");
  assert.equal(dispatches(f).length, 1);
  heartbeat(f, "idle");
  assert.equal(taskOf(f).state, "assigned");
  f.call("Dev", "inbox");
  heartbeat(f, "running");
  assert.throws(() => f.call("Lead", "resumeTask", args), /running-turn/);
});

test("resuming a paused ticket waits for the developer's other active ticket", async t => {
  const f = await pausedTask(t);
  const paused = taskOf(f);
  const other = f.call("Lead", "dispatch", {
    requirementId: paused.requirementId, developerId: paused.developerId,
    title: "另一张票", description: "核对规格", risk: "low", readOnly: true, writes: [], reads: ["spec.md"],
  });
  assert.equal(other.state, "assigned");
  f.call("Dev", "inbox");
  const resume = f.call("Lead", "resumeTask", { taskId: f.taskId, reason: "恢复原票" });
  assert.equal(resume.state, "stored");
  assert.equal(resume.previousOwnerState, "running");
  heartbeat(f, "idle");
  assert.equal(taskOf(f).state, "queued");
  assert.equal(dispatches(f).length, 1);
  f.call("Dev", "yieldForSchedule", { taskId: other.taskId, reason: "交回其他责任" });
  assert.equal(taskOf(f).state, "assigned");
  assert.equal(dispatches(f).length, 2);
});

test("rescheduling a paused task records its return to the queue", async t => {
  const f = await pausedTask(t);
  const result = f.call("Lead", "reviseSchedule", { taskId: f.taskId, reason: "重新排队" });
  assert.equal(result.resumed, true);
  assert.equal(taskOf(f).state, "queued");
  assert.equal(taskOf(f).scheduleHistory.at(-1).previous.state, "paused");
  assert.equal(taskOf(f).scheduleHistory.at(-1).resumed, true);
  assert.equal(dispatches(f).length, 1);
  heartbeat(f, "running");
  assert.equal(taskOf(f).state, "queued");
  heartbeat(f, "idle");
  assert.equal(taskOf(f).state, "assigned");
  assert.equal(dispatches(f).length, 2);
});
