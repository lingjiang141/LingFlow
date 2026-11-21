import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { baselineDrift, gitState, recordedBaselineChanges, readGit } from "../src/quality.mjs";
import { sourceFileFingerprint } from "../src/source-edit.mjs";
import { exactConfirmations } from "../src/workflow.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

const file = "r403.md";
const implementation = "implementation.cjs";
const original = "# 票 R4-03：选择人员\n\nAC1: new behavior\n";
const commit = (f, ...files) => {
  f.git("add", "--", ...files);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "record ticket and work");
};

async function setup(t, { frozen = original, tracked = false, autocrlf = false } = {}) {
  const f = await fixture(t, "AssertionError", { initialFiles: tracked ? { [file]: original } : {} });
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "停止前一张测试票" });
  f.call("Lead", "releaseSchedule", { taskId: f.taskId, reason: "保留前一张测试票记录" });
  f.git("config", "core.autocrlf", String(autocrlf));
  f.put(file, frozen);
  const state = f.store.read();
  const predecessor = state.tasks[0];
  // Use the public dispatch path to freeze ticket:0 and the admitted source digest.
  const verification = structuredClone(predecessor.verification);
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  const dispatched = f.call("Lead", "dispatchPlan", {
    requirementId: predecessor.requirementId,
    sources: { spec: "spec.md", tickets: [file], attempts: "attempts.md" },
    tickets: [{ key: "R4-03", developerId: predecessor.developerId, title: "选择人员", description: "已批准的行为",
      risk: "high", riskReason: "冻结票面和检查", writes: [implementation, f.testFile], reads: [], verification }],
  });
  const taskId = dispatched.tasks[0].taskId;
  const task = () => f.store.read().tasks.find(item => item.id === taskId);
  assert.equal(task().state, "assigned");
  f.call("Dev", "yieldForSchedule", { taskId, reason: "停写以核对 Git 基线" });
  const plan = f.store.read().plans.find(item => item.id === task().planId);
  assert.equal(plan.documents["ticket:0"].digest, task().sources.tickets.digest);
  assert.equal(plan.documents.tickets, undefined);
  const inspectRecords = (ticket = task(), frozenPlan = plan) => {
    const git = gitState(f.root, ticket);
    const drift = baselineDrift(f.root, ticket, git, ticket.writes);
    return recordedBaselineChanges(f.root, ticket, frozenPlan, git, drift);
  };
  return { ...f, taskId, task, plan, inspectRecords };
}

test("a newly committed unchanged multi-file ticket can rebind its committed implementation", async t => {
  const f = await setup(t);
  const before = f.task();
  f.put(implementation, "module.exports = 'new';");
  commit(f, file, implementation);
  const [record] = f.inspectRecords();
  const digest = before.sources.tickets.digest;
  assert.equal(record.proven, true);
  assert.equal(record.unchangedProof, "exact");
  assert.equal(record.fromDigest, digest);
  assert.equal(record.toDigest, digest);
  const diagnosed = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosed.nextAction?.command, "rebindCommittedWork", diagnosed.reason);
  const { args } = diagnosed.nextAction;
  assert.deepEqual(args.confirmPaths, [implementation]);
  assert.deepEqual(args.confirmRecordedBaseline, { [file]: digest });
  assert.throws(() => f.call("Lead", "rebindCommittedWork", { ...args, confirmRecordedBaseline: { [file]: null } }), /confirmRecordedBaseline/);
  const result = f.call("Lead", "rebindCommittedWork", args);
  assert.deepEqual(result.rebind.recordedBaseline, [record]);
  assert.equal(f.task().baseline.head, args.expectedHead);
  assert.deepEqual(f.task().sources, before.sources);
  assert.deepEqual(f.task().verification, before.verification);
});

test("a changed ticket and a dirty worktree cannot use the unchanged-source proof", async t => {
  const f = await setup(t);
  const changed = original.replace("new behavior", "new behaviouR");
  f.put(file, changed);
  commit(f, file);
  assert.equal(f.inspectRecords()[0].proven, false);
  const review = f.call("Lead", "diagnoseTask", { taskId: f.taskId }).nextAction;
  assert.equal(review.args.refreshSourceDigest, true);
  f.call("Lead", review.command, review.args);
  const args = { taskId: f.taskId, expectedBase: f.task().baseline.head, expectedHead: gitState(f.root).head,
    confirmPaths: [], confirmRecordedBaseline: { [file]: sourceFileFingerprint(file, Buffer.from(changed)) }, reason: "核对票面" };
  assert.throws(() => f.call("Lead", "rebindCommittedWork", args), /无法证明已入库规划记录/);
  const blocked = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(blocked.classification, "baseline-drift-blocked");
  assert.equal(blocked.nextAction, null, "diagnosis must not auto-release or auto-dispatch");
  assert.deepEqual(blocked.scopeRemedies.map(item => [item.command, item.requiredParameters]),
    [["supersede", ["supersededBy", "reason"]], ["releaseSchedule", ["reason"]]]);
  f.store.change(s => { Object.assign(s.tasks.find(task => task.id === f.taskId), { state: "trial", assignee: null }); });
  const trial = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(trial.classification, "baseline-drift-blocked");
  assert.equal(trial.actionRequired.command, "supersede");
  assert.equal(trial.nextAction, null);

  f.store.change(s => { s.tasks.find(task => task.id === f.taskId).state = "paused"; });
  f.put(file, original);
  commit(f, file);
  f.put(file, changed);
  assert.equal(f.inspectRecords()[0].proven, false);
});

test("multi-file append proof uses frozen text identified by path and digest", async t => {
  const frozen = original + "\n## 实施记录\n准入时记录。\n";
  const f = await setup(t, { frozen, tracked: true });
  f.put(file, frozen + "\n## 实施记录\n提交时追加。\n");
  commit(f, file);
  const [record] = f.inspectRecords();
  assert.equal(record.proven, true);
  assert.equal(record.firstAppendedHeading, "## 实施记录");
  assert.equal(record.unchangedProof, undefined);
  unlinkSync(path.join(f.root, file));
  commit(f, file);
  assert.throws(() => f.inspectRecords(), error =>
    error.verificationCode === "contract-invalid" && error.message.includes("当前提交缺少已冻结的规划来源"));
});

test("only normalize mode can prove a CRLF frozen ticket from its LF blob", async t => {
  const f = await setup(t, { frozen: original.replaceAll("\n", "\r\n"), autocrlf: true });
  commit(f, file);
  const ticket = f.task();
  const git = gitState(f.root, ticket);
  const [record] = f.inspectRecords();
  const blob = readGit(f.root, ["show", git.head + ":" + file], "buffer");
  assert.equal(blob.toString(), original);
  assert.equal(record.proven, true);
  assert.equal(record.unchangedProof, "eol");
  assert.equal(record.toDigest, sourceFileFingerprint(file, blob));
  assert.notEqual(record.toDigest, record.fromDigest);
  assert.equal(f.inspectRecords({ ...ticket, baseline: { ...ticket.baseline, fingerprintEol: "raw" } })[0].proven, false);
  assert.equal(f.inspectRecords(ticket, { documents: {} })[0].proven, false);
  const invalidAdmission = { ...ticket, baseline: { ...ticket.baseline, recordedDirtySources: { [file]: "0".repeat(64) } } };
  assert.equal(f.inspectRecords(invalidAdmission)[0].proven, false);
  assert.equal(f.inspectRecords({ ...ticket, reads: [file] })[0].proven, false);
  const diagnosed = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosed.nextAction?.command, "rebindCommittedWork", diagnosed.reason);
  assert.equal(diagnosed.nextAction.args.confirmRecordedBaseline[file], record.toDigest);
  assert.equal(f.call("Lead", "rebindCommittedWork", diagnosed.nextAction.args).state, "applied");
});

test("an empty or malformed digest is never a valid confirmation even if both maps agree", () => {
  for (const digest of [undefined, null, "", "g".repeat(64), "a".repeat(63)])
    assert.equal(exactConfirmations({ [file]: digest }, { [file]: digest }), false);
  const valid = { [file]: "a".repeat(64) };
  assert.equal(exactConfirmations(valid, valid), true);
});
