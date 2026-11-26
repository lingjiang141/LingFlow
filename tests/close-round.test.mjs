import assert from "node:assert/strict";
import test from "node:test";
import { fixture, reviewedDimensions } from "./helpers/evidence-fixture.mjs";

const evidence = "用户已实测本轮完整流程";
const reason = "后继票修改了同一个实现文件";
const implementation = "implementation.cjs";
const task = (f, id = f.taskId) => f.store.read().tasks.find(item => item.id === id);

async function trial(t) {
  const f = await fixture(t, "AssertionError", { risk: "medium" });
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');");
  assert.equal((await f.run("red")).state, "passed");
  f.put(implementation, "module.exports = 'new';");
  for (const name of ["green", "full"]) assert.equal((await f.run(name)).state, "passed");
  const dimensions = Object.fromEntries(["requirements", "implementation", "system"].map(name =>
    [name, { state: "pass", evidence: "已核对冻结验收条款与实际结果", checkIds: ["full"] }]));
  f.call("Dev", "report", { taskId: f.taskId, summary: "已验证", dimensions });
  assert.equal((await f.run("independent", false, "Lead")).state, "passed");
  const result = f.call("Lead", "summarize", { taskId: f.taskId, instructions: "试用整轮行为", decision: {
    candidate: task(f).candidate, limits: "测试环境", dimensions: reviewedDimensions("independent"),
    acceptance: [{ id: "AC1", evidence: "已核对", checkIds: ["independent"] }],
  } });
  assert.equal(result.state, "awaiting_user");
  return f;
}

function secondTrial(f) {
  const requirement = f.call("Lead", "approve", { text: "核对说明", source: "用户确认" });
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  const { taskId } = f.call("Lead", "dispatch", { requirementId: requirement.id,
    developerId: f.roles.find(role => role.kind === "developer").id, title: "核对说明", description: "确认规格",
    readOnly: true, writes: [], reads: ["spec.md"], risk: "low" });
  assert.equal(task(f, taskId).state, "assigned");
  const dimensions = Object.fromEntries(["requirements", "implementation", "system"].map(name =>
    [name, { state: "pass", evidence: "已核对规格，确认无写入" }]));
  f.call("Dev", "report", { taskId, summary: "已核对规格", dimensions,
    checks: [{ command: "read spec.md", exitCode: 0, evidence: "核对规格版本" }] });
  f.call("Lead", "summarize", { taskId, instructions: "查看核对结论" });
  assert.equal(task(f, taskId).state, "trial");
  return taskId;
}

test("closeRound uses normal acceptance for an unchanged delivery", async t => {
  const f = await trial(t);
  const before = task(f);
  const receipt = f.call("ui", "closeRound", { evidence, reason, planId: before.planId });
  assert.equal(receipt.state, "accepted");
  assert.deepEqual(task(f).acceptance, { evidence, acceptedBy: "ui", candidate: before.candidate, at: receipt.at });
  assert.deepEqual(task(f).baseline, before.baseline);
  assert.equal(receipt.accepted[0].candidateAtClose, before.candidate);
});

test("closeRound confirms a replaced uncommitted delivery and replays the same receipt", async t => {
  const f = await trial(t);
  const second = secondTrial(f);
  const before = task(f);
  f.put(implementation, "module.exports = 'later';");
  assert.throws(() => f.call("Lead", "accept", { taskId: f.taskId, evidence }), /候选/);
  const args = { evidence, reason, confirmDrift: true };
  const receipt = f.call("Lead", "closeRound", args, "close-round-retry");
  assert.equal(receipt.state, "accepted");
  assert.deepEqual(receipt.accepted.map(row => row.taskId), [f.taskId, second]);
  assert.deepEqual(f.call("Lead", "closeRound", args, "close-round-retry"), receipt);
  assert.deepEqual(task(f).acceptance, {
    evidence, acceptedBy: receipt.acceptedBy, candidate: before.candidate, at: receipt.at,
    candidateAtClose: f.wf.hash(f.store.read(), before), driftAccepted: true, driftReason: reason,
  });
  assert.notEqual(task(f).acceptance.candidateAtClose, before.candidate);
  assert.deepEqual(task(f).baseline, before.baseline);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'task.accepted'").get().n, 2);
});

test("closeRound skips drift without explicit confirmation", async t => {
  const f = await trial(t);
  const second = secondTrial(f);
  f.put(implementation, "module.exports = 'later';");
  const receipt = f.call("Lead", "closeRound", { evidence, reason });
  assert.equal(receipt.state, "partial");
  assert.deepEqual(receipt.accepted.map(row => row.taskId), [second]);
  assert.match(receipt.skipped[0].reason, /确认候选漂移/);
  assert.equal(task(f).state, "trial");
});

test("closeRound checks role, scope and operation ID", async t => {
  const f = await trial(t);
  assert.throws(() => f.call("Dev", "closeRound", { evidence, reason }), /仅.*主控/);
  const schema = f.call("Lead", "schema", { command: "closeRound" });
  assert.deepEqual(schema.roles, ["ui", "controller"]);
  assert.equal(schema.operationId.required, true);
  assert.equal(f.wf.call("Lead", "closeRound", { evidence, reason }).path, "operationId");
  assert.throws(() => f.call("Lead", "closeRound", { evidence, reason, projectId: "another" }), /仅.*主控/);
  const second = secondTrial(f);
  assert.equal(f.call("Lead", "closeRound", { evidence, reason, planId: task(f).planId }).state, "accepted");
  assert.equal(task(f, second).state, "trial");
});

test("closeRound reports ineligible tickets without changing them", async t => {
  const f = await trial(t);
  f.put(implementation, "module.exports = 'later';");
  const close = () => f.call("Lead", "closeRound", { evidence, reason, confirmDrift: true });
  const assertSkipped = pattern => {
    const before = task(f);
    const receipt = close();
    assert.equal(receipt.state, "blocked");
    assert.deepEqual(receipt.accepted, []);
    assert.equal(receipt.skipped[0].taskId, f.taskId);
    assert.match(receipt.skipped[0].reason, pattern);
    assert.deepEqual(task(f), before);
  };
  f.store.change(s => s.checkJobs.push({ id: "in-flight", taskId: f.taskId, state: "uncertain" }));
  assertSkipped(/在途/);
  f.store.change(s => {
    s.checkJobs.pop();
    s.tasks[0].questions.push({ blocking: true, answer: null });
  });
  assertSkipped(/待处理/);
  f.store.change(s => {
    s.tasks[0].questions.pop();
    s.checkJobs.find(job => job.check.id === "independent").invalidated = true;
  });
  assertSkipped(/independent/);
  f.store.change(s => { s.tasks[0].reports[0].revision++; });
  assertSkipped(/报告/);
  f.store.change(s => { s.tasks[0].state = "rework"; });
  assertSkipped(/返工/);
});
