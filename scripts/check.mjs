import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const files = [];
function walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(mjs|cjs|js)$/.test(file)) files.push(file);
  }
}
for (const root of ["src", "desktop", "adapters", "ui", "scripts", "tests", "panel"])
  walk(root);
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
}
console.log(`Syntax OK: ${files.length} files`);
