#!/usr/bin/env node
/**
 * Install, update or remove the LingFlow sidebar panel in the local DSH profile.
 *
 * The panel is installed as a linked bundle: the profile keeps pointing at
 * `E:\LingFlow\panel`, so later edits to LingFlow show up in the sidebar without
 * reinstalling. This script only touches two fields of the profile
 * package.json (dependencies + dsh.profile.bundles) plus one node_modules link;
 * it never writes cordis.patch.yml, never rewrites the plugin tree and never
 * deletes plugin data.
 *
 * Usage (dry run is the default):
 *   node scripts/panel-install.mjs                 # preview only
 *   node scripts/panel-install.mjs --apply         # install or refresh the link
 *   node scripts/panel-install.mjs --remove --apply# uninstall
 *   node scripts/panel-install.mjs --profile <dir> # target another profile
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_DIR = path.join(ROOT, "panel");
const NAME = "lingflow-panel";
const REPORT_DIR = path.join(ROOT, ".validation", "panel");
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const apply = argv.includes("--apply");
const remove = argv.includes("--remove");
const force = argv.includes("--force");
const profile = path.resolve(
  flag("--profile") ||
    process.env.DSH_PROFILE_DIR ||
    path.join(
      process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
      "profiles",
      process.env.DSH_PROFILE || "desktop",
    ),
);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const say = (line = "") => console.log(line);
const stripLongPath = (value) => value.replace(/^\\\\\?\\/, "");

function fail(message) {
  console.error("安装脚本停止：" + message);
  process.exit(1);
}

function linkTarget() {
  // pnpm-style link spec; forward slashes keep it stable inside JSON/YAML.
  return "link:" + PACKAGE_DIR.replaceAll("\\", "/");
}

function existingLink() {
  const target = path.join(profile, "node_modules", NAME);
  try {
    const info = lstatSync(target);
    if (!info.isSymbolicLink()) return { kind: "directory", path: target };
    return {
      kind: "link",
      path: target,
      target: path.resolve(stripLongPath(readlinkSync(target))),
    };
  } catch {
    return null;
  }
}

function writePlan(pkg, next, raw) {
  // `before` must be the bytes actually on disk: JSON.stringify would normalise
  // indentation and line endings and defeat the "nobody else touched it" guard.
  const before = raw;
  const after = JSON.stringify(next, null, 2) + "\n";
  mkdirSync(REPORT_DIR, { recursive: true });
  const preview = path.join(REPORT_DIR, "install-preview.json");
  writeFileSync(
    preview,
    JSON.stringify(
      {
        profile,
        packageDir: PACKAGE_DIR,
        link: linkTarget(),
        action: remove ? "remove" : "install",
        beforeHash: sha256(before),
        afterHash: sha256(after),
        dependencies: {
          before: pkg.dependencies?.[NAME] ?? null,
          after: next.dependencies?.[NAME] ?? null,
        },
        bundlesAdded: (next.dsh.profile.bundles ?? []).filter(
          (item) => !(pkg.dsh.profile.bundles ?? []).includes(item),
        ),
        bundlesRemoved: (pkg.dsh.profile.bundles ?? []).filter(
          (item) => !(next.dsh.profile.bundles ?? []).includes(item),
        ),
      },
      null,
      2,
    ),
  );
  return { before, after, preview };
}

// ---------------------------------------------------------------------------

if (!existsSync(PACKAGE_DIR))
  fail("找不到面板包目录：" + PACKAGE_DIR + "（应该在 E:\\LingFlow\\panel）");
for (const file of ["package.json", "index.js", "client.js", "cordis.patch.yml"])
  if (!existsSync(path.join(PACKAGE_DIR, file)))
    fail("面板包不完整，缺少 " + file + "：" + PACKAGE_DIR);

const profileFile = path.join(profile, "package.json");
if (!existsSync(profileFile))
  fail(
    "没找到 DSH profile 配置文件：" +
      profileFile +
      "\n可用 --profile <目录> 指定，或先运行一次 DSH。",
  );

const raw = readFileSync(profileFile, "utf8");
let pkg;
try {
  pkg = JSON.parse(raw);
} catch (error) {
  fail("profile package.json 无法解析（保留现场，不改动）：" + error.message);
}
if (!pkg || typeof pkg !== "object") fail("profile package.json 结构异常");
pkg.dependencies ??= {};
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
if (!Array.isArray(pkg.dsh.profile.bundles))
  fail(
    "profile package.json 的 dsh.profile.bundles 不是数组，本脚本只做增量安装，请手动核对：" +
      profileFile,
  );

const next = JSON.parse(JSON.stringify(pkg));
const bundles = next.dsh.profile.bundles;
const already = bundles.includes(NAME);
const linked = existingLink();

if (remove) {
  next.dsh.profile.bundles = bundles.filter((item) => item !== NAME);
  delete next.dependencies[NAME];
} else {
  next.dependencies[NAME] = linkTarget();
  // A bundle must load after the runtime packages it patches, so it goes last.
  if (!already) bundles.push(NAME);
}

const plan = writePlan(pkg, next, raw);
say("LingFlow 侧边栏面板 — " + (remove ? "卸载" : "安装/更新"));
say("  profile      : " + profile);
say("  面板包        : " + PACKAGE_DIR);
say("  链接目标      : " + linkTarget());
say(
  "  node_modules : " +
    (linked
      ? linked.kind === "link"
        ? "已有链接 → " + linked.target
        : "已存在同名实目录（不是链接）"
      : "不存在，将创建 junction"),
);
say(
  "  dependencies : " +
    (pkg.dependencies[NAME] ?? "（无）") +
    "  →  " +
    (next.dependencies[NAME] ?? "（无）"),
);
say("  bundles      : " + JSON.stringify(pkg.dsh.profile.bundles));
say("             →  " + JSON.stringify(next.dsh.profile.bundles));
say("  预览         : " + plan.preview);

if (plan.before === plan.after) {
  say("");
  say("profile 配置已经是目标状态，无需改动。");
} else if (!apply) {
  say("");
  say("这是预览，未修改任何文件。确认后加 --apply 执行。");
  say("注意：写入后需要重载 DSH（关闭并重新打开 DSH）才会加载侧边栏插件；");
  say("      正在运行的会话会被中断，请选空闲时机执行。");
}

if (apply) {
  const current = readFileSync(profileFile, "utf8");
  if (current !== plan.before)
    fail("profile package.json 在预览后被其他程序修改，已中止（未写入）。请重跑。");

  // 1. node_modules link (the only filesystem change outside package.json).
  const target = path.join(profile, "node_modules", NAME);
  if (remove) {
    if (linked?.kind === "link") {
      try {
        unlinkSync(target);
      } catch {
        rmSync(target, { recursive: true, force: true });
      }
      say("已移除链接：" + target);
    } else if (linked) {
      say("跳过：node_modules/" + NAME + " 不是链接，未删除：" + target);
    }
  } else {
    const wanted = path.resolve(PACKAGE_DIR);
    if (linked?.kind === "link" && linked.target === wanted) {
      say("链接已是最新：" + target);
    } else if (linked?.kind === "directory" && !force) {
      fail(
        "node_modules/" +
          NAME +
          " 是实目录而非链接，可能是 pnpm 拷贝安装。确认后加 --force 替换。",
      );
    } else {
      if (linked) {
        try {
          unlinkSync(target);
        } catch {
          rmSync(target, { recursive: true, force: true });
        }
      }
      mkdirSync(path.join(profile, "node_modules"), { recursive: true });
      symlinkSync(wanted, target, "junction");
      say("已建立链接：" + target + " → " + wanted);
    }
  }

  // 2. package.json, guarded by a backup.
  mkdirSync(REPORT_DIR, { recursive: true });
  const backup = path.join(
    REPORT_DIR,
    "package.json." + new Date().toISOString().replaceAll(":", "-") + ".bak",
  );
  copyFileSync(profileFile, backup);
  writeFileSync(profileFile, plan.after);
  const written = readFileSync(profileFile, "utf8");
  if (written !== plan.after)
    fail("写入校验失败，已保留备份：" + backup);
  writeFileSync(
    path.join(REPORT_DIR, "install-receipt.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        profile,
        action: remove ? "remove" : "install",
        link: remove ? null : linkTarget(),
        backup,
        beforeHash: sha256(plan.before),
        afterHash: sha256(written),
      },
      null,
      2,
    ),
  );
  say("已写入 profile package.json（备份：" + backup + "）");

  if (remove) {
    say("");
    say("卸载完成。LingFlow 项目数据、独立窗口和 DSH 适配器都没有被改动。");
    say("重载 DSH 后侧边栏入口消失。");
  } else {
    say("");
    say("安装完成。下一步：关闭并重新打开 DSH，侧边栏会出现 LingFlow 图标。");
    say("刷新浏览器页面只会更新面板前端；服务代码更新请点面板里的「重启服务」。");
  }
}
