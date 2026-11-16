#!/usr/bin/env node
/**
 * Isolated end-to-end drill for the LingFlow sidebar panel.
 *
 *   node scripts/panel-e2e.mjs
 *
 * Runs against a throwaway data directory and port (never the live 47831 and
 * never %LOCALAPPDATA%), starts the shared service through the same
 * `ensureService` path the panel uses, then drives three entrances at once:
 *
 *   A. panel host #1 (what the DSH sidebar calls)
 *   B. panel host #2 (a second sidebar-like client)
 *   C. direct /api/ui/* with the shared token (what the standalone window does)
 *
 * It creates an isolated project and two DSH-session stand-ins over the bridge
 * API, has the controller approve and dispatch a read-only ticket, has the
 * developer report back, and then asserts that every entrance sees the same
 * state and that the business event produced exactly one wake.
 */
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.mjs";
import { ensureService, requestJson, restartService } from "../src/instance.mjs";
import { createPanelHost } from "../src/panel-host.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const validation = path.join(ROOT, ".validation");
mkdirSync(validation, { recursive: true });
const BASE = mkdtempSync(path.join(validation, "panel-e2e-"));
const DATA = path.join(BASE, "data");
const PROJECT = path.join(BASE, "project");
const REPORT = path.join(BASE, "report.json");

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, ok: !!condition, detail });
  console.log((condition ? "  ✔ " : "  ✘ ") + name + (detail ? "  " + detail : ""));
  if (!condition) throw Error("验证失败：" + name + " " + detail);
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Mount a panel host's routes on a loopback server, like the DSH webServer does. */
function mount(routes) {
  const server = http.createServer((request, response) => {
    const found = routes.find(
      ([, method, routePath]) =>
        request.url === routePath && request.method === method,
    );
    if (!found) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not-found" }));
      return;
    }
    return found[3](request, response);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        call: async (route, body) => {
          const response = await fetch(
            "http://127.0.0.1:" + server.address().port + route,
            {
              method: body === undefined ? "GET" : "POST",
              headers: { "Content-Type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            },
          );
          return response.json();
        },
        /** A navigation-style read: no redirect following, headers kept. */
        raw: async (route, { method = "GET", headers } = {}) => {
          const response = await fetch(
            "http://127.0.0.1:" + server.address().port + route,
            { method, headers, redirect: "manual" },
          );
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            text: await response.text(),
          };
        },
      }),
    ),
  );
}

/** Read a URL as the embedded frame / a browser would. */
async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: "follow" });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: await response.text(),
  };
}

async function main() {
  mkdirSync(DATA, { recursive: true });
  mkdirSync(PROJECT, { recursive: true });

  const port = await freePort();
  const config = readConfig(DATA);
  const { writeFileSync: write } = await import("node:fs");
  write(
    path.join(DATA, "config.json"),
    JSON.stringify({ ...config, port }, null, 2),
  );

  console.log("隔离环境：dataDir=" + DATA + " port=" + port);
  let service = await ensureService({ dataDir: DATA, port, timeoutMs: 30000 });
  console.log("共享服务：" + service.mode + " pid=" + service.pid);

  const hostA = createPanelHost({ dataDir: DATA, port });
  const hostB = createPanelHost({ dataDir: DATA, port });
  const sideA = await mount(hostA.routes);
  const sideB = await mount(hostB.routes);
  let killed = false;
  const cleanup = () => {
    sideA.server.close();
    sideB.server.close();
    if (service.mode === "owned" && service.pid && !killed) {
      killed = true;
      try {
        process.kill(service.pid);
      } catch {
        // Already gone.
      }
    }
  };

  try {
    // --- entrance A: sidebar status -----------------------------------------
    const status = await sideA.call("/lingflow-panel/api/status");
    check("侧边栏状态接口在线", status.ok && status.online === true);
    check("服务由侧边栏持有（可重启）", status.service?.mode === "owned", status.service?.mode);
    check("状态不泄露令牌", !JSON.stringify(status).includes(service.uiToken));

    // --- entrance A: the sidebar shows the real page, not a copy of it ------
    const frame = await sideA.raw("/lingflow-panel/api/frame");
    check("侧边栏 frame 路由重定向", frame.status === 302, String(frame.status));
    check(
      "frame 指向共享服务当前地址",
      frame.headers.location === `${service.origin}/#${service.uiToken}`,
      frame.headers.location,
    );
    check("frame 响应体不含令牌", frame.text === "", frame.text.slice(0, 80));

    const page = await fetchText(service.origin + "/");
    check("嵌入页就是独立窗口加载的页面", page.status === 200 && /LingFlow/.test(page.text), String(page.status));
    check(
      "页面允许回环祖先嵌入",
      /frame-ancestors[^;]*http:\/\/127\.0\.0\.1:\*/.test(page.headers["content-security-policy"] || ""),
      page.headers["content-security-policy"],
    );
    const assets = ["/style.css", "/cards.css", "/theme.js", "/app.js", "/appearance.js"];
    for (const asset of assets) {
      const reply = await fetchText(service.origin + asset);
      check("嵌入页能取到样式与脚本：" + asset, reply.status === 200 && reply.text.length > 0, String(reply.status));
    }

    // --- isolated project + team -------------------------------------------
    const project = await sideA.call("/lingflow-panel/api/call", {
      command: "createProject",
      args: { name: "侧边栏隔离验证", root: PROJECT },
      operationId: randomUUID(),
    });
    check("侧边栏可创建隔离项目", project.ok && project.result?.id, project.error);
    const projectId = project.result.id;

    const controller = await sideA.call("/lingflow-panel/api/call", {
      command: "addRole",
      args: { projectId, kind: "controller", name: "验证主控" },
      operationId: randomUUID(),
    });
    check("可添加主控", controller.ok, controller.error);
    const developer = await sideB.call("/lingflow-panel/api/call", {
      command: "addRole",
      args: { projectId, kind: "developer", name: "验证开发" },
      operationId: randomUUID(),
    });
    check("第二个入口可添加开发", developer.ok, developer.error);

    // --- DSH session stand-ins over the bridge API -------------------------
    const bridge = async (action, body) =>
      requestJson(port, "/api/bridge/" + action, {
        token: config.bridgeToken,
        body,
      }).then((reply) => {
        if (reply.status >= 400 || reply.json.error)
          throw Error(action + "：" + reply.json.error);
        return reply.json;
      });

    const binds = [];
    for (const [role, sessionId] of [
      [controller.result, "e2e-controller"],
      [developer.result, "e2e-developer"],
    ]) {
      const request = await bridge("request", {
        roleId: role.id,
        sessionId,
        cwd: PROJECT,
      });
      binds.push({ role, sessionId, requestId: request.id });
    }
    for (const [index, bind] of binds.entries()) {
      const entrance = index === 0 ? sideA : sideB;
      const confirmed = await entrance.call("/lingflow-panel/api/call", {
        command: "confirmBinding",
        args: { requestId: bind.requestId },
        operationId: randomUUID(),
      });
      check("绑定确认：" + bind.sessionId, confirmed.ok, confirmed.error);
      const enabled = await entrance.call("/lingflow-panel/api/call", {
        command: "enable",
        args: { roleId: bind.role.id, enabled: true },
        operationId: randomUUID(),
      });
      check("角色开启：" + bind.sessionId, enabled.ok, enabled.error);
    }

    const sessions = binds.map((bind) => ({
      id: bind.sessionId,
      state: "idle",
      pending: 0,
      jobs: 0,
    }));
    const opening = await bridge("heartbeat", { sessions });
    for (const wake of opening.deliveries ?? [])
      await bridge("ack", { wakeId: wake.id, sessionId: wake.sessionId });
    check(
      "开启后每个角色各收到一条唤醒",
      (opening.deliveries ?? []).length === 2,
      "实际 " + (opening.deliveries ?? []).length + " 条",
    );
    // 会话读取收件箱 = 消费唤醒，之后的新业务通知才会生成新唤醒。
    for (const [role, sessionId] of [
      [controller.result, "e2e-controller"],
      [developer.result, "e2e-developer"],
    ]) {
      const inbox = await bridge("call", {
        sessionId,
        command: "inbox",
        args: {},
        operationId: randomUUID(),
      });
      check("收件箱可读取：" + sessionId, Array.isArray(inbox?.notices));
    }

    // --- controller approves and dispatches a read-only ticket -------------
    const requirement = await bridge("call", {
      sessionId: "e2e-controller",
      command: "approve",
      args: {
        projectId,
        text: "核对隔离项目结构并回报，不修改任何文件",
        source: "用户在 DSH 主控会话确认的只读验证",
      },
      operationId: randomUUID(),
    });
    check("主控登记需求", requirement?.id, JSON.stringify(requirement));

    const dispatch = await bridge("call", {
      sessionId: "e2e-controller",
      command: "dispatch",
      args: {
        requirementId: requirement.id,
        developerId: developer.result.id,
        title: "侧边栏验证票",
        description: "只读核对项目目录，回报目录内容",
        risk: "low",
        readOnly: true,
        writes: [],
        reads: [],
        resources: [],
        dependencies: [],
      },
      operationId: randomUUID(),
    });
    check("主控派只读测试票", dispatch?.taskId, JSON.stringify(dispatch));

    const delivered = await bridge("heartbeat", { sessions });
    const wakes = (delivered.deliveries ?? []).filter(
      (wake) => wake.sessionId === "e2e-developer",
    );
    check("成员收到一张票的唤醒", wakes.length === 1, "实际 " + wakes.length + " 条");
    check(
      "唤醒写明票名",
      (wakes[0]?.text ?? "").includes("侧边栏验证票"),
      (wakes[0]?.text ?? "").slice(0, 80),
    );
    for (const wake of delivered.deliveries ?? [])
      await bridge("ack", { wakeId: wake.id, sessionId: wake.sessionId });

    const again = await bridge("heartbeat", { sessions });
    check("确认后不重复投递", (again.deliveries ?? []).length === 0);

    // Restart the actual isolated service before the developer reads the old wake.
    const oldPid = service.pid;
    service = await restartService({ dataDir: DATA, port });
    check("隔离服务进程已重启", service.mode === "owned" && service.pid !== oldPid);
    const dormant = await bridge("heartbeat", { sessions });
    check("重启后未开启角色不投递", dormant.deliveries.length === 0);
    for (const { role } of binds) {
      const reopened = await sideA.call("/lingflow-panel/api/call", {
        command: "enable", args: { roleId: role.id, enabled: true }, operationId: randomUUID(),
      });
      check("在原绑定上重新开启：" + role.name, reopened.ok, reopened.error);
    }
    const resumed = await bridge("heartbeat", { sessions });
    const devWakes = resumed.deliveries.filter((wake) => wake.sessionId === "e2e-developer");
    check("只发一条替代续接卡", devWakes.length === 1 && devWakes[0].id !== wakes[0].id && devWakes[0].text.includes("沿原责任续接"));
    for (const wake of resumed.deliveries)
      await bridge("ack", { wakeId: wake.id, sessionId: wake.sessionId });
    const obsolete = await bridge("ack", { wakeId: wakes[0].id, sessionId: wakes[0].sessionId });
    check("旧卡迟到回执不影响续接", obsolete.state === "obsolete");

    const recovered = await bridge("call", {
      sessionId: "e2e-developer",
      command: "inbox",
      args: {},
      operationId: randomUUID(),
    });
    check("收件箱恢复的是原票", recovered.recovery?.tasks[0]?.id === dispatch.taskId && recovered.tasks[0]?.id === dispatch.taskId);
    const report = await bridge("call", {
      sessionId: "e2e-developer",
      command: "report",
      args: {
        taskId: dispatch.taskId,
        summary: "项目目录为空，没有需要修改的文件",
        dimensions: {
          requirements: { state: "pass", evidence: "按原票列出隔离项目目录" },
          implementation: { state: "pass", evidence: "空目录与实际输出一致" },
          system: { state: "pass", evidence: "只读取目录，未修改文件" },
        },
        checks: [
          {
            command: "列出隔离项目目录",
            exitCode: 0,
            evidence: "目录内只有一个空文件夹，符合只读要求",
          },
        ],
      },
      operationId: randomUUID(),
    });
    check("成员回报入库", report?.state === "stored", JSON.stringify(report));

    // --- three entrances, one state ----------------------------------------
    const viewA = await sideA.call("/lingflow-panel/api/snapshot", {});
    const viewB = await sideB.call("/lingflow-panel/api/snapshot", {});
    const direct = await requestJson(port, "/api/ui/snapshot", {
      token: service.uiToken,
      body: {},
    });
    const strip = (talk) => {
      const snapshot = talk.snapshot ?? talk;
      return {
        projects: snapshot.projects.map((item) => item.id),
        roles: snapshot.roles.map((role) => [role.id, role.enabled, role.sessionId]),
        tasks: snapshot.tasks.map((task) => [task.id, task.state]),
        notices: snapshot.notices.map((notice) => notice.id),
      };
    };
    const stateA = strip(viewA);
    const stateB = strip(viewB);
    const stateC = strip(direct.json);
    check(
      "两个侧边栏视图一致",
      JSON.stringify(stateA) === JSON.stringify(stateB),
    );
    check(
      "侧边栏与独立窗口数据一致",
      JSON.stringify(stateA) === JSON.stringify(stateC),
    );
    check(
      "任务状态已由回报推进",
      stateA.tasks.some(([, status]) => status === "ready"),
      JSON.stringify(stateA.tasks),
    );
    const taskId = dispatch.taskId;
    check(
      "报告只写一次",
      stateA.tasks.filter(([id]) => id === taskId).length === 1,
    );
    const noticeIds = stateA.notices;
    check(
      "协作动态无重复条目",
      new Set(noticeIds).size === noticeIds.length,
      "共 " + noticeIds.length + " 条",
    );

    // --- both entrances hammering the same service -------------------------
    const parallel = await Promise.all([
      sideA.call("/lingflow-panel/api/snapshot", {}),
      sideB.call("/lingflow-panel/api/snapshot", {}),
      sideA.call("/lingflow-panel/api/status"),
      sideB.call("/lingflow-panel/api/status"),
    ]);
    check(
      "并发读取不产生额外任务",
      parallel.every(
        (item) =>
          !item.snapshot ||
          item.snapshot.tasks.filter((task) => task.id === taskId).length <= 1,
      ),
    );

    writeFileSync(
      REPORT,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          dataDir: DATA,
          port,
          service: { mode: service.mode, pid: service.pid },
          projectId,
          taskId,
          checks,
          passed: checks.filter((item) => item.ok).length,
          total: checks.length,
        },
        null,
        2,
      ),
    );
    console.log(
      "\n全部通过：" + checks.length + " 项；报告 " + REPORT,
    );
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error("验证失败：" + error.message);
  process.exitCode = 1;
});
