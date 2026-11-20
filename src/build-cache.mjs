import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fingerprint } from "./files.mjs";

const ignoredNames = new Set(["node_modules", "dist", ".git", ".hive", ".scratch", "test-results", "playwright-report"]);
const cacheFile = (dataDir, projectId) => path.join(dataDir, "build-cache",
  createHash("sha256").update(projectId).digest("hex") + ".sqlite");

function keyFor(root, steps, outputs, env) {
  try {
    const git = execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD", "--abbrev-ref", "HEAD"],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const files = fingerprint(root, readdirSync(root), outputs, ignoredNames, { eol: "raw" });
    const recipe = steps.map(({ argv, outputs, timeoutMs }) => [argv, outputs, timeoutMs]);
    return createHash("sha256").update(JSON.stringify([1, root, git, recipe, files, process.execPath,
      process.version, Object.entries(env).sort(([left], [right]) => left.localeCompare(right))])).digest("hex");
  } catch {
    return null;
  }
}

function outputBytes(absolute) {
  const info = lstatSync(absolute);
  return info.isDirectory() ? readdirSync(absolute).reduce((sum, name) => sum + outputBytes(path.join(absolute, name)), 0) : info.size;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export function buildCacheStats(dataDir, projectId) {
  const file = cacheFile(dataDir, projectId);
  const empty = { entries: [], hits: 0, misses: 0, savedMs: 0 };
  if (!existsSync(file)) return empty;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='metrics'").get()) return empty;
    return {
      entries: db.prepare("SELECT cacheKey,builtAt,bytes,lastHitAt FROM entries ORDER BY builtAt DESC,rowid DESC").all().map(entry => ({ ...entry })),
      ...db.prepare("SELECT hits,misses,savedMs FROM metrics WHERE id=1").get(),
    };
  } finally { db.close(); }
}

export async function withBuildCache(root, check, { dataDir, projectId, env, started }, prepare, readArtifacts) {
  const steps = check.preSteps ?? [];
  if (!dataDir || !projectId || !steps.length) return prepare();
  const outputs = [...new Set(steps.flatMap(step => step.outputs))];
  const file = cacheFile(dataDir, projectId);
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000 });
  let lease = false;
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (cacheKey TEXT PRIMARY KEY,builtAt INTEGER,bytes INTEGER,lastHitAt INTEGER,buildMs INTEGER,artifacts TEXT);
      CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY CHECK(id=1),hits INTEGER,misses INTEGER,savedMs INTEGER);
      INSERT OR IGNORE INTO metrics VALUES (1,0,0,0);
      COMMIT;`);
    const acquire = db.prepare("INSERT OR IGNORE INTO lease VALUES (1,?)");
    while (!lease) {
      if (Date.now() - started >= check.timeoutMs)
        throw Object.assign(Error("等待同项目构建前置超过检查总时限"), { timedOut: true });
      lease = Boolean(acquire.run(process.pid).changes);
      if (lease) break;
      const owner = db.prepare("SELECT pid FROM lease WHERE id=1").get();
      if (owner && !alive(owner.pid)) db.prepare("DELETE FROM lease WHERE id=1 AND pid=?").run(owner.pid);
      else await delay(50);
    }
    const cacheKey = keyFor(root, steps, outputs, env);
    const entry = cacheKey && db.prepare("SELECT * FROM entries WHERE cacheKey=?").get(cacheKey);
    if (entry) {
      let artifacts;
      try { artifacts = readArtifacts(); } catch {}
      if (artifacts && entry.artifacts === JSON.stringify(artifacts.filter(artifact => outputs.includes(artifact.file)))) {
        const at = Date.now();
        db.prepare("UPDATE entries SET lastHitAt=? WHERE cacheKey=?").run(at, cacheKey);
        db.prepare("UPDATE metrics SET hits=hits+1,savedMs=savedMs+? WHERE id=1").run(entry.buildMs);
        return { steps: [], artifacts, cached: true, cacheKey, builtAt: entry.builtAt, savedMs: entry.buildMs };
      }
      db.prepare("DELETE FROM entries WHERE cacheKey=?").run(cacheKey);
    }
    db.exec("UPDATE metrics SET misses=misses+1 WHERE id=1");
    const result = await prepare();
    const builtAt = Date.now();
    if (cacheKey && cacheKey === keyFor(root, steps, outputs, env)) {
      const buildMs = result.steps.reduce((sum, step) => sum + step.elapsedMs, 0);
      const artifacts = result.artifacts.filter(artifact => outputs.includes(artifact.file));
      const bytes = outputs.reduce((sum, output) => sum + outputBytes(path.join(root, output)), 0);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO entries VALUES (?,?,?,NULL,?,?)").run(cacheKey, builtAt, bytes, buildMs, JSON.stringify(artifacts));
        db.exec("DELETE FROM entries WHERE cacheKey NOT IN (SELECT cacheKey FROM entries ORDER BY builtAt DESC,rowid DESC LIMIT 4); COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return { ...result, ...(cacheKey && { cacheKey, builtAt }) };
  } finally {
    try { if (lease) db.prepare("DELETE FROM lease WHERE id=1 AND pid=?").run(process.pid); }
    finally { db.close(); }
  }
}
