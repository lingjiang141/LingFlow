import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defaultDataDir } from "../src/server.mjs";
const toolsModule = process.argv[2];
if (!toolsModule)
  throw Error("请指定当前 DSH 的 dsh-tools/lib/index.js 绝对路径");
if (!path.isAbsolute(toolsModule)) throw Error("toolsModule 必须为绝对路径");
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = path.join(root, ".validation", "dsh-setup");
mkdirSync(dir, { recursive: true });
const yaml = `# LingFlow 注册项；只增加本插件，不替换已有插件树。\n- insert:\n    - id: lingflow-dsh\n      name: ${JSON.stringify(path.join(root, "adapters/dsh/index.mjs").replaceAll("\\", "/"))}\n      config:\n        toolsModule: ${JSON.stringify(toolsModule.replaceAll("\\", "/"))}\n        dataDir: ${JSON.stringify(defaultDataDir().replaceAll("\\", "/"))}\n`;
const file = path.join(dir, "cordis.patch.yml");
writeFileSync(file, yaml);
console.log(
  "已生成独立插件注册配置：" + file + "\n未修改 DSH 配置或重启 DSH。",
);
