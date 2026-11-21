import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../adapters/dsh/index.mjs";
import { Workflow } from "../src/workflow.mjs";

test("bridge classifies only enabled, bound DSH controllers for the wait policy", () => {
  const roles = [
    { kind: "controller", sessionId: "lead", enabled: true },
    { kind: "controller", sessionId: "disabled" },
    { kind: "controller", sessionId: "codex", enabled: true, provider: "codex" },
    { kind: "controller", sessionId: "archived", enabled: true, archivedAt: 1 },
    { kind: "developer", sessionId: "dev", enabled: true },
  ];
  const wf = new Workflow({ read: () => ({ roles }) }, { readOnly: true });
  assert.deepEqual(wf.bridgeBindings(), { sessions: ["lead", "disabled", "dev"], controllerSessions: ["lead"] });
});

test("controller wait is hidden and blocked, and a wait-only step yields without dropping input", async t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "lingflow-wait-policy-"));
  const toolsModule = path.join(dataDir, "define-tool.mjs");
  const cleanup = [], hooks = new Map(), denials = new Set();
  const createAgent = (id) => {
    const definitions = new Map();
    const restrictions = new Set();
    return { id, session: {}, inbox: { nextStep: [], nextTurn: [] }, restrictions,
      ctx: { tools: {
        register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); },
        get(name) { return definitions.get(name); },
        restrict({ deny }) {
          for (const name of deny) restrictions.add(name);
          return () => { for (const name of deny) restrictions.delete(name); };
        },
      } },
    };
  };
  const lead = createAgent("lead"), dev = createAgent("dev"), other = createAgent("other");
  const agents = [lead, dev, other];
  let controllers = [lead.id];
  let available = true;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(url.endsWith("/bindings"), url);
    if (!available) return Response.json({ error: "offline" }, { status: 503 });
    return Response.json({ sessions: [lead.id, dev.id], controllerSessions: controllers });
  });
  writeFileSync(toolsModule, "export const defineTool = (definition) => definition;");
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ port: 1, bridgeToken: "fixture" }));
  t.after(() => {
    cleanup.reverse().forEach(dispose => dispose());
    rmSync(dataDir, { recursive: true, force: true });
  });
  await apply({
    agents: { list: () => agents }, sessionController: {},
    tools: { get: name => name === "wait_agent", guard: fn => { denials.add(fn); return () => denials.delete(fn); } },
    logger: () => ({ warn() {} }),
    on(event, listener) { hooks.set(event, [...(hooks.get(event) ?? []), listener]); },
    effect(setup) { const dispose = setup(); if (typeof dispose === "function") cleanup.push(dispose); },
  }, { toolsModule, dataDir });
  const guarded = (agent, name) => [...denials].map(guard => guard({ agent, name })).find(Boolean);
  const emit = (session, event) => hooks.get("session/event").forEach(listener => listener(session, event));
  const assistant = (agent, turn, step, ...names) => {
    emit(agent.session, { type: "assistant/message", data: {
      turn, step, message: { content: names.map((name, id) => ({ type: "tool-call", name, id: String(id) })) },
    } });
    for (const [id, name] of names.entries()) {
      if (name === "wait_agent")
        emit(agent.session, { type: "tool/result", data: {
          turn, step, message: { toolCallId: String(id), isError: true }, error: { code: "UNKNOWN_TOOL" },
        } });
    }
  };
  const step = (agent, turn, n, messages = []) => {
    const listeners = hooks.get("agent/pre-step");
    const next = i => i === listeners.length ? { kind: "enter", messages }
      : listeners[i]({ agent, messages, turn, step: n }, () => next(i + 1));
    return next(0);
  };
  const preExecute = (agent, name) => {
    const listeners = hooks.get("tools/pre-execute");
    const next = i => i === listeners.length ? { kind: "allow" }
      : listeners[i]({ agent, name }, () => next(i + 1));
    return next(0);
  };
  assert.ok(lead.restrictions.has("wait_agent"));
  assert.equal(dev.restrictions.size + other.restrictions.size, 0);
  assert.ok(guarded(lead, "wait_agent"));
  assert.equal(guarded(dev, "wait_agent"), undefined);
  assert.equal(guarded(other, "wait_agent"), undefined);
  assert.equal(guarded(lead, "lingflow_team"), undefined);

  assistant(lead, 1, 1, "wait_agent");
  assert.equal((await step(lead, 1, 2)).kind, "reject");
  assert.equal((await step(lead, 1, 2)).kind, "enter", "the matched step is closed once");
  assistant(lead, 1, 3, "wait_agent", "lingflow_team");
  assert.equal((await step(lead, 1, 4)).kind, "enter", "a mixed batch still gets a model response");
  assistant(lead, 1, 5, "wait_agent");
  const human = { source: { kind: "user" } };
  assert.deepEqual(await step(lead, 1, 6, [human]), { kind: "enter", messages: [human] });
  assistant(lead, 1, 6, "wait_agent");
  lead.inbox.nextTurn.push(human);
  assert.equal((await step(lead, 1, 7)).kind, "enter", "queued input stays in the host driver");
  lead.inbox.nextTurn.length = 0;
  assistant(lead, 1, 7, "wait_agent");
  assert.equal((await step(lead, 2, 8)).kind, "enter", "a previous turn never closes a new turn");
  assistant(dev, 1, 1, "wait_agent");
  assert.equal((await step(dev, 1, 2)).kind, "enter");

  available = false;
  await preExecute(lead, "wait_agent");
  assert.ok(guarded(lead, "wait_agent"), "a transient server failure keeps the last known binding");
  available = true;
  controllers = [other.id];
  await preExecute(other, "wait_agent");
  assert.equal(guarded(lead, "wait_agent"), undefined);
  assert.ok(guarded(other, "wait_agent"), "a stale proposal refreshes current bindings before the guard runs");
  assert.equal(lead.restrictions.size, 0);
  assert.ok(other.restrictions.has("wait_agent"));
});
