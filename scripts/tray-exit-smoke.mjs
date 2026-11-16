import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(".validation", "tray-exit-" + Date.now());
mkdirSync(root, { recursive: true });
const env = { ...process.env, LINGFLOW_TRAY_EXIT_SMOKE_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.resolve("node_modules/electron/dist/electron.exe"), ["--disable-gpu", "desktop/tray-exit-smoke.cjs"], {
  env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
child.stderr.on("data", data => { errors += data; });
const timer = setTimeout(() => child.kill(), 15000);
let code;
try {
  code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
} finally { clearTimeout(timer); }
assert.equal(code, 0, errors);
const result = JSON.parse(readFileSync(path.join(root, "result.json"), "utf8"));
assert.ok(result.elapsedMs < 3000, "Tray quit must release an incomplete HTTP upload");
assert.equal(result.windowsRemaining, 0);
assert.equal(result.trayDestroyed, true);
assert.equal(result.serviceStopped, true);
await assert.rejects(fetch(`http://127.0.0.1:${result.port}/api/ui/hello`, { signal: AbortSignal.timeout(1000) }));
console.log(JSON.stringify({ ...result, evidence: root }));
