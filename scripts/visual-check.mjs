// 隔离视觉验证：spawn 一个独立的 Electron 实例（独立 dataDir / 端口 0 / 独立 userData），
// 截图四种主题、自定义窗口背景、成员卡背景，并断言页面无报错。
// 只读取本地产物，不触碰任何正在运行的服务。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(".validation", "visual-" + Date.now());
mkdirSync(root, { recursive: true });
const env = {
  ...process.env,
  LINGFLOW_VISUAL_DIR: root,
  LINGFLOW_DATA_DIR: path.join(root, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const exe = path.resolve("node_modules/electron/dist/electron.exe");
const child = spawn(exe, ["--disable-gpu", path.join("scripts", "visual-main.cjs")], {
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
let stdout = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
child.stdout.on("data", (data) => {
  stdout += data;
});
const timer = setTimeout(() => {
  child.kill();
}, 180000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timer);

const resultPath = path.join(root, "visual.json");
assert.ok(existsSync(resultPath), "缺少 visual.json（进程退出码 " + code + "）\n" + stderr);
const result = JSON.parse(readFileSync(resultPath, "utf8"));
assert.equal(result.fatal, undefined, "视觉脚本异常：" + result.fatal);
assert.equal(code, 0, "Electron 退出码 " + code + "\n" + stderr);

// 页面自身没有未捕获错误
assert.deepEqual(result.errors, [], "页面存在未捕获错误：" + JSON.stringify(result.errors));
// 顶栏主题按钮存在
assert.equal(result.themeButton, true, "左上角 Logo 下方缺少主题切换按钮");
// 对话框断言
assert.ok(result.dialogSummary, "窗口外观对话框未打开");
assert.equal(result.dialogSummary.open, true);
assert.equal(result.dialogSummary.themeCards, 4, "应展示 4 个预设主题");
assert.ok(result.dialogSummary.hasRange >= 3, "应提供位置与透明度滑块");
assert.ok(result.dialogSummary.assets >= 1, "对话框里应列出已导入素材");

// 背景偏好在刷新后仍然生效
assert.equal(result.persisted.wallpaper, "1", "刷新后自定义窗口背景未恢复");
assert.equal(result.persisted.hasImage, true, "刷新后背景图未绘制");
assert.equal(result.persisted.backgroundSize, "cover", "背景图应使用 cover 等比铺满");
assert.ok(result.persisted.opacity > 0.5, "背景图透明度应大于 0.5");

// 窗口比例变化不变形
for (const [label, size] of [["narrow", result.narrow], ["wide", result.wide]]) {
  assert.equal(size.backgroundSize, "cover", label + " 截图时背景应保持 cover");
  assert.equal(size.backgroundPosition, "50% 50%", label + " 截图时背景位置应保持 50% 50%");
}
assert.notEqual(result.narrow.width, result.wide.width, "窗口宽度应发生变化");

// 截图产物
const required = [
  "01-dark",
  "02-theme-white",
  "02-theme-lavender",
  "02-theme-sky",
  "03-wallpaper",
  "04-wallpaper-persisted",
  "05-theme-dialog",
  "09-narrow",
  "10-wide",
];
const names = new Set(result.shots.map((shot) => shot.name));
for (const name of required) assert.ok(names.has(name), "缺少截图 " + name);
assert.deepEqual(result.screenshotErrors, [], "截图失败：" + JSON.stringify(result.screenshotErrors));
for (const shot of result.shots) {
  const file = path.join(root, shot.name + ".png");
  assert.ok(existsSync(file), "缺少截图文件 " + file);
  assert.ok(statSync(file).size > 8000, "截图文件过小（可能空白）" + file);
}

// 控制台不允许出现 CSP 违规、脚本加载失败、外观接口 404 之类的问题
const suspicious = (result.consoleErrors ?? []).filter((line) =>
  /Content Security Policy|Refused to|status of 404|Cannot use import statement|is not defined|Uncaught/i.test(line),
);
assert.deepEqual(suspicious, [], "控制台存在异常：" + JSON.stringify(suspicious));

// 成员卡外观（模块缺省时可通过 LINGFLOW_REQUIRE_CARDS=0 放宽，用于中间态调试）
const requireCards = process.env.LINGFLOW_REQUIRE_CARDS !== "0";
if (result.cardState) {
  assert.ok(result.roles.length >= 3, "角色卡数量不足");
  assert.ok(result.roles.every((role) => role.icon), "每张角色卡右上角都应有外观图标按钮");
  assert.ok(
    result.roles.every((role) => role.iconLabel.length > 0),
    "外观图标按钮需要有 aria-label",
  );
  const painted = result.cardState.cards.filter((card) => card.hasImage && card.opacity > 0.5);
  assert.ok(painted.length >= 1, "成员卡背景图未生效");
  assert.ok(
    result.cardState.cards.some((card) => card.color === "rgb(42, 33, 64)"),
    "成员卡自定义底色未生效",
  );
  assert.ok(result.shots.some((shot) => shot.name === "06-card-applied"), "缺少成员卡背景截图");
  assert.ok(result.shots.some((shot) => shot.name === "08-card-persisted"), "缺少成员卡持久化截图");
} else if (requireCards) {
  assert.fail("window.__lingflowCards 未接入，成员卡外观模块缺失");
}

console.log("Visual check verified: " + root);
console.log(
  "screenshots: " +
    result.shots.map((shot) => shot.name + "(" + shot.size.width + "x" + shot.size.height + ")").join(", "),
);
console.log(
  "theme=" + result.theme + " wallpaper=" + result.wallpaper + " assets=" + result.assetCount,
);
if (stdout.trim()) console.log(stdout.trim());
