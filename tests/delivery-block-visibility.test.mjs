import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { selectWakeNotices } from "../src/controller-notices.mjs";

const dev = f => f.roles.find(role => role.name === "Dev");
const message = f => f.call("Lead", "message", { roleId: dev(f).id, text: "请查看原票的更新" });
const heartbeat = (f, changes, now = Date.now()) => f.wf.heartbeat(f.roles.map(role => ({
  id: role.name, state: "idle", pending: 0, jobs: 0, ...(role.name === "Dev" && changes),
})), now);
const roleStatus = f => f.call("Lead", "list").roles.find(role => role.id === dev(f).id);

test("a direct message exposes queued delivery and blocked reasons", async t => {
  const f = await fixture(t);
  heartbeat(f, { state: "running" });
  const sent = message(f);
  assert.equal(sent.state, "stored");
  assert.equal(sent.delivery.state, "blocked");
  assert.equal(sent.delivery.reason, "busy");
  const block = roleStatus(f).deliveryBlock;
  assert.equal(block.code, "role-running");
  assert.ok(block.noticeIds.includes(sent.delivery.noticeId));
  const rearm = f.call("Lead", "rearmWake", { roleId: dev(f).id, reason: "核对未读通知" });
  assert.equal(rearm.since, block.since);
  assert.ok(rearm.blockedNoticeIds.includes(sent.delivery.noticeId));
  assert.equal(rearm.nextAction.command, "inbox");
  f.call("Dev", "inbox");
  assert.equal(roleStatus(f).deliveryBlock, undefined);
  heartbeat(f, { jobs: null });
  assert.equal(message(f).delivery.reason, "jobs-unknown");
  f.wf.heartbeat([{ id: "Lead", state: "idle", pending: 0, jobs: 0 }]);
  assert.equal(message(f).delivery.reason, "offline");
  heartbeat(f, {});
  assert.equal(message(f).delivery.state, "queued");
});

test("a long open turn exposes an overdue message, a single alert and automatic delivery after idle", async t => {
  const f = await fixture(t);
  const now = Date.now();
  const turn = { id: "busy-turn", startedAt: now - 33000, outcome: "running" };
  heartbeat(f, { state: "running", telemetry: { turn } }, now);
  const sent = message(f);
  f.store.change(s => { s.notices.find(notice => notice.id === sent.delivery.noticeId).at = now - 31000; });
  for (const at of [now + 1, now + 2])
    heartbeat(f, { state: "running", telemetry: { turn } }, at);
  const role = roleStatus(f);
  assert.equal(role.deliveryBlock.code, "stale-turn");
  assert.equal(role.wakeHealth.stuck, 1);
  assert.equal(f.call("Lead", "inspect", { taskId: f.taskId }).deliveryState, "blocked-busy");
  const state = f.store.read();
  const alerts = state.notices.filter(notice => notice.key.startsWith("turn-stale:"));
  assert.equal(alerts.length, 1);
  const lead = state.roles.find(role => role.name === "Lead");
  const selection = selectWakeNotices(state, lead, alerts);
  assert.equal(selection.actionable, false);
  assert.equal(selection.diagnostics[0].critical, false);
  assert.equal(selection.diagnostics[0].actionable, false);
  const q = f.call("Dev", "question", { taskId: f.taskId, text: "这条原票需要主控判断" });
  const [business] = heartbeat(f, { state: "running", telemetry: { turn } }, now + 3).deliveries.filter(item => item.roleId === lead.id);
  assert.match(business.text, /成员提问/);
  assert.match(business.text, /成员回合超时（可自愈）/);
  assert.ok(!business.payloadNoticeIds.includes(alerts[0].id));
  assert.ok(f.call("Lead", "inbox").notices.some(notice => notice.key === "question:" + q.questionId));
  const idleAt = Date.now();
  const idle = heartbeat(f, { telemetry: { turn: { ...turn, endedAt: idleAt, outcome: "ended" } } }, idleAt);
  const wake = idle.deliveries.find(item => item.noticeIds.includes(sent.delivery.noticeId));
  assert.ok(wake);
  assert.ok(!idle.deliveries.some(item => item.roleId === lead.id));
  const recovered = f.store.read();
  assert.deepEqual(selectWakeNotices(recovered, lead, alerts).suppressedNotices,
    [{ id: alerts[0].id, reason: "resolved" }]);
  f.wf.acknowledge(wake.id, "Dev", "dsh", { generation: wake.generation });
  assert.equal(roleStatus(f).deliveryBlock, undefined);
  assert.equal(f.call("Lead", "messages", { messageId: sent.messageId }).delivery.state, "handed-off");
  assert.equal(f.call("Dev", "inbox").messages.find(item => item.id === sent.messageId).text, "请查看原票的更新");
  assert.equal(f.call("Lead", "messages", { messageId: sent.messageId }).delivery.state, "read");
});

test("a stop reaches the member's running turn and requires the member's receipt", async t => {
  const f = await fixture(t);
  heartbeat(f, { state: "running" });
  const ordinary = message(f);
  assert.equal(ordinary.delivery.state, "blocked");
  const request = f.call("Lead", "interveneTask", { taskId: f.taskId, mode: "stop", reason: "先停止新增写入" });
  const wake = heartbeat(f, { state: "running" }).deliveries.find(wake => wake.id === request.intervention.id);
  assert.equal(wake.taskIntervention, true);
  f.wf.acknowledge(wake.id, "Dev", "dsh", { generation: 0 });
  assert.equal(f.store.read().tasks[0].intervention.state, "requested");
  assert.equal(f.store.read().tasks[0].state, "assigned");
  f.call("Dev", "ackTaskIntervention", { taskId: f.taskId, requestId: wake.id, reason: "已停止本票写入" });
  assert.equal(f.store.read().tasks[0].intervention.state, "stopped");
  assert.equal(f.store.read().tasks[0].state, "paused");
});

test("answer explains whether the ticket resumed, independently of message delivery", async t => {
  const f = await fixture(t);
  const q = f.call("Dev", "question", { taskId: f.taskId, text: "补充范围" });
  const ordinary = f.call("Lead", "answer", { taskId: f.taskId, questionId: q.questionId, text: "范围已确认" });
  assert.equal(ordinary.resume.attempted, false);
  assert.equal(ordinary.resume.reason, "question-not-blocking");
  const blocker = f.call("Dev", "question", { taskId: f.taskId, text: "需要裁决", blocking: true });
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "等待裁决" });
  const resumed = f.call("Lead", "answer", { taskId: f.taskId, questionId: blocker.questionId, text: "可以继续" });
  assert.equal(resumed.resume.attempted, true);
  assert.equal(resumed.resume.result, "queued");
});
