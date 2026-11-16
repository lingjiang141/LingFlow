#!/usr/bin/env node
/**
 * DSH 侧边栏「白屏」决定性复现探针 —— Node 侧入口。
 *
 *   node scripts/panel-embed-probe.mjs            # 跑完整 A/B
 *   node scripts/panel-embed-probe.mjs --keep     # 保留 Electron 的 userData 中间产物
 *
 * 真实链路（真机证据 + panel/client.js:39-40、267-272）：
 *   DSH 页面本身是特权自定义协议页 dsh-app://app/
 *   → 侧栏组件插 <iframe src="dsh-app://app/lingflow-panel/api/frame">
 *   → panel-host 的 frame 路由回 302 Location: http://127.0.0.1:<port>/#<uiToken>
 *   → LingFlow 页面加载；页面 CSP 的 frame-ancestors 必须放行祖先 dsh-app://app
 *
 * 探针在 Electron 里注册同款 dsh-app 特权协议并让宿主页跑在 dsh-app://app/host.html，
 * 因而祖先 origin 与真机完全一致；iframe 的 src 仍走 panel-host 的 frame 路由，
 * 由 Electron 主进程把 dsh-app://app/lingflow-panel/... 转发到本地临时 DSH 宿主，
 * 302 原样回传（不跟随），重定向与 CSP 校验都发生在 Chromium 里，和真机同一条路径。
 *
 * 三个场景（每次一个独立 Electron 进程，避免会话/缓存串味）：
 *   live   当前正在运行的真实服务（端口/token 取自 readConfig()，只读，不启停它）
 *   before 隔离服务 + 旧 CSP（frame-ancestors 不含 dsh-app:）→ 期望白屏并打印 Refused to frame
 *   after  隔离服务 + 新 CSP（frame-ancestors 含 dsh-app:）  → 期望加载出 LingFlow 界面
 *
 * 产物：.validation/panel-embed/probe.json、live.png、before.png、after.png；
 * 判定：before 白屏且有 CSP 拒绝证据 且 after 加载成功 → 探针 exit 0（假设成立），否则 exit 1。
 * 不修改 src/、panel/、tests/ 下任何文件，也不写用户的真实数据目录（live 只读 config/token）。
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const baseDir = path.join(repoRoot, ".validation", "panel-embed");
const ELECTRON_TIMEOUT_MS = 120_000;
const PROBE_SIZE = "1120x760";
const SETTLE_MS = 3000;
const FRAME_WAIT_MS = 15000;
// 新 CSP：放行祖先 dsh-app://app（Lead 已改 src/server.mjs 默认值，这里显式覆盖以便对照）。
const NEW_ANCESTORS = "'self' http://127.0.0.1:* http://localhost:* dsh-app:";
// 旧 CSP：修复前的取值，故意不含 dsh-app:，用来复现白屏。
const OLD_ANCESTORS = "'self' http://127.0.0.1:* http://localhost:*";

const keepElectronData = process.argv.includes("--keep");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

/** GET 一个本地 origin 的首页，只读响应头（用来看 CSP 原文）。 */
function headersOf(origin) {
  return new Promise((resolve) => {
    const target = new URL(origin);
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: "/",
        method: "GET",
        timeout: 5000,
        headers: { Host: target.host },
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: 0, headers: {}, error: "timeout" });
    });
    request.on("error", (error) => resolve({ status: 0, headers: {}, error: errorText(error) }));
    request.end();
  });
}

/** 把 panel-host 的路由挂到一个临时 loopback http 服务上（等价 panel/index.js 的 register）。 */
function mountRoutes(routes) {
  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("bad request");
      return;
    }
    for (const [, method, routePath, handler] of routes) {
      if (request.method !== method || url.pathname !== routePath) continue;
      try {
        await handler(request, response);
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: errorText(error) }));
        } else {
          response.end();
        }
      }
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not-found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        server,
        port,
        origin: "http://127.0.0.1:" + port,
        close: () =>
          new Promise((done) => {
            try {
              server.closeAllConnections();
            } catch {
              // 老 Node 没有 closeAllConnections
            }
            server.close(() => done());
          }),
      });
    });
  });
}

/** 起一个隔离服务（临时 dataDir + 随机端口），CSP 由 LINGFLOW_FRAME_ANCESTORS 显式指定。 */
async function startIsolatedService(ancestors) {
  const { startServer } = await import(new URL("../src/server.mjs", import.meta.url));
  const dataDir = path.join(scratchDir, "service-" + (ancestors.includes("dsh-app:") ? "new-csp" : "old-csp"));
  mkdirSync(dataDir, { recursive: true });
  const previous = process.env.LINGFLOW_FRAME_ANCESTORS;
  process.env.LINGFLOW_FRAME_ANCESTORS = ancestors;
  let service;
  try {
    // 注意：frame-ancestors 在 startServer() 调用时读取，调用后即可恢复 env。
    service = await startServer({ dataDir, port: 0 });
  } finally {
    if (previous === undefined) delete process.env.LINGFLOW_FRAME_ANCESTORS;
    else process.env.LINGFLOW_FRAME_ANCESTORS = previous;
  }
  return {
    mode: "isolated",
    origin: "http://127.0.0.1:" + service.port,
    port: service.port,
    uiToken: service.uiToken,
    dataDir,
    close: async () => {
      await service.close();
    },
  };
}

/** 现场正在运行的真实服务：只读 config/token，绝不启停它。 */
async function resolveLiveService() {
  const { readConfig, defaultDataDir } = await import(new URL("../src/config.mjs", import.meta.url));
  const { probeInstance } = await import(new URL("../src/instance.mjs", import.meta.url));
  const dataDir = defaultDataDir();
  const config = readConfig(dataDir);
  const probe = await probeInstance(config.port, { token: config.uiToken, timeoutMs: 1500 });
  if (!probe.running || !probe.authorized) return null;
  return {
    mode: "live",
    origin: "http://127.0.0.1:" + config.port,
    port: config.port,
    uiToken: config.uiToken,
    dataDir,
    close: async () => {},
  };
}

/** 起一个 Electron 进程跑单个场景，读回它写的 result JSON。 */
function runElectron(scenario, service, hostOrigin) {
  const scriptPath = path.join(repoRoot, "scripts", "panel-embed-probe-main.cjs");
  const electronExe = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  if (!existsSync(electronExe)) throw new Error("Electron binary not found: " + electronExe);
  if (!existsSync(scriptPath)) throw new Error("probe main missing: " + scriptPath);

  const environment = {
    ...process.env,
    LINGFLOW_PROBE_DIR: baseDir,
    LINGFLOW_PROBE_SCENARIO: scenario.key,
    LINGFLOW_PROBE_HOST_ORIGIN: hostOrigin,
    LINGFLOW_PROBE_SERVICE_ORIGIN: service.origin,
    LINGFLOW_PROBE_TOKEN: service.uiToken,
    LINGFLOW_PROBE_SIZE: PROBE_SIZE,
    LINGFLOW_PROBE_SETTLE_MS: String(SETTLE_MS),
    LINGFLOW_PROBE_FRAME_WAIT_MS: String(FRAME_WAIT_MS),
    LINGFLOW_PROBE_SHOT: path.join(baseDir, scenario.shot),
    LINGFLOW_PROBE_RESULT: path.join(scratchDir, scenario.key + "-result.json"),
    LINGFLOW_PROBE_ELECTRON_DATA: path.join(scratchDir, "electron-" + scenario.key),
    LINGFLOW_PROBE_KEEP: keepElectronData ? "1" : "",
  };
  // 从 Node 里继承来的这两个变量会干扰 Electron 的启动方式 / 服务 CSP 语义。
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.LINGFLOW_FRAME_ANCESTORS;

  const child = spawn(electronExe, ["--disable-gpu", scriptPath], {
    cwd: repoRoot,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // 已经退出
    }
  }, ELECTRON_TIMEOUT_MS);

  return new Promise((resolve) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exit: null, signal: null, timedOut, stdout, stderr, error: errorText(error), result: null, resultPath: environment.LINGFLOW_PROBE_RESULT });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) console.log("[probe] TIMEOUT: electron did not finish within " + ELECTRON_TIMEOUT_MS / 1000 + "s; killed.");
      const resultPath = environment.LINGFLOW_PROBE_RESULT;
      let result = null;
      if (existsSync(resultPath)) {
        try {
          result = JSON.parse(readFileSync(resultPath, "utf8"));
        } catch (error) {
          console.error("[probe] result JSON unreadable: " + errorText(error));
        }
      }
      resolve({ exit: code, signal, timedOut, stdout, stderr, error: null, result, resultPath });
    });
  });
}

const startedAt = Date.now();
mkdirSync(baseDir, { recursive: true });
const scratchDir = path.join(baseDir, "scratch-" + timestamp());
mkdirSync(scratchDir, { recursive: true });

let closeIsolated = [];

/** CSP 里的 frame-ancestors 片段（只留诊断需要的部分）。 */
function ancestorsOf(csp) {
  const text = String(csp || "");
  const match = text.match(/frame-ancestors([^;]*)/i);
  return match ? match[1].trim() : "";
}

function cspConsole(result) {
  const messages = (result && result.console) || [];
  return messages
    .filter((entry) => /frame-ancestors|refused to frame|content security policy|csp/i.test(String(entry.message || "")))
    .map((entry) => String(entry.message || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function cspLoadFailures(result) {
  const failures = (result && result.didFailLoad) || [];
  return failures.filter((entry) => /csp|blocked|frame-ancestors/i.test(String(entry.errorDescription || "") + " " + String(entry.errorCode || "")));
}

async function runScenario(scenario) {
  const scenarioStartedAt = Date.now();
  const service = await scenario.makeService();
  if (service.mode === "isolated") closeIsolated.push(service);
  const headerProbe = await headersOf(service.origin);
  const csp = String(headerProbe.headers["content-security-policy"] || "");

  const hostDataDir = path.join(scratchDir, "host-" + scenario.key);
  mkdirSync(hostDataDir, { recursive: true });
  const { createPanelHost } = await import(new URL("../src/panel-host.mjs", import.meta.url));
  // 注入 startService：直接用这个场景的服务记录，避免探针去读/写真实 config 或误启服务。
  const panel = createPanelHost({
    dataDir: hostDataDir,
    port: service.port,
    startService: async () => ({
      mode: service.mode,
      origin: service.origin,
      port: service.port,
      uiToken: service.uiToken,
      dataDir: hostDataDir,
      bridgeToken: "",
      pid: null,
      startedAt: null,
      close: async () => {},
    }),
    openWindow: async () => ({ pid: null }),
  });
  const hostServer = await mountRoutes(panel.routes);

  try {
    console.log(
      "[probe] " + scenario.key + ": service=" + service.origin + " (" + service.mode + ") frame-ancestors=" + JSON.stringify(ancestorsOf(csp)),
    );
    const electron = await runElectron(scenario, service, hostServer.origin);
    const result = electron.result;
    const pass = Boolean(result && result.pass === true);
    const refused = cspConsole(result);
    const loadFailures = cspLoadFailures(result);
    console.log(
      "[probe] " + scenario.key + ": pass=" + pass + " frame=" + ((result && result.frame && result.frame.url) || "(none)") + " exit=" + electron.exit,
    );
    if (result && result.frame && result.frame.probe) {
      console.log(
        "[probe] " + scenario.key + ": title=" + JSON.stringify(result.frame.probe.title || "") + " brand=" + Boolean(result.frame.probe.brand) + " nodes=" + (result.frame.probe.nodes || 0),
      );
    }
    if (result && result.stats) {
      console.log(
        "[probe] " + scenario.key + ": shot=" + result.stats.width + "x" + result.stats.height + " meanLum=" + Number(result.stats.meanLum).toFixed(3) + " whiteRatio=" + Number(result.stats.whiteRatio).toFixed(3) + " distinctColors=" + result.stats.distinctColors,
      );
    }
    for (const message of refused.slice(0, 4)) console.log("[probe] " + scenario.key + " console: " + message.slice(0, 300));
    for (const failure of loadFailures.slice(0, 4)) {
      console.log("[probe] " + scenario.key + " did-fail-load: " + failure.errorCode + " " + failure.errorDescription + " " + failure.url);
    }
    return {
      key: scenario.key,
      label: scenario.label,
      expected: scenario.expected,
      service: { origin: service.origin, mode: service.mode, port: service.port },
      csp,
      frameAncestors: ancestorsOf(csp),
      pass,
      result,
      shot: path.join(baseDir, scenario.shot),
      console: (result && result.console) || [],
      cspConsole: refused,
      cspLoadFailures: loadFailures,
      electron,
      durationMs: Date.now() - scenarioStartedAt,
    };
  } finally {
    try {
      await hostServer.close();
    } catch {
      // 已关
    }
    panel.dispose();
  }
}

let probe = null;
let exitCode = 1;

try {
  const live = await resolveLiveService();
  const scenarios = [];
  if (live) {
    scenarios.push({ key: "live", label: "现场运行中的真实服务", shot: "live.png", expected: "加载（CSP 已含 dsh-app:）", makeService: async () => live });
  }
  scenarios.push({
    key: "before",
    label: "隔离服务 + 旧 CSP（不含 dsh-app:）",
    shot: "before.png",
    expected: "白屏 + Refused to frame（复现）",
    makeService: async () => startIsolatedService(OLD_ANCESTORS),
  });
  scenarios.push({
    key: "after",
    label: "隔离服务 + 新 CSP（含 dsh-app:）",
    shot: "after.png",
    expected: "加载出 LingFlow 界面（修复）",
    makeService: async () => startIsolatedService(NEW_ANCESTORS),
  });

  console.log("[probe] size=" + PROBE_SIZE + " settle=" + SETTLE_MS + "ms frameWait=" + FRAME_WAIT_MS + "ms");
  console.log("[probe] artifacts: " + baseDir);

  const results = {};
  for (const scenario of scenarios) results[scenario.key] = await runScenario(scenario);

  const before = results.before;
  const after = results.after;
  const liveResult = results.live || null;
  const reproduced = Boolean(before && before.pass === false && before.cspConsole.length > 0);
  const fixed = Boolean(after && after.pass === true);
  const liveLoaded = liveResult ? liveResult.pass === true : null;
  const ok = reproduced && fixed && (liveLoaded === null || liveLoaded === true);

  probe = {
    ok,
    tool: "panel-embed-probe",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    size: PROBE_SIZE,
    settleMs: SETTLE_MS,
    verdict: {
      reproduced,
      fixed,
      liveLoaded,
      hypothesis: "LingFlow 页面 CSP frame-ancestors 未放行 dsh-app: 时，DSH 侧栏 iframe 被 Chromium 拒绝加载，表现为纯白；放行后正常加载。",
    },
    csp: {
      live: liveResult ? liveResult.csp : null,
      before: before ? before.csp : null,
      after: after ? after.csp : null,
    },
    scenarios: Object.fromEntries(
      Object.entries(results).map(([key, entry]) => [
        key,
        {
          label: entry.label,
          expected: entry.expected,
          service: entry.service,
          csp: entry.csp,
          frameAncestors: entry.frameAncestors,
          pass: entry.pass,
          shot: entry.shot,
          frame: entry.result ? entry.result.frame : null,
          stats: entry.result ? entry.result.stats : null,
          console: entry.console,
          cspConsole: entry.cspConsole,
          cspLoadFailures: entry.cspLoadFailures,
          didFailLoad: (entry.result && entry.result.didFailLoad) || [],
          protocolLog: (entry.result && entry.result.protocolLog) || [],
          frames: (entry.result && entry.result.frames) || [],
          durationMs: entry.durationMs,
          electron: { exit: entry.electron.exit, signal: entry.electron.signal, timedOut: entry.electron.timedOut },
        },
      ]),
    ),
    shots: Object.fromEntries(Object.entries(results).map(([key, entry]) => [key, entry.shot])),
  };

  writeFileSync(path.join(baseDir, "probe.json"), JSON.stringify(probe, null, 2) + "\n");

  console.log("[probe] ---- verdict ----");
  console.log("[probe] live  : " + (liveResult ? (liveResult.pass ? "LOADED" : "BLANK") + "  frame-ancestors=" + JSON.stringify(liveResult.frameAncestors) : "service not running (skipped)"));
  console.log("[probe] before: " + (before.pass ? "LOADED (unexpected!)" : "BLANK") + "  frame-ancestors=" + JSON.stringify(before.frameAncestors) + "  cspEvidence=" + (before.cspConsole.length > 0));
  console.log("[probe] after : " + (after.pass ? "LOADED" : "BLANK (unexpected!)") + "  frame-ancestors=" + JSON.stringify(after.frameAncestors));
  console.log("[probe] reproduced=" + reproduced + " fixed=" + fixed + " liveLoaded=" + String(liveLoaded));
  console.log("[probe] before.png : " + before.shot);
  console.log("[probe] after.png  : " + after.shot);
  if (liveResult) console.log("[probe] live.png   : " + liveResult.shot);
  console.log("[probe] probe.json : " + path.join(baseDir, "probe.json"));
  console.log("[probe] duration   : " + (probe.durationMs / 1000).toFixed(1) + "s");
  console.log(
    "RESULT reproduced=" +
      reproduced +
      " before=" +
      (before.pass ? "load" : "blank") +
      " after=" +
      (after.pass ? "load" : "blank") +
      " live=" +
      (liveResult ? (liveResult.pass ? "load" : "blank") : "skipped") +
      " cspEvidence=" +
      (before.cspConsole.length > 0),
  );

  exitCode = ok ? 0 : 1;
  if (!ok) {
    console.log("[probe] VERDICT: NOT as expected — 看上面的 frame / console / did-fail-load 原文");
  }
} catch (error) {
  console.error("[probe] FAILED: " + (error && error.stack ? error.stack : errorText(error)));
  try {
    writeFileSync(
      path.join(baseDir, "probe.json"),
      JSON.stringify({ ok: false, error: errorText(error), startedAt: new Date(startedAt).toISOString() }, null, 2) + "\n",
    );
  } catch {
    // 写不了就算了
  }
  exitCode = 1;
} finally {
  for (const service of closeIsolated) {
    try {
      await service.close();
    } catch (error) {
      console.error("[probe] isolated service close failed: " + errorText(error));
    }
  }
  if (!keepElectronData && probe && probe.ok && existsSync(scratchDir)) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
      console.log("[probe] cleanup: removed " + scratchDir);
    } catch (error) {
      console.log("[probe] cleanup: could not remove " + scratchDir + " (" + errorText(error) + ")");
    }
  } else if (keepElectronData) {
    console.log("[probe] cleanup: kept " + scratchDir + " (--keep)");
  }
}

process.exitCode = exitCode;
