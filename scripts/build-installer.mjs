import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [portableDir, setupPath, compiler = "makensis.exe"] = process.argv.slice(2);
if (process.platform !== "win32" || !portableDir || !setupPath) {
  throw Error("Usage on Windows: npm run build:installer -- <portable directory> <new Setup.exe> [makensis.exe]");
}
const portable = path.resolve(portableDir);
const setup = path.resolve(setupPath);
const relative = path.relative(portable, setup);
if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
  throw Error("Installer output must be outside the portable directory.");
}
if (!/\.exe$/i.test(setup) || existsSync(setup)) throw Error("Choose a new .exe output path.");
const source = new URL("../package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(source, "utf8"));
const bundled = JSON.parse(readFileSync(path.join(portable, "resources/app/RELEASE-MANIFEST.json"), "utf8"));
if (bundled.product !== "LingFlow" || bundled.version !== version || !existsSync(path.join(portable, "LingFlow.exe"))) {
  throw Error("Build the matching LingFlow portable package before building Setup.");
}

function nsisPath(file) {
  if (/["\r\n*?]/.test(file)) throw Error("Unsupported installer path: " + file);
  return file.replaceAll("$", () => "$$");
}

const files = [], directories = [];
function walk(dir) {
  for (const name of readdirSync(path.join(portable, dir)).sort()) {
    const file = path.join(dir, name);
    const info = lstatSync(path.join(portable, file));
    if (info.isSymbolicLink()) throw Error("Installer must not follow local links: " + file);
    if (info.isFile()) files.push(file);
    else if (info.isDirectory()) {
      walk(file);
      directories.push(file);
    }
  }
}
walk("");

const temporary = mkdtempSync(path.join(os.tmpdir(), "lingflow-setup-"));
try {
  const include = path.join(temporary, "payload.nsh");
  const payload = [
    "!macro InstallPayload",
    '  File /r "' + nsisPath(portable) + '\\*"',
    "!macroend",
    "!macro RemovePayload",
    ...files.map(file => '  Delete "$INSTDIR\\' + nsisPath(file) + '"'),
    "  IfErrors failed",
    // Remove only empty program directories so files added by the user survive.
    ...directories.map(dir => '  RMDir "$INSTDIR\\' + nsisPath(dir) + '"'),
    "  ClearErrors",
    "!macroend",
  ];
  writeFileSync(include, "\uFEFF" + payload.join("\r\n") + "\r\n");
  const result = spawnSync(compiler, [
    "/V2", "/WX", "/DPAYLOAD_INCLUDE=" + nsisPath(include),
    "/DSETUP_OUTPUT=" + nsisPath(setup), "/DPRODUCT_VERSION=" + version,
    fileURLToPath(new URL("./installer.nsi", import.meta.url)),
  ], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(setup)) throw Error("NSIS failed to build the installer.");
  console.log("Built " + setup);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
