import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coversPath, implementationFingerprint, overlaps, scopePaths } from "./files.mjs";
import { readGit } from "./quality.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const status = root => readGit(root, ["status", "--porcelain=v1", "-z"]);
const contained = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

function copyDependencies(source, target, root, snapshot, checkBudget) {
  if (!existsSync(source)) return;
  const links = [];
  cpSync(source, target, { recursive: true, filter(from, to) {
    checkBudget();
    if (!lstatSync(from).isSymbolicLink()) return true;
    const resolved = realpathSync(from);
    if (!contained(root, resolved)) throw Error("隔离取红无法使用指向项目外的依赖链接：" + path.relative(root, from));
    const destination = path.join(snapshot, path.relative(root, resolved));
    links.push({ to, destination, directory: statSync(resolved).isDirectory() });
    return false;
  } });
  for (const { to, destination, directory } of links) {
    checkBudget();
    symlinkSync(process.platform === "win32" && directory ? destination : path.relative(path.dirname(to), destination),
      to, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
  }
}

function workspaceBuilds(root, snapshot, directories, check, testWrites) {
  const packages = new Map();
  for (const directory of directories.filter(Boolean)) {
    // Tests in this package already run against its source. Only bootstrap linked dependencies.
    if (testWrites.some(file => coversPath([directory.split(path.sep).join("/")], file))) continue;
    const manifest = JSON.parse(readFileSync(path.join(snapshot, directory, "package.json"), "utf8"));
    const { main, name, scripts } = manifest;
    if (typeof main !== "string" || typeof name !== "string" || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || !scripts?.build) continue;
    const mainPath = path.resolve(snapshot, directory, main);
    if (!contained(path.join(snapshot, directory), mainPath) || existsSync(mainPath) ||
        !existsSync(path.resolve(root, directory, main))) continue;
    const output = path.relative(snapshot, path.dirname(mainPath)).split(path.sep).join("/");
    if (path.dirname(mainPath) === path.join(snapshot, directory) ||
        check.preSteps?.some(step => coversPath(step.outputs, output))) continue;
    const packageRoot = realpathSync(path.join(root, directory));
    const linked = directories.some(owner => {
      const link = path.join(root, owner, "node_modules", name);
      return lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && realpathSync(link) === packageRoot;
    });
    if (!linked) continue;
    packages.set(name, { manifest, output });
  }
  const builds = [], visited = new Set(), visiting = new Set();
  function visit(name) {
    const item = packages.get(name);
    if (!item || visited.has(name)) return;
    if (visiting.has(name)) throw Error("隔离取红的工作区构建依赖成环：" + name);
    visiting.add(name);
    const { manifest, output } = item;
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) visit(dep);
    builds.push({ argv: ["npm", "run", "build", "--workspace", name], outputs: [output], timeoutMs: check.timeoutMs });
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of packages.keys()) visit(name);
  return builds;
}

function materializeTree(root, snapshot, entries, checkBudget) {
  const batchLimit = 8 * 1024 * 1024;
  let files = [], size = 0;
  function writeBatch() {
    if (!files.length) return;
    checkBudget();
    const input = Buffer.from(files.map(file => file.blob).join("\n") + "\n", "ascii");
    const data = readGit(root, ["cat-file", "--batch"], "buffer", input);
    let offset = 0;
    for (const file of files) {
      checkBudget();
      const end = data.indexOf(10, offset);
      if (end < 0 || data.toString("ascii", offset, end) !== `${file.blob} blob ${file.size}` ||
          data[end + 1 + file.size] !== 10) throw Error("无法读取隔离快照字节：" + file.path);
      const target = path.join(snapshot, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data.subarray(end + 1, end + 1 + file.size), { flag: "wx", mode: file.mode });
      offset = end + 2 + file.size;
    }
    files = [];
    size = 0;
  }
  for (const entry of entries) {
    const cost = entry.size + 128;
    if (size + cost > batchLimit || files.length >= 256) writeBatch();
    files.push(entry);
    size += cost;
  }
  writeBatch();
}

export function prepareRedSnapshot(job, deadline, preflight = () => {}) {
  const { root, redSnapshot, rawPaths } = job;
  const { head, writes, sources } = redSnapshot;
  const checkBudget = () => {
    if (Date.now() >= deadline) throw Object.assign(Error("隔离取红超时"), { timedOut: true });
  };
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw Error("隔离取红须绑定有效 Git 提交");
  if (job.check.argv.some(arg => arg.replaceAll("\\", "/").toLowerCase().includes(root.replaceAll("\\", "/").toLowerCase())))
    throw Error("隔离取红须使用相对项目路径");
  const beforeStatus = status(root);
  const scratchRoot = realpathSync(tmpdir());
  const scratch = mkdtempSync(path.join(scratchRoot, "lingflow-red-"));
  const cleanup = () => {
    if (path.dirname(scratch) !== scratchRoot || !path.basename(scratch).startsWith("lingflow-red-"))
      throw Error("隔离取红目录越界");
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    const snapshot = path.join(scratch, "project");
    mkdirSync(snapshot);
    const rows = readGit(root, ["ls-tree", "-r", "-l", "-z", head, "--"]).split("\0").filter(Boolean);
    const entries = rows.map(row => {
      const match = /^100(644|755) blob ([a-f0-9]+) +([0-9]+)\t([^\r\n]+)$/.exec(row);
      if (!match || scopePaths([match[4]])[0] !== match[4] || /(?:^|\/)[^/]*[. ](?:\/|$)/.test(match[4]))
        throw Error("隔离取红基线含不支持的 Git 路径、子模块或链接");
      return { path: match[4], blob: match[2], size: Number(match[3]), mode: Number.parseInt(match[1], 8) };
    });
    const tracked = new Map(entries.map(file => [file.path, file.blob]));
    materializeTree(root, snapshot, entries, checkBudget);
    const packages = ["", ...[...tracked.keys()].filter(file => file.endsWith("/package.json")).map(file => path.dirname(file))];
    const builds = workspaceBuilds(root, snapshot, packages, job.check, rawPaths);
    const conflictingOutputs = builds.flatMap(step => step.outputs).filter(output => overlaps([output], job.files));
    if (conflictingOutputs.length)
      throw Error("这些自动构建目录与冻结读写或检查输入重叠，请核对后由主控移除误加的产物路径：" + conflictingOutputs.join("、"));
    preflight(builds);

    const restoredFiles = [];
    const observed = {};
    for (const file of new Set([...tracked.keys(), ...job.files])) {
      if (coversPath(rawPaths, file) || !coversPath(job.files, file)) continue;
      checkBudget();
      const from = path.join(root, file), to = path.join(snapshot, file);
      if (existsSync(to) && lstatSync(to).isDirectory()) continue;
      const bytes = existsSync(to) ? readFileSync(to) : null;
      const blob = bytes && createHash(head.length === 64 ? "sha256" : "sha1")
        .update("blob " + bytes.length + "\0").update(bytes).digest("hex");
      if ((tracked.get(file) ?? null) !== blob) throw Error("隔离取红输入与提交字节不符：" + file);
      const before = existsSync(from) && lstatSync(from).isFile() ? sha256(readFileSync(from)) : null;
      const after = bytes ? sha256(bytes) : null;
      observed[file] = after;
      if (before !== after) restoredFiles.push({ path: file, before, after });
    }

    const task = { writes, verification: { testWrites: rawPaths } };
    if (implementationFingerprint(realpathSync(snapshot), task, job.fingerprintEol).sources !== sources)
      throw Error("隔离取红提交与冻结的实现写集指纹不符");
    for (const file of rawPaths) {
      checkBudget();
      const from = path.join(root, file), to = path.join(snapshot, file);
      if (!existsSync(from)) throw Error("隔离取红缺少冻结测试文件：" + file);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true, filter(input) {
        checkBudget();
        if (lstatSync(input).isSymbolicLink()) throw Error("隔离取红测试目录包含链接：" + file);
        return true;
      } });
    }
    for (const directory of packages) {
      checkBudget();
      copyDependencies(path.join(root, directory, "node_modules"), path.join(snapshot, directory, "node_modules"),
        root, snapshot, checkBudget);
    }
    const executionRoot = realpathSync(snapshot);
    const readObserved = () => Object.fromEntries(Object.keys(observed).map(file => {
      const target = path.join(executionRoot, file);
      if (!existsSync(target)) return [file, null];
      if (!lstatSync(target).isFile() || realpathSync(target) !== target) throw Error("隔离输入变成链接或非普通文件：" + file);
      return [file, sha256(readFileSync(target))];
    }));
    return { root: executionRoot, cleanup, observed, restoredFiles,
      workspaceBuilds: builds,
      inputsIntact: () => JSON.stringify(readObserved()) === JSON.stringify(observed),
      statusIntact: () => status(root) === beforeStatus };
  } catch (error) {
    cleanup();
    throw error;
  }
}
