import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const nodeDir = path.dirname(process.execPath);
const npm = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
const electron = path.resolve("node_modules", "electron", "dist", "electron.exe");

test("npm preparation uses the Node installation even when the desktop worker has no Node in PATH", {
  skip: process.platform !== "win32" || !existsSync(npm) || !existsSync(electron),
}, () => {
  const script = [
    'import { prepareCheck } from "./src/check-preparation.mjs";',
    'const result = await prepareCheck(process.cwd(), { timeoutMs: 10000,',
    'preSteps: [ ["npm", "--version"], ["node", "-p", "process.versions.modules"] ]',
    '.map(argv => ({ argv, timeoutMs: 10000, outputs: [] })) }, { env: { ...process.env } });',
    'console.log(JSON.stringify(result.steps.map(step => step.output.trim())));',
  ].join("\n");
  const output = execFileSync(electron, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true,
    env: { Path: path.join(process.env.SystemRoot, "System32"), SystemRoot: process.env.SystemRoot,
      ProgramFiles: path.dirname(nodeDir), ELECTRON_RUN_AS_NODE: "1" }, timeout: 15000 });
  const [npmVersion, modules] = JSON.parse(output);
  assert.match(npmVersion, /\d+\.\d+\.\d+/);
  assert.equal(modules, process.versions.modules);
});
