import { existsSync, statSync } from "node:fs";
import path from "node:path";

const windows = process.platform === "win32";
const nodeName = windows ? "node.exe" : "node";
const envKey = (env, name) => windows
  ? Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase()) ?? name
  : name;
const isFile = file => statSync(file, { throwIfNoEntry: false })?.isFile() === true;

export function resolveCheckCommand([program, ...args], env, preferredNode) {
  const bundledNode = program === "node" && path.basename(process.execPath).toLowerCase() !== nodeName;
  if (program !== "npm" && !bundledNode)
    return { executable: program === "node" ? process.execPath : program, args, env };
  const pathKey = envKey(env, "PATH");
  const search = (env[pathKey] ?? "").split(path.delimiter)
    .map(item => item.trim().replace(/^"|"$/g, "")).filter(path.isAbsolute);
  const installRoots = windows ? ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
    .map(name => env[envKey(env, name)]).filter(value => value && path.isAbsolute(value))
    .map(directory => path.join(directory, "nodejs")) : [];
  const directories = new Set([
    ...(preferredNode ? [path.dirname(preferredNode)] : []), path.dirname(process.execPath), ...search, ...installRoots,
  ]);
  for (const directory of directories) {
    const executable = path.join(directory, nodeName);
    if (!isFile(executable)) continue;
    const cli = program === "npm" && [
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      path.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find(isFile);
    if (program === "npm" && !cli) continue;
    const childEnv = { ...env };
    if (windows) {
      for (const key of Object.keys(childEnv))
        if (key.toUpperCase() === "PATH") delete childEnv[key];
    }
    childEnv[pathKey] = [directory, ...search].join(path.delimiter);
    delete childEnv[envKey(childEnv, "ELECTRON_RUN_AS_NODE")];
    return { executable, args: cli ? [cli, ...args] : args, env: childEnv };
  }
  if (bundledNode) return { executable: process.execPath, args, env };
  throw Object.assign(Error("LingFlow 检查进程找不到配套的 Node.js 与 npm-cli.js。请核对 Node 安装和桌面进程 PATH。"),
    { code: "npm-runtime-missing" });
}

export function preferredCheckNode(argv) {
  const program = argv?.[0];
  return program && path.isAbsolute(program) && path.basename(program).toLowerCase() === nodeName &&
    existsSync(program) ? program : undefined;
}
