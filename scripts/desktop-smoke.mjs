import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(".validation", "desktop-" + Date.now());
mkdirSync(root, { recursive: true });
const env = {
  ...process.env,
  LINGFLOW_DATA_DIR: path.join(root, "data"),
  LINGFLOW_SMOKE_DIR: root,
};
delete env.ELECTRON_RUN_AS_NODE;
const exe = path.resolve(process.argv[2] || "node_modules/electron/dist/electron.exe");
const child = spawn(exe, process.argv[2] ? ["--disable-gpu"] : ["--disable-gpu", "."], {
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
child.stderr.on("data", (data) => {
  errors += data;
});
const timer = setTimeout(() => {
  child.kill();
}, 30000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timer);
assert.equal(code, 0, errors);
const result = JSON.parse(
  readFileSync(path.join(root, "desktop.json"), "utf8"),
);
assert.match(result.emptyBody, /建立你的第一个协作团队/);
assert.deepEqual(result.projectFields, ["name", "root"]);
assert.equal(result.emptyTeam, true);
assert.equal(result.savedControllerPolicy, "先核对流程证据");
assert.match(result.controllerIdentityDefault, /用户的直接联系人/);
assert.doesNotMatch(result.controllerIdentityDefault, /undefined/);
assert.equal(result.savedControllerIdentity, "只核对收口证据");
assert.match(result.deleteConfirmation, /删除项目「LingFlow 界面验证」/);
assert.equal(result.deletedProject, true);
assert.equal(result.projectDirectoryRetained, true);
assert.match(result.body, /LingFlow 界面验证/);
assert.match(result.body, /需求与交付/);
assert.equal(result.manualDispatch, false);
assert.equal(result.checksPanel.editable, false);
assert.match(result.checksPanel.content, /按原票冻结的检查命令执行/);
assert.doesNotMatch(result.checksPanel.content, /白名单|待批准/);
assert.ok(Array.isArray(result.boardColumns));
assert.match(result.body, /质量审查员/);
assert.doesNotMatch(result.body, /编辑成员与提示词/);
assert.equal(result.renameOnly, true);
assert.equal(result.savedPrompt, "检查交互边界");
assert.equal(result.customRoleLabel, "质量工程师");
assert.match(result.deliveryControls.enablePending, /正在登记续接/);
assert.match(result.deliveryControls.silentResume, /保留原任务/);
assert.match(result.deliveryControls.pausePending, /正在暂停新投递/);
assert.match(result.deliveryControls.paused, /恢复投递与团队工具/);
assert.match(result.deliveryControls.unbindConfirmation, /解绑「质量审查员」的会话/);
assert.equal(result.deliveryControls.cancelKeptBinding, true);
assert.equal(result.deliveryControls.canEnableAfterUnbind, false);
assert.equal(result.reboundMember, true);
assert.match(result.body, /质量工程师\(审查\)/);
assert.deepEqual(result.errors, []);
assert.equal(result.trayHidden, true, "Closing the window must leave the tray active");
assert.equal(result.serviceWhileHidden, true, "The same local service must stay responsive while hidden");
assert.equal(result.trayRestored, true, "The tray click must restore the original renderer");
assert.equal(result.trayMinimized, true);
assert.equal(result.trayMenuRestored, true, "The tray menu must restore a minimized window");
await assert.rejects(fetch("http://127.0.0.1:" + result.trayServicePort + "/api/ui/hello",
  { signal: AbortSignal.timeout(1500) }), "Quitting from the tray must stop the desktop-owned service");
if (process.env.LINGFLOW_DSH_TOOLS)
  assert.equal(result.dshContract.passed, true);
for (const error of result.screenshotErrors ?? []) console.warn("Desktop screenshot unavailable: " + error);
console.log("Desktop window verified: " + root);
