import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { exportProject, projectRoot } from "./export-project.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw Error("Build on Windows x64 with the locked Electron runtime.");
const destination = process.argv[2];
if (!destination) throw Error("Usage: npm run build:portable -- <new absolute directory outside project>");
const target = path.resolve(destination), relative = path.relative(projectRoot, target);
if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw Error("Portable output must be outside project.");
if (existsSync(target)) throw Error("Destination already exists; nothing overwritten: " + target);
const runtime = path.join(projectRoot, "node_modules/electron/dist");
const expected = JSON.parse(readFileSync(path.join(projectRoot, "package.json"))).devDependencies.electron;
const actual = readFileSync(path.join(runtime, "version"), "utf8").trim();
if (actual.replace(/^v/, "") !== expected) throw Error("Electron runtime version differs from package lock.");
const arch = spawnSync(path.join(runtime, "electron.exe"), ["-p", "process.arch"],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true });
if (arch.status !== 0 || arch.stdout.trim() !== "x64") throw Error("Electron runtime must be Windows x64.");
mkdirSync(target, { recursive: true });
cpSync(runtime, target, { recursive: true, errorOnExist: true, force: false });
renameSync(path.join(target, "electron.exe"), path.join(target, "LingFlow.exe"));
const manifest = exportProject(path.join(target, "resources/app"));
writeFileSync(path.join(target, "Start-LingFlow.cmd"), '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "" "%~dp0LingFlow.exe" %*\r\n');
writeFileSync(path.join(target, "README.txt"),
  "LingFlow " + manifest.version + " - Windows x64\r\nExtract the whole folder to a writable location, then run Start-LingFlow.cmd.\r\nDo not copy LingFlow.exe alone. No Node installation is needed for the desktop UI.\r\nDSH integration needs your own DSH installation; CLI setup scripts need Node.js 24+.\r\nDocs, MIT license and third-party notices: resources/app/README.md and THIRD_PARTY_NOTICES.md.\r\nRuntime data defaults to %LOCALAPPDATA%/LingFlow, outside this application directory.\r\n");
console.log(JSON.stringify({ state: "built", destination: target, electron: actual, appFiles: manifest.files.length }));
