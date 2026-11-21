import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRelay } from "../adapters/dsh/relay.mjs";
import { wakeGeneration } from "../src/wake-state.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

async function setup(t) {
  const f = await fixture(t);
  const dev = f.roles.find(role => role.name === "Dev");
  const prompts = [], turns = [], events = [];
  let leaveQueued = false;
  let agent = {
    id: "Dev", status: "idle", inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => events },
    runMaintenance: async work => work(),
  };
  agent.inbox.remove = id => {
    const index = agent.inbox.nextTurn.findIndex(item => item.id === id);
    if (index < 0) return false;
    agent.inbox.nextTurn.splice(index, 1);
    return true;
  };
  const agents = new Map([[agent.id, agent]]);
  const options = {
    file: path.join(f.dir, "delivery-ledger.json"), agents, activeJobs: () => 0,
    api: (action, body) => action === "valid" ? f.wf.validWake(body.wakeId, body.sessionId, body.generation)
      : f.wf.acknowledge(body.wakeId, body.sessionId, "dsh", body.delivery),
    controller: { prompt(input) {
      prompts.push(input);
      const message = { id: input.requestId, source: { rpcId: input.requestId }, content: input.content };
      if (leaveQueued) agent.inbox.nextTurn.push(message);
      else {
        turns.push([...agent.inbox.nextStep.splice(0), message, ...agent.inbox.nextTurn.splice(0, 1)]);
        while (agent.inbox.nextTurn.length) turns.push(agent.inbox.nextTurn.splice(0, 1));
      }
      return { accepted: true };
    } },
  };
  let relay = createRelay(options);
  const heartbeat = (telemetry, now) => f.wf.heartbeat(f.roles.map(role => role.name === "Dev" ? {
    id: role.name, state: agent.status, pending: agent.inbox.nextTurn.length + agent.inbox.nextStep.length, jobs: 0,
    ...relay.pendingInput(agent), telemetry,
  } : { id: role.name, state: "idle", pending: 0, jobs: 0 }), now).deliveries.filter(wake => wake.sessionId === "Dev");
  const pump = async (telemetry, now) => {
    const wakes = heartbeat(telemetry, now);
    await relay.accept(wakes);
    return wakes;
  };
  const task = () => f.call("Lead", "list").tasks.find(task => task.id === f.taskId);
  const role = () => f.call("Lead", "list").roles.find(role => role.id === dev.id);
  const message = text => f.call("Lead", "message", { roleId: dev.id, text });
  const resend = operationId => f.call("Lead", "redeliver", { taskId: f.taskId }, operationId);
  return { ...f, dev, prompts, turns, heartbeat, pump, task, role, message, resend,
    hostInput(text) { agent.inbox.nextTurn.push({ id: `host-${text}`, content: [{ type: "text", text }] }); },
    makeIdle() { agent.status = "idle"; },
    makeRunning() { agent.status = "running"; },
    holdPrompt(value) { leaveQueued = value; },
    restart() {
      agent = { ...agent };
      agents.set(agent.id, agent);
      relay = createRelay(options);
    },
    replay: wakes => relay.accept(wakes),
  };
}

test("T1 idle LingFlow advisory and newly assigned ticket are visible together", async t => {
  const f = await setup(t);
  f.store.change(s => {
    const ticket = s.tasks[0];
    ticket.state = "queued";
    ticket.assignee = null;
    s.notices = s.notices.filter(notice => notice.taskId !== ticket.id);
    const predecessor = { ...ticket, id: "predecessor", ticketKey: "PRIOR", developerId: null, state: "blocked",
      writes: [], reads: [], verification: null };
    ticket.dependencies = [predecessor.id];
    s.tasks.unshift(predecessor);
  });
  const advisory = f.message("开工前先读验收例子");
  f.holdPrompt(true);
  await f.pump();
  assert.equal(f.role().pendingInputCount, 0); // sampled before host admission
  assert.equal(f.task().state, "queued");
  const released = f.call("Lead", "insertSchedule", { taskId: f.taskId, after: [], reason: "前置结果已经可用" });
  assert.equal(f.task().state, "assigned", JSON.stringify({ released, task: f.task() }));
  f.holdPrompt(false);
  const [wake] = await f.pump();
  assert.match(wake.queuedInputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(f.prompts.at(-1).mode, "steer");
  assert.equal(f.turns[0].length, 2);
  assert.equal(f.task().deliveryState, "delivered");
  const inbox = f.call("Dev", "inbox");
  assert.ok(inbox.tasks.some(task => task.id === f.taskId));
  assert.equal(inbox.messages.find(message => message.id === advisory.messageId).text, "开工前先读验收例子");
  await f.pump();
  assert.deepEqual(f.task().blockers, []);
});

test("T2 ended turn drains on idle heartbeat without another dispatch", async t => {
  const f = await setup(t);
  f.holdPrompt(true);
  assert.equal((await f.pump()).length, 1);
  f.makeRunning();
  assert.equal((await f.pump()).length, 0);
  f.makeIdle();
  f.holdPrompt(false);
  const [wake] = await f.pump({ turn: { id: "previous", outcome: "ended", endedAt: Date.now() } });
  assert.equal(wake.requeueReason, "idle-queued-input");
  assert.equal(f.prompts.at(-1).mode, "steer");
  assert.equal(f.turns[0].length, 2);
  await f.pump();
  assert.equal(f.role().pendingInputCount, 0);
  assert.equal(f.task().deliveryState, "delivered");
});

test("T3 redeliver and unblock diagnose host input and the exact command preserves it", async t => {
  const f = await setup(t);
  f.hostInput("宿主中排队的普通消息");
  assert.equal((await f.pump()).length, 0);
  const receipt = f.resend("queue-blocker");
  assert.match(receipt.controllerBoundary, /不得写业务代码/);
  assert.equal(receipt.blocker, "queued-input");
  assert.equal(receipt.pendingInputCount, 1);
  assert.deepEqual(receipt.pendingInputKinds, ["host"]);
  assert.match(receipt.hint, /^unblock \{/);
  assert.equal(f.role().blockReason, "queued-input");
  assert.equal(f.role().deliveryDiagnostic.reason, f.task().blockers[0].code);
  assert.deepEqual(f.call("Lead", "unblock", { taskId: f.taskId, reason: "诊断" }).nextAction, receipt.nextAction);
  assert.equal(f.call("Lead", "unblock", { ...receipt.nextAction.args, expectedQueueFingerprint: "0".repeat(64) }).state, "blocked");
  assert.equal(f.call("Lead", receipt.nextAction.command, receipt.nextAction.args, "queue-approval").recovery, "drain-queued-input");
  const [wake] = await f.pump();
  assert.ok(wake.queuedInputFingerprint);
  assert.equal(f.turns[0].some(message => message.content[0].text === "宿主中排队的普通消息"), true);
  await f.pump();
  assert.equal(f.role().pendingInputCount, 0);
  assert.equal(f.task().deliveryState, "delivered");
  assert.deepEqual(f.resend("queue-blocker"), receipt);
});

test("T4 first heartbeat after relay restart wakes a persisted advisory once", async t => {
  const f = await setup(t);
  const advisory = f.message("重连后继续读这一条");
  f.holdPrompt(true);
  await f.pump();
  f.restart();
  f.holdPrompt(false);
  const wakes = await f.pump();
  assert.equal(wakes.length, 1);
  assert.equal(f.prompts.at(-1).mode, "steer");
  await f.replay(wakes);
  await f.pump();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.role().pendingInputCount, 0);
  assert.ok(f.role().seenContextRevision);
  assert.ok(f.call("Dev", "inbox").messages.some(message => message.id === advisory.messageId));
});

test("a standalone message wakes an idle member and a leftover host prompt can drain after inbox read", async t => {
  const f = await setup(t);
  f.call("Dev", "inbox");
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "暂停原票" });
  const advisory = f.message("独立消息，无需先派新票");
  f.holdPrompt(true);
  assert.equal((await f.pump()).length, 1);
  assert.equal(f.prompts[0].mode, "queue");
  assert.equal(f.call("Dev", "inbox").messages[0].id, advisory.messageId);
  f.restart();
  f.holdPrompt(false);
  const [wake] = await f.pump();
  assert.equal(wake.queueDrainOnly, true);
  assert.equal(f.prompts.at(-1).mode, "steer");
  await f.pump();
  assert.equal(f.role().pendingInputCount, 0);
  assert.equal(f.prompts.length, 2);
});

test("T5 empty queue keeps admission, retry-limit, delivery ACK and operationId semantics", async t => {
  const f = await setup(t);
  assert.equal(f.resend().nextAction.command, "diagnoseTask");
  const [wake] = f.heartbeat();
  assert.equal(wake.queuedInputFingerprint, undefined);
  assert.equal(f.task().deliveryState, "pending");
  f.store.change(s => Object.assign(s.wakes.find(item => item.id === wake.id), { diagnostic: { reason: "retry-limit", attempt: 4 } }));
  assert.equal(f.task().deliveryIssue.reason, "retry-limit");
  const receipt = f.resend("empty-queue-retry");
  assert.equal(receipt.wakeId, wake.id);
  assert.deepEqual(f.resend("empty-queue-retry"), receipt);
  const [retry] = await f.pump();
  assert.equal(wakeGeneration(retry), wakeGeneration(wake) + 1);
  assert.equal(retry.deliveryRetry, wake.deliveryRetry + 1, "an explicit retry after host rejection counts");
  assert.equal(f.prompts[0].mode, "queue");
  assert.equal(f.task().deliveryState, "delivered");
});

test("T-A1/T-A2 one wake resumes an ended idle session and drains three inputs", async t => {
  const f = await setup(t);
  f.store.change(s => { s.roles.find(role => role.id === f.dev.id).seenContextRevision = null; });
  for (const input of ["one", "two", "three"]) f.hostInput(input);
  const now = Date.now();
  const telemetry = { turn: { id: "previous", outcome: "ended", endedAt: now } };
  assert.equal((await f.pump(telemetry, now)).length, 0);
  assert.equal(f.role().lastTurnState, "ended");
  const [wake] = await f.pump(telemetry, now + 6000);
  assert.ok(wake.queuedInputFingerprint);
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.turns.flat().filter(item => item.id.startsWith("host-")).map(item => item.id), ["host-one", "host-two", "host-three"]);
  await f.pump(telemetry, now + 8000);
  assert.equal(f.role().pendingInputCount, 0);
  assert.equal(f.role().seenContextRevision, null);
  assert.ok(f.call("Dev", "inbox").context);
  assert.ok(f.role().seenContextRevision);
  assert.ok(f.task().deliveredAt);
  assert.deepEqual(f.task().blockers, []);
});

test("T-A3/T-A4 an explicit drop audits exact input IDs and releases the original ticket", async t => {
  const f = await setup(t);
  f.hostInput("misdirected");
  f.heartbeat();
  const blocked = f.resend();
  for (const field of ["pendingInputCount", "blockingWakeId", "lastTurnState"]) {
    assert.ok(Object.hasOwn(blocked, field));
    assert.match(f.task().deliveryIssue.detail, new RegExp(field));
  }
  assert.doesNotMatch(blocked.hint, /请打开会话/);
  const request = f.call("Lead", blocked.dropAction.command, blocked.dropAction.args, "drop-misdirected");
  assert.equal(request.state, "pending");
  await f.pump();
  await f.pump();
  assert.equal(f.task().deliveryState, "delivered");
  assert.equal(f.role().pendingInputCount, 0);
  assert.deepEqual(f.role().lastInputDrop.ids, ["host-misdirected"]);
  assert.equal(f.role().lastInputDrop.state, "dropped");
  const audit = f.call("Lead", "inspect", { taskId: f.taskId, section: "events", limit: 30 }).items
    .find(event => event.kind === "input.drop-completed");
  assert.deepEqual(audit.inputDrop.ids, ["host-misdirected"]);
  assert.equal(f.turns.flat().some(item => item.id === "host-misdirected"), false);
  assert.deepEqual(f.call("Lead", blocked.dropAction.command, blocked.dropAction.args, "drop-misdirected"), request);
});

test("an input arriving after drop authorization survives and releases the stale request", async t => {
  const f = await setup(t);
  f.hostInput("old");
  f.heartbeat();
  const {dropAction} = f.resend();
  f.call("Lead", dropAction.command, dropAction.args);
  const [drop] = f.heartbeat();
  f.hostInput("new");
  await f.replay([drop]);
  assert.equal(f.role().lastInputDrop.state, "queue-changed");
  assert.deepEqual(f.role().lastInputDrop.ids, []);
  f.heartbeat();
  assert.equal(f.role().pendingInputCount, 2);
});

test("queued steer rejects changed queues and a disabled or rebound session", async t => {
  const f = await setup(t);
  f.hostInput("old");
  f.heartbeat();
  const action = f.resend().nextAction;
  f.call("Lead", "unblock", action.args);
  const [wake] = f.heartbeat();
  f.hostInput("new");
  await f.replay([wake]);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.heartbeat().length, 0);
  const current = f.resend().nextAction;
  assert.notEqual(current.args.expectedQueueFingerprint, action.args.expectedQueueFingerprint);
  f.call("Lead", "unblock", current.args);
  const [next] = f.heartbeat();
  f.store.change(s => { s.roles.find(role => role.id === f.dev.id).enabled = false; });
  await f.replay([next]);
  assert.equal(f.prompts.length, 0);
  f.store.change(s => { Object.assign(s.roles.find(role => role.id === f.dev.id), { enabled: true, sessionId: "new-session" }); });
  await f.replay([next]);
  assert.equal(f.prompts.length, 0);
});
