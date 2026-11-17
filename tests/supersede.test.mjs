import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from 'node:path';
import { fixture } from "./helpers/evidence-fixture.mjs";

const assertion = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";
const git = (f, ...args) => execFileSync("git", args, { cwd: f.root, windowsHide: true, encoding: "utf8" });
const gitSnapshot = f => [git(f, "rev-parse", "HEAD"), git(f, "ls-files", "--stage", "-z"), git(f, "status", "--porcelain=v1", "-z")];

function successor(f, after = []) {
  const state = f.store.read();
  const old = state.tasks.find(task => task.id === f.taskId);
  const verification = structuredClone(old.verification);
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  return f.call("Lead", "dispatchPlan", {
    requirementId: state.requirements[0].id,
    sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "SUCCESSOR", developerId: old.developerId, title: "Successor", description: "Replace unsatisfiable ticket",
      risk: "high", riskReason: "original behavior", writes: old.writes, reads: old.reads, after,
      verification }],
  });
}
const pause = f => f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "stopped, contract cannot be satisfied" });
const replacement = (f, id) => ({ taskId: f.taskId, supersededBy: id, reason: "remaining work moves to the approved successor" });

test("supersede releases paused scope immediately, preserves all evidence and never changes Git", async t => {
  const f = await fixture(t, "AssertionError", { existingTest: assertion });
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  pause(f);
  const before = f.call("Lead", "inspect", { taskId: f.taskId, section: "full" });
  const plan = successor(f);
  const nextId = plan.tasks[0].taskId;
  assert.equal(plan.runnable, false);
  const conflict = plan.tasks[0].scopeConflict;
  assert.equal(conflict.peerState, "paused");
  assert.match(conflict.message, /paused/);
  assert.equal(conflict.remedy.command, "supersede");
  assert.deepEqual(conflict.remedy.args, { ...replacement(f, nextId), reason: conflict.remedy.args.reason });
  const snapshot = gitSnapshot(f);
  const log = readFileSync(red.output);
  const result = f.call("Lead", "supersede", replacement(f, nextId), "replace-once");
  assert.equal(result.state, "superseded");
  assert.equal(result.successor.runnable, true);
  assert.equal(f.store.read().tasks.find(task => task.id === nextId).state, "assigned");
  const after = f.call("Lead", "inspect", { taskId: f.taskId, section: "full" });
  assert.equal(after.state, "superseded");
  assert.equal(after.supersededBy, nextId);
  assert.equal(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).classification, "superseded");
  assert.equal(f.call("Lead", "schema", { command: "supersede" }).gitWrites, false);
  for (const key of ["writes", "reads", "verification", "baseline", "reports", "reviews", "checkJobs"])
    assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(readFileSync(red.output), log);
  assert.equal(f.call("Lead", "checkEvidence", { jobId: red.id }).receipt.failureOutputSeen, true);
  assert.deepEqual(f.call("Lead", "supersede", replacement(f, nextId), "replace-once"), result);
  assert.deepEqual(gitSnapshot(f), snapshot);
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "red" }), /阶段|替代/);
  assert.equal(f.call("Lead", "scopePreview", { taskId: nextId, writes: after.writes, reads: [] }).conflicts.some(peer => peer.taskId === f.taskId), false);
});

test("replacement cycles are rejected even when untracked work needs a handoff", async t => {
  const f = await fixture(t);
  pause(f);
  const nextId = successor(f).tasks[0].taskId;
  f.put(f.testFile, assertion);
  const follower = f.call("Lead", "dispatch", { requirementId: f.store.read().requirements[0].id,
    developerId: f.roles.find(role => role.kind === "developer").id, title: "Cycle", description: "cycle fixture",
    risk: "low", readOnly: true, writes: [], reads: [], dependencies: [nextId] }).taskId;
  f.store.change(state => state.tasks.find(task => task.id === f.taskId).dependencies = [follower]);
  const before = f.store.read();
  const snapshot = gitSnapshot(f);
  assert.throws(() => f.call("Lead", "supersede", replacement(f, nextId)), /循环/);
  assert.deepEqual(f.store.read(), before);
  assert.deepEqual(gitSnapshot(f), snapshot);
});

test("Git ignored files inside the old write scope appear in an explicit handoff", async t => {
  for (const command of ['supersede','releaseSchedule']) await t.test(command,async t=>{
  const f = await fixture(t);
  pause(f);
  const nextId = successor(f).tasks[0].taskId;
  f.put(".gitignore", f.testFile + "\n");
  f.git("add", ".gitignore");
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture ignore rule");
  f.put(f.testFile, assertion);
  assert.equal(git(f, "status", "--porcelain"), "");
  const result=f.call('Lead',command,replacement(f,nextId));
  assert.deepEqual(result.handoff.ownedDirty,[f.testFile]);
  assert.equal(readFileSync(path.join(f.root,f.testFile),'utf8'),assertion);
  });
});

test("active tickets and unfinished checks cannot be superseded; dirty work is transferred explicitly", async t => {
  const f = await fixture(t, "AssertionError", { existingTest: assertion });
  const nextId = successor(f).tasks[0].taskId;
  const args = replacement(f, nextId);
  assert.throws(() => f.call("Lead", "supersede", args), /assigned.*停写|停写.*assigned/);
  pause(f);
  assert.throws(() => f.call("Dev", "supersede", args), /主控/);
  f.put("implementation.cjs", "module.exports = 'dirty';");
  const before = f.store.read();
  f.store.change(state => state.checkJobs.push({ id: "unfinished", taskId: f.taskId, state: "uncertain" }));
  assert.throws(() => f.call("Lead", "supersede", args), /检查/);
  assert.equal(f.store.read().tasks.find(task => task.id === f.taskId).state, before.tasks[0].state);
});

test("controller can release a paused ticket through writes empty or releaseSchedule without re-admission", async t => {
  for (const command of ["reviseSchedule", "releaseSchedule"]) {
    const f = await fixture(t, "AssertionError", { existingTest: assertion });
    assert.throws(() => f.call("Lead", command, { taskId: f.taskId, writes: [], reason: "release" }), /停写|paused|责任正在执行/);
    pause(f);
    const stopped = command === "releaseSchedule" ? "blocked" : "paused";
    if (stopped === "blocked") f.store.change(state => state.tasks.find(task => task.id === f.taskId).state = stopped);
    const plan = successor(f);
    const snapshot = gitSnapshot(f);
    f.call("Lead", command, { taskId: f.taskId, ...(command === "reviseSchedule" && { writes: [] }), reason: "close the stopped ticket" });
    const old = f.call("Lead", "inspect", { taskId: f.taskId, section: "full" });
    assert.deepEqual(old.writes, []);
    assert.equal(old.state, stopped);
    assert.deepEqual(old.releasedScope.writes, ["e2e/new-case.cjs", "implementation.cjs"]);
    assert.equal(f.store.read().tasks.find(task => task.id === plan.tasks[0].taskId).state, "assigned");
    assert.deepEqual(gitSnapshot(f), snapshot);
    f.put("implementation.cjs", "module.exports = 'successor edit';");
    assert.throws(() => f.call("Lead", "supersede", replacement(f, plan.tasks[0].taskId)), /已释放/);
  }
});

test("supersede rebinds waiting dependencies without treating replacement as acceptance", async t => {
  const f = await fixture(t, "AssertionError", { existingTest: assertion });
  pause(f);
  const nextId = successor(f, [{ taskId: f.taskId, stage: "verified" }]).tasks[0].taskId;
  const follower = f.call("Lead", "dispatch", { requirementId: f.store.read().requirements[0].id,
    developerId: f.roles.find(role => role.kind === "developer").id, title: "Follower", description: "wait for acceptance",
    risk: "low", readOnly: true, writes: [], reads: [], dependencies: [f.taskId] }).taskId;
  f.store.change(state => state.tasks.find(task => task.id === follower).dependencyStages = { [f.taskId]: "accepted" });
  f.call("Lead", "supersede", replacement(f, nextId));
  const state = f.store.read();
  assert.equal(state.tasks.find(task => task.id === nextId).state, "assigned");
  assert.deepEqual(state.tasks.find(task => task.id === nextId).dependencies, []);
  assert.deepEqual(state.tasks.find(task => task.id === follower).dependencies, [nextId]);
  assert.equal(state.tasks.find(task => task.id === follower).dependencyStages[nextId], "accepted");
  assert.equal(state.tasks.find(task => task.id === follower).state, "queued");
});
