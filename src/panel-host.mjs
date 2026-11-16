import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./config.mjs";
import { ensureService, probeInstance, requestJson, restartService } from "./instance.mjs";

/**
 * Host half bridge for the DSH sidebar.
 *
 * The sidebar embeds the real LingFlow page (see the "frame" route), so there is
 * exactly one UI implementation and nothing to keep in sync. Everything else
 * here exists so that the embedded page can be reached without handing the
 * credential to the renderer: the host looks the shared service up (or starts
 * it), redirects the frame to it with the token in the fragment, and answers
 * status questions. Because the host only ever forwards to the single service
 * on the configured port, opening the sidebar next to the desktop window cannot
 * create a second workflow loop or duplicate a wake card.
 */

const ROUTE_BASE = "/lingflow-panel/api";
const ADAPTER_STATUS_MAX_AGE = 30000;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CODE_DIRS = ["src", "ui", "panel", "adapters"];

/**
 * Newest mtime of the code the service and the panel are loaded from.
 *
 * The panel is installed as a link into the DSH profile, so editing LingFlow in
 * another session already reaches the sidebar; this stamp only tells the reader
 * whether the service process is still running code that has since changed.
 */
function codeLatest() {
  let latest = 0;
  for (const dir of CODE_DIRS) {
    const walk = (current, depth) => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (depth > 0) walk(full, depth - 1);
          continue;
        }
        if (!/\.(mjs|cjs|js|json)$/.test(entry.name)) continue;
        try {
          const at = statSync(full).mtimeMs;
          if (at > latest) latest = at;
        } catch {
          // A file removed mid-walk is not interesting.
        }
      }
    };
    walk(path.join(REPO_ROOT, dir), 1);
  }
  return latest;
}

function readAdapterStatus(dataDir) {
  try {
    const value = JSON.parse(
      readFileSync(path.join(dataDir, "dsh-status.json"), "utf8"),
    );
    const at = Number(value.at) || 0;
    return {
      loaded: value.loaded === true,
      at: at || null,
      age: at ? Date.now() - at : null,
      stale: !at || Date.now() - at > ADAPTER_STATUS_MAX_AGE,
      error: typeof value.error === "string" ? value.error : null,
      tools: Array.isArray(value.tools) ? value.tools : [],
    };
  } catch {
    return null;
  }
}

const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_BYTES = 128 * 1024;

/**
 * Best-effort append-only trace stored next to the service's own state.
 *
 * DSH gives a plugin no console the operator can read, so a panel that renders
 * nothing is otherwise undebuggable from the outside. Both halves of this panel
 * therefore leave breadcrumbs on disk: access lines for every route call, and the
 * renderer's own event log forwarded over `POST /log`. Every failure here is
 * swallowed — logging must never be the reason a route call fails.
 */
function createTrace(file) {
  let disabled = false;
  const trim = () => {
    try {
      if (statSync(file).size <= LOG_MAX_BYTES) return;
      const text = readFileSync(file);
      writeFileSync(file, text.subarray(text.length - LOG_KEEP_BYTES));
    } catch {
      // A log that cannot be trimmed is still better than no log.
    }
  };
  const write = (record) => {
    if (disabled) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
      trim();
    } catch {
      disabled = true;
    }
  };
  return { file, write };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 256 * 1024) throw Error("请求过大");
  }
  return raw ? JSON.parse(raw) : {};
}

const wrap = (handler) => async (request, response) => {
  try {
    await handler(request, response);
  } catch (error) {
    sendJson(response, 200, { ok: false, error: error.message });
  }
};

/**
 * DSH serves plugin routes without authentication and always on loopback, so a
 * write route is reachable by anything that can open a socket on this machine.
 * Requiring a JSON body forces a CORS preflight (a "simple" text/plain form post
 * can no longer reach the handler) and the fetch metadata check rejects a page
 * that is not this origin.
 */
const guardWrite = (handler) =>
  wrap(async (request, response) => {
    if (!/^application\/json\b/i.test(String(request.headers["content-type"] || "")))
      throw Error("请求必须使用 application/json");
    if (String(request.headers["sec-fetch-site"] || "") === "cross-site")
      throw Error("拒绝跨站请求");
    await handler(request, response);
  });

const isLoopback = (address) => {
  const value = String(address || "");
  return (
    value === "" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    /^127\./.test(value)
  );
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });

/** Shown inside the sidebar frame when the shared service cannot be reached. */
function sendFrameError(response, message) {
  const text = escapeHtml(message || "服务未就绪");
  response.writeHead(503, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LingFlow 未连接</title>
<style>html,body{margin:0;height:100%;background:#0e1116;color:#e6e9ef;
font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.box{max-width:520px;text-align:center}.t{font-size:16px;font-weight:600;margin:0 0 8px}
.p{margin:0;color:#9aa4b2;font-size:13px;overflow-wrap:anywhere}</style>
<div class="box"><p class="t">LingFlow 服务未连接</p><p class="p">${text}</p>
<p class="p">稍后会自动重试；也可以直接用独立窗口启动服务。</p></div></html>`,
  );
}

/**
 * The desktop window's Electron binary, when this checkout has one installed.
 *
 * The sidebar can start the window on request; it shares the same service, so
 * the two views never diverge. Missing Electron is a normal state for a
 * server-only install, so it degrades to a readable message.
 */
function desktopBinary() {
  const base = path.join(REPO_ROOT, "node_modules", "electron", "dist");
  const candidates =
    process.platform === "win32"
      ? [path.join(base, "electron.exe"), ...(path.basename(REPO_ROOT) === "app" && path.basename(path.dirname(REPO_ROOT)) === "resources"
        ? [path.resolve(REPO_ROOT, "../..", "LingFlow.exe")] : [])]
      : process.platform === "darwin"
        ? [path.join(base, "Electron.app", "Contents", "MacOS", "Electron")]
        : [path.join(base, "electron")];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function createPanelHost({
  dataDir = defaultDataDir(),
  port = null,
  version = "0.0.0",
  // Injectable so tests can prove the auto-reload rule without touching code.
  codeStamp = codeLatest,
  // Injectable so the failure path can be exercised without binding a port.
  startService = ensureService,
  // Injectable so a test never has to launch a real window.
  openWindow = null,
} = {}) {
  let service = null;
  let pending = null;
  let lastError = null;
  let lastErrorAt = null;

  const traces = {
    client: createTrace(path.join(dataDir, "panel-client.log")),
    access: createTrace(path.join(dataDir, "panel-access.log")),
  };
  const frameStats = { requests: 0, lastStatus: null, lastAt: null };

  /**
   * Start the desktop window, which attaches to the running shared service
   * instead of binding the port again (its main process handles EADDRINUSE that
   * way). Detached: closing the sidebar must not close the window.
   */
  const launchDesktop = () => {
    const binary = desktopBinary();
    if (!binary)
      throw Error(
        "找不到 Electron 可执行文件；请在 E:\\LingFlow 里运行 npm start 打开独立窗口",
      );
    const env = { ...process.env, LINGFLOW_DATA_DIR: dataDir };
    // Inherited from a Node-mode Electron, this would run the app as plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(binary, [REPO_ROOT], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env,
    });
    child.unref();
    traces.access.write({
      at: Date.now(),
      label: "desktop",
      pid: child.pid ?? null,
    });
    return { pid: child.pid ?? null };
  };
  const openDesktop = typeof openWindow === "function" ? openWindow : launchDesktop;

  const ensure = () => {
    if (service) return Promise.resolve(service);
    if (pending) return pending;
    pending = (async () => {
      try {
        const next = await startService({ dataDir, port: port ?? undefined });
        service = next;
        lastError = null;
        lastErrorAt = null;
        return next;
      } catch (error) {
        lastError = error.message;
        lastErrorAt = Date.now();
        throw error;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const serviceRequest = async (route, body, attempt = 0) => {
    const target = await ensure();
    let response;
    try {
      response = await requestJson(target.port, route, {
        token: target.uiToken,
        body,
        timeoutMs: 20000,
      });
    } catch (error) {
      // The service may have been stopped or restarted by its owner; forget the
      // stale handle once and retry, so a refresh always recovers.
      service = null;
      if (attempt > 0) throw Error("无法连接 LingFlow 服务：" + error.message);
      return serviceRequest(route, body, attempt + 1);
    }
    if (response.status === 401) {
      service = null;
      throw Error("LingFlow 服务令牌不匹配，可能换了数据目录；请重启服务后重试。");
    }
    if (response.status >= 400 || response.json?.error)
      throw Error(response.json?.error || "LingFlow 服务返回 " + response.status);
    return response.json;
  };

  const describe = async () => {
    const target = await ensure();
    const probe = await probeInstance(target.port, {
      token: target.uiToken,
      timeoutMs: 1200,
    });
    return {
      mode: target.mode,
      port: target.port,
      origin: target.origin,
      version: probe.version ?? version,
      startedAt: probe.startedAt ?? target.startedAt ?? null,
      running: probe.running === true,
      authorized: probe.authorized === true,
      pid: target.pid ?? null,
      dataDir,
    };
  };

  const routes = [
    [
      // The sidebar shows the real LingFlow page, framed. Handing out a redirect
      // instead of a token keeps the credential in the Location header, so the
      // renderer's own JavaScript never sees it, and the framed page is exactly
      // the file the desktop window loads: one UI, no second implementation.
      "frame",
      "GET",
      ROUTE_BASE + "/frame",
      wrap(async (request, response) => {
        if (!isLoopback(request.socket?.remoteAddress)) throw Error("只允许本机访问");
        if (String(request.headers["sec-fetch-site"] || "") === "cross-site")
          throw Error("拒绝跨站嵌入");
        let target;
        try {
          target = await ensure();
          const probe = await probeInstance(target.port, {
            token: target.uiToken,
            timeoutMs: 1200,
          });
          if (!probe.running || !probe.authorized) {
            // The owner may have stopped the service between two reads.
            service = null;
            target = await ensure();
          }
        } catch (error) {
          sendFrameError(response, error.message);
          return;
        }
        response.writeHead(302, {
          Location: `${target.origin}/#${target.uiToken}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        response.end();
      }),
    ],
    [
      "status",
      "GET",
      ROUTE_BASE + "/status",
      wrap(async (request, response) => {
        const latest = codeStamp();
        let info = null;
        try {
          info = await describe();
        } catch (error) {
          sendJson(response, 200, {
            ok: true,
            online: false,
            error: error.message,
            at: Date.now(),
            adapter: readAdapterStatus(dataDir),
            lastErrorAt,
            frame: { ...frameStats },
            logs: { client: traces.client.file, access: traces.access.file },
            code: { latest, changed: false, autoReloaded: false },
          });
          return;
        }
        let changed =
          Number(info.startedAt) > 0 &&
          latest > Number(info.startedAt) + 1000;
        let autoReloaded = false;
        // AUTO SYNC: LingFlow is installed as a link, so edits made in another
        // session land on disk immediately. The page half is picked up by the
        // frame reloading; the service half needs a new process. Reload it by
        // itself only while nothing is running, because a restart disables roles
        // (by design) and would otherwise silence someone's work.
        if (changed && info.mode === "owned") {
          try {
            const snapshot = await serviceRequest("/api/ui/snapshot", {});
            const idle = (snapshot.roles ?? []).every((role) => !role.enabled);
            if (idle) {
              service = null;
              service = await restartService({ dataDir, port: info.port });
              info = await describe();
              changed = false;
              autoReloaded = true;
            }
          } catch (error) {
            lastError = "自动重载失败：" + error.message;
            lastErrorAt = Date.now();
          }
        }
        sendJson(response, 200, {
          ok: true,
          online: info.running,
          error: lastError,
          service: info,
          adapter: readAdapterStatus(dataDir),
          at: Date.now(),
          frame: { ...frameStats },
          logs: { client: traces.client.file, access: traces.access.file },
          code: { latest, changed, autoReloaded },
        });
      }),
    ],
    [
      "snapshot",
      "POST",
      ROUTE_BASE + "/snapshot",
      guardWrite(async (_request, response) => {
        const snapshot = await serviceRequest("/api/ui/snapshot", {});
        sendJson(response, 200, { ok: true, snapshot, at: Date.now() });
      }),
    ],
    [
      "call",
      "POST",
      ROUTE_BASE + "/call",
      guardWrite(async (request, response) => {
        const body = await readBody(request);
        if (typeof body.command !== "string" || !body.command)
          throw Error("缺少 command");
        const result = await serviceRequest("/api/ui/call", {
          command: body.command,
          args: body.args ?? {},
          operationId: body.operationId,
        });
        sendJson(response, 200, { ok: true, result, at: Date.now() });
      }),
    ],
    [
      "start",
      "POST",
      ROUTE_BASE + "/start",
      guardWrite(async (_request, response) => {
        service = null;
        const next = await ensure();
        sendJson(response, 200, { ok: true, service: await describe(), started: next.mode });
      }),
    ],
    [
      "restart",
      "POST",
      ROUTE_BASE + "/restart",
      guardWrite(async (_request, response) => {
        const target = await ensure();
        if (target.mode !== "owned")
          throw Error(
            "当前 LingFlow 服务由独立窗口托管，侧边栏不能重启它。请退出独立窗口后重试。",
          );
        service = null;
        const next = await restartService({ dataDir, port: target.port });
        service = next;
        sendJson(response, 200, { ok: true, service: await describe() });
      }),
    ],
    [
      // Renderer breadcrumbs. The renderer has no readable console inside DSH, so
      // "the panel is blank" is only diagnosable if the panel itself can say what
      // it tried; this turns that into a file next to the service state.
      "log",
      "POST",
      ROUTE_BASE + "/log",
      guardWrite(async (request, response) => {
        const body = await readBody(request);
        const batch = Array.isArray(body.events) ? body.events.slice(-32) : [body];
        const context = {
          userAgent: String(body.userAgent || "").slice(0, 200),
          href: String(body.href || "").slice(0, 200),
        };
        for (const entry of batch) {
          traces.client.write({
            at: Number(entry?.at) || Date.now(),
            event: String(entry?.event || "").slice(0, 60),
            detail:
              entry?.detail === undefined || entry?.detail === null
                ? null
                : String(entry.detail).slice(0, 500),
            ...context,
          });
        }
        sendJson(response, 200, { ok: true, path: traces.client.file });
      }),
    ],
    [
      // The sidebar can open the desktop window, which attaches to the same
      // service. Useful when the embed itself is the broken part.
      "open",
      "POST",
      ROUTE_BASE + "/open",
      guardWrite(async (_request, response) => {
        sendJson(response, 200, { ok: true, ...openWindow() });
      }),
    ],
  ];

  // Every call leaves a line: this is how a silently blocked embed is told apart
  // from one whose page never rendered.
  const traced = routes.map(([label, method, routePath, handler]) => [
    label,
    method,
    routePath,
    (request, response) => {
      const startedAt = Date.now();
      const headers = request.headers || {};
      const record = (status) => {
        traces.access.write({
          at: startedAt,
          label,
          method: request.method,
          path: request.url,
          status,
          ms: Date.now() - startedAt,
          site: headers["sec-fetch-site"] ?? null,
          dest: headers["sec-fetch-dest"] ?? null,
          origin: headers.origin ?? null,
          ua: String(headers["user-agent"] || "").slice(0, 160),
        });
        if (label === "frame") {
          frameStats.requests += 1;
          frameStats.lastStatus = status;
          frameStats.lastAt = startedAt;
        }
      };
      // A minimal response stand-in (tests, alternate servers) may not be an
      // EventEmitter; the route must not care.
      if (typeof response.once === "function")
        response.once("finish", () => record(response.statusCode));
      else record(null);
      return handler(request, response);
    },
  ]);

  return {
    routes: traced,
    ensure,
    dispose() {
      service = null;
      pending = null;
    },
    get lastError() {
      return lastError;
    },
  };
}

export { ROUTE_BASE };
