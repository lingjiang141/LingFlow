import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { activeWake, countDeliveryAttempts, rearmLostWake, WAKE_LOST_MS, wakeHealth, wakeRecipientBusy } from "../src/wake-state.mjs";

const participants = (f, dev = {}) => f.roles.map(role => ({
  id: role.name, state: "idle", pending: 0, jobs: 0, ...(role.name === "Dev" && dev),
}));

test("busy members accumulate one card, with a fresh payload identity and no delivery retry", async t => {
  const f = await fixture(t);
  const dev = f.roles.find(role => role.kind === "developer").id;
  const read = () => f.store.read().wakes.filter(wake => wake.roleId === dev);
  const notice = key => f.store.change(s => f.wf.notice(s, dev, "message:" + key, key));
  const now = Date.now();
  const first = f.wf.heartbeat(participants(f), now).deliveries.find(wake => wake.roleId === dev);
  assert.ok(first);
  const generation = first.generation ?? first.deliveryRetry;
  f.wf.acknowledge(first.id, "Dev", "dsh", { generation });
  const initialPayload = read()[0].payloadNoticeIds;
  const additions = [];
  for (const [i, status] of [{ state: "running" }, { jobs: 2 }, { pending: 1 }].entries()) {
    additions.push(notice("message-" + i).id);
    assert.ok(!f.wf.heartbeat(participants(f, status), now + i + 1).deliveries.some(wake => wake.roleId === dev));
    assert.equal(read().filter(activeWake).length, 1);
    assert.equal(read()[0].deliveryRetry, 0);
    assert.deepEqual(read()[0].mergedNoticeIds, additions);
    assert.deepEqual(read()[0].payloadNoticeIds, initialPayload, "the old ACK must keep its original payload");
  }
  const next = f.wf.heartbeat(participants(f), now + 10).deliveries.find(wake => wake.roleId === dev);
  assert.equal(next.id, first.id);
  assert.ok(next.generation > generation);
  assert.equal(next.deliveryRetry, 0);
  assert.ok(additions.every(id => next.payloadNoticeIds.includes(id)));
  assert.equal(f.wf.acknowledge(first.id, "Dev", "dsh", { generation }).state, "obsolete");
  f.call("Dev", "inbox");
  const consumed = read()[0];
  assert.equal(consumed.state, "consumed");
  notice("during-continued-work");
  assert.ok(!f.wf.heartbeat(participants(f, { state: "running" }), now + 20).deliveries.some(wake => wake.roleId === dev));
  assert.equal(read().filter(activeWake).length, 0);
  const reused = f.wf.heartbeat(participants(f), now + 21).deliveries.find(wake => wake.roleId === dev);
  assert.equal(reused.id, first.id);
  assert.equal(read().length, 1, "another responsibility after inbox consumption should reuse the deferred wake");
});

test("a fresh busy heartbeat cannot spend a loss deadline or mark an enqueued wake stuck", async t => {
  const f = await fixture(t);
  const dev = f.roles.find(role => role.kind === "developer").id;
  const now = Date.now();
  const wake = f.wf.heartbeat(participants(f), now).deliveries.find(wake => wake.roleId === dev);
  f.wf.acknowledge(wake.id, "Dev", "dsh", { generation: wake.generation ?? wake.deliveryRetry });
  const state = () => f.store.read();
  const current = () => state().wakes.find(item => item.id === wake.id);
  const lead = f.roles.find(role => role.kind === "controller");
  const handoff = current().handedOffAt;
  f.wf.heartbeat(participants(f), handoff + 60000);
  assert.equal(state().roles.find(role => role.id === dev).deliveryIssue, null);
  f.wf.heartbeat(participants(f, { state: "running" }), handoff + WAKE_LOST_MS);
  assert.equal(current().state, "enqueued");
  assert.equal(wakeHealth(state(), dev, handoff + WAKE_LOST_MS).stuck, 0);
  let start = handoff;
  for (let loss = 1; loss <= 3; loss++) {
    const due = start + WAKE_LOST_MS * 2 ** (loss - 1);
    f.wf.heartbeat(participants(f, { state: "running" }), due);
    assert.equal(current().deliveryLosses, loss - 1);
    const result = f.wf.heartbeat(participants(f), due + 1);
    assert.equal(current().deliveryLosses, loss);
    assert.ok(!result.deliveries.some(wake => wake.roleId === lead.id), "wake diagnostics stay in the inbox");
    if (loss < 3) {
      const delivery = result.deliveries.find(item => item.id === wake.id);
      assert.ok(delivery);
      start = due + 1;
      f.store.change(s => Object.assign(s.wakes.find(item => item.id === wake.id), { state: "enqueued", handedOffAt: start }));
    }
  }
  assert.equal(current().state, "failed");
  const diagnostics = f.call("Lead", "inbox").notices.filter(notice => /^wake-(stuck|abandoned):/.test(notice.key));
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every(notice => notice.selfDiagnostic));
  assert.equal(f.store.db.prepare("SELECT count(*) AS total FROM events WHERE kind = 'wake.abandoned'").get().total, 1);
});

test("attempt statistics count all unique host attempts", () => {
  const wake = {};
  for (const attempt of [1, 4, 6, 6, 5]) countDeliveryAttempts(wake, attempt);
  assert.equal(wake.deliveryAttempts, 6);
});

test("an open observed turn remains busy even when a sampled state says idle", () => {
  const role = { state: "idle", pending: 0, jobs: 0, connectedAt: 180000,
    observation: { turn: { startedAt: 1000 } } };
  assert.equal(wakeRecipientBusy(role, 180000), true);
  role.observation.turn.endedAt = 179000;
  assert.equal(wakeRecipientBusy(role, 180000), false);
});

test("legacy simultaneous active rows become one without losing either business notification", async t => {
  const f = await fixture(t);
  const dev = f.roles.find(role => role.kind === "developer").id;
  const now = Date.now();
  const first = f.wf.heartbeat(participants(f), now).deliveries.find(wake => wake.roleId === dev);
  let otherId;
  f.store.change(s => {
    const other = f.wf.notice(s, dev, "message:from-other-row", "保留第二条责任");
    otherId = other.id;
    s.wakes.push({ id: "legacy-pending", roleId: dev, sessionId: "Dev", state: "pending", noticeIds: [otherId], at: now });
  });
  f.wf.heartbeat(participants(f, { state: "running" }), now + 1);
  const active = f.store.read().wakes.filter(wake => wake.roleId === dev && activeWake(wake));
  assert.deepEqual(active.map(wake => wake.id), [first.id]);
  assert.ok(active[0].noticeIds.includes(otherId));
  const delivery = f.wf.heartbeat(participants(f), now + 2).deliveries.find(wake => wake.roleId === dev);
  assert.ok([...first.noticeIds, otherId].every(id => delivery.payloadNoticeIds.includes(id)));
});

test("manual recovery supersedes a drain-only row instead of leaving two active wakes", () => {
  const role = { id: "role", sessionId: "Dev", queueDrainWakeId: "drain" };
  const state = { roles: [role], notices: [{ id: "notice", roleId: role.id, key: "message:important" }], wakes: [
    { id: "drain", roleId: role.id, queueDrainOnly: true, state: "pending", noticeIds: [] },
    { id: "failed", roleId: role.id, state: "failed", closeReason: "delivery-loss-limit", noticeIds: ["notice"] },
  ] };
  const result = rearmLostWake(state, role, 1000, () => {}, (_, notices) => notices, { manual: true });
  assert.equal(result.wakeId, "failed");
  assert.deepEqual(state.wakes.filter(activeWake).map(wake => wake.id), ["failed"]);
  assert.equal(role.queueDrainWakeId, undefined);
});
