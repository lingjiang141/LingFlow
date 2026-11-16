import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir, readConfig } from "./config.mjs";

/**
 * One LingFlow service per data directory.
 *
 * The desktop window used to start the service inside its own Electron main
 * process, so any second entrance (the DSH sidebar) could only collide on the
 * port. Everything now goes through `ensureService`: probe the shared port,
 * attach when a compatible instance answers, otherwise start a detached service
 * that both entrances talk to. Exactly one workflow loop therefore owns
 * delivery, surveillance and background checks, which is what makes duplicate
 * wake cards impossible.
 */

export const SERVER_ENTRY = fileURLToPath(new URL("./server.mjs", import.meta.url));
const PID_FILE = "panel-service.json";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal JSON client: loopback only, short timeouts, no keep-alive pool. */
export function requestJson(
  port,
  route,
  { method = "POST", token, body, timeoutMs = 2500 } = {},
) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (token) headers.Authorization = "Bearer " + token;
    const request = http.request(
      { host: "127.0.0.1", port, path: route, method, headers, timeout: timeoutMs },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let json;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = { error: "响应不是 JSON：" + raw.slice(0, 200) };
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(Error("连接 LingFlow 服务超时（端口 " + port + "）")),
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/** Identify the instance on a port without trusting anything but its own hello. */
export async function probeInstance(port, { token, timeoutMs = 900 } = {}) {
  try {
    const { status, json } = await requestJson(port, "/api/ui/hello", {
      method: "GET",
      token,
      timeoutMs,
    });
    if (status !== 200 || json?.app !== "lingflow") return { running: false };
    return {
      running: true,
      app: "lingflow",
      port,
      authorized: json.authorized === true,
      startedAt: json.startedAt ?? null,
      version: json.version ?? null,
    };
  } catch {
    return { running: false };
  }
}

const pidPath = (dataDir) => path.join(dataDir, PID_FILE);

function readPidFile(dataDir) {
  try {
    return JSON.parse(readFileSync(pidPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

function writePidFile(dataDir, value) {
  writeFileSync(pidPath(dataDir), JSON.stringify(value, null, 2), { mode: 0o600 });
}

function clearPidFile(dataDir) {
  if (existsSync(pidPath(dataDir))) rmSync(pidPath(dataDir), { force: true });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The detached service is a plain Node process; Electron hosts run it as node. */
function spawnService(dataDir, port) {
  const electron = Boolean(process.versions.electron);
  const command = process.env.LINGFLOW_NODE || process.execPath;
  const env = {
    ...process.env,
    LINGFLOW_DATA_DIR: dataDir,
    ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  // The child outlives both entrances on purpose: closing a window must not
  // kill delivery, and a later LingFlow release is picked up by restarting it.
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(command, [SERVER_ENTRY, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  return child;
}

function handle(config, dataDir, port, probe, managed) {
  return {
    mode: managed ? "owned" : "external",
    origin: "http://127.0.0.1:" + port,
    port,
    uiToken: config.uiToken,
    bridgeToken: config.bridgeToken,
    dataDir,
    pid: managed ? managed.pid : null,
    startedAt: probe.startedAt,
    close: async () => {
      // Attaching never owns the service; only the process that started it may
      // stop it, so a short-lived panel refresh cannot interrupt delivery.
    },
  };
}

/**
 * Attach to the running service or start one.
 * Returns `{ mode: 'owned' | 'external', origin, port, uiToken, ... }`.
 */
export async function ensureService({
  dataDir = defaultDataDir(),
  port,
  timeoutMs = 30000,
} = {}) {
  const config = readConfig(dataDir);
  const targetPort = port ?? config.port;
  const probe = await probeInstance(targetPort, { token: config.uiToken });
  if (probe.running && probe.authorized) {
    const record = readPidFile(dataDir);
    const managed =
      record && record.port === targetPort && alive(record.pid)
        ? { pid: record.pid }
        : null;
    return handle(config, dataDir, targetPort, probe, managed);
  }
  if (probe.running)
    throw Error(
      "端口 " +
        targetPort +
        " 上的 LingFlow 服务是旧版本（没有侧边栏令牌）。请先退出正在运行的 LingFlow 独立窗口或结束该服务，再重试。",
    );
  const child = spawnService(dataDir, targetPort);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const next = await probeInstance(targetPort, { token: config.uiToken, timeoutMs: 800 });
    if (next.running && next.authorized) {
      writePidFile(dataDir, {
        pid: child.pid,
        port: targetPort,
        startedAt: Date.now(),
      });
      return handle(config, dataDir, targetPort, next, { pid: child.pid });
    }
    if (next.running && !next.authorized)
      throw Error("新启动的 LingFlow 服务令牌不匹配，可能同时又启动了另一个实例。请检查独立窗口。");
    if (!alive(child.pid) && !next.running)
      throw Error(
        "LingFlow 服务启动失败（进程 " +
          child.pid +
          " 已退出）。请确认 Node.js 可用，或直接运行 `npm run service` 查看报错。",
      );
  }
  throw Error("等待 LingFlow 服务就绪超时（端口 " + targetPort + "）。");
}

/** Restart the detached service this module started. Refuses to touch one it does not own. */
export async function restartService({ dataDir = defaultDataDir(), port, timeoutMs = 30000 } = {}) {
  const config = readConfig(dataDir);
  const targetPort = port ?? config.port;
  const record = readPidFile(dataDir);
  if (!record || record.port !== targetPort || !alive(record.pid))
    throw Error(
      "当前 LingFlow 服务不是由侧边栏启动的（可能由独立窗口托管），侧边栏不能重启它。请在独立窗口退出 LingFlow 后再试。",
    );
  try {
    process.kill(record.pid);
  } catch (error) {
    if (error.code !== "ESRCH") throw Error("停止旧服务失败：" + error.message);
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const probe = await probeInstance(targetPort, { token: config.uiToken, timeoutMs: 500 });
    if (!probe.running) break;
    await sleep(250);
  }
  clearPidFile(dataDir);
  return ensureService({ dataDir, port: targetPort, timeoutMs });
}

export function managedPid(dataDir = defaultDataDir()) {
  const record = readPidFile(dataDir);
  return record && alive(record.pid) ? record : null;
}
