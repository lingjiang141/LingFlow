import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";

const oldTest = "export-xlsx.test.ts";
const text = "评分人导出从 403 改为 200";
const acceptance = [{ id: "AC1", text }];
const setup = t => fixture(t, "AssertionError", { initialFiles: {
  [oldTest]: "it('评分人导出禁止', () => {\n  expect(rater.statusCode).toBe(403);\n});\n",
  "unrelated.test.ts": "it('unrelated', () => { expect(response.status).toBe(403); });",
} });
const getTask = f => f.store.read().tasks.find(task => task.id === f.taskId);
const addAcceptance = f => f.store.change(s => { s.tasks.find(task => task.id === f.taskId).verification.acceptance = acceptance; });

test("plan preflight warns about the specific old literal assertion outside the write set", async t => {
  const f = await setup(t);
  const task = getTask(f);
  const verification = structuredClone(task.verification);
  verification.acceptance = acceptance;
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  const plan = f.call("Lead", "previewPlan", {
    requirementId: task.requirementId, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "SCOPE-WARNING", developerId: task.developerId, title: "调整评分人导出", description: text, risk: "high",
      riskReason: "调整导出权限", writes: task.writes, reads: [], verification }],
  });
  assert.equal(plan.state, "valid", JSON.stringify(plan.violations));
  assert.ok(plan.warnings.some(warning => warning.file === oldTest && warning.line === 2));
  assert.ok(!plan.warnings.some(warning => warning.file === "unrelated.test.ts"));
});

test("a running member can receive a clean write-set addition but not shrink or reclaim active scope", async t => {
  const f = await setup(t);
  const initial = getTask(f);
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: role.name === "Dev" ? "running" : "idle", pending: 0, jobs: 0 })));
  const update = writes => f.call("Lead", "reviseSchedule", { taskId: f.taskId, writes, reason: "确认旧断言需要同步更新" });
  const peer = { ...initial, id: "active-peer", ticketKey: "PEER", state: "assigned", writes: [oldTest] };
  f.store.change(s => s.tasks.push(peer));
  assert.throws(() => update([...initial.writes, oldTest]), /在飞责任冲突/);
  f.store.change(s => { s.tasks.find(task => task.id === peer.id).state = "abandoned"; });
  const result = update([...initial.writes, oldTest]);
  assert.equal(result.state, "applied");
  assert.deepEqual(result.addedWrites, [oldTest]);
  const after = getTask(f);
  assert.equal(after.state, initial.state);
  assert.equal(after.assignee, initial.assignee);
  assert.deepEqual(after.verification, initial.verification);
  assert.equal(f.store.db.prepare("SELECT count(*) AS total FROM events WHERE kind = 'schedule.writes-widened'").get().total, 1);
  assert.throws(() => update(initial.writes), /仅允许经核对的纯增写集/);
});

test("a write-set yield gives the original reason and a specific expansion proposal", async t => {
  const f = await setup(t);
  addAcceptance(f);
  const reason = "写集缺文件，旧导出测试包含被替换的断言";
  const receipt = f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason });
  assert.equal(receipt.reason, reason);
  assert.deepEqual(receipt.suggestedTests, [{ file: oldTest, line: 2 }]);
  const finding = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(finding.nextAction?.command, "reviseSchedule");
  assert.ok(finding.nextAction.args.writes.includes(oldTest));
  assert.equal(finding.recovery.requiresConfirmation, true);
});
