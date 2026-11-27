import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readConfig } from "../src/config.mjs";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { CONTROLLER_TURN_RULE } from "../src/role-context.mjs";
import { createRelay } from "../adapters/dsh/relay.mjs";
test("HTTP API authenticates, rejects foreign origin and persists state", async (t) => {
  mkdirSync(".validation", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".validation", "http-"));
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.port;
  assert.equal((await fetch(base + "/")).status, 200);
  const post = (route, token, body = {}, headers = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/api/ui/snapshot", "wrong")).status, 401);
  assert.equal(
    (
      await post(
        "/api/ui/snapshot",
        app.uiToken,
        {},
        { Origin: "https://example.com" },
      )
    ).status,
    400,
  );
  const res = await post("/api/ui/call", app.uiToken, {
    command: "createProject",
    operationId: "once",
    args: { name: "API项目", root: dataDir },
  });
  assert.equal(res.status, 200);
  const { id: projectId } = await res.json();
  const cache = await post("/api/ui/call", app.uiToken, { command: "buildCache", args: { projectId } });
  assert.equal(cache.status, 200);
  assert.deepEqual(await cache.json(), { entries: [], hits: 0, misses: 0, savedMs: 0 });
  assert.equal(
    (await (await post("/api/ui/snapshot", app.uiToken)).json()).projects
      .length,
    1,
  );
  const config = JSON.parse(readFileSync(path.join(dataDir, "config.json")));
  assert.equal(
    (await post("/api/ui/snapshot", config.bridgeToken)).status,
    401,
  );
  assert.equal(
    (
      await post("/api/bridge/call", config.bridgeToken, {
        sessionId: "ui",
        command: "list",
      })
    ).status,
    400,
  );
});

test("controller gets a quiet startup card and the turn rule when reading context or receiving real work", async (t) => {
  mkdirSync(".validation", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".validation", "controller-turn-"));
  const configuration = readConfig(dataDir);
  // This integration test checks transport and context ACK, while the merge
  // window is exercised separately with a deterministic clock.
  writeFileSync(configuration.path, JSON.stringify({ ...configuration, execution: { wakeCoalesceMs: 0 } }));
  const root = path.join(dataDir, "project");
  mkdirSync(root);
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());
  const { bridgeToken } = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));
  async function post(route, token, body) {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/${route}`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  const api = (action, body) => post("bridge/" + action, bridgeToken, body);
  let seq = 0;
  const ui = (command, args) => post("ui/call", app.uiToken, { command, args, operationId: "ui-" + ++seq });
  const call = (sessionId, command, args, operationId) => api("call", { sessionId, command, args, operationId });
  const project = await ui("createProject", {
    name: "主控回合验证",
    root,
    members: [{ kind: "controller", name: "主控" }, { kind: "developer", name: "开发" }],
  });
  await ui("setControllerPolicy", { projectId: project.id, policy: "项目自定义行为规范" });
  const agents = new Map();
  const prompts = [];
  const roles = (await api("catalog", {}))[0].roles;
  for (const { id, kind } of roles) {
    const binding = await api("request", { roleId: id, sessionId: kind, cwd: root });
    await ui("confirmBinding", { requestId: binding.id });
    await ui("enable", { roleId: id, enabled: true });
    agents.set(kind, { id: kind, status: "idle", inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => [] } });
  }
  const relay = createRelay({
    file: path.join(dataDir, "admissions.json"), agents, api,
    controller: { prompt: async (input) => {
      prompts.push(input);
      return { accepted: true };
    } },
  });
  async function heartbeat() {
    const sessions = [...agents].map(([id, agent]) => ({ id, state: agent.status, pending: 0, jobs: 0 }));
    const { deliveries } = await api("heartbeat", { sessions });
    await relay.accept(deliveries);
    return deliveries;
  }
  const lastPrompt = (sessionId) => prompts.findLast((p) => p.sessionId === sessionId)?.content[0].text;

  const startup = await heartbeat();
  assert.equal(startup.length, 1);
  assert.equal(startup[0].silent, true);
  assert.equal(startup[0].actionable, false);
  assert.match(lastPrompt("controller"), /角色已开启 · 本轮无责任/);
  assert.match(lastPrompt("controller"), /亲自实现或修复/);
  assert.doesNotMatch(lastPrompt("controller"), /下一步|角色上下文/);
  assert.equal(lastPrompt("developer"), undefined);
  const { context } = await call("controller", "inbox");
  assert.ok(context.rules.includes(CONTROLLER_TURN_RULE));
  assert.match(JSON.stringify(context), /项目自定义行为规范/);
  const laterInbox = await call("controller", "inbox");
  assert.equal(laterInbox.context, undefined);
  assert.match(laterInbox.controllerBoundary, /亲自实现或修复.*回投责任开发/);
  const developerInbox = await call("developer", "inbox");
  assert.ok(!developerInbox.context.rules.includes(CONTROLLER_TURN_RULE));
  assert.equal(developerInbox.controllerBoundary, undefined);
  assert.ok((await call("controller", "context")).rules.includes(CONTROLLER_TURN_RULE));
  assert.ok((await call("controller", "guide")).guide.includes(CONTROLLER_TURN_RULE));

  const roleId = roles.find((r) => r.kind === "controller").id;
  await ui("enable", { roleId, enabled: false });
  await ui("enable", { roleId, enabled: true });
  await heartbeat();
  assert.match(lastPrompt("controller"), /角色已开启/);
  assert.ok((await call("controller", "inbox")).context.rules.includes(CONTROLLER_TURN_RULE));

  agents.get("controller").status = "running";
  const requirement = await call("controller", "approve", { text: "核对测试输入", source: "验收夹具" }, "approve");
  const args = {
    requirementId: requirement.id,
    developerId: roles.find((r) => r.kind === "developer").id,
    title: "核对测试输入", description: "只读核对", risk: "low", readOnly: true, writes: [],
  };
  const dispatch = await call("controller", "dispatch", args, "dispatch");
  assert.equal(dispatch.turnRule, CONTROLLER_TURN_RULE);
  assert.equal((await call("controller", "list")).tasks[0].deliveryState, "pending");
  const receipt = await call("controller", "operation", { id: "dispatch" });
  assert.equal(receipt.state, "stored");
  assert.equal(receipt.result.taskId, dispatch.taskId);
  assert.match(receipt.controllerBoundary, /亲自实现或修复/);
  for (const command of ["inspect", "diagnoseTask"])
    assert.match((await call("controller", command, { taskId: dispatch.taskId })).controllerBoundary, /亲自实现或修复/);

  // Model-free host fixture ends the dispatch turn and makes no status calls.
  agents.get("controller").status = "idle";
  assert.deepEqual((await heartbeat()).map((wake) => wake.sessionId), ["developer"]);
  assert.equal((await call("controller", "list")).tasks[0].deliveryState, "delivered");
  assert.deepEqual(await heartbeat(), []);
  assert.equal((await call("developer", "inbox")).tasks[0].id, dispatch.taskId);
  const report = await call("developer", "report", {
    taskId: dispatch.taskId, summary: "输入核对完成",
    dimensions: {
      requirements: { state: "pass", evidence: "夹具要求核对输入" },
      implementation: { state: "pass", evidence: "夹具实际读取输入" },
      system: { state: "pass", evidence: "只读，无工作区写入" },
    },
    checks: [{ command: "read", exitCode: 0, evidence: "验收夹具" }],
  }, "report");
  assert.equal(report.state, "stored");
  assert.deepEqual((await heartbeat()).map((wake) => wake.sessionId), ["controller"]);
  const followup = lastPrompt("controller");
  assert.match(followup, /LingFlow · .*主控/);
  assert.match(followup, /开发报告已入库.*核对测试输入/);
  assert.match(followup, /输入核对完成[\s\S]*开发自测：需求正确性 通过/);
  assert.ok(followup.length < 800);
  const inbox = await call("controller", "inbox");
  assert.equal(inbox.notices[0].taskId, dispatch.taskId);
  const task = await call("controller", "inspect", { taskId: dispatch.taskId });
  assert.equal(task.id, dispatch.taskId);
  assert.equal(task.reports[0].summary, "输入核对完成");
  assert.equal((await call("controller", "list")).tasks[0].id, dispatch.taskId);
  assert.deepEqual(await heartbeat(), []);
});

test("open-project-tool validates authorization, project id and tool", async (t) => {
  mkdirSync(".validation", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".validation", "open-tool-"));
  const opened = [];
  const app = await startServer({
    dataDir,
    port: 0,
    openProjectTool(root, tool) {
      if (!["folder", "cmd"].includes(tool)) throw Error("未知项目工具");
      opened.push({ root, tool });
      return { ok: true };
    },
  });
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.port;
  const post = (route, token, body = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const created = await (await post("/api/ui/call", app.uiToken, {
    command: "createProject",
    operationId: "p-tool",
    args: { name: "工具测试", root: dataDir },
  })).json();
  assert.equal((await post("/api/ui/open-project-tool", "bad", { projectId: created.id, tool: "folder" })).status, 401);
  assert.equal((await post("/api/ui/open-project-tool", app.uiToken, { projectId: "missing", tool: "folder" })).status, 400);
  assert.equal((await post("/api/ui/open-project-tool", app.uiToken, { projectId: created.id, tool: "powershell" })).status, 400);
  const r1 = await post("/api/ui/open-project-tool", app.uiToken, { projectId: created.id, tool: "folder" });
  const r2 = await post("/api/ui/open-project-tool", app.uiToken, { projectId: created.id, tool: "cmd" });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.deepEqual(opened, [{ root: dataDir, tool: "folder" }, { root: dataDir, tool: "cmd" }]);
});
