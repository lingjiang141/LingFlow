import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRelay } from "../adapters/dsh/relay.mjs";
import { createDshTelemetry } from "../adapters/dsh/telemetry.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

async function setup(t) {
  const f = await fixture(t);
  const role = f.roles.find(item => item.kind === "controller");
  const events = [], listeners = new Map(), prompts = [];
  const agent = { id: role.name, status: "idle", inbox: { nextTurn: [], nextStep: [] },
    session: { snapshotEvents: () => events } };
  const observe = createDshTelemetry({ on: (name, listener) => listeners.set(name, listener) });
  let now = Date.now();
  const emit = (type, turn) => {
    const event = { type, time: ++now, seq: events.length + 1, data: { turn, reason: { kind: "completed" } } };
    events.push(event);
    listeners.get("session/event")(agent.session, event);
  };
  const relayOptions = {
    file: path.join(f.dir, "controller-turn-ledger.json"),
    agents: new Map([[agent.id, agent]]), activeJobs: () => 0, observe,
    api: (action, args) => action === "valid" ? f.wf.validWake(args.wakeId, args.sessionId, args.generation) :
      f.wf.acknowledge(args.wakeId, args.sessionId, "dsh", args.delivery),
    controller: { prompt(input) { prompts.push(input); return { accepted: true }; } },
  };
  const heartbeat = () => f.wf.heartbeat(f.roles.map(member => member.id === role.id ? {
    id: agent.id, state: agent.status, jobs: 0, pending: agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
    telemetry: observe(agent), ...createRelay(relayOptions).pendingInput(agent),
  } : { id: member.name, state: "idle", jobs: 0, pending: 0 }), now).deliveries.filter(wake => wake.sessionId === agent.id);
  const notice = (index) => f.store.change(s => {
    const notice = f.wf.notice(s, role.id, `report:fixture-${index}`, `报告 ${index}`, f.taskId);
    notice.at = ++now;
    return notice.id;
  });
  return { ...f, role, agent, emit, notice, heartbeat, relayOptions, prompts, observe,
    advance: ms => { now += ms; } };
}

test("controller returns accumulate across a turn and compaction, then queue once on the matched end", async t => {
  const f = await setup(t);
  const relay = createRelay(f.relayOptions);
  f.emit("turn/start", 1);
  f.agent.status = "running";
  const reports = [f.notice(1)];
  assert.deepEqual(f.heartbeat(), []);
  f.emit("compaction/start", 1);
  reports.push(f.notice(2));
  f.agent.status = "idle";
  assert.deepEqual(f.heartbeat(), []);
  f.emit("compaction/end", 1);
  reports.push(f.notice(3));
  f.emit("turn/end", 0);
  assert.deepEqual(f.heartbeat(), [], "an idle sample or the wrong end must not release the live turn");
  f.emit("turn/end", 1);
  const wakes = f.heartbeat();
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].noticeIds, reports);
  assert.ok(reports.every(id => f.store.read().notices.some(n => n.id === id && !n.readAt)));
  await relay.accept(wakes);
  await relay.accept(f.heartbeat());
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, "queue");
});

test("a stale boundary cannot admit a report while validating against a new turn or an open compaction", async t => {
  const f = await setup(t);
  f.emit("turn/start", 1);
  f.notice(1);
  f.emit("turn/end", 1);
  f.advance(30000);
  const [old] = f.heartbeat();
  assert.ok(old);
  const api = f.relayOptions.api;
  let raced = false;
  f.relayOptions.api = async (action, args) => {
    const result = await api(action, args);
    if (action === "valid" && !raced) {
      raced = true;
      f.emit("turn/start", 2);
    }
    return result;
  };
  const relay = createRelay(f.relayOptions);
  await relay.accept([old]);
  assert.deepEqual(f.prompts, []);
  f.emit("turn/end", 2);
  f.emit("compaction/start", 2);
  assert.deepEqual(f.heartbeat(), []);
  f.emit("compaction/end", 2);
  await relay.accept([old]);
  assert.deepEqual(f.prompts, [], "a wake offered at a previous turn boundary must be refreshed");
  await relay.accept(f.heartbeat());
  assert.equal(f.prompts[0]?.mode, "queue");
});

test("pending human input wins over a controller return even after the existing queue-drain delay", async t => {
  const f = await setup(t);
  f.emit("turn/start", 1);
  f.notice(1);
  f.emit("turn/end", 1);
  f.agent.inbox.nextTurn.push({ id: "next-user-input", source: { kind: "user" }, content: [{ type: "text", text: "继续规划" }] });
  assert.deepEqual(f.heartbeat(), []);
  f.advance(30000);
  assert.deepEqual(f.heartbeat(), []);
  assert.equal(f.agent.inbox.nextTurn[0].id, "next-user-input");
  f.agent.inbox.nextTurn.shift();
  f.emit("turn/start", 2);
  assert.deepEqual(f.heartbeat(), []);
  f.emit("turn/end", 2);
  const wakes = f.heartbeat();
  const relay = createRelay(f.relayOptions);
  assert.equal(wakes.length, 1);
  // The next user input reaches DSH after the service emitted this wake.
  f.agent.inbox.nextStep.push({ id: "new-host-input" });
  await relay.accept(wakes);
  assert.deepEqual(f.prompts, []);
  f.agent.inbox.nextStep.shift();
  f.emit("turn/start", 3);
  f.emit("turn/end", 3);
  await relay.accept(f.heartbeat());
  assert.equal(f.prompts[0]?.mode, "queue");
});

test("a restarted bridge observes an open turn and compaction beyond the recent event window", () => {
  const now = Date.now();
  const events = [
    { type: "turn/start", seq: 1, time: now, data: { turn: 4 } },
    { type: "compaction/start", seq: 2, time: now, data: { turn: 4 } },
    ...Array.from({ length: 250 }, (_, index) => ({ type: "tool/result", seq: index + 3, time: now })),
  ];
  const observe = createDshTelemetry({ on() {} });
  const observation = observe({ session: { snapshotEvents: () => events } });
  assert.equal(observation.turn.startedAt, now);
  assert.equal(observation.turn.endedAt, undefined);
  assert.equal(observation.compacting, true);
});
