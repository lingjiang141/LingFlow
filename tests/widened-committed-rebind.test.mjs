import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { gitState, protectsAdmittedWrites } from "../src/quality.mjs";
import { fixture, reviewedDimensions } from "./helpers/evidence-fixture.mjs";

const impl = "implementation.cjs";
const extra = "extra.cjs";
const extraTwo = "extra-two.cjs";
const readInput = "shared-read.cjs";
const assertion = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";
const commit = (f, ...files) => {
  f.git("add", "--", ...files);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "commit work");
  return gitState(f.root).head;
};
const taskOf = (f, taskId = f.taskId) => f.store.read().tasks.find(item => item.id === taskId);
const beat = (f, devState = "idle") => f.wf.heartbeat(f.roles.map(role => ({
  id: role.name, state: role.name === "Dev" ? devState : "idle", pending: 0, jobs: 0,
})));

test("legacy persisted widened queued ticket with committed overlap, read-to-write promotion, and dirty writes unblocks cleanly", async t => {
  const f = await fixture(t, "AssertionError", {
    risk: "medium",
    initialFiles: { [extra]: "module.exports = 'old-extra';\n", [extraTwo]: "module.exports = 'old-two';\n" },
  });
  // Match R20-03: extra was in reads at admission before being widened into writes.
  f.store.change(s => { s.tasks[0].reads = [extra]; });
  const baseHead = taskOf(f).baseline.head;
  f.put(f.testFile, assertion);
  assert.equal((await f.run("red")).state, "passed");

  // Widen the write set via paused reviseSchedule (matching R20-03 step 3).
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "停写以扩容写集" });
  const widened = f.call("Lead", "reviseSchedule", {
    taskId: f.taskId,
    writes: [...taskOf(f).writes, extra, extraTwo],
    reason: "补齐需要改动的实现文件",
  });
  assert.equal(widened.redBaselineRealigned, true);
  assert.equal(widened.redBaselineHead, baseHead);
  beat(f);
  assert.equal(taskOf(f).state, "assigned");
  assert.equal((await f.run("red")).state, "passed");

  // Simulate pre-fix persisted state: baseline.widenedWrites missing, stale added write still in baseline.other,
  // and ticket sitting in queued with candidate=null after a prior reviseSchedule/rework.
  f.put(impl, "module.exports = 'v1';\n");
  f.put(extra, "module.exports = 'extra-v1';\n");
  const head = commit(f, impl, extra, f.testFile);
  // Keep active in-progress round-2 edits in the working tree inside task.writes.
  f.put(impl, "module.exports = 'new';\n");
  f.put(extra, "module.exports = 'extra-v2';\n");
  f.store.change(s => {
    const task = s.tasks.find(item => item.id === f.taskId);
    delete task.baseline.widenedWrites;
    task.baseline.other = [[extra, "1".repeat(64)]];
    task.state = "queued";
    task.candidate = null;
    task.deliveredAt = null;
    task.waitReason = "Git 基线与冻结范围不一致";
  });

  // Legacy widened ticket with read->write promotion stays rejected for silent confirmCommit,
  // but yields an executable rebind plan requiring explicit confirmReadPromotion + confirmOwnedDirty.
  assert.equal(protectsAdmittedWrites(taskOf(f)), false);
  assert.equal(protectsAdmittedWrites(taskOf(f), { allowPromotedReads: true }), true);
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosis.classification, "baseline-drift-owned-rebindable", diagnosis.reason);
  assert.equal(diagnosis.nextAction?.command, "rebindCommittedWork");
  assert.equal(diagnosis.recovery?.executable, true);
  assert.equal(diagnosis.recovery?.requiresConfirmation, true);
  assert.deepEqual(diagnosis.promotedReads, [extra]);
  assert.deepEqual(diagnosis.nextAction.args.confirmReadPromotion, [extra]);
  assert.deepEqual(diagnosis.dirtyWrites, [extra, impl]);
  assert.deepEqual(Object.keys(diagnosis.nextAction.args.confirmOwnedDirty).sort(), [extra, impl]);

  // unblock must require explicit controller confirmation rather than silently rebinding.
  const unblock = f.call("Lead", "unblock", { taskId: f.taskId, reason: "核对恢复路径" });
  assert.equal(unblock.state, "confirmation-required");
  assert.equal(unblock.chosen?.command, "rebindCommittedWork");

  // Omitting confirmOwnedDirty, passing stale digests, or omitting/mismatching confirmReadPromotion must be rejected.
  const { confirmOwnedDirty, ...withoutDirty } = diagnosis.nextAction.args;
  assert.throws(() => f.call("Lead", "rebindCommittedWork", withoutDirty), /工作树.*extra\.cjs/);
  assert.throws(() => f.call("Lead", "rebindCommittedWork", {
    ...diagnosis.nextAction.args,
    confirmOwnedDirty: { ...confirmOwnedDirty, [impl]: "0".repeat(64) },
  }), /confirmOwnedDirty/);
  const { confirmReadPromotion, ...withoutReadPromotion } = diagnosis.nextAction.args;
  assert.throws(() => f.call("Lead", "rebindCommittedWork", withoutReadPromotion), /confirmReadPromotion/);
  assert.throws(() => f.call("Lead", "rebindCommittedWork", {
    ...diagnosis.nextAction.args,
    confirmReadPromotion: [],
  }), /confirmReadPromotion/);

  // Executing rebindCommittedWork with exact confirmations unblocks the ticket and preserves redBaseline.
  const rebound = f.call("Lead", "rebindCommittedWork", diagnosis.nextAction.args);
  assert.equal(rebound.state, "applied");
  assert.equal(rebound.rebind.from, baseHead);
  assert.equal(rebound.rebind.to, head);
  assert.deepEqual(rebound.rebind.confirmedOwnedDirty.sort(), [extra, impl]);
  assert.deepEqual(rebound.rebind.confirmedReadPromotion, [extra]);
  assert.equal(rebound.rebind.redBaselineHead, baseHead);
  assert.deepEqual(rebound.rebind.rerunRed ?? [], []);

  const afterRebind = taskOf(f);
  assert.equal(afterRebind.baseline.head, head);
  assert.deepEqual(afterRebind.baseline.other, []);
  assert.equal(protectsAdmittedWrites(afterRebind), true);
  assert.equal(afterRebind.redBaseline.head, baseHead);

  // Scheduler re-admits immediately; green, full, report, independent, summarize, and accept all pass.
  beat(f);
  assert.equal(taskOf(f).state, "rework", taskOf(f).waitReason);
  assert.equal((await f.run("green")).state, "passed");
  assert.equal((await f.run("full")).state, "passed");
  const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
    .map(key => [key, { state: "pass", evidence: "真实断言已验证", checkIds: ["full"] }]));
  const report = f.call("Dev", "report", { taskId: f.taskId, summary: "完成扩容后重绑交付", dimensions });
  assert.equal((await f.run("independent", false, "Lead")).state, "passed");
  f.call("Lead", "summarize", {
    taskId: f.taskId,
    instructions: "核对原票交付",
    decision: {
      candidate: report.candidate,
      limits: "无",
      dimensions: reviewedDimensions("full"),
      acceptance: [{ id: "AC1", evidence: "通过", checkIds: ["full"] }],
    },
  });
  assert.equal(f.call("ui", "accept", { taskId: f.taskId, evidence: "验收通过" }).state, "accepted");
});

test("in-flight pureWiden records widenedWrites and rebinds with deleted dirty writes", async t => {
  const f = await fixture(t, "AssertionError", {
    risk: "medium",
    initialFiles: { [extra]: "module.exports = 'old-extra';\n" },
  });
  beat(f, "running");
  const widened = f.call("Lead", "reviseSchedule", {
    taskId: f.taskId,
    writes: [...taskOf(f).writes, extra],
    reason: "运行中纯扩写集",
  });
  assert.deepEqual(widened.addedWrites, [extra]);
  assert.deepEqual(taskOf(f).baseline.widenedWrites, [extra]);

  f.put(f.testFile, assertion);
  assert.equal((await f.run("red")).state, "passed");
  f.put(impl, "module.exports = 'v1';\n");
  f.put(extra, "module.exports = 'extra-v1';\n");
  const head = commit(f, impl, extra, f.testFile);
  // Delete extra in working tree while keeping impl edited to verify deleted dirty write digest handling.
  f.put(impl, "module.exports = 'new';\n");
  unlinkSync(path.join(f.root, extra));
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "停写重绑" });

  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosis.nextAction?.command, "rebindCommittedWork", diagnosis.reason);
  assert.deepEqual(Object.keys(diagnosis.nextAction.args.confirmOwnedDirty).sort(), [extra, impl]);
  const rebound = f.call("Lead", "rebindCommittedWork", diagnosis.nextAction.args);
  assert.equal(rebound.state, "applied");
  assert.equal(taskOf(f).baseline.head, head);
  assert.equal(taskOf(f).state, "rework");
});

test("security invariants hold: shrinking writes, laundering committed reads, dirty reads, and dirty confirmCommit stay blocked", async t => {
  const f = await fixture(t, "AssertionError", {
    risk: "medium",
    initialFiles: { [extra]: "module.exports = 'extra';\n", [readInput]: "module.exports = 'read-v1';\n" },
  });
  f.store.change(s => { s.tasks[0].reads = [readInput]; });
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "停写核对" });

  // 1. Committed read file cannot be laundered into writes after HEAD moves.
  f.put(readInput, "module.exports = 'read-v2';\n");
  f.put(impl, "module.exports = 'v1';\n");
  commit(f, readInput, impl);
  f.call("Lead", "reviseSchedule", {
    taskId: f.taskId,
    writes: [...taskOf(f).writes, readInput],
    reads: [],
    reason: "试图把已提交只读输入并入写集",
  });
  assert.equal(protectsAdmittedWrites(taskOf(f)), false);
  const laundered = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(laundered.classification, "baseline-drift-blocked");
  assert.equal(laundered.nextAction, null);

  // 2. Shrinking an admitted write is still rejected by protectsAdmittedWrites.
  const shrunk = structuredClone(taskOf(f));
  shrunk.writes = [f.testFile];
  assert.equal(protectsAdmittedWrites(shrunk), false);

  // 3. Clean commit of a legitimately widened ticket supports confirmCommit, while dirty writes still block confirmCommit.
  const f2 = await fixture(t, "AssertionError", {
    risk: "medium",
    initialFiles: { [extra]: "module.exports = 'old';\n" },
  });
  beat(f2, "running");
  f2.call("Lead", "reviseSchedule", { taskId: f2.taskId, writes: [...taskOf(f2).writes, extra], reason: "合法扩容" });
  beat(f2, "idle");
  f2.put(f2.testFile, assertion);
  assert.equal((await f2.run("red")).state, "passed");
  f2.put(impl, "module.exports = 'new';\n");
  f2.put(extra, "module.exports = 'new';\n");
  assert.equal((await f2.run("green")).state, "passed");
  assert.equal((await f2.run("full")).state, "passed");
  const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
    .map(key => [key, { state: "pass", evidence: "已核对", checkIds: ["full"] }]));
  f2.call("Dev", "report", { taskId: f2.taskId, summary: "交付扩容候选", dimensions });
  const base2 = taskOf(f2).baseline.head;
  const head2 = commit(f2, impl, extra, f2.testFile);

  // Dirty write blocks confirmCommit.
  f2.put(extra, "module.exports = 'dirty-after-commit';\n");
  assert.throws(() => f2.call("Lead", "confirmCommit", {
    taskId: f2.taskId, expectedBase: base2, expectedHead: head2, paths: [extra, impl, f2.testFile], reason: "确认提交",
  }), /工作树|等价/);

  // Restoring committed bytes allows confirmCommit on the widened ticket.
  f2.put(extra, "module.exports = 'new';\n");
  const confirmed = f2.call("Lead", "confirmCommit", {
    taskId: f2.taskId, expectedBase: base2, expectedHead: head2, paths: [extra, impl, f2.testFile], reason: "确认扩容后的等价提交",
  });
  assert.equal(confirmed.state, "applied");
});
