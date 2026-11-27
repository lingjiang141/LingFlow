import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";

const assertion = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";
const commit = f => f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture change");
const task = (f, taskId = f.taskId) => f.store.read().tasks.find(item => item.id === taskId);
const diagnose = (f, taskId = f.taskId) => f.call("Lead", "diagnoseTask", { taskId });
const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
  .map(axis => [axis, { state: "pass", evidence: "核对原条款", checkIds: ["full"] }]));
async function deliver(f, testSource = assertion) {
  f.put(f.testFile, testSource);
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports = 'new';");
  for (const check of ["green", "full"]) assert.equal((await f.run(check)).state, "passed");
  return f.call("Dev", "report", { taskId: f.taskId, summary: "提交候选", dimensions });
}

test("a superseding ticket with an explicit red uses the predecessor's original implementation", async t => {
  const f = await fixture(t, "AssertionError", { existingTest: assertion });
  const old = task(f);
  assert.equal((await f.run("red")).state, "passed");
  f.call("Dev", "yieldForSchedule", { taskId: old.id, reason: "停止原票" });
  f.put("implementation.cjs", "module.exports = 'new';");
  const verification = structuredClone(old.verification);
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  const plan = f.call("Lead", "dispatchPlan", {
    requirementId: old.requirementId, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "SUCCESSOR", developerId: old.developerId, title: "后继票", description: "原实现归属已核对",
      risk: "high", riskReason: "实际门禁", reads: [], writes: old.writes, ownedDirty: ["implementation.cjs"], verification }],
  });
  const nextId = plan.tasks[0].taskId;
  f.call("Lead", "supersede", { taskId: old.id, supersededBy: nextId, reason: "承接在途实现" });
  assert.equal(task(f, nextId).state, "assigned");
  assert.equal(task(f, nextId).redBaseline?.sources, old.baseline.sources);
  assert.ok(f.store.read().notices.some(note => note.taskId === nextId && note.summary.includes(old.baseline.head)));
  f.put("implementation.cjs", "module.exports = 'old';");
  assert.equal((await f.run("red", false, "Dev", nextId)).state, "passed");
});

test("red exit zero on inherited edits requires the controller to select the red commit", async t => {
  const f = await fixture(t, "AssertionError", { existingTest: assertion,
    ownedDirty: { "implementation.cjs": "module.exports = 'new';" } });
  const red = await f.run("red");
  assert.equal(red.receipt.exitCode, 0);
  assert.match(red.error, /退出码 0.*取红/);
  assert.equal(red.nextAction?.command, "diagnoseTask");
  const before = task(f);
  const finding = diagnose(f);
  assert.equal(finding.classification, "red-exit-zero");
  assert.deepEqual(finding.reference, { command: "checkEvidence", args: { jobId: red.id } });
  const action = finding.actionRequired;
  assert.deepEqual(action.requiredParameters, ["redBaselineHead", "reason"]);
  assert.equal(action.args.redBaselineHead, undefined);
  assert.equal(f.call("Lead", action.command, { ...action.args, redBaselineHead: before.baseline.head,
    reason: "已核对准入提交仅包含原行为" }).state, "applied");
  assert.equal(task(f).state, "assigned");
  assert.deepEqual(task(f).baseline, before.baseline);
  f.put("implementation.cjs", "module.exports = 'old';");
  assert.equal((await f.run("red")).state, "passed");
});

test("repair on a waiting verification ticket retains the real delivered candidate and passed checks", async t => {
  const f = await fixture(t, "AssertionError", { risk: "medium" });
  const report = await deliver(f);
  const before = task(f);
  assert.equal(before.state, "waiting_verification");
  f.store.change(s => { s.tasks[0].redBaselinePending = true; });
  const checks = f.store.read().checkJobs;
  const finding = diagnose(f);
  assert.equal(finding.nextAction?.args.realignRedBaseline, true, finding.reason);
  const repair = f.call("Lead", finding.nextAction.command, finding.nextAction.args);
  assert.equal(repair.state, "applied");
  assert.deepEqual(repair.rerunRed, []);
  assert.deepEqual(f.store.read().checkJobs, checks);
  const after = task(f);
  for (const field of ["baseline", "verification", "revision", "scheduleVersion", "state", "candidate", "reports"])
    assert.deepEqual(after[field], before[field], field);
  assert.equal((await f.run("independent", false, "Lead")).state, "passed");
  assert.equal(task(f).candidate, report.candidate);
  assert.equal(task(f).state, "ready");
});

test("red separates assertion marker mismatches from broken probes and missing dependencies", async t => {
  const f = await fixture(t, "target assertion marker");
  f.put(f.testFile, assertion);
  const mismatch = await f.run("red");
  assert.equal(mismatch.redFailureReason, "marker-mismatch");
  assert.match(mismatch.error, /未命中冻结失败标记/);
  f.put(f.testFile, "undefinedVariable();");
  const broken = await f.run("red");
  assert.equal(broken.redFailureReason, "assertion-unverified");
  assert.doesNotMatch(broken.error, /修订原票检查/);
  f.put(f.testFile, "require('./missing-fixture.cjs');");
  const environment = await f.run("red");
  assert.equal(environment.classification, "environment-failed");
  assert.equal(environment.environmentFailureReason, "module-missing-before-tests");
});

test("diagnose and confirm agree with a CRLF candidate and an LF Git blob", async t => {
  const f = await fixture(t, "AssertionError", { risk: "medium" });
  f.git("config", "core.autocrlf", "true");
  const report = await deliver(f, assertion + "\r\n");
  f.git("add", "implementation.cjs", f.testFile);
  commit(f);
  assert.equal(execFileSync("git", ["show", "HEAD:" + f.testFile], { cwd: f.root, encoding: "utf8" }), assertion + "\n");
  const finding = diagnose(f);
  assert.equal(finding.nextAction?.command, "confirmCommit", finding.reason);
  const receipt = f.call("Lead", finding.nextAction.command, finding.nextAction.args);
  assert.equal(receipt.state, "applied");
  assert.equal(receipt.preservedChecks.length, 3);
  assert.equal(task(f).candidate, report.candidate);
  f.put(f.testFile, assertion + "\n");
  assert.equal(diagnose(f).contentDrift, true, "the original raw test bytes still pin the delivery");
  assert.notEqual(diagnose(f).nextAction?.command, "confirmCommit");
});

test("an assigned ticket can reconcile a peer's exact version outside frozen inputs", async t => {
  const f = await fixture(t);
  const file = "peer.cjs";
  f.put(file, "peer work\r\n");
  f.store.change(s => {
    s.tasks[0].baseline.other = [[file, "older baseline"]];
    s.tasks.push({ ...s.tasks[0], id: "peer", ticketKey: "PEER", state: "rework", writes: [file], ownedDirty: [file] });
  });
  const finding = diagnose(f);
  assert.equal(finding.nextAction?.args.confirmByOwnership?.[file]?.taskId, "peer");
  const queued = f.call("Dev", "check", { taskId: f.taskId, checkId: "red", async: true });
  const waiting = diagnose(f);
  assert.equal(waiting.nextAction.command, "checkStatus");
  assert.equal(waiting.outsideOwnership.canConfirmNow, false);
  assert.throws(() => f.call("Lead", finding.nextAction.command, finding.nextAction.args), /无在途检查/);
  assert.equal(f.wf.claimCheck(queued.jobId), null);
  const { confirmByOwnership, ...args } = finding.nextAction.args;
  const strict = { ...args, confirmForeignDirty: { [file]: { ...confirmByOwnership[file], sha256: finding.outsideOwnership.sha256 } } };
  assert.equal(f.call("Lead", "confirmForeignDirty", strict).state, "stored");
  f.put(file, "peer work\n");
  assert.throws(() => f.call("Lead", "confirmForeignDirty", strict), /文件已变化/);
  assert.equal(diagnose(f).outsideOwnership.file, file);
});

test("plan inspection exposes both frozen text and the active ticket's source status", async t => {
  const f = await fixture(t);
  const { id: taskId, planId } = task(f);
  const inspect = () => f.call("Lead", "inspectPlan", { planId, document: "tickets.md", taskId });
  const original = inspect();
  f.put("tickets.md", "更新票面记录");
  const finding = diagnose(f);
  assert.equal(finding.nextAction?.args.refreshSourceDigest, true);
  assert.equal(f.call("Lead", finding.nextAction.command, finding.nextAction.args).state, "applied");
  assert.equal(inspect().ticketSource.status, "unchanged");
  f.put("tickets.md", original.restoreText ?? original.text);
  const restored = inspect();
  assert.equal(restored.diff.status, "unchanged");
  assert.equal(restored.ticketSource.status, "changed");
  assert.equal(restored.ticketSource.liveDigest, original.digest);
  assert.notEqual(restored.ticketSource.expectedDigest, original.digest);
  const reconcile = diagnose(f).nextAction;
  assert.equal(reconcile.args.expectedSourceDigest, original.digest);
  assert.equal(f.call("Lead", reconcile.command, reconcile.args).state, "applied");
  assert.equal(inspect().ticketSource.status, "unchanged");
});
