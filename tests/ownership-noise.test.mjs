import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { executionPolicy } from "../src/execution-policy.mjs";
import { ownershipPolicy } from "../src/ownership-policy.mjs";
import { assertOutsideScope, gitState, planningSourceNotes } from "../src/quality.mjs";
import { fixture, versionedSpec } from "./helpers/evidence-fixture.mjs";

const newRules = ["/.scratch/", "/logs/", "**/dist.bak-*/"];
const spec = ".scratch/x/spec.md";
const noise = [".scratch/y/other.md", "logs/x.log", "apps/server/dist.bak-v48/x.js"];
const source = "apps/server/src/xxx.ts";
const git = (root, args) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: root, windowsHide: true, encoding: "utf8" });
const put = (f, file, body = "fixture") => {
  mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true });
  f.put(file, body);
};

test("ownership defaults compile for only the intended noise, and explicit project rules replace them", () => {
  const policy = ownershipPolicy();
  for (const file of [".scratch/a/spec.md", ...noise]) assert.equal(policy.ignores(file), true, file);
  for (const file of ["apps/server/src/org/routes.ts", "docs/agents/domain.md", ".lingflow/planning/spec.md",
    "packages/shared/src/types.ts", "apps/server/logs/readme.md", "apps/.scratch/not-root.md"])
    assert.equal(policy.ignores(file), false, file);
  const config = { ownershipIgnores: ["/.scratch/"], projects: {
    narrow: { ownershipIgnores: ["/logs/"] },
    off: { ownershipIgnores: [] },
  } };
  const narrow = ownershipPolicy(executionPolicy(config, "narrow").ownershipIgnores);
  assert.deepEqual(narrow.patterns, ["/logs/"]);
  assert.equal(narrow.ignores(spec), false);
  assert.equal(narrow.ignores("logs/x.log"), true);
  assert.deepEqual(ownershipPolicy(executionPolicy(config, "off").ownershipIgnores).patterns, []);
  assert.deepEqual(ownershipPolicy(executionPolicy(config, "other").ownershipIgnores).patterns, ["/.scratch/"]);
});

test("Git excludes the three noise paths but lists unrelated untracked source", async t => {
  const f = await fixture(t);
  for (const file of [...noise, source]) put(f, file);
  const args = ["ls-files", "-z", "--others", "--exclude-standard"];
  const files = options => git(f.root, [...args, ...options]).split("\0").filter(Boolean);
  for (const file of [...noise, source]) assert.ok(files([]).includes(file), file);
  assert.deepEqual(files(newRules.map(rule => "--exclude=" + rule)), [source]);
  const task = f.store.read().tasks[0];
  assert.deepEqual(gitState(f.root, task).dirty, [source]);
  assert.ok(gitState(f.root, { ...task, writes: [...task.writes, "logs/x.log"] }).dirty.includes("logs/x.log"));
  assert.throws(() => assertOutsideScope(f.root, task, [], gitState(f.root, task)), /发现未归属的改动：apps\/server\/src\/xxx\.ts/);
});

test("repository ignore patterns suppress historical noise but ticket paths remain visible", async t => {
  const f = await fixture(t);
  f.put(".gitignore", "/apps/web/dist/\n/.tmp/\n");
  f.git("add", ".gitignore");
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "ignore generated paths");
  put(f, "apps/web/dist/index.html");
  put(f, ".tmp/dump_xlsx.py");
  const task = f.store.read().tasks[0];
  task.baseline.other = [["apps/web/dist/index.html", "previous digest"]];
  const state = gitState(f.root, task, []);
  assert.deepEqual(state.dirty, []);
  assert.deepEqual(state.ownershipIgnoreDetails.suppressedHistoricalGit, ["apps/web/dist/index.html"]);
  const declared = gitState(f.root, { ...task, writes: [...task.writes, ".tmp/dump_xlsx.py"] }, []);
  assert.deepEqual(declared.ownershipIgnoreDetails.declaredGitIgnored, [".tmp/dump_xlsx.py"]);
  assert.deepEqual(declared.dirty, [".tmp/dump_xlsx.py"]);
});

test("ownership inventory counts active patterns without changing the ignored file count", async t => {
  const f = await fixture(t);
  for (const file of [...noise, source]) put(f, file);
  const rules = [...ownershipPolicy().patterns, "/not-present/"];
  const task = f.store.read().tasks[0];
  const logged = t.mock.method(console, "info", () => {});
  gitState(f.root, task, rules);
  const inventory = () => logged.mock.calls
    .filter(call => call.arguments[0] === "LingFlow ownership inventory")
    .map(call => JSON.parse(call.arguments[1]))
    .find(sample => sample.patterns === rules.length);
  const deadline = Date.now() + 10000;
  while (!inventory() && Date.now() < deadline) await delay(20);
  assert.equal(inventory()?.gitUntrackedFiles, 4);
  assert.equal(inventory()?.ignoredFiles, 3);
});

test("protected planning source and untracked noise do not block the five original-ticket recovery commands", async t => {
  const f = await fixture(t);
  const original = f.store.read().tasks[0];
  const requirementId = original.requirementId;
  const verification = structuredClone(original.verification);
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  const ticket = { developerId: original.developerId, title: "Ownership fixture", description: "Recover original ticket",
    writes: original.writes, reads: [], risk: "high", verification };
  const sources = { spec, tickets: "tickets.md", attempts: "attempts.md" };
  const baseline = key => f.call("Lead", "dispatchPlan", { requirementId, sources, tickets: [{ key, ...ticket }] }).tasks[0];
  const fileBefore = versionedSpec("冻结的规划文档");
  put(f, spec, fileBefore);
  f.store.change(state => { state.tasks = []; state.notices = []; });
  const { taskId, state } = baseline("OWNERSHIP-01");
  assert.equal(state, "assigned");
  const snapshot = f.store.read();
  const task = snapshot.tasks[0], plan = snapshot.plans.find(plan => plan.id === task.planId);
  assert.equal(task.sources.spec.file, spec);
  assert.ok(gitState(f.root, task).protectedPaths.includes(spec));
  assert.ok(gitState(f.root, task).dirty.includes(spec), "protected source must be restored to Git enumeration");
  assert.equal(task.baseline.recordedDirtySources[spec], task.sources.spec.digest);
  assert.ok(!task.baseline.other.some(([file]) => file === spec));
  assert.deepEqual(planningSourceNotes(f.root, task, plan), []);
  const scenarios = [
    { name: "未改动的已冻结 sources", notes: [] },
    { name: "改动已声明的 spec", setup: () => put(f, spec, versionedSpec("替换已冻结的规划正文").replace("v1", "v2")), notes: ["planning-source-changed"] },
    { name: "新增未声明的 scratch、logs、部署备份", setup: () => noise.forEach(file => put(f, file)), notes: ["planning-source-changed"] },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, () => {
    scenario.setup?.();
    assert.deepEqual(planningSourceNotes(f.root, task, plan).map(note => note.kind), scenario.notes);
    assert.doesNotThrow(() => assertOutsideScope(f.root, task, [], gitState(f.root, task)));
    for (const command of ["reviseSchedule", "supersede", "abandonTask", "releaseSchedule", "rework"]) {
      f.store.change(current => Object.assign(current, structuredClone(snapshot)));
      f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
      if (command === "rework") f.store.change(current => { current.tasks[0].state = "changes_requested"; });
      else f.call("Dev", "yieldForSchedule", { taskId, reason: "原票已停写" });
      const args = { taskId, reason: "隔离验收" };
      if (command === "reviseSchedule") args.refreshBaseline = true;
      if (command === "supersede") args.supersededBy = baseline("OWNERSHIP-02").taskId;
      const receipt = f.call("Lead", command, args);
      const resumed = f.store.read().tasks.find(task => task.id === taskId);
      if (command === "releaseSchedule") assert.equal(receipt.scopeReleased, true);
      else assert.equal(resumed.state, { reviseSchedule: "assigned", supersede: "superseded", abandonTask: "abandoned", rework: "rework" }[command], command);
    }
  });
});

test("existing baselines stop treating excluded untracked entries as ownership changes", async t => {
  const f = await fixture(t);
  for (const file of noise) put(f, file, "before policy rollout");
  f.wf.execution = { ownershipIgnores: ownershipPolicy().patterns.filter(rule => !newRules.includes(rule)) };
  const task = f.store.read().tasks[0];
  f.call("Dev", "yieldForSchedule", { taskId: task.id, reason: "fixture paused" });
  f.store.change(state => { state.tasks[0].baseline = null; });
  f.call("Lead", "reviseSchedule", { taskId: task.id, reason: "build a baseline with the pre-rollout policy" });
  const frozen = f.store.read().tasks[0];
  for (const file of noise) assert.ok(frozen.baseline.other.some(([path]) => path === file), file);
  for (const file of noise) put(f, file, "after policy rollout");
  f.wf.execution = undefined;
  assert.doesNotThrow(() => assertOutsideScope(f.root, frozen, [], gitState(f.root, frozen)));
});
