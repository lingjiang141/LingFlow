import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { readConfig } from "../src/config.mjs";
import {
  ensureService,
  probeInstance,
  requestJson,
  restartService,
} from "../src/instance.mjs";
import { createPanelHost } from "../src/panel-host.mjs";

const scratch = () => {
  mkdirSync(".validation", { recursive: true });
  return mkdtempSync(path.resolve(".validation", "panel-"));
};

/** A port nobody listens on: bind 0, read it, release it. */
const freePort = () =>
  new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Seed a config with an explicit port so tests never touch the real 47831. */
const seed = async (dataDir, port) => {
  const config = readConfig(dataDir);
  writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ ...config, port }),
  );
  return readConfig(dataDir);
};

const fakeResponse = () => ({
  status: 0,
  headers: {},
  body: "",
  finishing: [],
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers ?? {};
  },
  /** The host records one access line per response; stand-in replies emit too. */
  once(event, handler) {
    if (event === "finish") this.finishing.push(handler);
    return this;
  },
  end(body) {
    this.body = String(body ?? "");
    for (const handler of this.finishing.splice(0)) handler();
  },
});

const postRequest = (body) => ({
  method: "POST",
  // The host only accepts writes that speak JSON, so every test write says so.
  headers: { "content-type": "application/json" },
  socket: { remoteAddress: "127.0.0.1" },
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify(body));
  },
});

const getRequest = (headers = {}) => ({
  method: "GET",
  headers: { host: "127.0.0.1:57123", ...headers },
  socket: { remoteAddress: "127.0.0.1" },
  async *[Symbol.asyncIterator]() {},
});

const route = (host, name) => host.routes.find(([label]) => label === name);

test("hello identifies the instance and reports token validity", async (t) => {
  const dataDir = scratch();
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());
  const anonymous = await requestJson(app.port, "/api/ui/hello", {
    method: "GET",
  });
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.json.app, "lingflow");
  assert.equal(anonymous.json.authorized, false);
  assert.equal(anonymous.json.port, app.port);
  const known = await requestJson(app.port, "/api/ui/hello", {
    method: "GET",
    token: app.uiToken,
  });
  assert.equal(known.json.authorized, true);
});

test("shared config keeps one sidebar token and repairs a missing one", async (t) => {
  const dataDir = scratch();
  const first = readConfig(dataDir);
  assert.equal(typeof first.uiToken, "string");
  assert.ok(first.uiToken.length >= 32);
  assert.equal(typeof first.bridgeToken, "string");
  const again = readConfig(dataDir);
  assert.equal(again.uiToken, first.uiToken, "token must never rotate on read");

  const file = path.join(dataDir, "config.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  delete raw.uiToken;
  writeFileSync(file, JSON.stringify(raw));
  const repaired = readConfig(dataDir);
  assert.equal(typeof repaired.uiToken, "string");
  assert.ok(repaired.uiToken.length >= 32);
  assert.equal(repaired.bridgeToken, first.bridgeToken);
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).uiToken,
    repaired.uiToken,
    "repair must be written back so other entrances agree",
  );
});

test("ensureService attaches to a running instance instead of starting another", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  await seed(dataDir, port);
  const app = await startServer({ dataDir, port });
  t.after(() => app.close());
  const attached = await ensureService({ dataDir, timeoutMs: 5000 });
  assert.equal(attached.mode, "external");
  assert.equal(attached.port, port);
  assert.equal(attached.uiToken, app.uiToken);
  const reply = await requestJson(port, "/api/ui/snapshot", {
    token: attached.uiToken,
    body: {},
  });
  assert.equal(reply.status, 200);
  assert.ok(Array.isArray(reply.json.projects));
});

test("ensureService starts exactly one service and reuses it", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  await seed(dataDir, port);
  let owned = null;
  t.after(async () => {
    const pid = owned?.pid;
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  owned = await ensureService({ dataDir, timeoutMs: 25000 });
  assert.equal(owned.mode, "owned");
  assert.ok(Number.isInteger(owned.pid));
  const probe = await probeInstance(port, { token: owned.uiToken });
  assert.equal(probe.running, true);
  assert.equal(probe.authorized, true);
  const second = await ensureService({ dataDir, timeoutMs: 5000 });
  assert.equal(second.mode, "owned");
  assert.equal(second.pid, owned.pid);
  assert.equal(second.port, port);
});

test("restartService refuses a service it did not start", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  await seed(dataDir, port);
  const app = await startServer({ dataDir, port });
  t.after(() => app.close());
  await assert.rejects(
    () => restartService({ dataDir }),
    /不是由侧边栏启动/,
  );
  assert.equal((await probeInstance(port, { token: app.uiToken })).running, true);
});

test("panel host proxies one shared service and never leaks tokens", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  await seed(dataDir, port);
  const app = await startServer({ dataDir, port });
  t.after(() => app.close());

  const first = createPanelHost({ dataDir, port });
  const second = createPanelHost({ dataDir, port });
  const shared = readConfig(dataDir);
  const status = fakeResponse();
  await route(first, "status")[3]({ method: "GET" }, status);
  const statusBody = JSON.parse(status.body);
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.online, true);
  assert.equal(statusBody.service.port, port);
  assert.equal(statusBody.service.mode, "external");
  assert.equal(JSON.stringify(statusBody).includes(app.uiToken), false);
  assert.equal(JSON.stringify(statusBody).includes(shared.bridgeToken), false);

  const created = fakeResponse();
  await route(first, "call")[3](
    postRequest({
      command: "createProject",
      args: { name: "侧边栏项目", root: dataDir },
      operationId: "panel-create",
    }),
    created,
  );
  const createdBody = JSON.parse(created.body);
  assert.equal(createdBody.ok, true);
  assert.equal(typeof createdBody.result.id, "string");

  const snapshot = fakeResponse();
  await route(second, "snapshot")[3](postRequest({}), snapshot);
  const snapshotBody = JSON.parse(snapshot.body);
  assert.equal(snapshotBody.ok, true);
  assert.equal(snapshotBody.snapshot.projects.length, 1);
  assert.equal(snapshotBody.snapshot.projects[0].name, "侧边栏项目");

  const rejected = fakeResponse();
  await route(first, "call")[3](
    postRequest({ command: "notACommand", args: {}, operationId: "panel-bad" }),
    rejected,
  );
  const rejectedBody = JSON.parse(rejected.body);
  assert.equal(rejectedBody.ok, false);
  assert.match(rejectedBody.error, /未知命令|不支持/);
});

test("panel host restart refuses a window-hosted service", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  await seed(dataDir, port);
  const app = await startServer({ dataDir, port });
  t.after(() => app.close());
  const host = createPanelHost({ dataDir, port });
  const response = fakeResponse();
  await route(host, "restart")[3](postRequest({}), response);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /独立窗口/);
});

test("panel host starts the shared service on demand", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  await seed(dataDir, port);
  let owned = null;
  t.after(async () => {
    if (owned?.pid) {
      try {
        process.kill(owned.pid);
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  const host = createPanelHost({ dataDir, port });
  const response = fakeResponse();
  await route(host, "start")[3](postRequest({}), response);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.service.running, true);
  assert.equal(body.service.mode, "owned");
  owned = { pid: body.service.pid };
  assert.ok(Number.isInteger(owned.pid));
});

test("panel host reloads an idle owned service when LingFlow code changes", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  await seed(dataDir, port);
  let owned = null;
  const cleanup = async () => {
    const pid = owned?.pid;
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  };
  t.after(cleanup);

  owned = await ensureService({ dataDir, timeoutMs: 25000 });
  // The first read is stale on purpose: the code stamp is far in the future.
  let stamp = Date.now() + 60_000;
  const host = createPanelHost({ dataDir, port, codeStamp: () => stamp });
  const first = fakeResponse();
  await route(host, "status")[3]({ method: "GET" }, first);
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.online, true);
  assert.equal(firstBody.code.autoReloaded, true, "空闲时应自动重载");
  assert.equal(firstBody.code.changed, false);
  const reloaded = firstBody.service.pid;
  assert.ok(reloaded !== owned.pid, "自动重载必须换一个服务进程");
  owned = { pid: reloaded };

  // A reader who keeps the page open sees `changed` again only after new edits.
  stamp = Date.now() - 120_000;
  const second = fakeResponse();
  await route(host, "status")[3]({ method: "GET" }, second);
  assert.equal(JSON.parse(second.body).code.changed, false);
});

test("panel host never auto-reloads while a role is enabled", async (t) => {
  const dataDir = scratch();
  const port = await freePort();
  const config = await seed(dataDir, port);
  let owned = null;
  t.after(async () => {
    const pid = owned?.pid;
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  owned = await ensureService({ dataDir, timeoutMs: 25000 });

  const ui = async (command, args, operationId) => {
    const reply = await requestJson(port, "/api/ui/call", {
      token: owned.uiToken,
      body: { command, args, operationId },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    return reply.json;
  };
  const project = await ui("createProject", { name: "自动同步", root: dataDir }, "auto-project");
  const role = await ui("addRole", { projectId: project.id, kind: "developer", name: "开发" }, "auto-role");
  const request = await requestJson(port, "/api/bridge/request", {
    token: config.bridgeToken,
    body: { roleId: role.id, sessionId: "auto-session", cwd: dataDir },
  });
  assert.equal(request.status, 200, JSON.stringify(request.json));
  await ui("confirmBinding", { requestId: request.json.id }, "auto-bind");
  await ui("enable", { roleId: role.id, enabled: true }, "auto-enable");

  const host = createPanelHost({ dataDir, port, codeStamp: () => Date.now() + 60_000 });
  const response = fakeResponse();
  await route(host, "status")[3]({ method: "GET" }, response);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.code.autoReloaded, false, "有启用角色时不得自动重载");
  assert.equal(body.code.changed, true, "应提示需要重启服务");
  assert.equal(body.service.pid, owned.pid, "进程必须保持不变");
  assert.equal(body.service.running, true);
});

test("panel host frames the real page by redirecting to the shared service", async (t) => {
  const dataDir = scratch();
  // The window owns the service in this scenario; the sidebar only attaches.
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());
  await seed(dataDir, app.port);

  const host = createPanelHost({ dataDir, port: app.port });
  const response = fakeResponse();
  await route(host, "frame")[3](getRequest(), response);

  assert.equal(response.status, 302, "frame 路由必须用重定向把令牌挡在渲染层之外");
  assert.equal(
    response.headers.Location,
    `http://127.0.0.1:${app.port}/#${app.uiToken}`,
    "必须重定向到共享服务，并带上该服务当前的 uiToken",
  );
  assert.equal(response.body, "", "重定向响应体不得包含令牌");
});

test("panel host refuses a cross-site or remote embed of the frame", async (t) => {
  const dataDir = scratch();
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());
  await seed(dataDir, app.port);
  const host = createPanelHost({ dataDir, port: app.port });

  const crossSite = fakeResponse();
  await route(host, "frame")[3](getRequest({ "sec-fetch-site": "cross-site" }), crossSite);
  assert.equal(crossSite.status, 200);
  assert.match(JSON.parse(crossSite.body).error, /跨站/);

  const remote = fakeResponse();
  const remoteRequest = { ...getRequest(), socket: { remoteAddress: "10.1.2.3" } };
  await route(host, "frame")[3](remoteRequest, remote);
  assert.match(JSON.parse(remote.body).error, /本机/);
});

test("panel host explains the failure inside the frame instead of a blank pane", async (t) => {
  const dataDir = scratch();
  const host = createPanelHost({
    dataDir,
    port: 1,
    startService: async () => {
      throw Error("模拟 <启动> 失败");
    },
  });
  const response = fakeResponse();
  await route(host, "frame")[3](getRequest(), response);
  assert.equal(response.status, 503);
  assert.match(String(response.headers["Content-Type"]), /text\/html/);
  assert.match(response.body, /LingFlow 服务未连接/);
  assert.match(response.body, /模拟 &lt;启动&gt; 失败/, "错误文本必须转义后再进页面");
});

test("panel host only accepts JSON writes on loopback plugin routes", async (t) => {
  const dataDir = scratch();
  let starts = 0;
  const host = createPanelHost({
    dataDir,
    port: 1,
    startService: async () => {
      starts += 1;
      throw Error("不应被调用");
    },
  });

  const formPost = fakeResponse();
  const request = {
    method: "POST",
    headers: { "content-type": "text/plain" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"command":"deleteProject"}');
    },
  };
  await route(host, "snapshot")[3](request, formPost);
  const body = JSON.parse(formPost.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /application\/json/);
  assert.equal(starts, 0, "被拒绝的请求不得触发服务启动");

  const crossSite = fakeResponse();
  await route(host, "snapshot")[3](
    { ...postRequest({}), headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" } },
    crossSite,
  );
  assert.match(JSON.parse(crossSite.body).error, /跨站/);
});

test("served page allows framing from loopback parents only", async (t) => {
  const dataDir = scratch();
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());

  const reply = await new Promise((resolve, reject) => {
    const call = http.get(
      { host: "127.0.0.1", port: app.port, path: "/", headers: { accept: "text/html" } },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
      },
    );
    call.on("error", reject);
  });

  assert.equal(reply.status, 200);
  assert.match(reply.text, /LingFlow/, "侧边栏嵌入的就是这个页面");
  const csp = String(reply.headers["content-security-policy"] || "");
  assert.match(csp, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\*/, "必须允许回环祖先嵌入");
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("frame-ancestors"));
  assert.ok(directive, "缺少 frame-ancestors 指令");
  // dsh-app: is the privileged scheme the DSH desktop app serves its own
  // documents from, so that is the ancestor the sidebar really has.
  const loopback = ["http://127.0.0.1:", "http://localhost:", "dsh-app:"];
  for (const source of directive.replace("frame-ancestors", "").trim().split(/\s+/)) {
    assert.ok(
      source === "'self'" || loopback.some((prefix) => source.startsWith(prefix)),
      "frame-ancestors 只允许本机与 DSH 桌面壳祖先，收到：" + source,
    );
  }
});

test("panel host writes the renderer breadcrumbs it cannot show anywhere else", async (t) => {
  const dataDir = scratch();
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());
  const host = createPanelHost({ dataDir, port: app.port });

  const logged = fakeResponse();
  const logRoute = route(host, "log");
  await logRoute[3](
    postRequest({
      events: [
        { at: 1, event: "mount", detail: '{"bridge":"no"}' },
        { at: 2, event: "frame-timeout", detail: "iframe" },
      ],
      userAgent: "test-agent",
      href: "/",
    }),
    logged,
  );
  assert.equal(JSON.parse(logged.body).ok, true);

  const lines = readFileSync(path.join(dataDir, "panel-client.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2, "每条事件都是一行，便于事后 grep");
  assert.equal(lines[0].event, "mount");
  assert.equal(lines[1].event, "frame-timeout");
  assert.equal(lines[1].userAgent, "test-agent");

  // The access trace answers the other half: was the frame even requested?
  const status = fakeResponse();
  await route(host, "status")[3](getRequest(), status);
  const statusBody = JSON.parse(status.body);
  assert.ok(
    statusBody.logs && statusBody.logs.client.endsWith("panel-client.log"),
    "状态里要给出日志路径，否则白屏无从查起",
  );
  const access = readFileSync(path.join(dataDir, "panel-access.log"), "utf8");
  assert.match(access, /"label":"log"/);
  assert.match(access, /"label":"status"/);
  assert.ok("frame" in statusBody, "状态要带上 frame 请求计数");
  assert.equal(typeof statusBody.frame.requests, "number");
});

test("panel host opens the desktop window on request and reports why it cannot", async (t) => {
  const dataDir = scratch();
  const app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());

  // Injected: a unit test must not launch a real window.
  const opened = [];
  const host = createPanelHost({
    dataDir,
    port: app.port,
    openWindow: () => {
      opened.push(true);
      return { pid: 4242 };
    },
  });
  const open = route(host, "open");
  assert.ok(open, "缺少 /open 路由");
  assert.equal(open[1], "POST");
  const response = fakeResponse();
  await open[3](postRequest({}), response);
  assert.deepEqual(JSON.parse(response.body), { ok: true, pid: 4242 });
  assert.equal(opened.length, 1);

  const broken = createPanelHost({
    dataDir,
    port: app.port,
    openWindow: () => {
      throw Error("找不到 Electron 可执行文件；请在 E:\\LingFlow 里运行 npm start 打开独立窗口");
    },
  });
  const failure = fakeResponse();
  await route(broken, "open")[3](postRequest({}), failure);
  const body = JSON.parse(failure.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /npm start/, "失败要告诉读者怎么手动打开");
});
