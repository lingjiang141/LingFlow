import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const roots = ["src", "desktop", "adapters", "panel", "skills", "skill-pack", "tests", "ui", ".github"];
const files = ["package.json", "package-lock.json", ".gitignore", "AGENTS.md", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"];
const docs = ["deployment.md", "data-storage.md", "desktop-pet.md", "lingflow-contract.md", "command-arguments.md", "environment-failure.md", "global-skills.md", "planning-workflow.md",
  "images/lingflow-workbench.png", "images/lingflow-pet-progress.png"];
const scripts = ["check.mjs", "desktop-smoke.mjs", "dsh-contract.mjs", "prepare-dsh.mjs", "register-dsh.mjs", "adapt-global-skills.mjs", "backup-global-skills.ps1",
  "export-project.mjs", "build-portable.mjs", "build-installer.mjs", "installer.nsi", "migrate-data.ps1", "panel-install.mjs", "panel-e2e.mjs",
  "panel-embed-probe.mjs", "panel-embed-probe-main.cjs", "panel-visual.mjs", "panel-visual-main.cjs",
  "pet-smoke.mjs", "spec-cycle-smoke.mjs", "spec-cycle-smoke.cjs", "tray-exit-smoke.mjs", "visual-check.mjs", "visual-main.cjs", "import-pet-assets.mjs"];
const ignored = new Set([".git", "node_modules", ".validation", ".magpie-library", "dist", ".env", ".env.local"]);

export function exportProject(destination, source = projectRoot) {
  const root = path.resolve(source), target = path.resolve(destination);
  const relative = path.relative(root, target);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
    throw Error("Export destination must be outside the source project.");
  if (existsSync(target)) throw Error("Destination already exists; no files overwritten: " + target);
  const selected = [];
  function walk(file) {
    const parts = file.split("/");
    if (parts.some(part => ignored.has(part)) || file === "ui/assets" || /\.(sqlite(?:-wal|-shm)?|log)$/i.test(file)) return;
    const full = path.join(root, file), stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw Error("Release must not follow local links: " + file);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) walk(file + "/" + name);
    } else if (stat.isFile()) selected.push(file);
  }
  // Only these product directories/files are eligible; local evidence and private docs are never traversed.
  for (const file of [...files, ...roots, ...docs.map(f => "docs/" + f), ...scripts.map(f => "scripts/" + f)]) walk(file);
  const manifest = selected.sort().map(file => {
    const data = readFileSync(path.join(root, file));
    return { file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  });
  mkdirSync(target, { recursive: true });
  for (const { file } of manifest) {
    const output = path.join(target, file);
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(path.join(root, file), output);
  }
  const result = { product: "LingFlow", version: JSON.parse(readFileSync(path.join(root, "package.json"))).version,
    files: manifest, totalBytes: manifest.reduce((n, f) => n + f.bytes, 0) };
  writeFileSync(path.join(target, "RELEASE-MANIFEST.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw Error("Usage: npm run export:source -- <new absolute directory outside project>");
  const result = exportProject(destination);
  console.log(JSON.stringify({ destination: path.resolve(destination), files: result.files.length, bytes: result.totalBytes }));
}
