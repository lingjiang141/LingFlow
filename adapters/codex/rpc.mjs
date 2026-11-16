import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class CodexRpcError extends Error {}

export function startCodexRpc({ onEvent, onRequest, onClose }) {
  const executable = process.env.LINGFLOW_CODEX_EXECUTABLE ??
    (process.platform === "win32" ? "codex.exe" : "codex");
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const write = (value) => {
    if (closed || !child.stdin.writable) throw Error("Codex 会话服务已断开");
    child.stdin.write(JSON.stringify(value) + "\n");
  };
  function close(error) {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    child.stdin.destroy();
    if (child.pid) child.kill();
    onClose?.();
  }
  const fail = () => close(Error("无法连接本机 Codex。请检查 CLI 是否已安装并可运行。"));
  child.once("error", fail);
  child.once("exit", fail);
  child.stdin.on("error", fail);
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      if (message.id === undefined) onEvent?.(message.method, message.params);
      else onRequest?.(message.method, message.params, message.id);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new CodexRpcError(message.error.message ?? "Codex 请求被拒绝"));
    else entry.resolve(message.result);
  });
  return {
    request(method, params, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Codex 请求超时，结果需要对账"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { write({ id, method, params }); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method) { write({ method }); },
    reply(id, result) { write({ id, result }); },
    reject(id) { write({ id, error: { code: -32601, message: "该交互当前不受支持" } }); },
    close() { close(Error("Codex 会话服务已关闭")); },
  };
}
