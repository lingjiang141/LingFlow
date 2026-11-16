import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { apply } from "../adapters/dsh/index.mjs";
import { createDshTelemetry } from "../adapters/dsh/telemetry.mjs";

test("DSH dispatch timeout checks the original receipt without resubmitting", async (t) => {
  mkdirSync(".validation", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".validation", "dispatch-receipt-"));
  const toolsModule = path.join(dataDir, "define-tool.mjs");
  writeFileSync(toolsModule, "export const defineTool = (definition) => definition;");
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ port: 1, bridgeToken: "fixture" }));
  const definitions = new Map();
  const agent = { id: "fixture-session", ctx: { tools: { register: (def) => definitions.set(def.name, def) } } };
  const requests = [];
  let stored = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/bindings")) return Response.json({ sessions: [agent.id] });
    const request = JSON.parse(options.body);
    if (url.endsWith("/policy")) return Response.json({ timeoutMs: 300000 });
    requests.push(request);
    if (request.command === "dispatchPlan") throw new DOMException("timeout", "TimeoutError");
    return Response.json(stored ? { state: "stored", result: { receipt: "accepted", planId: "original" } } : { state: "unknown" });
  });
  const cleanups = [];
  t.after(() => cleanups.reverse().forEach((dispose) => dispose()));
  await apply({
    agents: { list: () => [agent] }, sessionController: {}, on() {},
    effect: (setup) => {
      const dispose = setup();
      if (typeof dispose === "function") cleanups.push(dispose);
    },
  }, { dataDir, toolsModule });
  const team = definitions.get("lingflow_team");
  const command = { command: "dispatchPlan", args: JSON.stringify({ requirementId: "fixture", sources: {}, tickets: [] }), operationId: "stable-dispatch" };
  assert.deepEqual(await team.execute(command, { agent }),
    { receipt: "accepted", planId: "original", recoveredOperationId: command.operationId });
  assert.deepEqual(requests.map(({ command }) => command), ["dispatchPlan", "operation"]);
  assert.deepEqual(requests.at(-1).args, { id: command.operationId });
  requests.length = 0;
  stored = false;
  const unresolved = await team.execute(command, { agent });
  assert.equal(unresolved.state, "unconfirmed");
  assert.equal(unresolved.receiptState, "unknown");
  assert.equal(unresolved.confirmationRequired, false);
  assert.deepEqual(unresolved.nextAction, { command: "operation", args: { id: command.operationId } });
  assert.match(unresolved.message, /原命令、参数和同一 operationId/);
  assert.deepEqual(requests.map(({ command }) => command), ["dispatchPlan", "operation"]);
});

test("long check waits past the former five-second deadline and keeps its operation ID", async (t) => {
  mkdirSync(".validation", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".validation", "check-timeout-"));
  const toolsModule = path.join(dataDir, "define-tool.mjs");
  writeFileSync(toolsModule, "export const defineTool = (definition) => definition;");
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ port: 1, bridgeToken: "fixture" }));
  const definitions = new Map(), cleanup = [];
  const agent = { id: "fixture", ctx: { tools: { register: (tool) => definitions.set(tool.name, tool) } } };
  const deadlines = [];
  let timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => { timeout = ms; return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/bindings")) return Response.json({ sessions: [agent.id] });
    const body = JSON.parse(options.body);
    if (url.endsWith("/policy")) return Response.json({ timeoutMs: 300000 });
    deadlines.push(timeout);
    assert.equal(body.operationId, "stable-check");
    if (timeout < 17000) throw new DOMException("timeout", "TimeoutError");
    return Response.json({ jobId: "check-job", state: "queued" });
  });
  await apply({ agents: { list: () => [agent] }, sessionController: {}, on() {}, effect: (run) => cleanup.push(run()) }, { dataDir, toolsModule });
  t.after(() => cleanup.forEach((dispose) => typeof dispose === "function" && dispose()));
  const result = await definitions.get("lingflow_team").execute({ command: "check", args: JSON.stringify({ taskId: "fixture", checkId: "focused" }), operationId: "stable-check" }, { agent });
  assert.equal(result.jobId, "check-job");
  assert.equal(deadlines.length, 1);
  assert.ok(deadlines[0] >= 300000);
});

test("DSH telemetry distinguishes a provider outage from cancellation and permanent failure", () => {
  const listeners = new Map();
  const now = Date.now();
  const session = {
    snapshotEvents: () => [
      { type: "turn/start", seq: 10, time: now - 300 },
      {
        type: "turn/end",
        seq: 11,
        time: now - 200,
        data: {
          reason: {
            kind: "error",
            error: { code: "503", message: "service unavailable" },
          },
        },
      },
    ],
  };
  const agent = { session };
  const observe = createDshTelemetry({
    on: (name, listener) => listeners.set(name, listener),
  });
  assert.equal(observe(agent).turn.outcome, "transient");
  assert.equal(observe(agent).turn.code, "503");
  const event = (type, seq, time, reason) =>
    listeners.get("session/event")(session, {
      type,
      seq,
      time,
      data: { reason },
    });
  event("turn/start", 12, now - 100);
  listeners.get("agent/assistant-stream")({ agent });
  event("turn/end", 13, now - 50, {
    kind: "aborted",
    reason: { kind: "user" },
  });
  assert.equal(observe(agent).turn.outcome, "cancelled");
  event("turn/start", 14, now + 10);
  event("turn/end", 15, now + 20, {
    kind: "provider-error",
    error: { code: "429", message: "insufficient quota" },
  });
  assert.equal(observe(agent).turn.outcome, "failed");
  assert.equal(observe(agent).turn.code, "429");
});
