import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
const profileOption = process.argv.indexOf("--profile");
if (profileOption >= 0 && !process.argv[profileOption + 1]) throw Error("--profile 需要 cordis.patch.yml 的绝对路径");
const profile = profileOption >= 0 ? path.resolve(process.argv[profileOption + 1]) : path.join(
  os.homedir(),
  ".dsh",
  "profiles",
  "desktop",
  "cordis.patch.yml",
);
const root = path.resolve(".validation", "dsh-setup");
mkdirSync(root, { recursive: true });
const original = readFileSync(profile);
const snippet = readFileSync(path.join(root, "cordis.patch.yml"), "utf8");
if (original.includes(Buffer.from("id: lingflow-dsh")))
  throw Error("已有 LingFlow 注册项，保留现场");
if (process.argv.includes("--with-validation")) throw Error("发行版不注册本机调试驱动，请单独核对调试配置。");
const addition =
  "\n# BEGIN LingFlow local integration\n" +
  snippet +
  "# END LingFlow local integration\n";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const receipt = {
  profile,
  before: hash(original),
  after: hash(Buffer.concat([original, Buffer.from(addition)])),
  addition,
};
writeFileSync(
  path.join(root, "registration-preview.json"),
  JSON.stringify(receipt, null, 2),
);
if (!process.argv.includes("--apply")) {
  console.log("已准备追加配置预览；未修改 DSH。");
  process.exit(0);
}
if (hash(readFileSync(profile)) !== receipt.before)
  throw Error("DSH 配置并发变化，停止写入");
const backup = path.join(root, "cordis.patch." + Date.now() + ".bak");
writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
receipt.backup = backup;
appendFileSync(profile, addition);
if (hash(readFileSync(profile)) !== receipt.after)
  throw Error("追加后出现并发改动，请保留现场");
writeFileSync(
  path.join(root, "registration-receipt.json"),
  JSON.stringify(receipt, null, 2),
);
console.log("已追加 LingFlow 注册项；未更改原配置内容，也未重启进程。");
