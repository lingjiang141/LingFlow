import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

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
export function overlaps(a, b) {
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
export function coversPath(paths, file) {
  const candidate = file.toLowerCase();
  return paths.some((path) => candidate === path.toLowerCase() || candidate.startsWith(path.toLowerCase() + "/"));
}
export function fingerprint(root, paths, excluded = []) {
  const hash = createHash("sha256");
  let count = 0;
  function visit(relative) {
    if (excluded.some((entry) => relative.toLowerCase() === entry.toLowerCase() || relative.toLowerCase().startsWith(entry.toLowerCase() + "/")))
      return;
    if (++count > 10000) throw Error("候选范围超过 10000 个条目，请缩小范围");
    const absolute = path.resolve(root, relative);
    let walk = root;
    for (const segment of relative.split("/")) {
      walk = path.join(walk, segment);
      if (existsSync(walk) && lstatSync(walk).isSymbolicLink())
        throw Error("候选范围不能包含链接：" + relative);
    }
    hash.update(relative + "\0");
    if (!existsSync(absolute)) {
      hash.update("missing\0");
      return;
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const name of readdirSync(absolute).sort()) {
        if (name === ".git") throw Error("候选范围不能包含 .git");
        visit(relative + "/" + name);
      }
    } else {
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
        throw Error("候选仅支持每个 20MB 以内的普通文件：" + relative);
      hash.update("file\0");
      hash.update(readFileSync(absolute));
    }
  }
  if (realpathSync(root) !== root) throw Error("项目路径身份发生变化");
  for (const item of [...new Set(paths)].sort()) visit(item);
  return hash.digest("hex");
}

const ownershipCaches = new Map();
const stamp = (stat) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function ownershipFingerprints(root, { head, index, indexStamp, ignoreVersion }) {
  if (realpathSync(root) !== root) throw Error("项目路径身份发生变化");
  let cache = ownershipCaches.get(root);
  const invalidatedBy = !cache ? "cold" : cache.head !== head ? "head-changed" :
    cache.index !== index || cache.indexStamp !== indexStamp ? "index-changed" : cache.ignoreVersion !== ignoreVersion ? "ignores-changed" : null;
  if (invalidatedBy) {
    cache = { head, index, indexStamp, ignoreVersion, files: new Map() };
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
    if (stat.isDirectory()) return fingerprint(root, [relative]);
    if (!stat.isFile() || stat.size > 20n * 1024n * 1024n) throw Error("候选仅支持每个 20MB 以内的普通文件：" + relative);
    const key = stamp(stat), previous = cache.files.get(relative);
    if (previous?.key === key) {
      metrics.cacheHits++;
      return previous.digest;
    }
    const bytes = readFileSync(absolute);
    if (stamp(lstatSync(absolute, { bigint: true })) !== key) throw Error("核算归属期间文件已变化：" + relative);
    const digest = createHash("sha256").update(relative + "\0file\0").update(bytes).digest("hex");
    if (cache.files.size < 16000 || previous) cache.files.set(relative, { key, digest });
    metrics.bytesRead += bytes.length;
    return digest;
  } };
}
