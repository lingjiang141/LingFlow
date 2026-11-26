import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";

const taskOf = f => f.store.read().tasks.find(task => task.id === f.taskId);
const heartbeat = (f, now = Date.now()) => f.wf.heartbeat(f.roles.map(role => ({
  id: role.name, state: "idle", pending: 0, jobs: 0,
})), now);

async function stopped(t) {
  const f = await fixture(t);
  const args = { taskId: f.taskId, reason: "修订取红方式" };
  const checks = taskOf(f).verification.checks.map(({ expectedOutput, ...check }) => ({
    ...check,
    ...(expectedOutput && { expectedOutput }),
    ...(check.stage === "red" && { redMode: "auto-revert" }),
  }));
  f.call("Dev", "inbox");
  assert.equal(f.call("Dev", "yieldForSchedule", args).state, "paused");
  return { ...f, args, authorize: operationId => f.call("Lead", "reviseSchedule", { ...args, allowCheckRevision: true }, operationId),
    register: (role = "Dev", operationId) => f.call(role, "registerChecks", { ...args, checks, replace: true }, operationId) };
}

test("authorization delivers one repair request to the paused developer and is consumed once", async t => {
  const f = await stopped(t);
  const authorization = f.authorize("authorize-once");
  assert.equal(authorization.nextAction.command, "registerChecks");
  assert.deepEqual(f.authorize("authorize-once"), authorization);
  const pending = f.store.read().notices.filter(notice => notice.key.startsWith("check-revision-requested:"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].roleId, taskOf(f).developerId);
  assert.equal(taskOf(f).state, "paused");
  const wakes = heartbeat(f).deliveries;
  const delivery = wakes.find(wake => wake.roleId === taskOf(f).developerId && wake.noticeIds.includes(pending[0].id));
  assert.ok(delivery);
  assert.match(delivery.text, /检查修订已授权/);
  const delivered = f.call("Dev", "inbox").notices.find(notice => notice.id === pending[0].id);
  assert.match(delivered.summary, /paused.*registerChecks/);
  assert.equal(taskOf(f).state, "paused");
  assert.equal(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).nextAction.command, "registerChecks");
  const revised = f.register("Dev", "replace-once");
  assert.equal(revised.state, "stored");
  assert.deepEqual(f.register("Dev", "replace-once"), revised);
  assert.equal(taskOf(f).state, "paused");
  assert.equal(taskOf(f).checkRevisionApproval, undefined);
  assert.ok(taskOf(f).scheduleHistory.at(-1).approval.consumedAt);
  assert.throws(() => f.register(), /该票的检查已冻结/);
});

test("resume revokes the pending approval and reports its version to the original developer", async t => {
  const f = await stopped(t);
  const before = f.authorize().checkRevisionApproval.scheduleVersion;
  const resume = f.call("Lead", "resumeTask", f.args);
  assert.equal(resume.state, "stored");
  assert.equal(resume.checkRevisionRevoked, true);
  const deliveries = heartbeat(f, Date.now() + 4000).deliveries;
  assert.ok(deliveries.every(delivery => !delivery.text.includes("检查修订已授权")));
  const active = taskOf(f);
  assert.equal(active.state, "assigned");
  assert.equal(active.scheduleVersion, before + 1);
  assert.equal(active.checkRevisionApproval.revocationReason, "resumeTask");
  assert.throws(() => f.register(), new RegExp(`授权已过期.*授权版本 ${before}，当前版本 ${before + 1}`));
});

test("missing, wrong-owner and expired approvals have distinct errors", async t => {
  const f = await stopped(t);
  assert.throws(() => f.register(), /该票的检查已冻结/);
  f.authorize();
  const other = f.call("ui", "addRole", { projectId: taskOf(f).projectId, kind: "developer", name: "Other" });
  const binding = f.wf.request({ roleId: other.id, sessionId: "Other", cwd: f.root });
  f.call("ui", "confirmBinding", { requestId: binding.id });
  f.call("ui", "enable", { roleId: other.id, enabled: true });
  assert.throws(() => f.register("Other"), /仅原票责任开发/);
  f.store.change(state => { state.tasks.find(task => task.id === f.taskId).scheduleVersion = 7; });
  assert.throws(() => f.register(), /授权已过期.*授权版本 0，当前版本 7/);
  assert.equal(f.authorize().checkRevisionApproval.scheduleVersion, 7);
  assert.equal(f.register().state, "stored");
});
