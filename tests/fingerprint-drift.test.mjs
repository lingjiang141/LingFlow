import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileSha256, fingerprint, normalizeEol, ownershipFingerprints } from "../src/files.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { startServer } from "../src/server.mjs";

const file = "implementation.cjs";
const testCode = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');\n";
const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
  .map(axis => [axis, { state: "pass", evidence: "核对隔离项目中的实际差异与用例", checkIds: ["full"] }]));
const taskOf = f => f.store.read().tasks.find(task => task.id === f.taskId);
const git = (f, ...args) => execFileSync("git", args, { cwd: f.root, windowsHide: true });
const commit = (f, ...files) => {
  f.git("add", "--", ...files);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "in-flight fixture");
  return git(f, "rev-parse", "HEAD").toString().trim();
};
const heartbeat = f => f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
const yieldTask = f => f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "隔离原票停止写入" });

test("normalization affects only CRLF, and raw mode sees an EOL-only edit", async t => {
  const f = await fixture(t);
  assert.deepEqual(normalizeEol(Buffer.from([0, 255, 13, 10, 13, 77, 13, 10, 10, 13])),
    Buffer.from([0, 255, 10, 13, 77, 10, 10, 13]));
  f.put(file, "line one\nline two\n");
  const lf = fingerprint(f.root, [file]);
  const raw = fingerprint(f.root, [file], [], undefined, { eol: "raw" });
  const cache = ownershipFingerprints(f.root, { head: "fixture", index: "fixture" });
  assert.equal(cache.file(file), lf);
  f.put(file, "line one\r\nline two\r\n");
  assert.equal(fingerprint(f.root, [file]), lf);
  assert.equal(cache.file(file), lf);
  assert.notEqual(fingerprint(f.root, [file], [], undefined, { eol: "raw" }), raw);
  const fromRawProcess = execFileSync(process.execPath, ["--input-type=module", "-e",
    "import {fingerprint, fingerprintEol} from './src/files.mjs'; console.log(fingerprintEol, fingerprint(process.argv[1], ['implementation.cjs']));", f.root],
    { env: { ...process.env, LINGFLOW_FINGERPRINT_EOL: "raw" }, windowsHide: true, encoding: "utf8" }).trim();
  assert.equal(fromRawProcess, "raw " + fingerprint(f.root, [file], [], undefined, { eol: "raw" }));
});

test("real git show LF restores a CRLF red baseline; assertion files stay byte-exact", async t => {
  const f = await fixture(t, "AssertionError", { implementation: "module.exports = 'old';\r\n" });
  f.git("-c", "core.autocrlf=true", "add", "--renormalize", "--", file);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "LF blob fixture");
  f.store.change(state => {
    const task = state.tasks[0];
    task.state = "queued";
    task.baseline = null;
    f.wf.schedule(state);
  });
  const old = taskOf(f).baseline;
  assert.equal(old.fingerprintEol, "normalize");
  const bytes = git(f, "-c", "core.autocrlf=false", "show", old.head + ":" + file);
  assert.equal(bytes.toString(), "module.exports = 'old';\n");
  f.put(file, bytes);
  f.put(f.testFile, testCode);
  assert.equal(f.wf.sourceInput(f.root, taskOf(f)), old.sources);
  assert.equal((await f.run("red")).state, "passed");
  f.put(file, "module.exports = 'new';\n");
  f.put(f.testFile, testCode.replaceAll("\n", "\r\n"));
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "green" }), /先完成可核对的预期失败检查/);
});

test("legacy mode must explicitly refresh and red mismatch reports both hashes and exact paths", async t => {
  const f = await fixture(t);
  f.store.change(state => { delete state.tasks[0].baseline.fingerprintEol; });
  const red = { taskId: f.taskId, checkId: "red" };
  assert.throws(() => f.call("Dev", "check", red), error => {
    assert.equal(error.verificationCode, "contract-invalid");
    assert.match(error.message, /指纹口径已从 raw.*normalize.*reviseSchedule/);
    return true;
  });
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosis.nextAction.command, "reviseSchedule");
  assert.equal(diagnosis.nextAction.args.refreshBaseline, true);
  yieldTask(f);
  heartbeat(f);
  f.call("Lead", "reviseSchedule", diagnosis.nextAction.args);
  assert.equal(taskOf(f).baseline.fingerprintEol, "normalize");
  const expected = taskOf(f).baseline.sources;
  f.put(file, "module.exports = 'olD';");
  assert.throws(() => f.call("Dev", "check", red), error => {
    assert.equal(error.verificationCode, "contract-invalid");
    const issue = error.violations[0];
    assert.equal(issue.expected, expected);
    assert.match(issue.actual, /^[a-f0-9]{64}$/);
    assert.notEqual(issue.actual, expected);
    assert.deepEqual(issue.changedFiles, [file]);
    assert.deepEqual(issue.remedy.inspectBytes[0], ["git", "-c", "core.autocrlf=false", "show", taskOf(f).baseline.head + ":" + file]);
    assert.equal(issue.remedy.nextAction, undefined);
    return true;
  });
  assert.deepEqual(f.store.read().checkJobs, []);
});

test("foreign commits are recorded once as non-actionable drift without blocking readback", async t => {
  const f = await fixture(t);
  const from = taskOf(f).baseline.head;
  f.put("unrelated.cjs", "external");
  const to = commit(f, "unrelated.cjs");
  const args = { taskId: f.taskId };
  const diagnosis = f.call("Lead", "diagnoseTask", args);
  assert.equal(diagnosis.historyAdvance.to, to);
  const drift = f.wf.call("Dev", "describeDrift", args);
  assert.deepEqual(drift.committedBetween, ["unrelated.cjs"]);
  assert.deepEqual(drift.conflicts, []);
  f.put(f.testFile, testCode);
  assert.equal((await f.run("red")).state, "passed");
  assert.equal(taskOf(f).baseline.head, to);
  const notes = f.call("Lead", "inbox").notices.filter(notice => notice.key.startsWith("git-drift:"));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].actionable, false);
  assert.deepEqual(notes[0].drift, { from, to, committedBetween: ["unrelated.cjs"], conflicts: [], commits: [to], origin: "unattributed" });
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM events WHERE kind='git.drift'").get().count, 1);
  const times = f.call("Lead", "inspect", args);
  assert.ok(times.elapsedSinceLastCheckMs >= 0);
  assert.ok(times.blockedOnContractMs >= 0);
});

test("a diagnosis through the evidence worker writes exactly one drift notice to the writer", async t => {
  const f = await fixture(t);
  const from = taskOf(f).baseline.head;
  f.put("outside.cjs", "foreign commit");
  const to = commit(f, "outside.cjs");
  f.close();
  const app = await startServer({ dataDir: f.dir, port: 0 });
  t.after(() => app.close());
  const args = { taskId: f.taskId };
  const diagnosis = await app.workflow.call("ui", "diagnoseTask", args);
  assert.equal(diagnosis.from, from);
  assert.equal(diagnosis.to, to);
  await app.workflow.call("ui", "diagnoseTask", args);
  const until = Date.now() + 3000;
  let notices = [];
  while (!notices.length && Date.now() < until) {
    notices = (await app.workflow.snapshot()).notices.filter(notice => notice.key.startsWith("git-drift:"));
    if (!notices.length) await delay(25);
  }
  assert.deepEqual(notices.map(notice => notice.drift), [{ from, to, committedBetween: ["outside.cjs"], conflicts: [], commits: [to], origin: "unattributed" }]);
});

test("an owned early commit requires explicit rebind, a fresh genuine red, green and full checks", async t => {
  const f = await fixture(t);
  f.call("Dev", "inbox");
  f.put(f.testFile, testCode);
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  const from = taskOf(f).baseline.head;
  f.put(file, "module.exports = 'new';");
  f.put(f.testFile, testCode + "// 新测试版本\n");
  const to = commit(f, file, f.testFile);
  const args = { taskId: f.taskId };
  assert.throws(() => f.call("Dev", "check", { ...args, checkId: "full" }), /baseline-drift-blocked.*2 个写集文件.*describeDrift.*report outcome=blocked/);
  assert.throws(() => f.call("Dev", "report", { ...args, summary: "尚不能交付" }), /baseline-drift-blocked/);
  const blocked = f.call("Dev", "report", { ...args, outcome: "blocked", summary: "保留当前提交内容", blocker: "在途提交", dimensions });
  assert.equal(blocked.state, "stored");
  await delay(15);
  const metrics = f.call("Lead", "inspect", args);
  assert.ok(metrics.elapsedSinceDeliveryMs >= metrics.elapsedSinceLastCheckMs);
  assert.ok(metrics.blockedOnContractMs >= 15);
  assert.equal(f.call("Lead", "diagnoseTask", args).nextAction.command, "yieldForSchedule");
  yieldTask(f);
  heartbeat(f);
  const diagnosis = f.call("Lead", "diagnoseTask", args);
  assert.deepEqual(diagnosis.rerunRed, ["red"]);
  const rebind = f.call("Lead", diagnosis.nextAction.command, diagnosis.nextAction.args);
  assert.equal(rebind.rebind.to, to);
  assert.deepEqual(taskOf(f).scheduleHistory.at(-1).previous.writes, taskOf(f).writes);
  assert.deepEqual(rebind.rebind.rerunRed, ["red"]);
  assert.equal(rebind.rebind.redBaselineHead, from);
  heartbeat(f);
  f.call("Dev", "inbox");
  assert.throws(() => f.call("Dev", "check", { ...args, checkId: "green" }), /先完成可核对的预期失败检查/);
  assert.throws(() => f.call("Dev", "check", { ...args, checkId: "red" }), /红阶段必须在实现文件未变化/);
  f.put(file, git(f, "show", from + ":" + file));
  const freshRed = await f.run("red");
  assert.equal(freshRed.state, "passed");
  assert.notEqual(freshRed.id, red.id);
  assert.equal(git(f, "rev-parse", "HEAD").toString().trim(), to);
  f.put(file, git(f, "show", to + ":" + file));
  for (const stage of ["green", "full"]) assert.equal((await f.run(stage)).state, "passed");
  const report = f.call("Dev", "report", { ...args, summary: "已重取真实红且绿和完整检查通过", dimensions });
  assert.equal(report.state, "stored");
  assert.equal(taskOf(f).blockedReports.length, 1);
  assert.deepEqual(taskOf(f).reports.at(-1).checks.find(check => check.stage === "red").jobId, freshRed.id);
  heartbeat(f);
  f.call("Review", "inbox");
  f.call("Review", "review", { ...args, candidate: report.candidate, verdict: "pass", findings: "三段证据可核对",
    dimensions, testReview: "已核对修改后的测试版本，红仍在旧实现上真实失败，绿在提交后的实现通过。" });
  assert.equal(taskOf(f).state, "ready");
});

test("ownedDirty proposals are byte-bound and never applied without controller confirmation", async t => {
  const f = await fixture(t);
  f.put(file, "module.exports = 'modified';");
  const taskId = f.taskId;
  const value = () => fileSha256(f.root, file);
  const propose = () => f.call("Dev", "proposeOwnedDirty", { taskId, files: [{ file, sha256: value() }] });
  const proposal = propose();
  assert.equal(proposal.state, "pending");
  assert.deepEqual(taskOf(f).ownedDirty, []);
  assert.throws(() => f.call("Dev", "reviseSchedule", { taskId, reason: "越权", confirmOwnedDirty: proposal.proposal.files }), /主控/);
  yieldTask(f);
  heartbeat(f);
  const args = { taskId, reason: "核实文件归属", refreshBaseline: true };
  assert.throws(() => f.call("Lead", "reviseSchedule", args), /确认现有改动归属/);
  f.put(file, "module.exports = 'changed again';");
  assert.throws(() => f.call("Lead", "reviseSchedule", { ...args, confirmOwnedDirty: proposal.proposal.files }), /SHA-256 已变/);
  const confirmed = propose().proposal.files;
  f.call("Lead", "reviseSchedule", { ...args, confirmOwnedDirty: confirmed });
  assert.deepEqual(taskOf(f).ownedDirty, [file]);
  assert.equal(taskOf(f).ownedDirtyProposal.state, "confirmed");
});
