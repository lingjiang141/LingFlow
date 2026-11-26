import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";

const taskOf = f => f.store.read().tasks.find(task => task.id === f.taskId);
const risk = { id: "RISK-1", reason: "共享入口涉及权限", impact: "可能放行无权限用户", coveredBy: ["AC1"], verifiedBy: ["full"] };
const developerDimensions = Object.fromEntries(["requirements", "implementation", "system"].map(name =>
  [name, { state: "pass", evidence: "核对实现与候选回执", checkIds: ["full"] }]));
const controllerDimensions = Object.fromEntries(Object.entries(developerDimensions).map(([name, value]) =>
  [name, { ...value, note: "独立核对候选差异与接口断言，结果与开发报告一致" }]));

function plan(f, overrides = {}) {
  const task = taskOf(f);
  const verification = structuredClone(task.verification);
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  return { requirementId: task.requirementId, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "AUDIT", developerId: task.developerId, title: "核对权限", description: "审查共享入口",
      risk: "high", reads: [], writes: task.writes, verification, ...overrides }] };
}

test("new high-risk plans require auditable reasons and check-to-AC mappings", async t => {
  const f = await fixture(t);
  const missing = f.call("Lead", "previewPlan", plan(f));
  assert.equal(missing.state, "invalid");
  assert.equal(missing.verificationCode, "contract-invalid");
  assert.equal(missing.violations[0].path, "tickets[AUDIT].riskItems");
  assert.ok(Array.isArray(missing.violations[0].expected));
  assert.throws(() => f.call("Lead", "dispatchPlan", plan(f)), { verificationCode: "contract-invalid" });
  const mismatch = plan(f, { riskItems: [risk] });
  mismatch.tickets[0].verification.acceptance.push({ id: "AC2", text: "另一条验收" });
  mismatch.tickets[0].verification.checks.push({
    id: "other", stage: "full", argv: ["node", f.testFile], inputs: [f.testFile, "implementation.cjs"], covers: ["AC2"],
  });
  mismatch.tickets[0].riskItems = [{ ...risk, verifiedBy: ["other"] }];
  assert.match(f.call("Lead", "previewPlan", mismatch).violations[0].message, /未覆盖/);
  assert.deepEqual(f.call("Lead", "previewPlan", plan(f, { riskItems: [risk] })).tickets[0].riskItems, [risk]);
  const legacy = f.call("Lead", "previewPlan", plan(f, { riskReason: "待定位根因" }));
  assert.equal(legacy.state, "valid");
  assert.match(legacy.warnings.find(item => item.path.endsWith(".riskItems")).message, /自由文本/);
  assert.deepEqual(legacy.tickets[0].riskItems[0].verifiedBy, []);
});

async function delivered(t, options) {
  const f = await fixture(t, "AssertionError", options);
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');");
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports = 'new';");
  for (const stage of ["green", "full"]) assert.equal((await f.run(stage)).state, "passed");
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  f.call("Dev", "report", { taskId: f.taskId, summary: "实现已交付", dimensions: developerDimensions });
  return f;
}

const summary = f => ({ taskId: f.taskId, instructions: "试用新行为", decision: {
  candidate: taskOf(f).candidate, limits: "无", testReview: "检查了真实新增断言",
  acceptance: [{ id: "AC1", evidence: "核对候选及检查", checkIds: ["full"] }],
} });

test("high-risk pass and summary require the reviewer and controller to address frozen risks", async t => {
  const f = await delivered(t, { riskItems: [risk] });
  f.call("Review", "inbox");
  const args = { taskId: f.taskId, candidate: taskOf(f).candidate, verdict: "pass", findings: "审查候选",
    testReview: "核对了新增权限断言", dimensions: developerDimensions };
  assert.throws(() => f.call("Review", "review", args), /逐条.*riskItems/);
  const assessment = { id: risk.id, verdict: "covered", evidence: "全量检查覆盖共享入口权限", checkIds: ["full"] };
  assert.throws(() => f.call("Review", "review", { ...args, riskAssessment: [{ ...assessment, verdict: "unverifiable" }] }), /changes/);
  assert.throws(() => f.call("Review", "review", { ...args, riskAssessment: [{ ...assessment, checkIds: ["unknown"] }] }), /已通过检查/);
  assert.equal(f.call("Review", "review", { ...args, riskAssessment: [assessment] }).state, "stored");
  const evidence = f.call("Lead", "deliveryEvidence", { taskId: f.taskId });
  assert.equal(evidence.independentReview.riskItems[0].id, evidence.independentReview.riskAssessment[0].id);
  const trial = summary(f);
  assert.throws(() => f.call("Lead", "summarize", trial), /riskNote/);
  trial.decision.riskNote = "核对 RISK-1 的独立审查结论及权限断言";
  assert.equal(f.call("Lead", "summarize", trial).state, "awaiting_user");
  assert.equal(taskOf(f).controllerEvidence.riskNote, trial.decision.riskNote);
});

test("non-high-risk summary independently compares the current developer report", async t => {
  const f = await delivered(t, { risk: "medium" });
  assert.equal((await f.run("independent", false, "Lead")).state, "passed");
  const args = summary(f);
  assert.throws(() => f.call("Lead", "summarize", args), /主控需核对开发提交的三维/);
  const issues = { ...controllerDimensions, system: { ...controllerDimensions.system, state: "issues" } };
  assert.throws(() => f.call("Lead", "summarize", { ...args, decision: { ...args.decision, dimensions: issues } }),
    error => error.verificationCode === "evidence-missing" && error.nextAction?.command === "rework");
  const report = taskOf(f).reports.at(-1);
  args.decision.dimensions = controllerDimensions;
  assert.equal(f.call("Lead", "summarize", args).state, "awaiting_user");
  assert.equal(taskOf(f).controllerEvidence.dimensions.system.note, controllerDimensions.system.note);
  assert.deepEqual(taskOf(f).reports.at(-1), report);
});

test("an unversioned high-risk ticket with a null reason can finish under its original contract", async t => {
  const f = await delivered(t);
  f.store.change(s => {
    const task = s.tasks.find(task => task.id === f.taskId);
    task.riskItems = null;
    task.riskReason = null;
    delete task.riskContractVersion;
  });
  f.call("Review", "inbox");
  const args = { taskId: f.taskId, candidate: taskOf(f).candidate, verdict: "pass", findings: "按原票审查",
    testReview: "核对断言覆盖", dimensions: developerDimensions };
  assert.equal(f.call("Review", "review", args).state, "stored");
  assert.equal(f.call("Lead", "summarize", summary(f)).state, "awaiting_user");
  const before = taskOf(f);
  assert.equal(f.call("ui", "accept", { taskId: f.taskId, evidence: "试用通过" }).state, "accepted");
  assert.deepEqual(taskOf(f).reviews, before.reviews);
  assert.deepEqual(taskOf(f).reports, before.reports);
});
