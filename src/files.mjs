import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export const fingerprintEol = process.env.LINGFLOW_FINGERPRINT_EOL ?? "normalize";
if (!["raw", "normalize"].includes(fingerprintEol))
  throw Error("LINGFLOW_FINGERPRINT_EOL 必须是 raw 或 normalize");

export function normalizeEol(buffer) {
  let start = buffer.indexOf("\r\n");
  if (start < 0) return buffer;
  const normalized = Buffer.allocUnsafe(buffer.length);
  let read = 0, written = 0;
  while (start >= 0) {
    written += buffer.copy(normalized, written, read, start);
    normalized[written++] = 10;
    read = start + 2;
    start = buffer.indexOf("\r\n", read);
  }
  written += buffer.copy(normalized, written, read);
  return normalized.subarray(0, written);
}

const fingerprintBytes = (bytes, eol) => eol === "raw" ? bytes : normalizeEol(bytes);

export function scopePaths(values) {
  if (!Array.isArray(values)) throw Error("范围必须是相对路径数组");
  return [
    ...new Set(
      values.map((value) => {
        if (typeof value !== "string" || !value.trim())
          throw Error("路径不能为空");
        const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
        if (
          path.isAbsolute(normalized) ||
          normalized.includes(":") ||
          /[*?]/.test(normalized) ||
          normalized
            .split("/")
            .some((p) => [".", "..", ".git", ""].includes(p.toLowerCase()))
        )
          throw Error("请声明具体相对路径，不允许 .git 或越界路径");
        return normalized;
      }),
    ),
  ].sort();
}
function invalidPath(value, origin, expected) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const message = `${origin} 须为${expected}，实际为 ${type}`;
  throw Object.assign(Error(message), { verificationCode: "contract-invalid",
    violations: [{ path: origin, message, expected, actual: type }] });
}
export function assertPaths(paths, origin) {
  if (!Array.isArray(paths)) invalidPath(paths, origin, "路径数组");
  for (let i = 0; i < paths.length; i++)
    if (typeof paths[i] !== "string") invalidPath(paths[i], `${origin}[${i}]`, "路径字符串");
}
export function overlaps(a, b, aOrigin = "overlaps.a", bOrigin = "overlaps.b") {
  assertPaths(a, aOrigin);
  assertPaths(b, bOrigin);
  return a.some((left) =>
    b.some((right) => {
      left = left.toLowerCase();
      right = right.toLowerCase();
      return (
        left === right ||
        left.startsWith(right + "/") ||
        right.startsWith(left + "/")
      );
    }),
  );
}
export function coversPath(paths, file, pathsOrigin = "coversPath.paths", fileOrigin = "coversPath.file") {
  if (typeof file !== "string") invalidPath(file, fileOrigin, "路径字符串");
  assertPaths(paths, pathsOrigin);
  const candidate = file.toLowerCase();
  return paths.some((path) => {
    const lower = path.toLowerCase();
    return candidate === lower || candidate.startsWith(lower + "/");
  });
}
export function fingerprint(root, paths, excluded = [], excludedNames, { eol = fingerprintEol, rawPaths = [], fileDigests, onFileBytes, fileBytes } = {}) {
  if (realpathSync(root) !== root) throw Error("项目路径身份发生变化");
  return fingerprintEntries(paths, excluded, excludedNames, { eol, rawPaths, fileDigests, onFileBytes }, relative => {
    const absolute = path.resolve(root, relative);
    let walk = root;
    for (const segment of relative.split("/")) {
      walk = path.join(walk, segment);
      if (existsSync(walk) && lstatSync(walk).isSymbolicLink())
        throw Error("候选范围不能包含链接：" + relative);
    }
    if (!existsSync(absolute)) return null;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) return readdirSync(absolute);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw Error("候选仅支持每个 20MB 以内的普通文件：" + relative);
    return fileBytes?.get(relative) ?? readFileSync(absolute);
  });
}

export function fingerprintEntries(paths, excluded, excludedNames, { eol, rawPaths, fileDigests, onFileBytes }, readEntry) {
  const hash = createHash("sha256");
  let count = 0;
  function visit(relative) {
    if (excludedNames?.has(relative.slice(relative.lastIndexOf('/') + 1).toLowerCase())) return;
    if (excluded.some((entry) => relative.toLowerCase() === entry.toLowerCase() || relative.toLowerCase().startsWith(entry.toLowerCase() + "/")))
      return;
    if (++count > 10000) throw Error("候选范围超过 10000 个条目，请缩小范围");
    const entry = readEntry(relative);
    hash.update(relative + "\0");
    if (entry === null) {
      hash.update("missing\0");
      if (fileDigests) fileDigests[relative] = null;
      return;
    }
    if (Array.isArray(entry)) {
      hash.update("directory\0");
      if (fileDigests) fileDigests[relative] = "directory";
      for (const name of entry.sort()) {
        if (name === ".git" && !excludedNames?.has(name)) throw Error("候选范围不能包含 .git");
        visit(relative + "/" + name);
      }
    } else {
      hash.update("file\0");
      onFileBytes?.(relative, entry);
      const bytes = fingerprintBytes(entry, coversPath(rawPaths, relative) ? "raw" : eol);
      hash.update(bytes);
      if (fileDigests) fileDigests[relative] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  for (const item of [...new Set(paths)].sort()) visit(item);
  return hash.digest("hex");
}

export function implementationTreeFingerprint(task, eol, readEntry) {
  const sourceFiles = Object.create(null);
  const sources = fingerprintEntries(task.writes, task.verification.testWrites, undefined,
    { eol, rawPaths: [], fileDigests: sourceFiles }, readEntry);
  return { sources, sourceFiles };
}

export function fileSha256(root, relative) {
  const [file] = scopePaths([relative]);
  const fileDigests = Object.create(null);
  fingerprint(root, [file], [], undefined, { eol: "raw", fileDigests });
  if (!/^[a-f0-9]{64}$/.test(fileDigests[file] ?? "")) throw Error("归属确认需要现存普通文件：" + file);
  return fileDigests[file];
}

export function implementationFingerprint(root, task, eol = fingerprintEol, onFileBytes) {
  const sourceFiles = Object.create(null);
  const sources = fingerprint(root, task.writes, task.verification.testWrites, undefined, { eol, fileDigests: sourceFiles, onFileBytes });
  return { sources, sourceFiles };
}

const ownershipCaches = new Map();
const stamp = (stat) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function ownershipFingerprints(root, { head, index, indexStamp, ignoreVersion, eol = fingerprintEol }) {
  if (realpathSync(root) !== root) throw Error("项目路径身份发生变化");
  let cache = ownershipCaches.get(root);
  const invalidatedBy = !cache ? "cold" : cache.head !== head ? "head-changed" :
    cache.index !== index || cache.indexStamp !== indexStamp ? "index-changed" : cache.ignoreVersion !== ignoreVersion ? "ignores-changed" :
      cache.eol !== eol ? "fingerprint-eol-changed" : null;
  if (invalidatedBy) {
    cache = { head, index, indexStamp, ignoreVersion, eol, files: new Map() };
    if (ownershipCaches.size >= 8 && !ownershipCaches.has(root)) ownershipCaches.delete(ownershipCaches.keys().next().value);
    ownershipCaches.set(root, cache);
  }
  const directories = new Set([root]);
  const metrics = { scannedFiles: 0, cacheHits: 0, bytesRead: 0, invalidatedBy };
  function regularDirectory(dir) {
    if (directories.has(dir)) return;
    if (dir === path.dirname(dir)) throw Error("候选范围越过项目根目录");
    regularDirectory(path.dirname(dir));
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw Error("候选范围不能包含链接：" + path.relative(root, dir));
    directories.add(dir);
  }
  return { metrics, started: performance.now(), file(relative) {
    metrics.scannedFiles++;
    const absolute = path.join(root, relative);
    regularDirectory(path.dirname(absolute));
    let stat;
    try { stat = lstatSync(absolute, { bigint: true, throwIfNoEntry: false }); }
    catch (error) { if (error.code !== "ENOTDIR") throw error; }
    if (!stat) return createHash("sha256").update(relative + "\0missing\0").digest("hex");
    if (stat.isSymbolicLink()) throw Error("候选范围不能包含链接：" + relative);
    if (stat.isDirectory()) return fingerprint(root, [relative], [], undefined, { eol });
    if (!stat.isFile() || stat.size > 20n * 1024n * 1024n) throw Error("候选仅支持每个 20MB 以内的普通文件：" + relative);
    const key = stamp(stat), previous = cache.files.get(relative);
    if (previous?.key === key) {
      metrics.cacheHits++;
      return previous.digest;
    }
    const bytes = readFileSync(absolute);
    if (stamp(lstatSync(absolute, { bigint: true })) !== key) throw Error("核算归属期间文件已变化：" + relative);
    const digest = createHash("sha256").update(relative + "\0file\0").update(fingerprintBytes(bytes, eol)).digest("hex");
    if (cache.files.size < 16000 || previous) cache.files.set(relative, { key, digest });
    metrics.bytesRead += bytes.length;
    return digest;
  } };
}
