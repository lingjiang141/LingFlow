import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { dshWakeSummary, wakeSummary } from "../src/wake-card.mjs";
import { WAKE_LOST_MS } from "../src/wake-state.mjs";

const lead = f => f.roles.find(role => role.kind === "controller");
const heartbeat = (f, now = Date.now(), changes = {}) => f.wf.heartbeat(f.roles.map(role => ({
  id: role.name, state: "idle", jobs: 0, pending: 0, ...changes[role.name],
})), now).deliveries;
const broadcasts = notices => notices.filter(notice => /^(preflight-ready|dependency-ready):/.test(notice.key));

test("lost controller wakes retry without notifying the controller about itself", async t => {
  const f = await fixture(t);
  f.store.change(s => f.wf.notice(s, lead(f).id, "message:unread", "待裁决事项"));
  const now = Date.now();
  const deliveries = heartbeat(f, now);
  const first = deliveries.find(wake => wake.roleId === lead(f).id);
  const memberWake = deliveries.find(wake => wake.sessionId === "Dev");
  assert.ok(first);
  assert.ok(memberWake);
  for (const wake of [first, memberWake])
    f.wf.acknowledge(wake.id, wake.sessionId, "dsh", { generation: wake.generation });
  const handedOffAt = Math.max(...f.store.read().wakes.filter(wake => [first.id, memberWake.id].includes(wake.id)).map(wake => wake.handedOffAt));
  const retry = heartbeat(f, handedOffAt + WAKE_LOST_MS + 1).find(wake => wake.id === first.id);
  assert.ok(retry.generation > first.generation);
  assert.equal(retry.deliveryLosses, 1);
  const notices = f.call("Lead", "inbox").notices;
  assert.ok(notices.some(notice => notice.key === "message:unread"));
  assert.ok(notices.some(notice => notice.key.startsWith("wake-stuck:" + memberWake.id)));
  assert.ok(!notices.some(notice => notice.key.startsWith("wake-stuck:" + first.id)));
  assert.ok(f.store.db.prepare("SELECT count(*) AS total FROM events WHERE kind = 'wake.delivery_lost'").get().total >= 1);
});

test("two schedule revisions preserve one inbox-only notice per admission event kind", async t => {
  const f = await fixture(t);
  const task = () => f.store.read().tasks.find(task => task.id === f.taskId);
  const waitForAdmission = () => f.store.change(s => {
    const ticket = s.tasks.find(ticket => ticket.id === f.taskId);
    ticket.state = "queued";
    ticket.waitedForDependency = true;
    ticket.preflightFailure = { version: ticket.scheduleVersion ?? 0, checkedAt: Date.now(), reason: "模拟既有准入阻塞" };
  });
  for (let revision = 1; revision <= 2; revision++) {
    waitForAdmission();
    const revised = f.call("Lead", "reviseSchedule", { taskId: f.taskId, reason: "核对准入条件 " + revision });
    assert.equal(revised.scheduleVersion, revision);
    assert.equal(task().state, "assigned");
    assert.ok(!task().deliveredAt);
    const deliveries = heartbeat(f);
    const dispatch = deliveries.find(wake => wake.roleId === task().developerId);
    if (dispatch) f.wf.acknowledge(dispatch.id, "Dev", "dsh", { generation: dispatch.generation });
    f.call("Dev", "inbox");
    assert.ok(task().deliveredAt);
    assert.ok(!heartbeat(f, Date.now() + 30000).some(wake => wake.roleId === lead(f).id));
  }
  const recorded = broadcasts(f.store.read().notices);
  assert.equal(recorded.length, 2);
  assert.ok(recorded.every(notice => notice.actionable === false));
});

test("legacy broadcasts and passive turn diagnostics cannot replace an enqueued business card", async t => {
  const f = await fixture(t);
  const now = Date.now();
  f.store.change(s => {
    s.tasks.find(task => task.id === f.taskId).deliveredAt = now;
    f.wf.notice(s, lead(f).id, "message:business", "需要主控判断");
  });
  const [first] = heartbeat(f, now).filter(wake => wake.roleId === lead(f).id);
  assert.ok(first);
  f.wf.acknowledge(first.id, "Lead", "dsh", { generation: first.generation });
  f.store.change(s => {
    for (const version of [0, 1]) {
      s.notices.push({ id: "legacy-ready-" + version, roleId: lead(f).id,
        key: "dependency-ready:" + f.taskId + ":1:" + version, taskId: f.taskId,
        summary: "原票已自动分派", actionable: true, readAt: null, at: now });
    }
    const member = s.roles.find(role => role.name === "Dev");
    const notice = f.wf.notice(s, lead(f).id, "turn-stale:" + member.id + ":" + now, "成员回合仍未结束");
    Object.assign(notice, { blockedRoleId: member.id, blockedTurnStartedAt: now });
    const pending = s.notices.find(notice => notice.roleId === member.id && !notice.readAt);
    pending.at = now - 31000;
  });
  const next = heartbeat(f, now + 31000, { Dev: { state: "running", telemetry: { turn: { id: "busy", startedAt: now } } } });
  assert.ok(!next.some(wake => wake.roleId === lead(f).id));
  const stored = f.store.read().wakes.find(wake => wake.id === first.id);
  assert.equal(stored.generation, first.generation);
  assert.deepEqual(stored.payloadNoticeIds, first.payloadNoticeIds);
  const inbox = f.call("Lead", "inbox").notices;
  assert.equal(broadcasts(inbox).length, 1);
  assert.ok(inbox.filter(notice => /^(dependency-ready|turn-stale):/.test(notice.key)).every(notice => !notice.actionable));
  assert.ok(inbox.find(notice => notice.key === "message:business").actionable);
});

test("wake cards keep business rows, identify unknown kinds and group stale turns by member", () => {
  const history = ["dependency-ready", "preflight-ready"].map(kind => ({ key: kind + ":task:1", actionable: true }));
  const work = [1, 2, 3, 4].map(n => ({ key: "message:request-" + n, summary: "成员回复：" + n, actionable: true }));
  const unknown = { key: "new-kind:ref", summary: "待核对", actionable: true };
  const diagnostics = [
    { key: "turn-stale:a:1", summary: "成员甲的旧回合", actionable: false },
    { key: "turn-stale:a:2", summary: "成员甲的当前回合", actionable: false },
    { key: "turn-stale:b:1", summary: "成员乙的当前回合", actionable: false },
  ];
  for (const render of [dshWakeSummary, wakeSummary]) {
    const full = render([...history, ...diagnostics, ...work], [], [], []);
    assert.equal((full.match(/团队消息/g) ?? []).length, 4);
    assert.doesNotMatch(full, /前置已满足|准入恢复|成员回合超时/);
    const compact = render([...history, ...diagnostics, unknown], [], [], []);
    assert.match(compact, /未分类通知（kind=new-kind）/);
    assert.match(compact, /成员甲的当前回合/);
    assert.match(compact, /成员乙的当前回合/);
    assert.equal((compact.match(/成员回合超时（可自愈）/g) ?? []).length, 2);
    assert.doesNotMatch(compact, /协作动态|成员甲的旧回合|前置已满足|准入恢复/);
  }
});
