import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fingerprintEol, implementationFingerprint } from "../src/files.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

const implementation = "implementation.cjs";
const original = "module.exports = 'old';\n";
const changed = "module.exports = 'new';\n";
const assertion = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";
const taskOf = f => f.store.read().tasks.find(task => task.id === f.taskId);
const redOf = task => task.verification.checks.find(check => check.stage === "red");

function git(f, ...args) {
  return execFileSync("git", args, { cwd: f.root, windowsHide: true });
}

function staleSources(f, { redBaseline = false } = {}) {
  f.put(implementation, changed);
  const stale = implementationFingerprint(f.root, taskOf(f));
  f.store.change(s => {
    const task = s.tasks.find(item => item.id === f.taskId);
    Object.assign(task.baseline, stale);
    if (redBaseline) task.redBaseline = { head: task.baseline.head, ...stale };
  });
  return stale.sources;
}

function committedBytes(f) {
  return git(f, "-c", "core.autocrlf=false", "show", taskOf(f).baseline.head + ":" + implementation);
}

function refresh(f, ownedDirty = []) {
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "交回原票刷新冻结基线" });
  return f.call("Lead", "reviseSchedule", { taskId: f.taskId, refreshBaseline: true,
    expectedHead: taskOf(f).baseline.head, ownedDirty, reason: "已核对原写集与 Git 基线" });
}

test("exact Git blob bytes repair stale sources and require a fresh real red before green", async t => {
  const f = await fixture(t, "AssertionError", { implementation: original });
  f.put(f.testFile, assertion);
  const oldRed = await f.run("red");
  assert.equal(oldRed.state, "passed");
  const previousSources = staleSources(f);
  f.put(implementation, committedBytes(f));
  const before = taskOf(f);
  const current = implementationFingerprint(f.root, before);
  assert.throws(() => f.wf.checkPrerequisites(f.store.read(), before, redOf(before), f.root), /红阶段必须在实现文件未变化时运行/);

  const receipt = refresh(f, [f.testFile]);
  const after = taskOf(f);
  assert.equal(receipt.state, "applied");
  assert.equal(receipt.redBaselineRealigned, true);
  assert.equal(receipt.taskId, f.taskId);
  assert.equal(receipt.scheduleVersion, (before.scheduleVersion ?? 0) + 1);
  assert.equal(receipt.previousSources, previousSources);
  assert.equal(receipt.newSources, current.sources);
  assert.equal(after.baseline.sources, current.sources);
  assert.deepEqual(after.baseline.sourceFiles, { ...current.sourceFiles });
  assert.deepEqual(after.redBaseline, { head: before.baseline.head, sources: current.sources, sourceFiles: { ...current.sourceFiles } });
  assert.deepEqual(receipt.rerunRed, ["red"]);
  assert.deepEqual(receipt.nextAction, { command: "check", args: { taskId: f.taskId, checkId: "red" } });
  assert.doesNotThrow(() => f.wf.checkPrerequisites(f.store.read(), after, redOf(after), f.root));
  assert.ok(!f.wf.validCheck(f.store.read(), after, redOf(after)));

  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  f.call("Dev", "inbox");
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "green" }), /先完成可核对的预期失败检查/);
  const fresh = await f.run("red");
  assert.equal(fresh.state, "passed");
  assert.notEqual(fresh.id, oldRed.id);
  assert.equal(fresh.receipt.failureOutputSeen, true);
  f.put(implementation, changed);
  assert.equal((await f.run("green")).state, "passed");
});

test("unrestored implementation keeps both historical source snapshots and the red gate", async t => {
  const f = await fixture(t, "AssertionError", { implementation: original });
  const stale = staleSources(f, { redBaseline: true });
  f.put(implementation, "module.exports = 'intermediate';\n");
  const before = taskOf(f);
  const receipt = refresh(f, [implementation]);
  const after = taskOf(f);
  assert.equal(receipt.redBaselineReused, true);
  assert.equal(receipt.reason, "实现文件仍与基线提交不同");
  assert.deepEqual(receipt.rerunRed ?? [], []);
  assert.equal(after.baseline.sources, stale);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.baseline.sourceFiles, before.baseline.sourceFiles);
  assert.deepEqual(after.redBaseline, before.redBaseline);
  assert.throws(() => f.wf.checkPrerequisites(f.store.read(), after, redOf(after), f.root), /红阶段必须在实现文件未变化时运行/);
});

test("CRLF checkout realigns only under normalize and repeated refresh preserves the fresh red job", async t => {
  const f = await fixture(t, "AssertionError", { implementation: original });
  f.git("config", "--local", "core.autocrlf", "true");
  const stale = staleSources(f);
  const blob = committedBytes(f);
  assert.deepEqual(blob, Buffer.from(original));
  const crlf = original.replaceAll("\n", "\r\n");
  assert.notDeepEqual(Buffer.from(crlf), blob);
  f.put(implementation, crlf);
  f.put(f.testFile, assertion);
  f.store.change(s => { s.tasks[0].redBaseline = null; });
  const normalized = implementationFingerprint(f.root, taskOf(f), "normalize").sources;
  const receipt = refresh(f, [implementation, f.testFile]);
  if (fingerprintEol === "raw") {
    assert.equal(receipt.redBaselineReused, true);
    assert.equal(taskOf(f).baseline.sources, stale);
    return;
  }
  assert.equal(receipt.redBaselineRealigned, true);
  assert.equal(receipt.newSources, normalized);
  const wake = () => {
    f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
    f.call("Dev", "inbox");
  };
  wake();
  const red = await f.run(receipt.nextAction.args.checkId);
  assert.equal(red.state, "passed");
  assert.equal(red.receipt.exitCode, 1);
  assert.equal(red.receipt.failureOutputSeen, true);
  const prior = taskOf(f);
  const again = refresh(f, [implementation, f.testFile]);
  assert.equal(again.redBaselineRealigned, true);
  assert.deepEqual(taskOf(f).redBaseline, prior.redBaseline);
  assert.equal(taskOf(f).revision, prior.revision);
  wake();
  assert.equal((await f.run("red")).id, red.id);
});

test("one implementation character change is enough to refuse repair", async t => {
  const f = await fixture(t, "AssertionError", { implementation: original });
  const stale = staleSources(f);
  f.put(implementation, original.replace("old", "ald"));
  const receipt = refresh(f, [implementation]);
  assert.equal(receipt.redBaselineReused, true);
  assert.equal(taskOf(f).baseline.sources, stale);
});
