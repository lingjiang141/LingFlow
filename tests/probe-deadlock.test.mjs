import test from "node:test";
import assert from "node:assert/strict";
import { fixture, reviewedRisk } from "./helpers/evidence-fixture.mjs";

const probe = {
  id: "config", stage: "independent", inputs: ["vitest.config.ts"], covers: ["AC1"], expectedOutput: "ok",
  argv: ["node", "-e", "const c=require('fs').readFileSync('vitest.config.ts','utf8'); if (!c.includes('30000')) process.exit(1); console.log('ok');"],
};
const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
  .map(key => [key, { state: "pass", evidence: "Verified candidate", checkIds: ["full"] }]));

async function delivered(t, independent = probe, risk = "medium") {
  const checks = ["red", "green", "full"].map(stage => ({
    id: stage, stage, argv: ["node", "e2e/new-case.cjs"], inputs: ["e2e/new-case.cjs", "implementation.cjs"],
    covers: ["AC1"], ...(stage === "red" && { expectedOutput: "AssertionError" }),
  }));
  const f = await fixture(t, "AssertionError", {
    risk, checks: [...checks, independent], initialFiles: { "vitest.config.ts": "testTimeout: 30000" },
  });
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'),'new');");
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports='new';");
  for (const stage of ["green", "full"]) assert.equal((await f.run(stage)).state, "passed");
  f.call("Dev", "report", { taskId: f.taskId, summary: "Verified candidate", dimensions });
  assert.equal(f.store.read().tasks[0].state, risk === "high" ? "reviewing" : "waiting_verification");
  return f;
}

function heartbeat(f, override = {}) {
  const now = Date.now();
  f.wf.heartbeat(f.roles.map(role => ({
    id: role.name, state: "idle", pending: 0, jobs: 0,
    ...(role.name === "Dev" && {
      telemetry: { turn: { id: "delivery", startedAt: now - 2000, endedAt: now, outcome: "ended" } }, ...override,
    }),
  })), now);
}

test("a frozen inline config probe completes the actual delivery", async t => {
  const f = await delivered(t);
  const job = await f.run(probe.id, false, "Lead");
  assert.equal(job.receipt.exitCode, 0);
  assert.equal(job.receipt.expectedOutputSeen, true);
  assert.equal(job.receipt.evidenceKind, "probe");
  assert.equal(job.receipt.caseReadback, "not-applicable");
  assert.equal(job.state, "passed");
  assert.equal(f.store.read().tasks[0].state, "ready");
});

test("a bad frozen probe is corrected on the same candidate and only that probe is rerun", async t => {
  const f = await delivered(t, { ...probe, argv: ["node", "-e", "process.exit(1)"] });
  const failed = await f.run(probe.id, false, "Lead");
  assert.equal(failed.state, "failed");
  const original = f.store.read().tasks[0];
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosis.reference?.args.jobId, failed.id);
  const repair = diagnosis.actionRequired;
  assert.equal(repair?.command, "reviseSchedule");
  const reviseLeadCheck = { ...repair.args.reviseLeadCheck, replacement: { argv: probe.argv } };
  const args = { ...repair.args, reason: "原断言引用了内部实现，已核对同一验收条款的实际输出", reviseLeadCheck };
  assert.throws(() => f.call("Dev", "reviseSchedule", args), /主控/);
  assert.throws(() => f.call("Lead", "reviseSchedule", { ...args, reviseLeadCheck: {
    ...reviseLeadCheck, replacement: { covers: [] },
  } }), /覆盖|covers/);
  assert.throws(() => f.call("Lead", "reviseSchedule", { ...args, reviseLeadCheck: {
    ...reviseLeadCheck, replacement: { argv: ["node", f.testFile] },
  } }), /复用开发检查/);
  assert.throws(() => f.call("Lead", "reviseSchedule", { ...args, reviseLeadCheck: {
    ...reviseLeadCheck, replacement: { inputs: ["outside.cjs"] },
  } }), /原票读写范围/);
  const queued = f.call("Lead", "check", { taskId: f.taskId, checkId: probe.id, async: true });
  assert.throws(() => f.call("Lead", "reviseSchedule", args), /在途检查/);
  f.store.change(state => { state.checkJobs.find(job => job.id === queued.jobId).state = "interrupted"; });
  const applied = f.call("Lead", "reviseSchedule", args, "replace-probe");
  assert.equal(applied.state, "stored");
  assert.deepEqual(f.call("Lead", "reviseSchedule", args, "replace-probe"), applied);
  assert.throws(() => f.call("Lead", "reviseSchedule", args), /配方.*变化/);
  assert.equal(applied.nextAction.command, "check");
  assert.equal((await f.run(probe.id, false, "Lead")).state, "passed");
  const state = f.store.read();
  const complete = state.tasks[0];
  assert.equal(complete.state, "ready");
  for (const field of ["candidate", "revision", "reports", "reviews", "dependencies"])
    assert.deepEqual(complete[field], original[field]);
  assert.deepEqual(complete.verification.checks.filter(check => check.id !== probe.id),
    original.verification.checks.filter(check => check.id !== probe.id));
  assert.equal(state.checkJobs.filter(job => job.check.stage !== "independent").length, 3);
  assert.equal(state.checkJobs.find(job => job.id === failed.id).state, "failed");
  assert.ok(state.checkJobs.find(job => job.id === failed.id).invalidated);
  assert.equal(complete.scheduleHistory.at(-1).leadCheckRevision.checkId, probe.id);
  assert.throws(() => f.call("Lead", "reviseSchedule", { ...args, reason: "尝试改动已完成验证的原票" }), /待主控检查/);
});

test("a probe-only objection stays on the original candidate and a passing review survives later probe repair", async t => {
  const f = await delivered(t, { ...probe, stage: "controller", argv: ["node", "-e", "process.exit(1)"] }, "high");
  const current = () => f.store.read().tasks[0];
  const candidate = current().candidate;
  const review = { taskId: f.taskId, candidate, dimensions, findings: "实现及三维证据通过，冻结探针断言了旧写法" };
  f.call("Review", "inbox");
  f.call("Review", "review", { ...review, verdict: "changes", classification: "contract-invalid" });
  const objection = current().reviews.at(-1);
  assert.throws(() => f.call("Review", "review", { ...review, verdict: "pass", recheckCandidate: true }), /独立审查者/);
  const repair = (argv) => {
    const next = f.call("Lead", "diagnoseTask", { taskId: f.taskId }).actionRequired;
    return f.call("Lead", next.command, { ...next.args, reason: "核对当前候选及原 AC 的行为",
      reviseLeadCheck: { ...next.args.reviseLeadCheck, replacement: { argv } } });
  };
  const amendment = repair(["node", "-e", "process.exit(2)"]);
  assert.equal(current().state, "changes_requested");
  assert.equal(amendment.nextAction.ownerId, objection.reviewerId);
  assert.equal(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).nextAction.args.recheckCandidate, true);
  assert.throws(() => f.call("Review", "review", { ...review, ...amendment.nextAction.args, verdict: "pass",
    leadCheckRevisionId: "stale" }), /修订记录已变化/);
  f.call("Review", "review", { ...review, ...amendment.nextAction.args, verdict: "pass",
    findings: "已核对修订与原候选，确认旧契约异议已处理", riskAssessment: reviewedRisk,
    testReview: "核对开发测试写入及完整回执" });
  assert.equal(current().state, "waiting_verification");
  assert.equal(current().reviews.at(-1).rechecksReviewId, objection.id);
  assert.equal((await f.run(probe.id, false, "Lead")).state, "failed");
  const approved = current();
  assert.equal(repair(probe.argv).nextAction.command, "check");
  assert.equal((await f.run(probe.id, false, "Lead")).state, "passed");
  assert.equal(current().state, "ready");
  assert.equal(current().candidate, candidate);
  assert.equal(current().revision, approved.revision);
  assert.deepEqual(current().reviews, approved.reviews);
  assert.deepEqual(current().reports, approved.reports);
});

test("a failed frozen probe can be superseded after delivery without a developer yield", async t => {
  const f = await delivered(t, { ...probe, argv: ["node", "-e", "process.exit(1)"] });
  assert.equal((await f.run(probe.id, false, "Lead")).state, "failed");
  const state = f.store.read();
  const original = state.tasks[0];
  const verification = structuredClone(original.verification);
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  verification.checks[3].argv = probe.argv;
  const { tasks: [next] } = f.call("Lead", "dispatchPlan", {
    requirementId: state.requirements[0].id, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "SUCCESSOR", developerId: original.developerId, title: "Successor", description: "Correct the frozen probe",
      risk: "medium", riskReason: "Same delivery", writes: original.writes, reads: original.reads, ownedDirty: original.writes, verification }],
  });
  assert.equal(next.state, "queued");
  assert.equal(next.scopeConflict.kind, "write/write");
  const args = { taskId: original.id, supersededBy: next.taskId, reason: "Frozen config probe exited before checking" };
  assert.throws(() => f.call("Lead", "supersede", args), /停写/);
  for (const busy of [{ state: "running" }, { pending: 1 }, { jobs: 1 }]) {
    heartbeat(f, busy);
    assert.throws(() => f.call("Lead", "supersede", args), /停写/);
  }
  heartbeat(f);
  const recovery = f.call("Lead", "diagnoseTask", { taskId: next.taskId });
  assert.equal(recovery.nextAction.command, "diagnoseTask");
  assert.equal(recovery.nextAction.args.supersedeConflict, original.id);
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: next.taskId, supersedeConflict: original.id });
  assert.equal(diagnosis.nextAction.command, "supersede");
  f.call("Lead", "insertSchedule", { taskId: next.taskId, after: [{ taskId: original.id, stage: "verified" }],
    reason: "Reproduce an explicit wait on the original ticket" });
  const result = f.call("Lead", "supersede", args);
  assert.equal(result.successor.runnable, true, JSON.stringify(result.successor));
  assert.deepEqual(f.store.read().tasks.find(task => task.id === next.taskId).dependencies, []);
  const retired = f.store.read().tasks[0];
  assert.equal(retired.state, "superseded");
  assert.equal(retired.supersession.reason, args.reason);
  assert.equal(retired.supersession.by, f.roles.find(role => role.name === "Lead").id);
  assert.equal(retired.supersession.stopProof.reportId, original.reports.at(-1).id);
  assert.deepEqual(retired.verification, original.verification);
  assert.deepEqual(retired.reports, original.reports);
  const events = f.call("Lead", "inspect", { taskId: original.id, section: "events", limit: 10 });
  const audit = events.items.find(event => event.kind === "supersede-task")?.scopeRelease;
  assert.equal(audit?.supersededBy, next.taskId);
  assert.equal(audit?.reason, args.reason);
  assert.equal(audit?.by, retired.supersession.by);
  assert.deepEqual(audit?.stopProof, retired.supersession.stopProof);
});

test("abandoning a delivered ticket requires a current report and stopped host, and records the proof", async t => {
  const f = await delivered(t);
  const args = { taskId: f.taskId, reason: "Frozen probe needs replacement" };
  const original = f.store.read().tasks[0];
  const endedBeforeReport = original.reports.at(-1).at - 1;
  heartbeat(f, { telemetry: { turn: {
    id: "older-turn", startedAt: endedBeforeReport - 2000, endedAt: endedBeforeReport, outcome: "ended",
  } } });
  assert.throws(() => f.call("Lead", "abandonTask", args), /停写/);
  heartbeat(f);
  f.store.change(state => { state.roles.find(role => role.name === "Dev").observation.compacting = true; });
  assert.throws(() => f.call("Lead", "abandonTask", args), /停写/);
  heartbeat(f);
  assert.throws(() => f.call("Lead", "releaseSchedule", args), /停写/);
  const unfinished = { id: "unfinished", taskId: f.taskId, state: "uncertain" };
  f.store.change(state => state.checkJobs.push(unfinished));
  assert.throws(() => f.call("Lead", "abandonTask", args), /检查|停写/);
  f.store.change(state => { state.checkJobs.pop(); });
  assert.throws(() => f.call("Dev", "abandonTask", args), /主控/);
  assert.equal(f.call("Lead", "abandonTask", args).state, "abandoned");
  assert.equal(f.store.read().tasks[0].abandonment.stopProof.reportId, original.reports.at(-1).id);
  const events = f.call("Lead", "inspect", { taskId: f.taskId, section: "events" });
  assert.equal(events.items.find(event => event.kind === "abandon-task")?.scopeRelease?.reason, args.reason);
});
