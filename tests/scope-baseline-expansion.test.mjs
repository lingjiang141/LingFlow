import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { implementationFingerprint } from "../src/files.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

test("expanding the write set projects missing implementation paths into the original red snapshot", async t => {
  const f = await fixture(t);
  const snapshot = f.store.read();
  const original = snapshot.tasks[0];
  const verification = structuredClone(original.verification);
  for (const check of verification.checks) {
    if (!check.expectedOutput) delete check.expectedOutput;
    check.inputs = [f.testFile, "future.cjs"];
  }
  f.store.change(s => { s.tasks = []; s.notices = []; s.wakes = []; });
  const initial = ["future.cjs", ...Array.from({ length: 8 }, (_, index) => `initial-${index}.cjs`)];
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", {
    requirementId: original.requirementId, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "EXPAND", developerId: original.developerId, title: "missing implementation", description: "new files",
      risk: "high", writes: [...initial, f.testFile], reads: [], verification }],
  });
  f.put(f.testFile, "require('node:assert/strict').equal(require('node:fs').existsSync('future.cjs'), true);");
  const added = Array.from({ length: 20 }, (_, index) => `added-${index}.cjs`);
  const implementations = ["future.cjs", ...added];
  implementations.forEach(file => f.put(file, "module.exports = true;"));
  f.call("Dev", "yieldForSchedule", { taskId, reason: "stop to record expanded scope" });
  f.call("Lead", "reviseSchedule", { taskId, writes: [...initial, ...added, f.testFile], ownedDirty: added,
    reason: "approve the remaining implementation files" });
  const issueRed = (async = false) => f.call("Dev", "check", { taskId, checkId: "red", async });
  const finish = async ({ jobId }) => {
    for (let i = 0; i < 100; i++) {
      const job = f.store.read().checkJobs.find(item => item.id === jobId);
      if (job.finishedAt) return job;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("red did not finish");
  };
  assert.throws(issueRed, /红阶段必须在实现文件未变化时运行/);
  assert.equal((await finish(issueRed(true))).state, "stale");
  implementations.forEach(file => unlinkSync(path.join(f.root, file)));
  const refresh = () => {
    f.call("Dev", "yieldForSchedule", { taskId, reason: "核对扩容后的基线" });
    return f.call("Lead", "reviseSchedule", { taskId, refreshBaseline: true, pruneOutside: true, ownedDirty: [f.testFile, ...added],
      expectedHead: original.baseline.head, reason: "按冻结的新范围重算红基线" });
  };
  const first = refresh();
  assert.equal(first.redBaselineRealigned, true);
  assert.equal(refresh().newSources, first.newSources);
  const expanded = f.store.read().tasks.find(task => task.id === taskId);
  assert.equal(expanded.writes.length, 30);
  assert.equal(Object.keys(expanded.redBaseline.sourceFiles).every(file => expanded.writes.includes(file)), true);
  assert.equal((expanded.redBaseline ?? expanded.baseline).sources, implementationFingerprint(f.root, expanded).sources);
  const red = await finish(issueRed());
  assert.equal(red.state, "passed", red.error);
});

test("T-C2 an ownedDirty successor references the original genuine derived red through acceptance", async t => {
  const testFile = "e2e/new-case.cjs";
  const code = "implementation.cjs";
  const checks = ["green", "full", "independent"].map(stage => ({
    id: stage, stage, covers: ["AC1"], inputs: stage === "independent" ? [code] : [code, testFile],
    argv: stage === "independent" ? ["node", "-e", "require('node:assert/strict').equal(require('./implementation.cjs'),'new')"] : ["node", testFile],
    ...(stage === "green" && { deriveRed: true, redExpectedOutput: "AssertionError" }),
  }));
  const f = await fixture(t, "AssertionError", { risk: "medium", checks });
  const original = f.store.read().tasks[0];
  f.put(testFile, "require('node:assert/strict').equal(require('../implementation.cjs'),'new');");
  const red = await f.run("green-red");
  assert.equal(red.state, "passed");
  assert.equal(red.receipt.exitCode, 1);
  assert.equal(red.receipt.failureOutputSeen, true);
  f.put(code, "module.exports='new';");
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "移交已有实现" });
  const abandoned = f.call("Lead", "abandonTask", { taskId: f.taskId, reason: "保留历史并沿同契约承接" });
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", {
    requirementId: original.requirementId, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "HANDOFF", developerId: original.developerId, title: "承接实现", description: "验证已存在的实现",
      risk: "medium", writes: original.writes, reads: [], ownedDirty: abandoned.handoff.ownedDirty, upstreamRedTaskId: original.id,
      verification: { testWrites: [testFile], checks, acceptance: original.verification.acceptance } }],
  });
  const referenced = f.call("Dev", "check", { taskId, checkId: "green-red" });
  assert.equal(referenced.redNotApplicable, true);
  assert.equal(referenced.jobId, red.id);
  assert.equal(f.store.read().checkJobs.some(job => job.taskId === taskId && job.check.stage === "red"), false);
  const output = readFileSync(red.output);
  writeFileSync(red.output, "broken upstream proof");
  assert.throws(() => f.call("Dev", "check", { taskId, checkId: "green" }), /预期失败检查/);
  writeFileSync(red.output, output);
  for (const checkId of ["green", "full"]) assert.equal((await f.run(checkId, false, "Dev", taskId)).state, "passed");
  const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
    .map(key => [key, { state: "pass", evidence: "真实程序核对", checkIds: ["full"] }]));
  const report = f.call("Dev", "report", { taskId, summary: "承接交付", dimensions });
  assert.equal(report.redNotApplicable[0].jobId, red.id);
  assert.equal((await f.run("independent", false, "Lead", taskId)).state, "passed");
  f.call("Lead", "summarize", { taskId, instructions: "验证承接实现", decision: { candidate: report.candidate, limits: "无",
    acceptance: [{ id: "AC1", evidence: "通过", checkIds: ["full"] }] } });
  assert.equal(f.call("ui", "accept", { taskId, evidence: "试用成功" }).state, "accepted");
});

test("an assigned ticket can prune outside evidence and a stopped ticket can combine prune with refresh", async t => {
  const f = await fixture(t);
  const prune = (options = {}) => f.call("Lead", "reviseSchedule", {
    taskId: f.taskId, pruneOutside: true, reason: "no stale paths in fixture", ...options,
  });
  assert.deepEqual(prune().prunedOutside, []);
  assert.match(prune().pruneOutsideReason, /没有可证明/);
  assert.equal(f.store.read().tasks[0].state, "assigned");
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "stop for refresh" });
  assert.deepEqual(prune({ refreshBaseline: true }).prunedOutside, []);
});

test("T-C6 rebind moves an equivalent red snapshot to the new commit and keeps genuine red", async t => {
  const f = await fixture(t);
  const old = f.store.read().tasks[0].baseline;
  f.put(f.testFile, "require('node:assert/strict').equal(1, 2);");
  f.git("add", "--", f.testFile);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "adopt test only");
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "停止以核对提前提交" });
  const drift = f.call("Lead", "describeDrift", { taskId: f.taskId });
  const {rebind} = f.call("Lead", "rebindCommittedWork", { taskId: f.taskId, expectedBase: old.head, expectedHead: drift.to,
    confirmPaths: [f.testFile], reason: "只提交已确认的测试文件" });
  assert.equal(rebind.redBaselineRebound, true);
  assert.equal(rebind.redBaselineHead, drift.to);
  assert.equal(f.store.read().tasks[0].redBaseline.sources, old.sources);
  assert.equal((await f.run("red")).receipt.failureOutputSeen, true);
});

test("unproven original red basis requires an explicit current HEAD and a real red failure", async t => {
  const f = await fixture(t);
  const { writes, baseline } = f.store.read().tasks[0];
  f.store.change(s => { s.tasks[0].baseline.sources = "0".repeat(64); });
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "stop to review missing red provenance" });
  const expand = f.call("Lead", "reviseSchedule", { taskId: f.taskId, writes: [...writes, "more.cjs"], reason: "expand verified scope" });
  assert.equal(expand.redBaselinePending, true);
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "red" }), /NEW-TEST.*red.*scheduleVersion=1.*diagnoseTask/);
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.deepEqual(diagnosis.actionRequired.requiredParameters, ["redBaselineHead", "reason"]);
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "stop for explicit red snapshot" });
  f.put("implementation.cjs", "module.exports = 'owned changes';");
  const refresh = redBaselineHead => f.call("Lead", "reviseSchedule", { taskId: f.taskId, reason: "confirm current clean implementation",
    refreshBaseline: true, expectedHead: baseline.head, redBaselineHead, ownedDirty: ["implementation.cjs"] });
  assert.throws(() => refresh("0".repeat(40)), /redBaselineHead/);
  assert.equal(refresh(baseline.head).redBaselineRealigned, true);
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "red" }), /红阶段必须在实现文件未变化时运行/);
  f.put("implementation.cjs", "module.exports = 'old';");
  f.put(f.testFile, "require('node:assert/strict').equal(1, 2);");
  assert.equal((await f.run("red")).state, "passed");
});

test("the original developer can revise checks after explicit controller approval", async t => {
  const f = await fixture(t);
  const original = f.store.read().tasks[0];
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');");
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  f.put("implementation.cjs", "module.exports = 'new';");
  assert.equal((await f.run("green")).state, "passed");
  const checks = original.verification.checks.map(check => {
    const { expectedOutput, ...recipe } = check;
    return { ...recipe, ...(expectedOutput && { expectedOutput }), ...(check.id === "full" && { timeoutMs: check.timeoutMs + 1000 }) };
  });
  const revise = () => f.call("Dev", "registerChecks", {
    taskId: f.taskId, checks, replace: true, reason: "increase the measured full-check time budget",
  });
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "stop for recipe approval" });
  assert.throws(revise, /主控明确授权/);
  f.call("Lead", "reviseSchedule", { taskId: f.taskId, allowCheckRevision: true, reason: "approve updated budget" });
  assert.equal(revise().nextAction.command, "reviseSchedule");
  const revised = f.store.read().tasks[0];
  assert.deepEqual(revised.verification.acceptance, original.verification.acceptance);
  assert.equal(revised.revision, original.revision + 1);
  assert.equal(revised.scheduleHistory.at(-1).previous.verification.checks.find(check => check.id === "full").timeoutMs,
    original.verification.checks.find(check => check.id === "full").timeoutMs);
  assert.deepEqual(revised.scheduleHistory.at(-1).invalidatedChecks, ["full"]);
  assert.equal(f.wf.validCheck(f.store.read(), revised, revised.verification.checks.find(check => check.id === "red")).id, red.id);
  assert.throws(revise, /主控明确授权/);
});
