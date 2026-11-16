import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { createRelay } from "../adapters/dsh/relay.mjs";
const wake = { id: "same-wake", sessionId: "session", text: "读取收件箱" };
function setup() {
  mkdirSync(".validation", { recursive: true });
  const root = mkdtempSync(path.resolve(".validation", "relay-"));
  const events = [],
    calls = [],
    acks = [];
  const agent = {
    id: wake.sessionId,
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    session: { snapshotEvents: () => events },
  };
  const agents = new Map([["session", agent]]);
  const options = {
    file: path.join(root, "ledger.json"),
    agents,
    controller: {
      prompt: async (input) => {
        calls.push(input);
        events.push({
          type: "user/message",
          data: { source: { rpcId: input.requestId } },
        });
        return { accepted: true };
      },
    },
    api: async (action, body) => {
      if (action === "valid") return { valid: true };
      acks.push(body);
      return { state: "stored" };
    },
  };
  return { agent, options, calls, acks, events };
}
test("ACK loss and concurrent redelivery admit exactly one prompt, including after restart", async () => {
  const f = setup();
  let reject = true;
  const api = f.options.api;
  f.options.api = async (action, body) => {
    if (action === "ack" && reject) throw Error("ACK lost");
    return api(action, body);
  };
  let relay = createRelay(f.options);
  await assert.rejects(relay.accept([wake]), /ACK lost/);
  assert.equal(f.calls.length, 1);
  reject = false;
  relay = createRelay(f.options);
  await Promise.all(Array.from({ length: 20 }, () => relay.accept([wake])));
  assert.equal(f.calls.length, 1);
  assert.equal(f.acks.length, 1);
});
test("busy or pending-input sessions receive no injected prompt", async () => {
  const f = setup();
  const relay = createRelay(f.options);
  f.agent.status = "running";
  await relay.accept([wake]);
  assert.equal(f.calls.length, 0);
  f.agent.status = "idle";
  f.agent.inbox.nextTurn.push({});
  await relay.accept([wake]);
  assert.equal(f.calls.length, 0);
});
test("DSH job lookup uses a session ID and an unavailable scoped registry falls back to session events", async () => {
  const f = setup();
  Object.defineProperty(f.agent, "ctx", { get() { throw Error("scoped jobs unavailable"); } });
  const relay = createRelay(f.options);
  f.events.push({ type: "job/registered", data: { jobId: "running" } });
  await relay.accept([wake]);
  assert.equal(f.calls.length, 0);
  f.events.push({ type: "job/settled", data: { jobId: "running" } });
  await relay.accept([wake]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.acks.length, 1);
});
test("the current DSH registry receives a session ID and still blocks active jobs", async () => {
  const f = setup();
  let jobs = [{ status: "stopping" }];
  f.agent.ctx = { jobs: { list: (sessionId) => {
    assert.equal(sessionId, wake.sessionId);
    return jobs;
  } } };
  const relay = createRelay(f.options);
  await relay.accept([wake]);
  assert.equal(f.calls.length, 0);
  jobs = [];
  await relay.accept([wake]);
  assert.equal(f.calls.length, 1);
});
test("consumed background event is skipped before DSH admission", async () => {
  const f = setup();
  f.options.api = async () => ({ valid: false });
  await createRelay(f.options).accept([wake]);
  assert.equal(f.calls.length, 0);
});
test("ACK failure for one session does not delay another session", async () => {
  const f = setup();
  const otherWake = { ...wake, id: "other-wake", sessionId: "other-session" };
  f.options.agents.set(otherWake.sessionId, f.agent);
  const original = f.options.api;
  f.options.api = async (action, body) => {
    if (action === "ack" && body.wakeId === wake.id)
      throw Error("first ACK lost");
    return original(action, body);
  };
  await assert.rejects(
    createRelay(f.options).accept([wake, otherWake]),
    /first ACK lost/,
  );
  assert.deepEqual(
    f.calls.map((call) => call.sessionId),
    [wake.sessionId, otherWake.sessionId],
  );
  assert.deepEqual(
    f.acks.map((ack) => ack.wakeId),
    [otherWake.id],
  );
});
test("a pending ACK cannot hold the next heartbeat's other session", async () => {
  const f = setup();
  const otherWake = { ...wake, id: "other-wake", sessionId: "other-session" };
  f.options.agents.set(otherWake.sessionId, f.agent);
  const slow = Promise.withResolvers();
  const ackStarted = Promise.withResolvers();
  const api = f.options.api;
  f.options.api = async (action, body) => {
    if (action === "ack" && body.wakeId === wake.id) {
      ackStarted.resolve();
      await slow.promise;
    }
    return api(action, body);
  };
  const relay = createRelay(f.options);
  const first = relay.accept([wake]);
  await ackStarted.promise;
  const duplicate = relay.accept([wake]);
  try {
    const result = await Promise.race([
      relay.accept([otherWake]).then(() => "delivered"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);
    assert.equal(result, "delivered");
    assert.deepEqual(f.acks.map((entry) => entry.wakeId), [otherWake.id]);
  } finally {
    slow.resolve();
    await Promise.all([first, duplicate]);
  }
  assert.deepEqual(f.calls.map((entry) => entry.sessionId), [wake.sessionId, otherWake.sessionId]);
  assert.deepEqual(f.acks.map((entry) => entry.wakeId), [otherWake.id, wake.id]);
});
test("ambiguous prompt response blocks retries instead of multiplying input", async () => {
  const f = setup();
  f.options.controller.prompt = async (input) => {
    f.calls.push(input);
    throw Error("transport lost");
  };
  let relay = createRelay(f.options);
  await assert.rejects(relay.accept([wake]), /待对账/);
  relay = createRelay(f.options);
  await relay.accept([wake]);
  assert.equal(f.calls.length, 1);
  assert.equal(relay.diagnostics().length, 1);
  f.events.push({
    type: "user/message",
    data: { source: { rpcId: "lingflow-" + wake.id } },
  });
  await relay.accept([wake]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.acks.length, 1);
});

test("explicit host rejection retries the original wake with backoff and stops at the limit", async (t) => {
  const f = setup();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.options.controller.prompt = async (input) => {
    f.calls.push(input);
    if (f.calls.length % 2) throw Object.assign(Error("prompt rejected"), { isDSHRemoteError: true, code: "session/agent-busy" });
    return { accepted: false };
  };
  let relay = createRelay(f.options);
  for (const interval of [2000, 4000, 8000, 16000]) {
    await relay.accept([wake]);
    relay = createRelay(f.options);
    const count = f.calls.length;
    await relay.accept([wake]);
    assert.equal(f.calls.length, count);
    now += interval;
  }
  await relay.accept([wake]);
  assert.equal(f.calls.length, 4);
  assert.equal(relay.diagnostics()[0].state, "exhausted");
  assert.equal(new Set(f.calls.map((input) => input.requestId)).size, 1);
  f.options.controller.prompt = async (input) => { f.calls.push(input); return { accepted: true }; };
  relay = createRelay(f.options);
  await relay.accept([{ ...wake, deliveryRetry: 1 }]);
  assert.equal(f.calls.length, 5);
  assert.equal(f.acks.length, 1);
});
