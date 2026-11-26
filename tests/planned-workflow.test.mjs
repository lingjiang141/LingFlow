import { reviewedRisk, reviewedDimensions } from "./helpers/evidence-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../src/server.mjs";
import { assertScope, gitState, scopeBaseline } from "../src/quality.mjs";
import { Store } from "../src/store.mjs";
import { versionedSpec } from "./helpers/evidence-fixture.mjs";

const dimensions = Object.fromEntries(
  ["requirements", "implementation", "system"].map((name) => [
    name,
    { state: "pass", evidence: "核对测试候选及实际程序证据", checkIds: ["full"] },
  ]),
);
const summary = (taskId, candidate) => ({
  taskId,
  instructions: "试用",
  decision: {
    candidate,
    acceptance: [{ id: "AC1", evidence: "核对实际候选、验证回执和直接影响", checkIds: ["full"] }],
    limits: "无",
    dimensions: reviewedDimensions("full"), riskNote: "核对独立审查与候选回执",
  },
});

async function setup(t, { existingTest = false, legacyChecks = false } = {}) {
  mkdirSync(".validation", { recursive: true });
  const temp = mkdtempSync(path.resolve(".validation", "planned-"));
  const root = path.join(temp, "project");
  const dataDir = path.join(temp, "runtime");
  mkdirSync(root);
  const sources = {
    spec: "spec.md",
    tickets: "tickets.md",
    attempts: "attempts.md",
  };
  for (const file of Object.values(sources))
    writeFileSync(path.join(root, file), "approved");
  writeFileSync(path.join(root, sources.spec), versionedSpec());
  writeFileSync(path.join(root, "feature.txt"), "old");
  writeFileSync(path.join(root, "feature-b.txt"), "old");
  const checkProgram = `
const fs = require("node:fs");
const success = fs.readFileSync("feature.txt", "utf8") === fs.readFileSync("behavior.txt", "utf8");
setTimeout(() => {
  require("node:assert/strict").ok(success, "assertion: approved behavior missing");
  console.log("behavior confirmed");
}, process.argv.includes("full") ? 1400 : 0);
`;
  writeFileSync(path.join(root, "verify.cjs"), checkProgram);
  for (const suffix of ['', '-b']) writeFileSync(path.join(root, `probe${suffix}.cjs`),
    `require('node:assert/strict').equal(require('node:fs').readFileSync('feature${suffix}.txt','utf8'),'new'); console.log('behavior confirmed');`);
  writeFileSync(
    path.join(root, "verify-b.cjs"),
    checkProgram
      .replace("feature.txt", "feature-b.txt")
      .replace("behavior.txt", "behavior-b.txt"),
  );
  writeFileSync(
    path.join(root, "cumulative.cjs"),
    `
const fs = require("node:fs");
const result = ["feature.txt", "feature-b.txt"].every((file) => fs.readFileSync(file, "utf8") === "new");
console.log(result ? "two candidates verified" : "cumulative failure");
process.exitCode = result ? 0 : 1;
`,
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
  git("init");
  git(
    "add",
    "spec.md",
    "tickets.md",
    "attempts.md",
    "feature.txt",
    "verify.cjs",
    "probe.cjs",
    "probe-b.cjs",
    "feature-b.txt",
    "verify-b.cjs",
    "cumulative.cjs",
  );
  if (existingTest) {
    writeFileSync(path.join(root, "behavior.txt"), "old");
    git("add", "behavior.txt");
  }
  git(
    "-c",
    "user.name=LingFlow fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  let app = await startServer({ dataDir, port: 0 });
  t.after(() => app.close());
  let seq = 0;
  const call = (actor, command, args = {}, op = "test-" + ++seq) =>
    app.workflow.call(actor, command, args, op);
  const project = await call("ui", "createProject", {
    name: "计划测试",
    root,
    members: [
      { kind: "controller", name: "Lead" },
      { kind: "developer", name: "DevA" },
      { kind: "developer", name: "DevB" },
      { kind: "reviewer", name: "Review" },
      { kind: "reviewer", name: "Review2" },
      { kind: "supervisor", name: "Supervisor" },
    ],
  });
  const roles = Object.fromEntries(
    (await app.workflow.catalog())[0].roles.map((role) => [role.name, role]),
  );
  const enable = async () => {
    for (const role of Object.values(roles)) {
      const request = await app.workflow.request({
        roleId: role.id,
        sessionId: role.name,
        cwd: role.name === "Supervisor" ? temp : root,
      });
      if (!request.bound)
        await call("ui", "confirmBinding", { requestId: request.id });
      await call("ui", "enable", { roleId: role.id, enabled: true });
    }
    await app.workflow.heartbeat(
      Object.keys(roles).map((id) => ({
        id,
        state: "idle",
        pending: 0,
        jobs: 0,
      })),
    );
    for (const role of Object.values(roles)) await call(role.name, "inbox");
  };
  if (legacyChecks) {
    const store = new Store(path.join(dataDir, "workflow.sqlite"));
    try {
      store.change((state) => Object.assign(state.projects[0], {
        checkPolicy: "restricted", allowedChecks: [], proposedChecks: { commands: [["node", "-e", "0"]] },
      }));
    } finally { store.close(); }
  }
  await enable();
  const requirement = await call("Lead", "approve", {
    text: "实现并验证新行为",
    source: "approved",
  });
  const inputs = ["verify.cjs", "behavior.txt", "feature.txt"];
  const checks = [
    {
      id: "red",
      stage: "red",
      argv: ["node", "verify.cjs"],
      expectedOutput: "assertion: approved behavior missing",
    },
    { id: "green", stage: "green", argv: ["node", "verify.cjs"], failureOutput: "assertion: approved behavior missing" },
    { id: "full", stage: "full", argv: ["node", "verify.cjs", "full"] },
    {
      id: "independent",
      stage: "independent",
      argv: ["node", "probe.cjs"],
    },
  ].map((check) => ({ ...check, inputs:check.stage==='independent'?['probe.cjs','feature.txt']:inputs, covers: ["AC1"] }));
  const ticket = {
    key: "A",
    developerId: roles.DevA.id,
    title: "行为 A",
    description: "更新行为",
    risk: "medium",
    writes: ["feature.txt", "behavior.txt"],
    reads: ["verify.cjs"],
    verification: {
      acceptance: [{ id: "AC1", text: "符合批准行为" }],
      checks,
      testWrites: ["behavior.txt"],
    },
  };
  async function waitJob(id, state = "passed") {
    for (let i = 0; i < 140; i++) {
      const job = (await app.workflow.snapshot())
        .checkJobs.find((item) => item.id === id);
      if (job.state === state) return job;
      if (["stale", "failed", "uncertain"].includes(job.state))
        assert.fail(JSON.stringify(job));
      await delay(100);
    }
    assert.fail("检查未完成：" + id);
  }
  const inspect = (taskId) => call("Lead", "inspect", { taskId, section: "full" });
  return {
    root,
    project,
    sources,
    roles,
    requirement,
    ticket,
    call,
    heartbeat: (ids, now) => app.workflow.heartbeat(ids.map((id) => ({ id, state: "idle", pending: 0, jobs: 0 })), now),
    acknowledge: (wake) => app.workflow.acknowledge(wake.id, wake.sessionId),
    binding: (name) => app.workflow.request({ roleId: roles[name].id, sessionId: name, cwd: root }),
    waitJob,
    inspect,
    async restart() {
      await app.close();
      app = await startServer({ dataDir, port: 0 });
      await enable();
    },
  };
}

test("an accepted plan automatically delivers its original ticket after Git admission recovers", async (t) => {
  const f = await setup(t);
  const releaseDir = path.join(f.root, ".hive", "release");
  mkdirSync(releaseDir, { recursive: true });
  const output = path.join(releaseDir, "bundle.tar.gz");
  const blocker = path.join(f.root, "user-notes.md");
  for (const file of [output, blocker]) {
    writeFileSync(file, "");
    truncateSync(file, 21 * 1024 * 1024);
  }
  const plan = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket] };
  const operationId = "original-plan";
  const response = await f.call("Lead", "dispatchPlan", plan, operationId);
  assert.equal(response.receipt, "accepted");
  assert.equal(response.confirmationRequired, false);
  assert.equal(response.runnable, false);
  assert.match(response.blockedBy[0].reason, /user-notes\.md/);
  const [{ taskId }] = response.tasks;
  assert.equal(response.tasks[0].deliveredAt, null);
  const receipt = await f.call("Lead", "operation", { id: operationId });
  assert.equal(receipt.state, "stored");
  assert.equal(receipt.result.confirmationRequired, false);
  assert.equal(receipt.result.tasks[0].taskId, taskId);
  unlinkSync(blocker);
  const sessions = Object.keys(f.roles);
  const now = Date.now() + 31000;
  let wake;
  // The writer can finish Git admission after the heartbeat's reply budget.
  for (let poll = 0; poll < 8 && !wake; poll++) {
    if (poll) await delay(120);
    const { deliveries } = await f.heartbeat(sessions, now + poll * 120);
    wake = deliveries.find((item) => item.sessionId === "DevA");
  }
  assert.ok(wake, "heartbeat must offer the original ticket without a second write command");
  assert.equal((await f.inspect(taskId)).state, "assigned");
  await f.acknowledge(wake);
  assert.ok((await f.inspect(taskId)).deliveredAt);
  assert.equal((await f.call("DevA", "inbox")).tasks[0].id, taskId);
  assert.equal((await f.call("Lead", "list")).tasks.length, 1);
  assert.ok(!(await f.heartbeat(sessions, now + 1000)).deliveries.some((item) => item.sessionId === "DevA"));
});

test("T1/T3/T4: report uses the dispatch spec, records advisory impacts, and new plans use the current version", async (t) => {
  const f = await setup(t);
  const spec = path.join(f.root, f.sources.spec);
  const attempts = path.join(f.root, f.sources.attempts);
  writeFileSync(spec, "# Spec\nVersion: v1\n\nOriginal wording\n\n## 变更记录\n");
  writeFileSync(path.join(f.root, f.sources.tickets), "Approved\ncovers: AC-3\n");
  const plan = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket] };
  const first = await f.call("Lead", "dispatchPlan", plan, "spec-v1-dispatch");
  const [{ taskId }] = first.tasks;
  assert.equal((await f.inspect(taskId)).specVersion, "v1");
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  const run = async (checkId) => f.waitJob((await f.call("DevA", "check", { taskId, checkId })).jobId);
  await run("red");
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  await run("green");
  await run("full");

  writeFileSync(spec, "# Spec\nVersion: v2\n\nUpdated wording\n\n## 变更记录\n\n" +
    "| 日期 | 版本 | 改了什么 | 影响 AC | 影响在飞票 |\n| --- | --- | --- | --- | --- |\n" +
    "| 2026-11-19 | v2 | 文案引用 AC1 但未声明影响 | AC-3 | — |\n");
  writeFileSync(attempts, "Changed coordination");
  const diagnostic = await f.call("Lead", "diagnoseTask", { taskId });
  assert.notEqual(diagnostic.classification, "contract-invalid");
  assert.deepEqual(diagnostic.specVersion, { dispatched: "v1", current: "v2" });
  const [notice] = diagnostic.notices;
  assert.deepEqual(notice.affectedTickets, [{ taskId, ticketKey: "A", acceptance: ["AC-3"], named: false }]);
  assert.deepEqual(notice.options.map(option => option.choice), ["keep-frozen", "add-ticket", "replace-ticket"]);
  assert.equal(notice.options[1].action.command, "dispatchPlan");
  assert.equal(notice.options[2].action.args.taskId, taskId);
  assert.equal(notice.options[2].before[0].command, "yieldForSchedule");
  const until = Date.now() + 3000;
  let diagnosisNotices = [];
  do {
    diagnosisNotices = (await f.call("Lead", "messages")).filter(item => item.details?.kind === "spec-impact");
    if (!diagnosisNotices.length) await delay(25);
  } while (!diagnosisNotices.length && Date.now() < until);
  assert.equal(diagnosisNotices.length, 1);

  const document = await f.call("Lead", "inspectPlan", { planId: first.planId, document: "spec" });
  assert.match(document.text, /Original wording/);
  assert.equal(document.diff.startLine, 2);
  assert.ok(document.diff.after.includes("Updated wording"));
  assert.notEqual(document.digest, document.currentDigest);

  const reportArgs = { taskId, summary: "交付", dimensions, specVersion: "v2" };
  const report = await f.call("DevA", "report", reportArgs, "spec-v2-report");
  assert.equal(report.state, "stored");
  assert.deepEqual(report.specVersion, diagnostic.specVersion);
  assert.equal(report.implementationSummary, "按 spec v2 实现。");
  assert.match(report.acceptanceSummary, /v1.*v2/);
  assert.deepEqual(report.notices, diagnostic.notices);
  assert.deepEqual(await f.call("DevA", "report", reportArgs, "spec-v2-report"), report);
  assert.deepEqual((await f.inspect(taskId)).reports.at(-1).sourceNotes.map(note => note.file), [f.sources.spec, f.sources.attempts]);
  const inbox = await f.call("Lead", "messages");
  assert.equal(inbox.filter(item => item.details?.kind === "spec-impact").length, 1);

  const second = await f.call("Lead", "dispatchPlan", { ...plan, tickets: [{ ...f.ticket, key: "B" }] });
  assert.equal((await f.call("Lead", "inspectPlan", { planId: second.planId })).specVersion, "v2");
  assert.equal((await f.inspect(second.tasks[0].taskId)).specVersion, "v2");
  assert.equal((await f.inspect(taskId)).specVersion, "v1");
  assert.equal((await f.call("Lead", "inspectPlan", { planId: first.planId })).specVersion, "v1");

  await f.waitJob((await f.call("Lead", "check", { taskId, checkId: "independent" })).jobId);
  const trial = await f.call("Lead", "summarize", summary(taskId, report.candidate));
  assert.match(trial.acceptanceSummary, /v1.*v2/);
});

test("T-B3 new dispatch rejects each missing spec header, and accepts an integer version", async t => {
  const f = await setup(t);
  const spec = path.join(f.root, f.sources.spec);
  const args = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket] };
  for (const [contents, field] of [["# Spec\n## 变更记录\n", "Version:"], ["Version: 2\n", "## 变更记录"]]) {
    writeFileSync(spec, contents);
    const preview = await f.call("Lead", "previewPlan", args);
    assert.equal(preview.state, "invalid");
    assert.ok(preview.violations.some(issue => issue.path === "sources.spec" && issue.message.includes(field)));
    await assert.rejects(f.call("Lead", "dispatchPlan", args), /规格缺少/);
  }
  writeFileSync(spec, "Version: 2\n## 变更记录\n");
  assert.equal((await f.call("Lead", "dispatchPlan", args)).receipt, "accepted");
});

test("T-B4 the controller can keep, add and replace using the notice actions", async t => {
  const f = await setup(t);
  const args = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket] };
  const original = await f.call("Lead", "dispatchPlan", args);
  const [{taskId}] = original.tasks;
  writeFileSync(path.join(f.root, f.sources.spec), "Version: v2\n## 变更记录\n" +
    "| 日期 | 版本 | 改了什么 | 影响 AC | 影响在飞票 |\n| --- | --- | --- | --- | --- |\n| 2026-11-19 | v2 | 修改 | AC1 | — |\n");
  const notice = (await f.call("Lead", "diagnoseTask", { taskId })).notices.find(item => item.kind === "spec-impact");
  const [keep, add, replace] = notice.options;
  assert.equal((await f.call("Lead", keep.action.command, keep.action.args)).taskId, taskId);
  const dispatch = async (action, key) => {
    const source = action.args.sources.tickets[0].replace("RNEW-01", key);
    const target = path.join(f.root, source);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `# 票 ${key}：后续规划\n\n## 验收\nAC1: 原验收\n`);
    const payload = { ...action.args, sources: { ...action.args.sources, tickets: [source] },
      tickets: [{ ...f.ticket, ...action.args.tickets[0], key }] };
    assert.equal((await f.call("Lead", "previewPlan", payload)).state, "valid");
    return f.call("Lead", action.command, payload);
  };
  const added = await dispatch(add.action, "RNEW-02");
  assert.equal((await f.inspect(taskId)).state, "assigned");
  await f.call("DevA", replace.before[0].command, replace.before[0].args);
  assert.equal((await f.call("Lead", replace.action.command, replace.action.args)).state, "abandoned");
  const replacement = await dispatch(replace.then, "RNEW-03");
  const documents = await Promise.all([original, added, replacement].map(plan =>
    f.call("Lead", "inspectPlan", { planId: plan.planId, document: "spec" })));
  assert.notEqual(documents[0].digest, documents[2].digest);
  assert.equal(documents[1].digest, documents[2].digest);
  assert.equal((await f.inspect(replacement.tasks[0].taskId)).specVersion, "v2");
});

test("T2/T5: the issue file freezes AC, writes and checks; the unchanged plan retains digest and report behavior", async (t) => {
  const f = await setup(t);
  const issue = "issues/R1-02.md";
  mkdirSync(path.join(f.root, "issues"));
  const file = path.join(f.root, issue);
  const frozen = "# 票 R1-02：行为 A\n\nAC1: 原验收\n写集: feature.txt\n检查: verify.cjs\n";
  writeFileSync(file, frozen);
  const result = await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id, sources: { spec: f.sources.spec, attempts: f.sources.attempts, ticketsDir: "issues" },
    tickets: [{ ...f.ticket, key: "R1-02" }],
  });
  const [{ taskId, runnable }] = result.tasks;
  assert.equal(runnable, true);
  assert.equal((await f.inspect(taskId)).specVersion, "v1");
  const original = await f.call("Lead", "inspectPlan", { planId: result.planId, document: issue });
  assert.equal(original.digest, original.currentDigest);
  assert.equal(original.diff.status, "unchanged");
  assert.equal((await f.call("Lead", "diagnoseTask", { taskId })).sourceNotes, undefined);
  const reportArgs = { taskId, summary: "交付", dimensions };
  for (const [before, after] of [["原验收", "改验收"], ["feature.txt", "other.txt"], ["verify.cjs", "other.cjs"]]) {
    writeFileSync(file, frozen.replace(before, after));
    await assert.rejects(f.call("DevA", "report", reportArgs), /冻结票面已变化.*reviseSchedule .*taskId.*reason.*writes/);
    const diagnostic = await f.call("Lead", "diagnoseTask", { taskId });
    assert.equal(diagnostic.classification, "contract-invalid");
    assert.equal(diagnostic.nextAction.command, "reviseSchedule");
    assert.equal(diagnostic.nextAction.args.refreshSourceDigest, true);
    assert.deepEqual(diagnostic.nextAction.args.writes, [...f.ticket.writes].sort());
    assert.equal(diagnostic.nextAction.args.taskId, taskId);
    assert.equal(diagnostic.nextAction.args.expectedSourceDigest, diagnostic.violations[0].liveDigest);
    assert.equal(diagnostic.violations[0].expectedDigest, original.digest);
    assert.equal(diagnostic.violations[0].remedy.replacement.then.command, "dispatchPlan");
  }
  writeFileSync(file, frozen);
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  const run = async (checkId) => f.waitJob((await f.call("DevA", "check", { taskId, checkId })).jobId);
  await run("red");
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  await run("green");
  await run("full");
  const report = await f.call("DevA", "report", reportArgs);
  assert.equal(report.state, "stored");
  assert.equal(report.sourceNotes, undefined);
  assert.equal(report.specVersion, undefined);
  assert.deepEqual((await f.inspect(taskId)).reports.at(-1).manifest.scopeNotes, []);
});

test("only inherited untracked Hive outputs outside the contract are exempt from the scope baseline", async (t) => {
  const f = await setup(t);
  const generated = ".hive/workflow/control.sqlite";
  const generatedAfterAdmission = ".hive/workflow/control.sqlite-wal";
  mkdirSync(path.join(f.root, ".hive", "workflow"), { recursive: true });
  const task = { ...f.ticket, id: "scope-fixture", ownedDirty: [], sources: {} };
  writeFileSync(path.join(f.root, generated), "existing");
  task.baseline = scopeBaseline(f.root, task, []);
  assert.deepEqual(task.baseline.inheritedHiveOutputs, [generated]);
  writeFileSync(path.join(f.root, generated), "changed");
  assert.doesNotThrow(() => assertScope(f.root, task, []));
  assert.equal(scopeBaseline(f.root, { ...task, reads: [generated] }, []).other[0][0], generated);
  writeFileSync(path.join(f.root, generatedAfterAdmission), "new");
  assert.throws(() => assertScope(f.root, task, []), /control\.sqlite-wal/);
});

test("ownership cache protects tracked generated paths and explicit images and detects same-size worktree edits", async (t) => {
  const f = await setup(t);
  mkdirSync(path.join(f.root, "dist"));
  const tracked = path.join(f.root, "dist", "tracked.js");
  writeFileSync(tracked, "00");
  execFileSync("git", ["add", "dist/tracked.js"], { cwd: f.root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "tracked artifact"], { cwd: f.root, windowsHide: true, stdio: "ignore" });
  writeFileSync(tracked, "11");
  writeFileSync(path.join(f.root, "dist", "bundle.js"), "untracked");
  writeFileSync(path.join(f.root, "assertion.png"), "approved pixels");
  const task = { ...f.ticket, id: "cache", reads: ["assertion.png"], ownedDirty: [] };
  const first = gitState(f.root, task);
  task.baseline = scopeBaseline(f.root, task, [], first);
  assert.deepEqual(task.baseline.other.map(([file]) => file).sort(), ["assertion.png", "dist/tracked.js"]);
  assert.equal(first.ownershipMetrics.scannedFiles, 2);
  const warm = assertScope(f.root, task, []);
  assert.equal(warm.ownershipMetrics.cacheHits, 2);
  assert.equal(warm.ownershipMetrics.bytesRead, 0);
  const unfiltered = gitState(f.root, task, []);
  assert.equal(scopeBaseline(f.root, task, [], unfiltered).other.length, 3);
  assert.equal(unfiltered.ownershipMetrics.invalidatedBy, "ignores-changed");
  assertScope(f.root, task, []);
  const { atime, mtime } = statSync(tracked);
  writeFileSync(tracked, "22");
  utimesSync(tracked, atime, mtime);
  assert.throws(() => assertScope(f.root, task, []), /未归属的改动.*dist\/tracked\.js/);
  execFileSync("git", ["add", "dist/tracked.js"], { cwd: f.root, windowsHide: true });
  const staged = gitState(f.root, task);
  scopeBaseline(f.root, task, [], staged);
  assert.equal(staged.ownershipMetrics.invalidatedBy, "index-changed");
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "move HEAD"], { cwd: f.root, windowsHide: true, stdio: "ignore" });
  const committed = gitState(f.root, task);
  scopeBaseline(f.root, task, [], committed);
  assert.equal(committed.ownershipMetrics.invalidatedBy, "head-changed");
});

test("plan preview identifies parallel assignments only when an idle developer can take the ticket", async t => {
  const f = await setup(t);
  const reader = { key: "B", developerId: f.roles.DevA.id, title: "背景调查", description: "核对规划",
    risk: "low", readOnly: true, writes: [], reads: ["spec.md"] };
  const input = tickets => ({ requirementId: f.requirement.id, sources: f.sources, tickets });
  const preview = async (tickets) => {
    await f.heartbeat(["Lead", "DevA", "DevB"]);
    const result = await f.call("Lead", "previewPlan", input(tickets));
    assert.equal(result.state, "valid", JSON.stringify(result.violations));
    return result.warnings.filter(warning => warning.kind === "parallel-assignment");
  };
  const [warning] = await preview([f.ticket, reader]);
  assert.equal(warning.ticketKey, reader.key);
  assert.equal(warning.parallelWith, f.ticket.key);
  assert.equal(warning.suggestedDeveloperId, f.roles.DevB.id);
  assert.deepEqual(await preview([f.ticket, { ...reader, developerId: warning.suggestedDeveloperId }]), []);
  assert.deepEqual(await preview([f.ticket, { ...reader, assignmentReason: "沿用领域负责人" }]), []);
  assert.deepEqual(await preview([f.ticket, { ...reader, after: [{ ticket: "A", stage: "verified" }] }]), []);
  assert.deepEqual(await preview([f.ticket, { ...reader, reads: ["behavior.txt"] }]), []);
  assert.deepEqual(await preview([f.ticket, { ...reader, reads: undefined }]), []);
  assert.deepEqual(await preview([{ ...f.ticket, resources: ["demo-db"] }, { ...reader, resources: ["demo-db"] }]), []);
  assert.deepEqual(await preview([f.ticket, reader, { ...reader, key: "C", developerId: f.roles.DevB.id }]), []);
  assert.deepEqual((await f.call("Lead", "list")).tasks, []);

  await f.call("ui", "enable", { roleId: f.roles.DevB.id, enabled: false });
  assert.deepEqual(await preview([f.ticket, reader]), []);
  await f.call("ui", "enable", { roleId: f.roles.DevB.id, enabled: true });
  await f.heartbeat(["Lead", "DevA", "DevB"]);
  await f.call("DevB", "inbox");
  await f.call("Lead", "dispatchPlan", input([f.ticket]));
  assert.equal((await preview([reader]))[0].suggestedDeveloperId, f.roles.DevB.id);
  const { tasks: [{ taskId }] } = await f.call("Lead", "dispatchPlan", input([{ ...reader, assignmentReason: "领域负责人连续处理" }]));
  assert.equal((await f.inspect(taskId)).assignmentReason, "领域负责人连续处理");
});

test("plan preview never dispatches, and context reads do not lock verification inputs", async (t) => {
  const f = await setup(t);
  const plan = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket, {
    key: "B", developerId: f.roles.DevB.id, title: "背景调查", description: "仅阅读",
    risk: "low", readOnly: true, writes: [], contextReads: ["feature.txt"],
  }] };
  const preview = await f.call("Lead", "previewPlan", plan);
  assert.equal(preview.state, "valid");
  assert.equal((await f.call("Lead", "list")).tasks.length, 0);
  assert.match((await f.call("Lead", "previewPlan", { ...plan, sources: { ...plan.sources, attempts: "missing.md" } })).violations[0].message, /sources\.attempts.*missing\.md/);
  await assert.rejects(f.call("Lead", "dispatchPlan", { ...plan, tickets: [{ ...f.ticket, verification: undefined }] }),
    { verificationCode: "contract-invalid" });
  assert.equal((await f.call("Lead", "list")).tasks.length, 0);
  const [{ taskId }, { taskId: reader }] = (await f.call("Lead", "dispatchPlan", plan)).tasks;
  assert.equal((await f.inspect(reader)).state, "assigned");
  assert.deepEqual((await f.inspect(reader)).contextReads, ["feature.txt"]);
  assert.equal((await f.inspect(taskId)).state, "assigned");
  const snapshot = await f.call("Lead", "scopePreview", { writes: [], reads: ["feature.txt"] });
  assert.deepEqual(snapshot.conflicts.map((conflict) => conflict.paths), [["feature.txt", "feature.txt"]]);
  const gate = await f.call("Lead", "diagnoseTask", { taskId });
  assert.equal(gate.classification, "evidence-missing");
  assert.match(gate.reason, /red/);
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  const red = await f.call("DevA", "check", { taskId, checkId: "red" });
  await f.waitJob(red.jobId);
  const green = await f.call("DevA", "check", { taskId, checkId: "green" });
  const failed = await f.waitJob(green.jobId, "failed");
  assert.equal(failed.classification, "quality-failed");
  const diagnosis = await f.call("Lead", "diagnoseTask", { taskId });
  assert.equal(diagnosis.classification, "quality-failed");
  assert.match(diagnosis.reason, /命中冻结的断言失败标记/);
});

test("approved plan keeps local evidence, resumes detached checks, and releases each gate", async (t) => {
  const f = await setup(t, { existingTest: true });
  f.ticket.verification.checks.push({id:"regression",stage:"regression",argv:["node","verify.cjs","regression"],inputs:["verify.cjs","behavior.txt","feature.txt"],covers:[]});
  const args = {
    requirementId: f.requirement.id,
    sources: f.sources,
    tickets: [
      {
        key: "B",
        developerId: f.roles.DevB.id,
        title: "验收后调查",
        description: "检查实际影响",
        risk: "low",
        readOnly: true,
        writes: [],
        after: [{ ticket: "A", stage: "accepted" }],
      },
      f.ticket,
    ],
  };
  await assert.rejects(
    () =>
      f.call("Lead", "dispatch", {
        ...f.ticket,
        requirementId: f.requirement.id,
      }),
    /dispatchPlan/,
  );
  const cycle = {
    ...args,
    tickets: [args.tickets[0], { ...f.ticket, after: [{ ticket: "B" }] }],
  };
  await assert.rejects(() => f.call("Lead", "dispatchPlan", cycle), /循环/);
  const plan = await f.call("Lead", "dispatchPlan", args, "approved-plan");
  assert.deepEqual(await f.call("Lead", "dispatchPlan", args, "approved-plan"), plan);
  const [{ taskId }, { taskId: downstream }] = plan.tasks;
  assert.equal((await f.inspect(taskId)).state, "assigned");
  assert.match((await f.inspect(downstream)).waitReason, /用户验收/);
  await assert.rejects(
    () => f.call("DevA", "report", { taskId, summary: "自称通过", dimensions }),
    /程序检查/,
  );
  await assert.rejects(
    () => f.call("DevA", "check", { taskId, checkId: "full" }),
    /预期失败/,
  );
  writeFileSync(path.join(f.root, "behavior.txt"), "old");
  const badRed = await f.call("DevA", "check", { taskId, checkId: "red" });
  assert.equal((await f.waitJob(badRed.jobId, "failed")).classification, "evidence-missing");
  assert.equal((await f.inspect(taskId)).checkJobs.length, 1);
  assert.ok((await f.call("DevA", "inbox")).notices.some((notice) => notice.summary.includes("red failed")));
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  const red = await f.call("DevA", "check", { taskId, checkId: "red" });
  const redReceipt = await f.waitJob(red.jobId);
  assert.equal(redReceipt.receipt.exitCode, 1);
  assert.match(
    readFileSync(redReceipt.output, "utf8"),
    /approved behavior missing/,
  );
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  await f.waitJob((await f.call("DevA", "check", { taskId, checkId: "green" })).jobId);
  const full = await f.call("DevA", "check", { taskId, checkId: "full" });
  await f.waitJob(full.jobId, "launching");
  await f.restart();
  const fullReceipt = await f.waitJob(full.jobId);
  const log = readFileSync(fullReceipt.output, "utf8");
  writeFileSync(fullReceipt.output, "altered evidence");
  await assert.rejects(f.call("DevA", "checkEvidence", { jobId: full.jobId }),
    { verificationCode: "evidence-missing" });
  await assert.rejects(
    () =>
      f.call("DevA", "report", { taskId, summary: "被修改的证据", dimensions }),
    /程序检查：full/,
  );
  writeFileSync(fullReceipt.output, log);
  await assert.rejects(f.call("DevA", "report", { taskId, summary: "仍缺回归", dimensions }), /程序检查：regression/);
  await f.waitJob((await f.call("DevA","check",{taskId,checkId:"regression"})).jobId);
  const regressionOnly = Object.fromEntries(Object.entries(dimensions).map(([key,value])=>[key,{...value,checkIds:["regression"]}]));
  await assert.rejects(f.call("DevA", "report", { taskId, summary: "回归不是 AC 证据", dimensions:regressionOnly }), /须引用适用/);
    const unsupported = structuredClone(dimensions);
  delete unsupported.implementation.checkIds;
  await assert.rejects(f.call("DevA", "report", { taskId, summary: "只有自述", dimensions: unsupported }),
    { verificationCode: "evidence-missing" });
  const delivery = await f.call("DevA", "report", {
    taskId,
    summary: "已实现",
    dimensions,
  });
  assert.equal(delivery.independentRequired, true);
  const evidenceArgs = { taskId, candidate: delivery.candidate };
  const index = await f.call("Lead", "deliveryEvidence", { ...evidenceArgs, file: "feature.txt" });
  assert.match(index.change.content, /^\+new/m);
  assert.equal(index.change.kind, "diff");
  const proof = index.checks.find((check) => check.id === "full");
  assert.equal(proof.reusable, true);
  assert.deepEqual(proof.covers, ["AC1"]);
  assert.deepEqual(proof.argv, ["node", "verify.cjs", "full"]);
  assert.equal(proof.evidence.args.jobId, full.jobId);
  assert.equal(index.checks.find((check) => check.id === "independent").reusable, false);
  assert.match((await f.call("Lead", proof.evidence.command, proof.evidence.args)).log, /behavior confirmed/);
  writeFileSync(fullReceipt.output, "altered evidence again");
  assert.equal((await f.call("Lead", "deliveryEvidence", evidenceArgs)).checks.find((check) => check.id === "full").reusable, false);
  writeFileSync(fullReceipt.output, log);
  writeFileSync(path.join(f.root, "feature.txt"), "candidate drift");
  await assert.rejects(f.call("Lead", "deliveryEvidence", evidenceArgs), /候选输入已变化/);
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  const [report] = (await f.inspect(taskId)).reports;
  assert.deepEqual(report.manifest.testChanges, ["behavior.txt"]);
  assert.ok(report.manifest.files.some((entry) => entry.file === "feature.txt" && entry.fingerprint));
  assert.deepEqual(report.dimensions.implementation.evidenceJobs, [{ checkId: "full", jobId: full.jobId }]);
  await assert.rejects(
    () => f.call("DevA", "check", { taskId, checkId: "independent" }),
    /角色或阶段/,
  );
  await assert.rejects(
    () => f.call("Lead", "summarize", { taskId, instructions: "试用" }),
    /交付门槛/,
  );
  await f.waitJob(
    (await f.call("Lead", "check", { taskId, checkId: "independent" })).jobId,
  );
  await assert.rejects(() => f.call("ui", "summarize", summary(taskId, delivery.candidate)), /DSH 主控/);
  const missingDecision = await f.call("Lead", "summarize", { taskId, instructions: "缺少核对记录" });
  assert.equal(missingDecision.path, "decision.testReview");
  assert.equal(missingDecision.error, "missing-argument");
  const decision = summary(taskId, delivery.candidate);
  const missingTestReview = await f.call("Lead", "summarize", decision);
  assert.equal(missingTestReview.path, "decision.testReview");
  assert.ok(missingTestReview.remedy);
  decision.decision.testReview = "对比原期望，新增错误输入反例并保留旧覆盖。";
  await f.call("Lead", "summarize", decision);
  assert.equal((await f.inspect(downstream)).state, "queued");
  await f.heartbeat(Object.keys(f.roles));
  await f.call("ui", "accept", { taskId, evidence: "用户确认通过" });
  assert.equal((await f.inspect(downstream)).state, "assigned");
  const released = (await f.call("Lead", "inbox")).notices.filter((item) => item.taskId === downstream && item.key.startsWith("dependency-ready:"));
  assert.equal(released.length, 1);
  assert.match(released[0].summary, /原票已自动分派/);
  assert.equal((await f.call("Lead", "inbox")).notices.filter((item) => item.key.startsWith("dependency-ready:")).length, 0);
});

test("live conflict changes the same ticket and keeps planning and supervision channels scoped", async (t) => {
  const f = await setup(t);
  const plan = await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id,
    sources: f.sources,
    tickets: [
      f.ticket,
      {
        key: "B",
        developerId: f.roles.DevB.id,
        title: "调查 B",
        description: "调查",
        risk: "low",
        readOnly: true,
        writes: [],
        reads: ["shared.txt"],
      },
    ],
  });
  const [{ taskId }, { taskId: predecessor }] = plan.tasks;
  assert.equal((await f.inspect(predecessor)).state, "assigned");
  const preview = await f.call("Lead", "scopePreview", { taskId, writes: ["shared.txt"] });
  const [scopeConflict] = preview.conflicts;
  assert.deepEqual([scopeConflict.taskId, scopeConflict.ticketKey, scopeConflict.kind, scopeConflict.paths],
    [predecessor, "B", "write/read", ["shared.txt", "shared.txt"]]);
  assert.match(scopeConflict.message, /inspect.*reviseSchedule/);
  await assert.rejects(
    () => f.call("Lead", "reviseSchedule", { taskId, reason: "发现资源争用" }),
    /停写/,
  );
  await f.call("DevA", "yieldForSchedule", {
    taskId,
    reason: "现场发现需要 B 的结果",
  });
  await f.call("Lead", "reviseSchedule", {
    taskId,
    reason: "现场发现需写共享文件",
    writes: [...f.ticket.writes, "shared.txt"],
  });
  assert.match((await f.inspect(taskId)).waitReason, /读取或共享资源冲突/);
  const scheduledConflict = (await f.inspect(taskId)).scopeConflict;
  assert.deepEqual(scheduledConflict.paths, scopeConflict.paths);
  assert.equal(scheduledConflict.taskId, scopeConflict.taskId);
  const order = scheduledConflict.nextAction;
  assert.equal(order.command, "reviseSchedule");
  assert.deepEqual(order.args.after, [{ taskId: predecessor, stage: "verified" }]);
  await f.call("Lead", order.command, order.args);
  assert.match((await f.inspect(taskId)).waitReason, /前置/);
  await f.call("DevB", "report", {
    taskId: predecessor,
    summary: "调查完成",
    dimensions,
    checks: [{ command: "read", exitCode: 0, evidence: "fixture" }],
  });
  assert.equal((await f.inspect(taskId)).state, "assigned");
  assert.equal((await f.inspect(taskId)).scheduleHistory.length, 2);
  const originalHead = (await f.inspect(taskId)).baseline.head;
  const git = (...args) => execFileSync("git", args, { cwd: f.root, stdio: "ignore" });
  const commit = (file, contents) => {
    writeFileSync(path.join(f.root, file), contents);
    git("add", "--", file);
    git("-c", "user.name=LingFlow fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "drift fixture HEAD");
  };
  commit("unrelated.txt", "unrelated");
  assert.ok((await f.call("Lead", "diagnoseTask", { taskId })).historyAdvance);
  await f.call("DevA", "yieldForSchedule", { taskId, reason: "Git 基线漂移" });
  const eligible = await f.call("Lead", "diagnoseTask", { taskId });
  assert.ok(eligible.historyAdvance);
  assert.deepEqual(eligible.committedBetween, ["unrelated.txt"]);
  const foreign = path.join(f.root, "unassigned.txt");
  writeFileSync(foreign, "must not be absorbed by rebind");
  assert.equal((await f.call("Lead", "diagnoseTask", { taskId })).classification, "contract-invalid");
  const refresh = { taskId, reason: "对账", refreshBaseline: true, expectedHead: eligible.to };
  await assert.rejects(f.call("Lead", "reviseSchedule", refresh), /未归属.*unassigned/);
  unlinkSync(foreign);
  const rebound = await f.call("Lead", "reviseSchedule", refresh);
  assert.deepEqual(rebound.rebind, { from: originalHead, to: eligible.to, committedBetween: ["unrelated.txt"] });
  assert.notEqual((await f.inspect(taskId)).baseline.head, originalHead);
  assert.equal((await f.inspect(taskId)).scheduleHistory.at(-1).previous.baseline.head, originalHead);
  commit("verify.cjs", "// 改动了冻结检查输入");
  commit("feature.txt", "改动了冻结写集");
  await f.call("DevA", "yieldForSchedule", { taskId, reason: "Git 基线再次漂移" });
  const blocked = await f.call("Lead", "diagnoseTask", { taskId });
  assert.equal(blocked.classification, "baseline-drift-blocked");
  assert.deepEqual(blocked.conflicts, ["feature.txt", "verify.cjs"]);
  await assert.rejects(f.call("Lead", "reviseSchedule", { taskId, reason: "尝试重绑", refreshBaseline: true }), /冻结范围.*verify\.cjs/);
  assert.equal((await f.inspect(taskId)).baseline.head, eligible.to);
  await f.call("ui", "setControllerPolicy", {
    projectId: f.project.id,
    policy: "自定义协调原则",
  });
  assert.equal((await f.call("Lead", "inbox")).context.duties, "自定义协调原则");
  for (const kind of ["planner", "tester"]) {
    await assert.rejects(() => f.call("ui", "addRole", { projectId: f.project.id, kind, name: kind }), /新成员的工作流职责/);
  }
  assert.match((await f.call("Supervisor", "context")).identityPrompt, /项目监督者/);
  assert.match((await f.call("Lead", "context")).rules, /replyTo/);
  await assert.rejects(() => f.call("Lead", "dispatch", { requirementId: f.requirement.id, developerId: f.roles.Supervisor.id, title: "只读任务", description: "检查", risk: "low", readOnly: true, writes: [] }), /角色不具备该任务/);
  await assert.rejects(() => f.call("Supervisor", "message", { roleId: f.roles.DevA.id, text: "不能联系开发" }), /频道成员无效/);
  const request = { text: "转达问题" };
  const message = await f.call("Supervisor", "message", request, "supervisor-request");
  assert.equal((await f.call("Supervisor", "message", request, "supervisor-request")).messageId, message.messageId);
  const forwarded = (await f.heartbeat(["Lead", "Supervisor"])).deliveries;
  assert.equal(forwarded.filter((item) => item.sessionId === "Lead" && item.text.includes("监管者转达")).length, 1);
  assert.equal((await f.call("Lead", "inbox")).messages.find((item) => item.id === message.messageId).text, request.text);
  await assert.rejects(() => f.call("Lead", "message", { roleId: f.roles.Supervisor.id, text: "漏填原消息" }), /replyTo/);
  const reply = await f.call("Lead", "message", { replyTo: message.messageId, text: "回复" });
  const returned = (await f.heartbeat(["Lead", "Supervisor"])).deliveries;
  assert.equal(returned.filter((item) => item.sessionId === "Supervisor" && item.text.includes("主控已回复")).length, 1);
  const inbox = await f.call("Supervisor", "inbox");
  assert.deepEqual(inbox.tasks, []);
  assert.deepEqual(inbox.messages.map(({ id, replyTo, text }) => ({ id, replyTo, text })), [
    { id: reply.messageId, replyTo: message.messageId, text: "回复" },
  ]);
  assert.equal((await f.call("Supervisor", "messages", { messageId: message.messageId })).text, request.text);
  const channel = await f.call("Supervisor", "messages");
  assert.equal(channel.filter(item => item.kind === "message").length, 2);
  assert.ok(channel.some(item => item.kind === "notice" && item.key === "message:" + reply.messageId));
  assert.equal((await f.call("Supervisor", "inbox")).messages, undefined);
  await assert.rejects(
    () => f.call("Supervisor", "inspect", { taskId }),
    /独立消息频道/,
  );
  writeFileSync(path.join(f.root, f.sources.spec), "later draft");
  assert.equal(
    (await f.call("Lead", "inspectPlan", { planId: plan.planId, document: "spec" }))
      .text,
    versionedSpec(),
  );
});

test("independent reviewers, controller short probes and a single cumulative receipt keep separate gates", async (t) => {
  const f = await setup(t);
  const high = {
    ...f.ticket,
    risk: "high", riskReason: "高风险闭环验证",
    verification: {
      ...f.ticket.verification,
      checks: f.ticket.verification.checks.map((check) =>
        check.stage === "independent"
          ? { ...check, stage: "controller", id: "handoff" }
          : check,
      ),
    },
  };
  const other = {
    ...f.ticket,
    key: "B",
    developerId: f.roles.DevB.id,
    writes: ["feature-b.txt", "behavior-b.txt"],
    reads: ["verify-b.cjs"],
    verification: {
      ...f.ticket.verification,
      testWrites: ["behavior-b.txt"],
      checks: f.ticket.verification.checks.map((check) => ({
        ...check,
        argv: check.argv.map((arg) =>
          arg === "verify.cjs" ? "verify-b.cjs" : arg==='probe.cjs'?'probe-b.cjs':arg,
        ),
        inputs: check.stage==='independent'?['probe-b.cjs','feature-b.txt']:["verify-b.cjs", "behavior-b.txt", "feature-b.txt"],
      })),
    },
  };
  const batch = {
    key: "release",
    tickets: ["A", "B"],
    argv: ["node", "-e", "require('./cumulative.cjs')"],
    inputs: ["cumulative.cjs", "feature.txt", "feature-b.txt"],
    expectedOutput: "two candidates verified",
    covers: ["A", "B"].map((ticket) => ({ ticket, acceptance: ["AC1"] })),
  };
  const plan = await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id,
    sources: f.sources,
    tickets: [high, other],
    batches: [batch],
  });
  const [first, second] = plan.tasks.map((item) => item.taskId);
  assert.equal((await f.inspect(first)).state, "assigned");
  assert.equal((await f.inspect(second)).state, "assigned");
  async function deliver(taskId, actor, suffix) {
    writeFileSync(path.join(f.root, `behavior${suffix}.txt`), "new");
    await f.waitJob((await f.call(actor, "check", { taskId, checkId: "red" })).jobId);
    writeFileSync(path.join(f.root, `feature${suffix}.txt`), "new");
    await f.waitJob((await f.call(actor, "check", { taskId, checkId: "green" })).jobId);
    await f.waitJob((await f.call(actor, "check", { taskId, checkId: "full" })).jobId);
    return f.call(actor, "report", { taskId, summary: "完成自测", dimensions });
  }
  const [candidate] = await Promise.all([
    deliver(first, "DevA", ""),
    deliver(second, "DevB", "-b"),
  ]);
  // These are simulated sessions. Refresh the reviewer's lease after the builds.
  await f.heartbeat(Object.keys(f.roles));
  assert.equal((await f.inspect(first)).state, "reviewing");
  const reviewGate = await f.call("Lead", "diagnoseTask", { taskId: first });
  assert.equal(reviewGate.classification, "evidence-missing");
  assert.equal(reviewGate.blocker, "review-missing");
  const index = await f.call("Lead", "deliveryEvidence", { taskId: first, candidate: candidate.candidate, file: "behavior.txt" });
  assert.equal(index.change.kind, "added");
  assert.equal(index.change.content, "new");
  assert.equal(index.independentReview.required, true);
  assert.equal(index.independentReview.riskItems[0].reason, high.riskReason);
  assert.equal(index.independentReview.riskAssessment, undefined);
  await assert.rejects(
    () =>
      f.call("Lead", "review", {
        taskId: first,
        candidate: candidate.candidate,
        verdict: "pass",
        dimensions,
        findings: "不能替审查",
      }),
    /独立审查者/,
  );
  await f.call("Review", "review", {
    taskId: first,
    candidate: candidate.candidate,
    verdict: "pass",
    dimensions,
    findings: "独立核对反例和差异", riskAssessment: reviewedRisk,
  });
  assert.equal((await f.inspect(first)).state, "waiting_verification");
  await f.waitJob(
    (await f.call("Lead", "check", { taskId: first, checkId: "handoff" })).jobId,
  );
  assert.equal((await f.inspect(first)).state, "waiting_batch");
  await f.waitJob(
    (await f.call("Lead", "check", { taskId: second, checkId: "independent" })).jobId,
  );
  const shared = (await f.inspect(first))
    .checkJobs.find((job) => job.check.stage === "batch");
  await f.waitJob(shared.id);
  assert.equal((await f.inspect(first)).state, "ready");
  assert.equal((await f.inspect(second)).batchReceiptId, shared.id);
  assert.equal(
    (await f.inspect(second)).checkJobs.filter((job) => job.check.stage === "batch")
      .length,
    1,
  );
  await f.call("Lead", "summarize", summary(first, candidate.candidate));
  writeFileSync(path.join(f.root, "feature-b.txt"), "stale");
  await assert.rejects(
    () => f.call("ui", "accept", { taskId: first, evidence: "旧候选" }),
    /批次成员候选已变化/,
  );
  const rework = await f.call("Lead", "rework", { taskId: first, reason: "复审发现需要扩大范围", adjustScope: true });
  assert.equal(rework.state, "paused");
  assert.equal((await f.inspect(first)).state, "paused");
  await f.heartbeat(Object.keys(f.roles));
  await f.call("Lead", "reviseSchedule", { taskId: first, reason: "纳入补充实现", writes: [...high.writes, "extra.txt"] });
  const amended = await f.inspect(first);
  assert.equal(amended.id, first);
  assert.equal(amended.state, "rework");
  assert.deepEqual(amended.scheduleHistory.at(-1).previous.writes, [...high.writes].sort());
  assert.ok(amended.writes.includes("extra.txt"));
});

test("legacy whitelist settings no longer block original-ticket inline checks", async (t) => {
  const f = await setup(t, { legacyChecks: true });
  const probe = f.ticket.verification.checks.find((check) => check.stage === "independent");
  probe.argv = ["node", "-e", "require('./verify.cjs')"];
  probe.expectedOutput = "behavior confirmed";
  const next = { key: "B", developerId: f.roles.DevB.id, title: "下游调查", description: "核对已验证的行为",
    risk: "low", readOnly: true, writes: [], after: [{ ticket: "A", stage: "accepted" }] };
  const input = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket, next] };
  assert.equal((await f.call("Lead", "previewPlan", input)).state, "valid");
  const { tasks: [{ taskId }, { taskId: successor }] } = await f.call("Lead", "dispatchPlan", input);
  assert.equal((await f.call("Lead", "list")).tasks[0].deliveryState, "pending");
  await f.call("DevA", "inbox");
  assert.equal((await f.call("Lead", "list")).tasks[0].deliveryState, "delivered");
  const unknownCheck = await f.call("DevA", "check", { taskId, checkId: "unregistered" });
  assert.equal(unknownCheck.error, "not-found");
  assert.equal(unknownCheck.id, "unregistered");
  await assert.rejects(() => f.call("Lead", "check", { taskId, checkId: "red" }), /不属于当前角色或阶段/);
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  await f.waitJob((await f.call("DevA", "check", { taskId, checkId: "red" })).jobId);
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  for (const checkId of ["green", "full"]) await f.waitJob((await f.call("DevA", "check", { taskId, checkId })).jobId);
  await f.call("DevA", "report", { taskId, summary: "完成", dimensions });
  const { jobId } = await f.call("Lead", "check", { taskId, checkId: "independent" });
  await f.waitJob(jobId);
  assert.match((await f.call("Lead", "checkEvidence", { jobId })).log, /behavior confirmed/);
  assert.equal((await f.inspect(successor)).state, "queued");
  await f.heartbeat(Object.keys(f.roles));
  await f.call("Lead", "reviseSchedule", { taskId: successor, reason: "技术前置只需验证通过", after: [{ taskId, stage: "verified" }] });
  assert.equal((await f.inspect(successor)).state, "assigned");
  assert.notEqual((await f.inspect(taskId)).state, "accepted");
});

test("native plan preflight and dispatch reject browser evidence that is missing or assigned to the controller", async (t) => {
  const { browserCheckArgv, CONTROLLER_CHECK_BOUNDARY } = await import("../src/verification-policy.mjs");
  const f = await setup(t);
  const base = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket] };
  const fixture = structuredClone(base);
  const browser = { file: "e2e/feature.spec.ts", title: "AC1: uses real browser focus", reason: "焦点与浏览器权限交互", covers: ["AC1"] };
  const ticket = fixture.tickets[0];
  ticket.writes.push(browser.file);
  ticket.verification.testWrites.push(browser.file);
  assert.ok((await f.call("Lead", "previewPlan", fixture)).violations.some((item)=>/缺少 verification\.browserE2E/.test(item.message)));
  await assert.rejects(() => f.call("Lead", "dispatchPlan", fixture), { verificationCode: "contract-invalid", message: /tickets\[A\].*缺少 verification\.browserE2E/ });
  assert.deepEqual((await f.call("DevA", "inbox")).tasks, []);
  ticket.verification.browserE2E = [browser];
  const check = { id: "browser", stage: "full", argv: browserCheckArgv(browser), inputs: [browser.file], covers: browser.covers };
  ticket.verification.checks.push(check);
  const independent = ticket.verification.checks.find((item) => item.stage === "independent");
  const probeArgv = independent.argv;
  const probeInputs = independent.inputs;
  independent.argv = check.argv;
  independent.inputs = check.inputs;
  assert.ok((await f.call("Lead", "previewPlan", fixture)).violations.some((item)=>/浏览器 E2E 由责任开发/.test(item.message)));
  independent.argv = ["npm", "test"];
  assert.ok((await f.call("Lead", "previewPlan", fixture)).violations.some((item)=>/低负载短探针/.test(item.message)));
  independent.argv = probeArgv;
  independent.inputs = probeInputs;
  assert.equal((await f.call("Lead", "previewPlan", fixture)).state, "valid");
  const plan = await f.call("Lead", "dispatchPlan", fixture);
  const taskId = plan.tasks[0].taskId;
  assert.deepEqual((await f.inspect(taskId)).verification.browserE2E, [browser]);
  await assert.rejects(() => f.call("Lead", "check", { taskId, checkId: check.id }), /不属于当前角色/);
  await f.call("ui", "setControllerPolicy", { projectId: f.project.id, policy: "用户自定义行为" });
  const context = await f.call("Lead", "context");
  assert.equal(context.duties, "用户自定义行为");
  assert.ok(context.rules.includes(CONTROLLER_CHECK_BOUNDARY));
  assert.ok((await f.call("Lead", "guide")).guide.includes(CONTROLLER_CHECK_BOUNDARY));
  await f.restart();
  assert.ok((await f.call("Lead", "context")).rules.includes(CONTROLLER_CHECK_BOUNDARY));
  assert.deepEqual((await f.inspect(taskId)).verification.browserE2E, [browser]);
});


test("mandatory controller duties survive custom behavior, startup and compact wakes", async () => {
  const { CONTROLLER_CHECK_BOUNDARY, CONTROLLER_WAKE_BOUNDARY } = await import("../src/verification-policy.mjs");
  const { markContextSeen, wakeText } = await import("../src/role-context.mjs");
  const project = { id: "P", name: "Project", root: "E:/Project", controllerPolicy: "用户习惯：主控自行修复" };
  const role = { id: "L", name: "Lead", kind: "controller", seenContextRevision: 1, seenSupervisionPolicy: 9 };
  const state = { projects: [project], tasks: [], checkJobs: [], roles: [role] };
  const first = wakeText(project, role, true, "会话启动或续接", state);
  assert.match(first, /角色上下文/);
  assert.match(first, /用户习惯/);
  assert.ok(first.includes(CONTROLLER_CHECK_BOUNDARY));
  assert.ok(first.indexOf(CONTROLLER_WAKE_BOUNDARY) < first.indexOf(project.controllerPolicy));
  markContextSeen(role);
  const compact = wakeText(project, role, true, "收到开发交付", state);
  assert.match(compact, /收到开发交付/);
  assert.doesNotMatch(compact, /角色上下文/);
  assert.ok(compact.includes(CONTROLLER_WAKE_BOUNDARY));
});

test("unrelated Git commits preserve original red, green and full receipts after a safe baseline rebind", async (t) => {
  const f = await setup(t);
  const rename = (file) => file.replace(/\.(txt|cjs)$/, "-b.$1");
  const b = { ...f.ticket, key: "B", developerId: f.roles.DevB.id,
    writes: f.ticket.writes.map(rename), reads: f.ticket.reads.map(rename),
    verification: { ...f.ticket.verification, testWrites: f.ticket.verification.testWrites.map(rename),
      checks: f.ticket.verification.checks.map((check) => ({ ...check, inputs: check.inputs.map(rename), argv: check.argv.map(rename) })),
    },
  };
  const [{ taskId }, { taskId: otherId }] = (await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket, b],
  })).tasks;
  const run = async (checkId, actor = "DevA", id = taskId) => {
    const { jobId } = await f.call(actor, "check", { taskId: id, checkId });
    await f.waitJob(jobId);
    return jobId;
  };
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  writeFileSync(path.join(f.root, "behavior-b.txt"), "new");
  const [red] = await Promise.all([run("red"), run("red", "DevB", otherId)]);
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  writeFileSync(path.join(f.root, "feature-b.txt"), "new");
  const [green] = await Promise.all([run("green"), run("green", "DevB", otherId)]);
  const [full] = await Promise.all([run("full"), run("full", "DevB", otherId)]);
  const git = (...args) => execFileSync("git", args, { cwd: f.root, stdio: "ignore" });
  writeFileSync(path.join(f.root, "spec.md"), "主控补记说明；已派发票仍使用冻结正文");
  const unknown = path.join(f.root, "unclaimed.txt");
  writeFileSync(unknown, "outside both scopes");
  for (const [actor, id] of [["DevA", taskId], ["DevB", otherId]])
    await assert.rejects(f.call(actor, "report", { taskId: id, summary: "越界检查", dimensions }), /未归属.*unclaimed\.txt.*diagnoseTask/);
  unlinkSync(unknown);
  const liveSpecReport = await f.call("DevB", "report", { taskId: otherId, summary: "并行交付", dimensions });
  assert.equal(liveSpecReport.state, "stored");
  assert.ok(liveSpecReport.notices.some(notice => notice.kind === "spec-revision"));
  assert.ok((await f.call("Lead", "messages")).some(message => message.details?.kind === "spec-revision"));
  const other = await f.inspect(otherId);
  assert.ok(other.reports.at(-1).manifest.scopeNotes.some((note) => note.kind === "foreign-in-flight" && note.taskId === taskId && note.file === "feature.txt"));
  assert.ok(other.reports.at(-1).manifest.scopeNotes.some((note) => note.kind === "planning-source-changed" && note.file === "spec.md"));
  assert.doesNotMatch((await f.call("Lead", "inspectPlan", { planId: other.planId, document: "spec" })).text, /主控补记说明/);
  git("add", "--", "spec.md");
  git("-c", "user.name=LingFlow fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "unrelated planning edit");
  await f.call("DevA", "yieldForSchedule", { taskId, reason: "已停写，核对新 HEAD" });
  const diagnosis = await f.call("Lead", "diagnoseTask", { taskId });
  assert.ok(diagnosis.historyAdvance);
  // Re-admission requires a live member; the preceding checks may exceed 15s.
  await f.heartbeat(Object.keys(f.roles), Date.now());
  await f.call("Lead", "reviseSchedule", {
    taskId, reason: "已核实开发改动归属", refreshBaseline: true,
    expectedHead: diagnosis.to, ownedDirty: ["behavior.txt", "feature.txt"],
  });
  const stored = await f.call("DevA", "report", { taskId, summary: "沿原票使用原检查证据", dimensions });
  assert.equal(stored.state, "stored");
  const task = await f.inspect(taskId);
  assert.equal(task.reports.at(-1).manifest.head, diagnosis.to);
  assert.deepEqual(task.reports.at(-1).checks.map((item) => item.jobId), [red, green, full]);
  assert.ok(task.reports.at(-1).manifest.scopeNotes.some((note) => note.kind === "foreign-in-flight" && note.taskId === otherId && note.file === "feature-b.txt"));
});

test("a blocked handoff keeps evidence and decision context without accepting a candidate", async (t) => {
  const { wakeSummary } = await import("../src/wake-card.mjs");
  const f = await setup(t);
  const [{ taskId }] = (await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id, sources: f.sources, tickets: [{
      ...f.ticket, brief: "保留未保存的选题结果", boundaries: "不改接口协议", stopConditions: "若需要扩大接口立即停手",
    }],
  })).tasks;
  const task = () => f.inspect(taskId);
  const developer = await f.call("DevA", "inbox");
  const dispatch = wakeSummary(developer.notices, [await task()], [], Object.values(f.roles));
  for (const expected of ["发送者：Lead", "保留未保存的选题结果", "不改接口协议", "若需要扩大接口立即停手",
    "允许写入（项目相对路径）", "feature.txt", "verify.cjs", "inspectPlan", "AC1", "inspect"])
    assert.ok(dispatch.includes(expected), expected);
  const blocked = {
    taskId, outcome: "blocked", summary: "实现完成；自测结论见下。" + "长报告".repeat(600),
    blocker: "成功交付被原生 gate 拒绝；请核对原有回执",
    dimensions: { ...dimensions, system: { state: "unverified", evidence: "等待证据" } },
    request: "主控核对程序检查记录", artifacts: ["checks/red.log"],
    openItems: [{ text: "确认旧用户提示", blocking: false, trigger: "旧入口", impact: "提示一致性", evidence: "spec.md" }],
  };
  const receipt = await f.call("DevA", "report", blocked, "blocked-1");
  assert.deepEqual(await f.call("DevA", "report", blocked, "blocked-1"), receipt);
  const state = await task();
  assert.equal(state.state, "assigned");
  assert.equal(state.candidate, undefined);
  assert.equal(state.reports.length, 0);
  assert.equal(state.blockedReports.length, 1);
  assert.equal(state.blockedReports[0].summary, blocked.summary);
  const inbox = await f.call("Lead", "inbox");
  const card = wakeSummary(inbox.notices, [state], [], Object.values(f.roles));
  for (const expected of ["发送者：DevA", "交付受阻", "系统影响 未验证", "本责任 2 项开放，1 项阻塞",
    "交付检查点向用户汇总非阻塞项并请其取舍", "成功交付被原生 gate 拒绝", "evidence-missing", "摘要已截断", "主控核对程序检查记录",
    "触发：旧入口", "影响：提示一致性", "证据：spec.md", "checks/red.log"])
    assert.ok(card.includes(expected), expected);
  await assert.rejects(f.call("DevA", "report", { ...blocked, outcome: "success" }), /缺少通过且仍有效的程序检查/);
});

test("planning contracts reject omitted API test writes and ACs before either dispatch entry", async (t) => {
  const f = await setup(t);
  writeFileSync(path.join(f.root, f.sources.tickets), [
    "# A", "必须更新 API 测试并验证两条 AC。", "```lingflow-contract",
    JSON.stringify({ ticket: "A", requiredWrites: ["feature.txt"], requiredTestWrites: ["api.test.cjs"], requiredAcceptance: ["AC1", "AC2"] }),
    "```",
  ].join("\n"));
  const plan = { requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket] };
  assert.match((await f.call("Lead", "previewPlan", plan)).violations[0].message, /api\.test\.cjs.*AC2/s);
  await assert.rejects(f.call("Lead", "dispatchPlan", plan), /api\.test\.cjs.*AC2/s);
  assert.deepEqual((await f.call("Lead", "list")).tasks, []);
  assert.deepEqual((await f.call("DevA", "inbox")).tasks, []);
  const valid = structuredClone(plan);
  const [ticket] = valid.tickets;
  ticket.writes.push("api.test.cjs");
  ticket.verification.testWrites.push("api.test.cjs");
  ticket.verification.acceptance.push({ id: "AC2", text: "API 可观察行为" });
  for (const check of ticket.verification.checks) {
    check.inputs.push("api.test.cjs");
    check.covers.push("AC2");
  }
  const missingInputs = structuredClone(valid);
  for (const check of missingInputs.tickets[0].verification.checks)
    check.inputs = check.inputs.filter((file) => file !== "api.test.cjs");
  assert.match((await f.call("Lead", "previewPlan", missingInputs)).violations[0].message, /api\.test\.cjs.*inputs/);
  const uncovered = structuredClone(valid);
  uncovered.tickets[0].verification.checks.find((check) => check.stage === "full").covers = ["AC1"];
  assert.ok((await f.call("Lead", "previewPlan", uncovered)).violations.some((item)=>/完整检查未覆盖验收条款：AC2/.test(item.message)));
  assert.equal((await f.call("Lead", "previewPlan", valid)).state, "valid");
  const result = await f.call("Lead", "dispatchPlan", valid, "stable-audit-plan");
  assert.deepEqual(await f.call("Lead", "dispatchPlan", valid, "stable-audit-plan"), result);
  await assert.rejects(f.call("Lead", "dispatchPlan", valid, "different-audit-plan"), /票编号已存在/);
  const [row] = (await f.call("Lead", "list")).tasks;
  assert.equal(row.id, result.tasks[0].taskId);
});

test("early commit of owned files can resume only by explicit rebind and fresh candidate checks", async (t) => {
  const f = await setup(t);
  const [{ taskId }] = (await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket],
  })).tasks;
  const run = async (checkId) => {
    const { jobId } = await f.call("DevA", "check", { taskId, checkId });
    return f.waitJob(jobId);
  };
  const original = (await f.inspect(taskId)).baseline;
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  const red = await run("red");
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  const green = await run("green");
  const full = await run("full");
  const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" }).trim();
  git("add", "--", "behavior.txt", "feature.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "controller early commit");
  const head = git("rev-parse", "HEAD");
  await assert.rejects(f.call("DevA", "report", { taskId, summary: "尚不能交付", dimensions }), /HEAD/);
  const diagnosed = await f.call("Lead", "diagnoseTask", { taskId });
  assert.equal(diagnosed.nextAction?.command, "yieldForSchedule");
  assert.equal(diagnosed.afterStop?.command, "rebindCommittedWork");
  await f.call("DevA", "yieldForSchedule", diagnosed.nextAction.args);
  await assert.rejects(f.call("Lead", "reviseSchedule", { taskId, reason: "普通前移", refreshBaseline: true }), /冻结范围/);
  const { nextAction } = await f.call("Lead", "diagnoseTask", { taskId });
  assert.equal(nextAction?.command, "rebindCommittedWork");
  const args = { ...nextAction.args, reason: "我已核对两个提交路径，属于这张原票" };
  await assert.rejects(f.call("DevA", "rebindCommittedWork", args), /主控/);
  const missingReason = await f.call("Lead", "rebindCommittedWork", { ...nextAction.args, reason: undefined });
  assert.equal(missingReason.error, "missing-argument");
  assert.deepEqual(missingReason.missing, ["reason"]);
  await assert.rejects(f.call("Lead", "rebindCommittedWork", { ...args, confirmPaths: ["feature.txt"] }), /确认不一致/);
  writeFileSync(path.join(f.root, "feature.txt"), "dirty");
  await assert.rejects(f.call("Lead", "rebindCommittedWork", args), /工作树.*feature\.txt/);
  git("add", "--", "feature.txt");
  await assert.rejects(f.call("Lead", "rebindCommittedWork", args), /暂存区/);
  writeFileSync(path.join(f.root, "feature.txt"), "new");
  git("add", "--", "feature.txt");
  writeFileSync(path.join(f.root, "spec.md"), "changed requirements");
  const edited = await f.call("Lead", "diagnoseTask", { taskId });
  assert.deepEqual(edited.blockingConditions.map(({ condition }) => condition), ["committed-scope-overlap"]);
  assert.equal(edited.nextAction.args.confirmSourceChanges, undefined);
  assert.equal(edited.sourceNotes[0].kind, "planning-source-changed");
  writeFileSync(path.join(f.root, "spec.md"), versionedSpec() + "\n## 返工记录\n补一条现有行为的回归用例\n");
  const appended = await f.call("Lead", "diagnoseTask", { taskId });
  assert.equal(appended.classification, "baseline-drift-owned-rebindable");
  assert.equal(appended.sourceNotes[0].kind, "source-appended");
  assert.equal(appended.sourceNotes[0].firstAppendedHeading, "## 返工记录");
  assert.equal(appended.nextAction.command, "rebindCommittedWork");
  assert.equal(appended.nextAction.args.confirmSourceAppends, undefined);
  const rebound = await f.call("Lead", "rebindCommittedWork", args);
  assert.deepEqual(rebound.rebind.sourceNotes, appended.sourceNotes);
  const index = await f.call("Lead", "inspectPlan", { planId: (await f.inspect(taskId)).planId, document: "spec" });
  assert.equal(index.text, versionedSpec());
  assert.deepEqual(rebound.rebind.overlap, ["behavior.txt", "feature.txt"]);
  assert.equal((await f.inspect(taskId)).baseline.head, head);
  assert.deepEqual((await f.inspect(taskId)).scheduleHistory.at(-1).previous.baseline, original);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("status", "--porcelain"), "M spec.md");
  // The runtime can return before applying a heartbeat when the writer is busy.
  let resumed;
  for (let attempt = 0; attempt < 20; attempt++) {
    await f.heartbeat(Object.keys(f.roles));
    resumed = await f.inspect(taskId);
    if (resumed.state === "rework") break;
    await delay(100);
  }
  assert.equal(resumed.state, "rework", JSON.stringify({ state: resumed.state, waitReason: resumed.waitReason }));
  const newGreen = await run("green");
  const newFull = await run("full");
  assert.equal(newGreen.id, green.id);
  assert.equal(newFull.id, full.id);
  const report = await f.call("DevA", "report", { taskId, summary: "新基线已验证", dimensions });
  assert.equal(report.independentRequired, true);
  const stored = (await f.inspect(taskId)).reports.at(-1);
  assert.deepEqual(stored.checks.map(({ jobId }) => jobId), [red.id, newGreen.id, newFull.id]);
  assert.deepEqual(stored.manifest.files.map(({ file }) => file), ["behavior.txt", "feature.txt"]);
  assert.deepEqual(stored.manifest.testChanges, []);
  assert.deepEqual(await f.call("Lead", "checkEvidence", { jobId: full.id }), { ...full, log: readFileSync(full.output, "utf8") });
  const evidence = await f.call("Lead", "deliveryEvidence", { taskId, candidate: report.candidate, file: "feature.txt" });
  assert.match(evidence.change.content, /^\+new/m);
  assert.equal(evidence.checks.find((check) => check.id === "red").evidenceHead, original.head);
  assert.equal(evidence.checks.find((check) => check.id === "full").evidenceHead, original.head);
  assert.equal(evidence.sourceNotes[0].kind, "source-appended");
  assert.equal(stored.manifest.scopeNotes.find((note) => note.file === "spec.md").kind, "source-appended");
  await assert.rejects(f.call("Lead", "summarize", summary(taskId, report.candidate)), /交付门槛/);
  await f.waitJob((await f.call("Lead", "check", { taskId, checkId: "independent" })).jobId);
  await f.call("Lead", "summarize", summary(taskId, report.candidate));
  await f.call("ui", "accept", { taskId, evidence: "用户已确认" });
  await assert.rejects(f.call("Lead", "rebindCommittedWork", args), /暂停/);
});

test("appending a planning note without a HEAD change preserves the ordinary check path", async (t) => {
  const f = await setup(t);
  const [{ taskId }] = (await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id, sources: f.sources, tickets: [f.ticket],
  })).tasks;
  writeFileSync(path.join(f.root, "attempts.md"), "approved\n## 返工记录\n补充验收说明\n");
  writeFileSync(path.join(f.root, "behavior.txt"), "new");
  const red = await f.call("DevA", "check", { taskId, checkId: "red" });
  assert.equal(red.sourceNotes[0].kind, "source-appended");
  assert.equal(red.sourceNotes[0].startLine, 2);
  await f.waitJob(red.jobId);
  const { sourceNotes, classification } = await f.call("Lead", "diagnoseTask", { taskId });
  assert.equal(sourceNotes[0].file, "attempts.md");
  assert.equal(classification, "evidence-missing");
});

test("spec dirty at admission can later be committed without a planning confirmation", async (t) => {
  const f = await setup(t);
  const file = "planning notes.md";
  const frozen = versionedSpec("# Approved AC\nKeep original behavior.");
  const suffix = "\n## 返工记录\n保留同一要求。\n";
  const doc = path.join(f.root, file);
  writeFileSync(doc, frozen);
  const [{ taskId }] = (await f.call("Lead", "dispatchPlan", {
    requirementId: f.requirement.id, sources: { ...f.sources, spec: file }, tickets: [f.ticket],
  })).tasks;
  assert.equal((await f.inspect(taskId)).state, "assigned");
  const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" }).trim();
  writeFileSync(doc, "# Updated AC wording\n" + suffix);
  git("add", "--", file);
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Record follow-up");
  await f.call("DevA", "yieldForSchedule", { taskId, reason: "核对规划记录" });
  const note = await f.call("Lead", "diagnoseTask", { taskId });
  assert.notEqual(note.classification, "contract-invalid");
  assert.equal(note.recordedBaseline, undefined);
  assert.match(note.acceptanceSummary, /v1.*摘要/);
  assert.equal(note.sourceNotes[0].kind, "planning-source-changed");
  const head = git("rev-parse", "HEAD");
  const resumed = await f.call("Lead", "reviseSchedule", { taskId, expectedHead: head, refreshBaseline: true, reason: "续接已提交 spec 后的基线" });
  assert.equal(resumed.state, "stored");
  assert.equal((await f.inspect(taskId)).baseline.head, head);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal((await f.call("Lead", "inspectPlan", { planId: (await f.inspect(taskId)).planId, document: "spec" })).text, frozen);
});

const r35Fixture = {
  "R35-01": { ac: 6, browser: 5, title: "R35-01 the wizard renders one form with or without preselected resources" },
  "R35-02": { ac: 8, browser: 7, title: "R35-02 the records panel lists recent jobs and hides a deleted one" },
  "R35-03": { ac: 7, browser: 6, title: "R35-03 a running job can be stopped from the queue and from the header" },
  "R35-04": { ac: 6, browser: 5, title: "R35-04 one material shows exactly one status after stopping" },
};
const r35Files = ["01-unified-entry.md","02-records-panel.md","03-stop-controls.md","04-status-consistency.md"];
const r35Dir = ".scratch/r35-generation-console";
const e2e = "e2e/ai-generation.spec.ts";
const page = "apps/web/src/pages/AiQuestionGenerationPage.tsx";
const cli = ["node", "node_modules/@playwright/test/cli.js", "test", e2e];

async function r35Plan(t) {
  const f = await setup(t);
  const dir = path.join(f.root, r35Dir);
  mkdirSync(path.join(dir,"issues"), {recursive:true});
  const sourceRoot = process.env.LINGFLOW_R35_REFERENCE;
  const documents = [];
  const put = (file, content) => writeFileSync(path.join(dir,file), sourceRoot ? readFileSync(path.join(sourceRoot,file)) : content);
  put("spec.md",versionedSpec("# R35 规格"));
  put("planned-attempts.md","# R35 预定路线");
  for (const [i,[key,info]] of Object.entries(r35Fixture).entries()) {
    const ac = Array.from({length:info.ac},(_,j)=> j+1===info.browser
      ? "- **AC-"+(j+1)+" 浏览器用例**：`"+e2e+"` 新增 `"+info.title+"`"
      : "- **AC-"+(j+1)+" 条款**：要求 "+(j+1));
    const testFiles=i===1 ? "、`apps/server/test/generation-records.api.test.ts`" : "";
    const text = ["# 票 "+key+"：验证", "", "## 需求与 AC",...ac,"","## 依赖与归属",
      "- 前置："+(i ? Object.keys(r35Fixture)[i-1]+" 已落库（对应 AC-1）" : "无"),
      "- 归属：`"+page+"`、`"+e2e+"`"+testFiles+(i===2?"；\n  若需要扩展，再改 `apps/server/src/questions/generation/jobs.ts`。":""),
      "", "## Planned attempt 01", "**Objective:** 核对流程", "**Stop conditions:** 需要扩写就停止", "",
      "## riskAssessment", "- 等级：**medium**"
    ].join("\n");
    const file="issues/"+r35Files[i];
    put(file,text);
    documents.push(readFileSync(path.join(dir,file),"utf8"));
  }
  for (const file of ["apps/server/src/questions/generation/routes.ts","apps/server/src/db.ts"]) {
    mkdirSync(path.dirname(path.join(f.root,file)),{recursive:true});
    writeFileSync(path.join(f.root,file),"// isolated source path fixture");
  }
  writeFileSync(path.join(dir,"aggregate.md"),documents.join("\n\n"));
  const tickets=Object.entries(r35Fixture).map(([key,info],i)=>{
    const browser={file:e2e,title:info.title,reason:"票面需要浏览器观察用户行为",covers:["AC-"+info.browser]};
    const api="apps/server/test/generation-records.api.test.ts";
    const focused={id:"focus",argv:[...cli,"--grep",key],inputs:[e2e,page],covers:browser.covers};
    const other=Array.from({length:info.ac},(_,j)=>"AC-"+(j+1)).filter((id)=>!browser.covers.includes(id));
    return {key,developerId:i%2?f.roles.DevB.id:f.roles.DevA.id,writes: i%2 ? []:"from-ticket",reads:"from-ticket",
      ...(i===0&&{browserE2E:[browser]}),
      verification:{checks:[
        {...focused,id:"red",stage:"red",expectedOutput:"Expected: visible"},
        {...focused,id:"green",stage:"green"},
        {...focused,id:"browser-full",stage:"full"},
        {id:"full",stage:"full",argv:["node","verify.cjs"],inputs:["verify.cjs",page,...(i===1?[api]:[])],covers:other},
        {id:"regression",stage:"regression",argv:cli,inputs:[e2e,page],covers:[]},
        {id:"independent",stage:"independent",argv:["node","-e",`require('node:assert/strict').ok(require('node:fs').statSync(${JSON.stringify(page)}).isFile())`],inputs:[page],covers:[other[0]],timeoutMs:60000}
      ]}};
  });
  const plan={requirementId:f.requirement.id,sources:{spec:r35Dir+"/spec.md",attempts:r35Dir+"/planned-attempts.md",ticketsDir:r35Dir+"/issues"},tickets};
  return {f,plan};
}

test("Hive R35 preview accepts directory and list, preserves ACs, promotes browser declarations and supports non-AC regression", async(t)=>{
  const {f,plan}=await r35Plan(t);
  const preview=await f.call("Lead","previewPlan",plan);
  assert.equal(preview.state,"valid",JSON.stringify(preview.violations));
  assert.deepEqual(preview.violations,[]);
  assert.equal(preview.tickets.length,4);
  assert.deepEqual(preview.tickets.map((ticket)=>ticket.after[0]?.ticket ?? null),[null,"R35-01","R35-02","R35-03"]);
  assert.deepEqual(preview.tickets.slice(1).map((ticket) => ticket.after[0].stage), ["verified", "verified", "verified"]);
  const explicitAcceptance = structuredClone(plan);
  explicitAcceptance.tickets[1].after = [{ ticket: "R35-01", stage: "accepted" }];
  const override = await f.call("Lead", "previewPlan", explicitAcceptance);
  assert.equal(override.tickets[1].after[0].stage, "accepted");
  assert.ok(override.warnings.some(({ path, message }) => path === "tickets[R35-02].after" && message.includes("等待用户验收")));
  assert.deepEqual(preview.tickets.map((ticket)=>ticket.verification.acceptance.length),[6,8,7,6]);
  assert.ok(preview.tickets.every((ticket)=>ticket.writes.includes(page)));
  assert.ok(!preview.tickets[2].writes.some((file)=>file.endsWith("/jobs.ts")));
  if (process.env.LINGFLOW_R35_REFERENCE) assert.equal(preview.tickets[1].writes.length,8);
  assert.ok(preview.warnings.some((warning)=>warning.path.endsWith(".browserE2E") && warning.message.includes("归并")));
  assert.ok(preview.tickets.every((ticket)=>ticket.verification.checks.some((check)=>check.stage==="regression"&&!check.covers.length)));
  const {ticketsDir,...common}=plan.sources;
  for (const source of [r35Files.map((name)=>ticketsDir+"/"+name),r35Dir+"/aggregate.md"]) {
    const alternate=await f.call("Lead","previewPlan",{...plan,sources:{...common,tickets:source}});
    assert.equal(alternate.state,"valid",JSON.stringify(alternate.violations));
    assert.deepEqual(alternate.tickets,preview.tickets);
  }
  const shape=await f.call("Lead","schema",{command:"dispatchPlan"});
  assert.equal(shape.independentTimeoutMs,60000);
  assert.ok(shape.stages.includes("regression"));
  assert.deepEqual((await f.call("Lead","list")).tasks,[]);
});

test("Hive R35 preview returns independent violations together and derives red only with a failure assertion", async(t)=>{
  const {f,plan}=await r35Plan(t);
  const raw=structuredClone(plan);
  raw.tickets=raw.tickets.slice(0,1);
  const [a,b,c]=plan.tickets;
  a.verification.checks=a.verification.checks.filter(({stage})=>stage!=="green");
  b.verification.checks.find(({id})=>id==="full").covers.pop();
  c.verification.checks.find(({id})=>id==="independent").timeoutMs=300000;
  a.verification.checks.find(({id})=>id==="independent").timeoutMs=300001;
  a.verification.checks.find(({id})=>id==="full").covers.pop();
  a.unrecognizedField = "field warning fixture";
  const invalid=await f.call("Lead","previewPlan",plan);
  assert.equal(invalid.state,"invalid");
  for(const [key,expected] of [["R35-01",/缺少 green/],["R35-02",/未覆盖/],["R35-03",/limit=60000 actual=300000/]])
    assert.ok(invalid.violations.some((item)=>item.path.includes(key)&&expected.test(item.message)&&item.expected&&item.remedy),JSON.stringify(invalid));
  assert.ok(invalid.violations.filter((item)=>item.path.includes("R35-01")).length>=3);
  assert.ok(invalid.warnings.some((warning)=>warning.path.endsWith(".unrecognizedField")));
  await assert.rejects(f.call("Lead","dispatchPlan",plan),(error)=>error.verificationCode==="contract-invalid"&&error.violations.length>=3);
  assert.deepEqual((await f.call("Lead","list")).tasks,[]);

  const checks=raw.tickets[0].verification.checks;
  const red=checks.find(({stage})=>stage==="red");
  Object.assign(red,{stage:"green",deriveRed:true,redExpectedOutput:"Expected: visible"});
  delete red.expectedOutput;
  const derived=await f.call("Lead","previewPlan",raw);
  assert.equal(derived.state,"valid",JSON.stringify(derived));
  assert.ok(derived.tickets[0].verification.checks.some((check)=>check.stage==="red"&&check.failureOutput==="Expected: visible"));
  delete red.redExpectedOutput;
  const unsafe=await f.call("Lead","previewPlan",raw);
  assert.ok(unsafe.violations.some(({message})=>message.includes("本案缺少 failureOutput 声明")));
});

test("Hive R35 registration with offline developers does not create delivery acknowledgements", async(t)=>{
  const {f,plan}=await r35Plan(t);
  await f.heartbeat(["Lead","Supervisor"]); // The bridge no longer lists any of the four members.
  const requested=await f.binding("DevA");
  assert.equal(requested.effective,true);
  assert.equal(requested.deliveryBlocker,"offline");
  const receipt=await f.call("Lead","dispatchPlan",plan,"r35-offline");
  assert.equal(receipt.receipt,"accepted");
  assert.equal(receipt.runnable,false);
  assert.equal(receipt.tasks.length,4);
  assert.ok(receipt.tasks.every((item)=>item.deliveredAt===null && item.blockedBy[0].reason==="offline"));
  const delivery=await f.heartbeat(["Lead"]);
  assert.ok(!delivery.deliveries.some((wake)=>wake.sessionId==="DevA"||wake.sessionId==="DevB"));
  for(const {taskId} of receipt.tasks) assert.equal((await f.inspect(taskId)).deliveredAt,null);
  const ticketPath=r35Dir+"/issues/"+r35Files[0];
  assert.match((await f.call("Lead","inspectPlan",{planId:receipt.planId,document:ticketPath})).text,/R35-01/);
});
