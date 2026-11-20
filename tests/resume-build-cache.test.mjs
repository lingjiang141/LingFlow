import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { fingerprint } from "../src/files.mjs";
import { artifactsIntact, prepareCheck } from "../src/check-preparation.mjs";
import { Store } from "../src/store.mjs";
import { Workflow } from "../src/workflow.mjs";

const runProcess = promisify(execFile);

test("idle resumes coalesce across members and survive service restarts without follow-up turns", async (t) => {
  const f = await fixture(t);
  f.store.change(state => { state.tasks = []; state.notices = []; state.roles.reverse(); });
  f.close();
  const tick = (workflow, now) => workflow.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })), now).deliveries;
  let store, workflow;
  t.after(() => store?.close());
  for (let restart = 0; restart < 3; restart++) {
    store?.close();
    store = new Store(path.join(f.dir, "workflow.sqlite"));
    workflow = new Workflow(store);
    for (const role of f.roles) workflow.call("ui", "enable", { roleId: role.id, enabled: true, resume: true }, `resume-${restart}-${role.id}`);
    assert.deepEqual(tick(workflow, Date.now()), []);
  }
  const deliveries = tick(workflow, Date.now() + 25050);
  assert.equal(deliveries.length, 1);
  const [wake] = deliveries;
  assert.equal(wake.roleId, f.roles.find(role => role.kind === "reviewer").id);
  assert.equal(wake.silent, true);
  assert.equal(wake.actionable, false);
  assert.equal(workflow.validWake(wake.id, wake.sessionId).valid, true);
  assert.match(wake.text, /角色已开启 · 本轮无责任.*无需核对收件箱/s);
  assert.doesNotMatch(wake.text, /下一步|待处理事项|没有派给/);
  workflow.acknowledge(wake.id, wake.sessionId);
  assert.deepEqual(tick(workflow, Date.now() + 150000), []);
  for (const role of f.roles) {
    const inbox = workflow.call(role.name, "inbox", {});
    const notice = inbox.notices.find(item => item.key.startsWith("resume:"));
    assert.equal(notice.silent, true);
    assert.equal(notice.actionable, false);
    assert.equal(inbox.recovery, undefined);
  }
});

function buildFixture(f, buildMs = 900) {
  const outputs = ["apps/web/dist"];
  const log = path.join(f.dir, "build.log");
  const mode = path.join(f.dir, "build-mode");
  mkdirSync(path.join(f.root, "apps/web"), { recursive: true });
  f.put("apps/web/app.js", "first");
  f.put("package.json", JSON.stringify({ scripts: { build: "node build.cjs" } }));
  f.put("build.cjs", `const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(log)}, process.pid + '\\n');
    const mode = ${JSON.stringify(mode)};
    if (fs.existsSync(mode) && fs.readFileSync(mode, 'utf8') === 'fail') process.exit(3);
    setTimeout(() => {
      if (fs.existsSync(mode) && fs.readFileSync(mode, 'utf8') === 'missing') return;
      fs.mkdirSync('apps/web/dist', { recursive: true });
      fs.copyFileSync('apps/web/app.js', 'apps/web/dist/app.js');
    }, ${buildMs});`);
  const projectId = f.store.read().projects[0].id;
  const check = { argv: ["node", "-e", "const fs=require('node:fs'); require('node:assert/strict').equal(fs.readFileSync('apps/web/dist/app.js','utf8'),fs.readFileSync('apps/web/app.js','utf8'));"], timeoutMs: buildMs + 6000,
    preSteps: [{ argv: ["npm", "run", "build"], outputs, timeoutMs: buildMs + 3000 }], requiredArtifacts: outputs };
  const buildCount = () => readFileSync(log, "utf8").trim().split("\n").length;
  return { check, options: { projectId, dataDir: f.dir }, buildCount, mode };
}

async function startCheck(f, id, check, projectId) {
  const directory = path.join(f.dir, "checks", id);
  mkdirSync(directory, { recursive: true });
  const files = ["apps/web/app.js"];
  writeFileSync(path.join(directory, "request.json"), JSON.stringify({ id, check, root: f.root,
    projectId, files, input: JSON.stringify([fingerprint(f.root, files)]) }));
  await runProcess(process.execPath, [path.resolve("src/check-worker.mjs"), directory]);
  return JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8"));
}

test("four build preparations reuse products until inputs or output fingerprints change", async (t) => {
  const f = await fixture(t);
  const { check, options, buildCount } = buildFixture(f, Number(process.env.LINGFLOW_BENCHMARK_BUILD_MS ?? 900));
  let start = performance.now();
  const uncached = [];
  for (const stage of ["red", "green", "e2e-full", "regression"]) uncached.push(await startCheck(f, `${stage}-no-cache`, { ...check, id: stage }));
  const uncachedMs = performance.now() - start;
  start = performance.now();
  const jobs = [];
  for (const stage of ["red", "green", "e2e-full", "regression"]) jobs.push(await startCheck(f, `${stage}-cache`, { ...check, id: stage }, options.projectId));
  const cachedMs = performance.now() - start;
  assert.ok([...uncached, ...jobs].every(job => job.exitCode === 0));
  const receipts = jobs.map(job => job.preparation);
  const preparationSeconds = runs => (runs.reduce((sum, job) => sum + job.preparation.elapsedMs, 0) / 1000).toFixed(3);
  t.diagnostic(`four fixture checks: wall ${(uncachedMs / 1000).toFixed(3)}s -> ${(cachedMs / 1000).toFixed(3)}s; preparation ${preparationSeconds(uncached)}s -> ${preparationSeconds(jobs)}s`);
  assert.equal(buildCount(), 5);
  assert.deepEqual(receipts.map(receipt => receipt.cached), [false, true, true, true]);
  const stats = f.call("ui", "buildCache", { projectId: options.projectId });
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 3);
  assert.equal(stats.savedMs, receipts.slice(1).reduce((sum, receipt) => sum + receipt.savedMs, 0));
  assert.equal(stats.entries.length, 1);
  assert.ok(stats.entries[0].lastHitAt >= stats.entries[0].builtAt);
  assert.ok(stats.entries[0].bytes > 0);
  f.put("apps/web/app.js", "uncommitted source edit");
  const changed = await prepareCheck(f.root, check, options);
  assert.equal(changed.cached, false);
  assert.notEqual(changed.cacheKey, receipts[0].cacheKey);
  const hit = await prepareCheck(f.root, check, options);
  assert.equal(hit.cached, true);
  f.put("apps/web/dist/app.js", "edited output");
  assert.equal(artifactsIntact(f.root, hit), false);
  assert.equal((await prepareCheck(f.root, check, options)).cached, false);
});

test("build-cache keys include branch and recipe; older entries are pruned", async (t) => {
  const f = await fixture(t);
  const projectId = f.store.read().projects[0].id;
  const options = { projectId, dataDir: f.dir };
  const check = { timeoutMs: 5000, preSteps: [{ argv: ["node", "-e", "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/app.js','compiled');"], outputs: ["dist"], timeoutMs: 1000 }] };
  const base = await prepareCheck(f.root, check, options);
  assert.equal(base.cached, false);
  f.git("branch", "cache-fixture");
  f.git("switch", "cache-fixture");
  const branch = await prepareCheck(f.root, check, options);
  assert.notEqual(base.cacheKey, branch.cacheKey);
  assert.equal(branch.cached, false);
  for (const timeoutMs of [1100, 1200, 1300]) await prepareCheck(f.root, { ...check, preSteps: [{ ...check.preSteps[0], timeoutMs }] }, options);
  const { entries } = f.call("ui", "buildCache", { projectId });
  assert.equal(entries.length, 4);
  assert.ok(!entries.some(entry => entry.cacheKey === base.cacheKey));
});

test("independent check processes build once; failed preparations do not seed the cache", async (t) => {
  const f = await fixture(t);
  const { check, options, buildCount, mode } = buildFixture(f);
  const run = (id, recipe = check) => startCheck(f, id, recipe, options.projectId);
  writeFileSync(mode, "fail");
  assert.match((await run("failed")).preparationError, /构建前置失败/);
  writeFileSync(mode, "missing");
  assert.match((await run("missing")).preparationError, /缺少构建产物/);
  const timeoutStep = { ...check.preSteps[0], argv: ["node", "-e", "setTimeout(()=>{},5000)"], timeoutMs: 200 };
  assert.equal((await run("timeout", { ...check, preSteps: [timeoutStep] })).timedOut, true);
  assert.deepEqual(f.call("ui", "buildCache", { projectId: options.projectId }).entries, []);
  writeFileSync(mode, "ok");
  const receipts = await Promise.all([run("one"), run("two")]);
  assert.ok(receipts.every(receipt => receipt.exitCode === 0));
  assert.deepEqual(receipts.map(receipt => receipt.preparation.cached).sort(), [false, true]);
  assert.equal(buildCount(), 3);
  t.diagnostic("two detached check workers after nonzero exit, missing artifact and timeout: exactly one successful build process");
});
