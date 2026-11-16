#!/usr/bin/env electron
/**
 * DSH 侧边栏「白屏」探针 —— Electron 主进程。
 *
 * 由 `scripts/panel-embed-probe.mjs` 拉起，一个进程只跑一个场景：
 *   LINGFLOW_PROBE_SCENARIO = live | before | after
 *
 * 关键点（和真机同构）：
 * 1. 用 protocol.registerSchemesAsPrivileged 把 `dsh-app:` 注册成 standard + secure 特权协议，
 *    与 DSH 桌面壳 `E:\T\tmp-asar\lib\main.js:20048` 的注册方式一致，因此宿主页 origin 真的是
 *    `dsh-app://app`，LingFlow 页面的 CSP `frame-ancestors` 会按真机的祖先 origin 来校验。
 * 2. 宿主页 `dsh-app://app/host.html` 内只有一个 iframe，src 与真机 panel/client.js 的
 *    `frameUrl()` 完全一致：`dsh-app://app/lingflow-panel/api/frame`。
 * 3. 这个 dsh-app 请求由本进程 protocol.handle 转发给 Node 侧临时挂起的 DSH 宿主
 *    （panel-host 的真实路由），302 原样回传、绝不跟随；重定向跟随与 CSP 校验全部由
 *    Chromium 自己完成，所以旧 CSP 会在这里真实地拒绝加载。
 * 4. 判定四件事：子 frame 的最终 URL、子 frame 的 DOM（.brand/title/节点数）、截图统计
 *    （白色占比 / 非均匀度）、以及 console 里是否出现 `Refused to frame ... frame-ancestors` 原文。
 *
 * 产物：LINGFLOW_PROBE_SHOT 指定的截图 + LINGFLOW_PROBE_RESULT 指定的 JSON。
 * 退出码：pass=0 / fail=1。
 */
"use strict";

const { app, BrowserWindow, protocol } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HOST_SCHEME = "dsh-app";
const FRAME_PATH = "/lingflow-panel/api/frame";

// ---------- 读取 Node 侧传入的配置（全走 env，避免额外的命令行解析） ----------
const probeDir = (process.env.LINGFLOW_PROBE_DIR || "").trim();
const scenario = (process.env.LINGFLOW_PROBE_SCENARIO || "probe").trim();
const hostOrigin = (process.env.LINGFLOW_PROBE_HOST_ORIGIN || "").trim();
const serviceOrigin = (process.env.LINGFLOW_PROBE_SERVICE_ORIGIN || "").trim().replace(/\/+$/, "");
const uiToken = (process.env.LINGFLOW_PROBE_TOKEN || "").trim();
const sizeText = (process.env.LINGFLOW_PROBE_SIZE || "1120x760").trim();
const settleMs = numberOr(process.env.LINGFLOW_PROBE_SETTLE_MS, 3000);
const frameWaitMs = numberOr(process.env.LINGFLOW_PROBE_FRAME_WAIT_MS, 15000);
const shotPath = (process.env.LINGFLOW_PROBE_SHOT || "").trim();
const resultPath = (process.env.LINGFLOW_PROBE_RESULT || "").trim();
const electronData = (process.env.LINGFLOW_PROBE_ELECTRON_DATA || "").trim();

const sizeMatch = sizeText.match(/^(\d+)x(\d+)$/);
const width = sizeMatch ? Number(sizeMatch[1]) : 0;
const height = sizeMatch ? Number(sizeMatch[2]) : 0;
const configured = Boolean(
  probeDir && hostOrigin && serviceOrigin && uiToken && width > 0 && height > 0 && shotPath && resultPath,
);

const hostUrl = HOST_SCHEME + "://app/host.html";

// 宿主页：body 里只有一个 iframe，就是真机侧栏里的那一层；背景用 DSH 侧栏的 #0e1116。
const HOST_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>dsh-app host (panel embed probe)</title>
    <style>
      html, body { margin: 0; height: 100%; background: #0e1116; overflow: hidden; }
      iframe { border: 0; display: block; width: 100%; height: 100%; background: #0e1116; }
    </style>
  </head>
  <body>
    <iframe src="${HOST_SCHEME}://app${FRAME_PATH}" referrerpolicy="no-referrer"></iframe>
  </body>
</html>`;

// ---------- 特权协议必须在 ready 之前注册（和 DSH 桌面壳一致） ----------
protocol.registerSchemesAsPrivileged([
  {
    scheme: HOST_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

// ---------- 让窗口在 Windows 上一定能产出合成帧（否则 capturePage 可能返回空图） ----------
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

if (electronData) {
  try {
    fs.mkdirSync(electronData, { recursive: true });
    app.setPath("userData", electronData);
  } catch (error) {
    console.error("[probe-main] cannot set userData: " + error.message);
  }
}

// ---------- 运行期状态 ----------
const consoleMessages = [];
const didFailLoad = [];
const frameEvents = [];
const protocolLog = [];

let win = null;
let wc = null;
let finished = false;

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

/** 日志/产物里不落明文 uiToken。 */
function redactUrl(url) {
  return String(url || "").replace(/#[^\s"']*/g, "#<token>");
}

function recordConsole(details) {
  if (!details || typeof details !== "object") return;
  consoleMessages.push({
    level: details.level,
    source: details.source,
    message: redactUrl(details.message),
    sourceUrl: redactUrl(details.sourceUrl),
    lineNumber: details.lineNumber,
  });
}

// ---------- 结果文件 ----------
function writeResult(payload) {
  const body = Object.assign(
    {
      tool: "panel-embed-probe-main",
      scenario,
      at: new Date().toISOString(),
      hostOrigin,
      hostUrl,
      serviceOrigin,
      requestedSize: sizeText,
      settleMs,
      frameWaitMs,
    },
    payload,
  );
  try {
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, JSON.stringify(body, null, 2) + "\n", "utf8");
  } catch (error) {
    console.error("[probe-main] cannot write result: " + errorText(error));
  }
  console.log(
    "[probe-main] " +
      JSON.stringify({
        scenario,
        pass: body.pass === true,
        checks: body.checks || null,
        frameUrl: body.frame ? body.frame.url : null,
        error: body.error || null,
      }),
  );
  return body;
}

function finish(code) {
  if (finished) return;
  finished = true;
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch (error) {
    // 窗口已经没了
  }
  // 先走正常退出，再硬退出，保证退出码和结果一致（quit() 是异步的，exit() 立即生效）。
  try {
    app.quit();
  } catch (error) {
    // ignore
  }
  try {
    app.exit(code);
  } catch (error) {
    process.exit(code);
  }
}

function fail(error) {
  if (finished) return;
  const text = error && error.stack ? String(error.stack) : errorText(error);
  console.error("[probe-main] FAIL: " + text);
  writeResult({
    ok: false,
    pass: false,
    error: errorText(error),
    stack: text,
    frames: framesInfo(),
    console: consoleMessages.slice(-60),
    didFailLoad,
    frameEvents,
    protocolLog,
  });
  finish(1);
}

// ---------- dsh-app 协议转发 ----------
function relayUpstream(upstreamPath, method, body) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(hostOrigin);
    } catch (error) {
      resolve({ status: 502, headers: {}, body: Buffer.from("probe: bad host origin") });
      return;
    }
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: upstreamPath,
        method,
        timeout: 15000,
        headers: { Host: target.host, Accept: "text/html,application/json,*/*" },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: 504, headers: {}, body: Buffer.from("probe: upstream timeout") });
    });
    request.on("error", (error) =>
      resolve({ status: 502, headers: {}, body: Buffer.from("probe: upstream error: " + errorText(error)) }),
    );
    if (body && body.length) request.write(body);
    request.end();
  });
}

const RELAY_HEADERS = ["content-type", "location", "cache-control", "referrer-policy", "x-lingflow-instance"];

async function handleDshApp(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return new Response("probe: bad dsh-app url", { status: 400 });
  }
  if (url.hostname !== "app" && url.host !== "app") {
    return new Response("probe: unknown dsh-app host " + url.host, { status: 404 });
  }
  if (url.pathname === "/host.html") {
    return new Response(HOST_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const body =
    request.method === "GET" || request.method === "HEAD" ? null : Buffer.from(await request.arrayBuffer());
  const upstream = await relayUpstream(url.pathname + url.search, request.method, body);
  const headers = {};
  for (const name of RELAY_HEADERS) {
    const value = upstream.headers[name];
    if (value) headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  protocolLog.push({
    path: url.pathname,
    status: upstream.status,
    location: upstream.headers.location ? redactUrl(upstream.headers.location) : null,
  });
  // 302/303/307/308/204 不能带 body，否则 Response 构造会抛错。
  const noBody =
    upstream.status === 204 || upstream.status === 302 || upstream.status === 303 || upstream.status === 304 ||
    upstream.status === 307 || upstream.status === 308;
  return new Response(noBody ? null : new Uint8Array(upstream.body), { status: upstream.status, headers });
}

// ---------- 窗口 / 帧 ----------
function childFrames() {
  try {
    const main = wc.mainFrame;
    return main.framesInSubtree.filter((frame) => frame !== main);
  } catch (error) {
    return [];
  }
}

function framesInfo() {
  try {
    const main = wc.mainFrame;
    return main.framesInSubtree.map((frame) => {
      const entry = { url: redactUrl(frame.url), isMainFrame: frame === main };
      try {
        entry.processId = frame.processId;
        entry.routingId = frame.routingId;
      } catch (error) {
        // 帧可能已经销毁
      }
      return entry;
    });
  } catch (error) {
    return [];
  }
}

function createWindow() {
  win = new BrowserWindow({
    show: true,
    width,
    height,
    useContentSize: true,
    backgroundColor: "#0e1116",
    title: "dsh-app panel embed probe",
    autoHideMenuBar: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: false,
      backgroundThrottling: false,
    },
  });
  wc = win.webContents;
  win.showInactive();
  wc.setZoomFactor(1);

  wc.on("console-message", (event, ...args) => {
    // Electron 45 是 (event, messageDetails) 形态；老形态 (event, level, message, line, sourceId) 也兜一下。
    const details = args[0];
    if (details && typeof details === "object") recordConsole(details);
    else recordConsole({ level: args[0], message: String(args[1] || "") });
  });
  wc.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    didFailLoad.push({
      errorCode,
      errorDescription: String(errorDescription || ""),
      url: redactUrl(validatedURL),
      isMainFrame: Boolean(isMainFrame),
    });
  });
  wc.on("did-frame-finish-load", (event, isMainFrame, frameProcessId, frameRoutingId) => {
    frameEvents.push({ event: "did-frame-finish-load", isMainFrame: Boolean(isMainFrame), frameProcessId, frameRoutingId });
    // 记下这一刻所有（含子）frame 的 URL，CSP 拒绝时这里能看到 frame 停在哪个 URL 上。
    frameEvents[frameEvents.length - 1].frames = framesInfo();
  });
  wc.on("frame-created", (event, details) => {
    let url = "";
    try {
      url = redactUrl(details && details.frame ? details.frame.url : "");
    } catch (error) {
      url = "";
    }
    frameEvents.push({ event: "frame-created", url });
  });
  wc.on("render-process-gone", (event, details) => {
    fail(new Error("render-process-gone: " + (details && details.reason ? details.reason : "unknown")));
  });
  wc.on("preload-error", (event, preloadPath, error) => {
    console.error("[probe-main] preload-error " + preloadPath + ": " + errorText(error));
  });

  return win;
}

/** 等主 frame 完成加载；子 frame 的失败不在这里拒绝（CSP 拒绝子 frame 正是被测现象）。 */
function loadHostPage(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout loading " + url + " within 30s"));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timer);
      wc.off("did-finish-load", onFinish);
      wc.off("did-fail-load", onFail);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onFail = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error("did-fail-load(main): " + errorCode + " " + errorDescription + " " + redactUrl(validatedURL)));
    };
    wc.on("did-finish-load", onFinish);
    wc.on("did-fail-load", onFail);
    win.loadURL(url).catch((error) => {
      // 失败细节由 did-fail-load 记录，这里只是避免 unhandled rejection。
      console.error("[probe-main] loadURL rejected: " + errorText(error));
    });
  });
}

/** 轮询子 frame，直到它落到 LingFlow 服务页面上并 readyState=complete（或超时）。 */
async function waitForServiceFrame() {
  const startedAt = Date.now();
  let last = { url: "", ready: "" };
  while (Date.now() - startedAt < frameWaitMs) {
    const frames = childFrames();
    last = { url: frames.length ? redactUrl(frames[0].url) : "", ready: last.ready };
    for (const frame of frames) {
      let url = "";
      try {
        url = String(frame.url || "");
      } catch (error) {
        continue;
      }
      if (!url.startsWith(serviceOrigin)) continue;
      let ready = "";
      try {
        ready = String(await frame.executeJavaScript("document.readyState", false));
      } catch (error) {
        ready = "error: " + errorText(error);
      }
      if (ready === "complete") {
        return { found: true, frame, url: redactUrl(url), ready, elapsedMs: Date.now() - startedAt, timedOut: false };
      }
      last = { url: redactUrl(url), ready };
    }
    await wait(150);
  }
  const frames = childFrames();
  return {
    found: false,
    frame: frames.length ? frames[0] : null,
    url: frames.length ? redactUrl(frames[0].url) : "",
    ready: last.ready,
    elapsedMs: Date.now() - startedAt,
    timedOut: true,
  };
}

const FRAME_PROBE_JS = `(() => {
  const root = document.documentElement;
  const style = root ? getComputedStyle(root) : null;
  let tokenStored = false;
  try { tokenStored = Boolean(sessionStorage.getItem("lingflow.uiToken")); } catch (error) { tokenStored = false; }
  return {
    href: String(location.href).replace(/#.*$/, "#<token>"),
    title: document.title,
    ready: document.readyState,
    brand: Boolean(document.querySelector(".brand")),
    aside: Boolean(document.querySelector("aside")),
    rolesChildren: document.querySelectorAll("#roles *").length,
    nodes: document.querySelectorAll("*").length,
    rootBackground: style ? style.backgroundColor : "",
    bodyText: document.body ? String(document.body.innerText || "").slice(0, 200) : "",
    tokenStored,
  };
})()`;

async function probeFrame(frame) {
  if (!frame) return { error: "no child frame" };
  try {
    return await frame.executeJavaScript(FRAME_PROBE_JS, false);
  } catch (error) {
    return { error: errorText(error) };
  }
}

function imageStats(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const total = size.width * size.height;
  if (!total || bitmap.length < total * 4) {
    return { width: size.width, height: size.height, error: "empty-bitmap", bytes: bitmap.length };
  }
  const buckets = new Uint32Array(4096);
  let sum = 0;
  let white = 0;
  let dark = 0;
  let maxBucket = 0;
  let distinct = 0;
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    const lum = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    sum += lum;
    if (lum > 0.92) white += 1;
    if (lum < 0.1) dark += 1;
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    if (buckets[key] === 0) distinct += 1;
    buckets[key] += 1;
    if (buckets[key] > maxBucket) maxBucket = buckets[key];
  }
  return {
    width: size.width,
    height: size.height,
    totalPixels: total,
    bytes: bitmap.length,
    meanLum: sum / total,
    whiteRatio: white / total,
    darkRatio: dark / total,
    distinctColors: distinct,
    nonUniformRatio: 1 - maxBucket / total,
  };
}

async function nextFrame() {
  try {
    await wc.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", false);
  } catch (error) {
    // 页面都没了就直接尝试截图
  }
}

/** 截图；Windows 上被遮挡时可能拿到空图，先抬窗口再重试。 */
async function captureOnce() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await nextFrame();
    let image = null;
    try {
      image = await wc.capturePage();
    } catch (error) {
      image = null;
    }
    if (image && !image.isEmpty()) return { image, attempts: attempt };
    try {
      win.setAlwaysOnTop(true, "screen-saver");
      win.showInactive();
      win.moveTop();
      wc.invalidate();
    } catch (error) {
      // 窗口可能已销毁
    }
    await wait(150);
  }
  return { image: null, attempts: 5 };
}

function savePng(image, target) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, image.toPNG());
    return { path: target, bytes: fs.statSync(target).size };
  } catch (error) {
    return { path: target, error: errorText(error) };
  }
}

/** 判定：URL + DOM + 截图 + 没有 CSP 拒绝，四条全中才算加载成功。 */
function computeChecks(frameWait, frameProbe, stats) {
  const urlOk = Boolean(frameWait && frameWait.found && frameWait.frame);
  const domOk = Boolean(
    frameProbe && !frameProbe.error && frameProbe.brand === true && /LingFlow/i.test(String(frameProbe.title || "")) && (frameProbe.nodes || 0) > 20,
  );
  const shotOk = Boolean(stats && !stats.error && stats.whiteRatio < 0.9 && stats.nonUniformRatio > 0.02);
  const refusalConsole = consoleMessages.filter((entry) => /frame-ancestors|refused to frame/i.test(entry.message));
  const blockedLoads = didFailLoad.filter((entry) => /csp|blocked|frame-ancestors/i.test(entry.errorDescription));
  return {
    pass: urlOk && domOk && shotOk && refusalConsole.length === 0 && blockedLoads.length === 0,
    checks: {
      urlOk,
      domOk,
      shotOk,
      noCspRefusal: refusalConsole.length === 0,
      noCspLoadFailure: blockedLoads.length === 0,
    },
    refusalConsole,
    blockedLoads,
  };
}

async function main() {
  if (!configured) throw new Error("probe main missing env (dir/hostOrigin/serviceOrigin/token/size/shot/result)");

  console.log(
    "[probe-main] scenario=" + scenario + " size=" + sizeText + " host=" + hostOrigin + " service=" + serviceOrigin,
  );

  await app.whenReady();
  protocol.handle(HOST_SCHEME, (request) =>
    handleDshApp(request).catch((error) => {
      console.error("[probe-main] dsh-app handler failed: " + errorText(error));
      return new Response("probe: handler error: " + errorText(error), { status: 502 });
    }),
  );

  createWindow();
  try {
    const contentSize = win.getContentSize();
    console.log("[probe-main] window content size " + contentSize[0] + "x" + contentSize[1] + " (requested " + sizeText + ")");
  } catch (error) {
    // 非致命
  }

  const loadStartedAt = Date.now();
  await loadHostPage(hostUrl);
  const frameWait = await waitForServiceFrame();
  if (frameWait.found) {
    // 等页面把 snapshot 渲染出来、字体/图片稳定下来，再截图。
    await wait(settleMs);
  }

  const frameProbe = frameWait.found ? await probeFrame(frameWait.frame) : { error: "no frame on service origin" };
  const hostTitle = await wc.executeJavaScript("document.title", false).catch(() => "");
  const capture = await captureOnce();
  const stats = capture.image ? imageStats(capture.image) : null;
  const shot = capture.image ? savePng(capture.image, shotPath) : { path: shotPath, error: "capturePage returned empty image" };

  const verdict = computeChecks(frameWait, frameProbe, stats);
  const payload = {
    ok: true,
    pass: verdict.pass,
    checks: verdict.checks,
    frame: {
      url: frameWait.url,
      found: frameWait.found,
      ready: frameWait.ready,
      timedOut: frameWait.timedOut,
      elapsedMs: frameWait.elapsedMs,
      probe: frameProbe,
    },
    hostTitle: String(hostTitle || ""),
    frames: framesInfo(),
    frameEvents,
    stats,
    captureAttempts: capture.attempts,
    shot,
    console: consoleMessages.slice(-80),
    consoleRefusals: verdict.refusalConsole,
    didFailLoad,
    cspLoadFailures: verdict.blockedLoads,
    protocolLog,
    hostOrigin,
    serviceOrigin,
    token: uiToken ? "present" : "missing",
    durationMs: Date.now() - loadStartedAt,
    note:
      "宿主页跑在 dsh-app://app（standard+secure 特权协议，与 DSH 桌面壳一致），iframe src=dsh-app://app" +
      FRAME_PATH +
      "，由主进程转发到临时 DSH 宿主并原样回传 302，所以重定向与 CSP frame-ancestors 校验都是 Chromium 真实执行的。" +
      "pass = 子 frame 落到服务页面 + DOM 有 .brand/LingFlow + 截图非纯白且非单色 + console 无 Refused to frame。",
  };

  writeResult(payload);
  finish(verdict.pass ? 0 : 1);
}

process.on("uncaughtException", (error) => fail(error));
process.on("unhandledRejection", (error) => fail(error));

app.on("window-all-closed", () => {
  // 保持进程存活到我们写完结果并显式退出。
});

if (!configured) {
  console.error("[probe-main] FATAL: missing env configuration");
  try {
    if (resultPath) writeResult({ ok: false, pass: false, error: "missing env configuration" });
  } catch (error) {
    // ignore
  }
  app.exit(1);
} else {
  main().catch((error) => fail(error));
}
