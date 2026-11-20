import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fingerprintEol } from "../src/files.mjs";
import { Store } from "../src/store.mjs";
import { Workflow } from "../src/workflow.mjs";
import { startCheckRunner } from "../src/check-runner.mjs";

const base = "module.exports = 'old';\n";
const ready = "module.exports = 'new';\r\n";
const assertion = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');\r\n";
const dimensions = Object.fromEntries(["requirements", "implementation", "system"].map(key =>
  [key, { state: "pass", evidence: "核对真实断言与候选", checkIds: ["full"] }]));

async function rawTrial() {
  const cleanups = [];
  const f = await fixture({ after: callback => cleanups.push(callback) }, "AssertionError", { implementation: base, untrackedFiles: 1 });
  try {
    f.put(f.testFile, assertion);
    assert.equal((await f.run("red")).state, "passed");
    f.put("implementation.cjs", ready);
    assert.equal((await f.run("green")).state, "passed");
    assert.equal((await f.run("full")).state, "passed");
    const report = f.call("Dev", "report", { taskId: f.taskId, summary: "实现已就绪", dimensions });
    f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
    f.call("Review", "inbox");
    f.call("Review", "review", { taskId: f.taskId, candidate: report.candidate, verdict: "pass", findings: "核对真实证据", dimensions });
    f.call("Lead", "summarize", { taskId: f.taskId, instructions: "用户按原步骤试用",
      decision: { candidate: report.candidate, limits: "无", acceptance: [{ id: "AC1", evidence: "核对验收", checkIds: ["full"] }] } });
    assert.equal(f.store.read().tasks[0].state, "trial");
    console.log("TRIAL-FIXTURE " + JSON.stringify({ dir: f.dir, root: f.root, taskId: f.taskId, testFile: f.testFile }));
  } finally {
    for (const close of cleanups) close();
  }
}

function openRawTrial(t) {
  const fixtureUrl = new URL("./helpers/evidence-fixture.mjs", import.meta.url);
  const program = `import assert from "node:assert/strict"; import { fixture } from ${JSON.stringify(fixtureUrl.href)};
    const base = ${JSON.stringify(base)}, ready = ${JSON.stringify(ready)}, assertion = ${JSON.stringify(assertion)},
      dimensions = ${JSON.stringify(dimensions)}; await (${rawTrial.toString()})();`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8", windowsHide: true, timeout: 120000, env: { ...process.env, LINGFLOW_FINGERPRINT_EOL: "raw" },
  });
  const { dir, root, taskId, testFile } = JSON.parse(output.split(/^TRIAL-FIXTURE /m).at(-1));
  const store = new Store(path.join(dir, "workflow.sqlite"));
  const wf = new Workflow(store);
  const stop = startCheckRunner(wf, dir);
  t.after(() => { stop(); store.close(); });
  let operation = 0;
  const call = (who, command, args = {}, operationId = "trial-eol-" + ++operation) => wf.call(who, command, args, operationId);
  const snapshot = () => store.read().tasks.find(task => task.id === taskId);
  const heartbeat = () => wf.heartbeat(store.read().roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  for (const role of store.read().roles) call("ui", "enable", { roleId: role.id, enabled: true });
  heartbeat();
  const put = (file, content) => writeFileSync(path.join(root, file), content);
  async function run(checkId) {
    const { jobId } = call("Dev", "check", { taskId, checkId, async: true });
    for (let i = 0; i < 240; i++) {
      const job = store.read().checkJobs.find(entry => entry.id === jobId);
      if (job && !["queued", "launching"].includes(job.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("new-mode check did not settle");
  }
  return { dir, root, taskId, testFile, store, wf, call, snapshot, heartbeat, put, run };
}

test("trial fingerprint migration validates the original candidate and requires new red and candidate checks", async t => {
  assert.equal(fingerprintEol, "normalize");
  const f = openRawTrial(t), { taskId } = f;
  const old = f.snapshot();
  const jobs = f.store.read().checkJobs.filter(job => job.taskId === taskId);
  assert.ok(jobs.every(job => job.state === "passed" && job.fingerprintEol === "raw"));
  f.store.change(s => {
    delete s.tasks[0].baseline.fingerprintEol;
    delete s.tasks[0].baseline.sourceFiles;
  });
  const diagnose = () => f.call("Lead", "diagnoseTask", { taskId });
  const blockedAccept = () => f.call("ui", "accept", { taskId, evidence: "不应提前验收" });
  assert.throws(blockedAccept, /口径已从/);

  await t.test("trial can prune a committed outside file, while a later dirty version still blocks", () => {
    const file = "outside-0.txt";
    f.put(file, "version in HEAD");
    const git = (...args) => execFileSync("git", args, { cwd: f.root, windowsHide: true });
    git("add", "--", file);
    git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-m", "peer completes outside work");
    const prune = () => f.call("Lead", "reviseSchedule", { taskId, pruneOutside: true, reason: "核对票外清单" });
    f.put(file, "third version");
    assert.match(diagnose().reason, /未归属的改动：outside-0/);
    assert.throws(prune, /未归属的改动：outside-0/);
    f.put(file, "version in HEAD");
    assert.deepEqual(prune().prunedOutside, [file]);
    assert.equal(f.snapshot().state, "trial");
    assert.equal(f.snapshot().candidate, old.candidate);
    assert.deepEqual(f.snapshot().baseline.other, []);
  });
  await t.test("candidate drift rejects migration and supplies an executable closeout", () => {
    const desired = diagnose().nextAction;
    f.put("implementation.cjs", "module.exports = 'edit';\n");
    const blocked = diagnose();
    assert.equal(blocked.classification, "unrecoverable");
    assert.equal(blocked.nextAction.command, "abandonTask");
    assert.deepEqual(blocked.violations.map(item => item.path), ["baseline.fingerprintEol", "candidate"]);
    assert.throws(() => f.call("Lead", desired.command, desired.args), /写集或候选输入已变化/);
    assert.equal(f.snapshot().candidate, old.candidate);
    assert.equal(f.snapshot().state, "trial");
    const before = f.store.read();
    assert.equal(f.call("Lead", blocked.nextAction.command, blocked.nextAction.args).state, "abandoned");
    f.store.change(state => Object.assign(state, before));
    f.put("implementation.cjs", ready);
    f.put("outside.txt", "unexpected outside change\n");
    assert.throws(() => f.call("Lead", desired.command, desired.args), /发现未归属的改动：outside.txt/);
    unlinkSync(path.join(f.root, "outside.txt"));
  });

  const projectId = old.projectId;
  const member = f.call("ui", "addRole", { projectId, kind: "developer", name: "Downstream" });
  const binding = f.wf.request({ roleId: member.id, sessionId: "Downstream", cwd: f.root });
  if (!binding.bound) f.call("ui", "confirmBinding", { requestId: binding.id });
  f.call("ui", "enable", { roleId: member.id, enabled: true });
  f.heartbeat();
  const requirement = f.store.read().requirements[0];
  const plan = f.call("Lead", "dispatchPlan", { requirementId: requirement.id,
    sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "AFTER-TRIAL", developerId: member.id, title: "检查下游等待", description: "前置技术结果",
      reason: "使用前置交付", after: [{ taskId, stage: "verified" }], risk: "low", readOnly: true, writes: [], reads: ["spec.md"] }] });
  const downstream = () => f.store.read().tasks.find(task => task.id === plan.tasks[0].taskId);
  assert.equal(downstream().state, "queued");
  assert.equal(downstream().waitReason, "前置 NEW-TEST 待口径续接");

  const diagnostic = diagnose();
  assert.deepEqual(diagnostic.violations.map(item => item.path), ["baseline.fingerprintEol"]);
  assert.equal(diagnostic.nextAction.command, "reviseSchedule");
  const next = diagnostic.nextAction;
  assert.throws(() => f.call("Dev", next.command, next.args), /主控/);
  const receipt = f.call("Lead", next.command, next.args, "trial-eol-revise");
  assert.deepEqual(f.call("Lead", next.command, next.args, "trial-eol-revise"), receipt);
  assert.deepEqual(receipt, { state: "stored", cipherRealigned: true, taskId, previousFingerprintEol: "raw",
    newFingerprintEol: "normalize", invalidatedChecks: ["red", "green", "full"],
    nextAction: { command: "check", args: { taskId, checkId: "red" } } });
  assert.equal(f.snapshot().state, "waiting_verification");
  assert.equal(f.snapshot().candidate, null);
  assert.equal(f.snapshot().baseline.fingerprintEol, "normalize");
  assert.equal(f.snapshot().baseline.sources, old.baseline.sources);
  assert.ok(f.snapshot().baseline.sourceFiles["implementation.cjs"]);
  assert.deepEqual(f.snapshot().fingerprintEolHistory.map(({ from, to }) => ({ from, to })), [{ from: "raw", to: "normalize" }]);
  assert.throws(blockedAccept, /汇总试用步骤/);
  assert.equal(downstream().state, "queued");
  const notice = f.call("Dev", "inbox").notices.find(row => row.taskId === taskId && /口径已切换/.test(row.summary));
  assert.equal(notice.actionable, true);
  assert.match(notice.summary, /按新口径重跑 red.*check/);
  assert.ok(f.call("Dev", "checkStatus", { taskId }).every(job => job.invalidated === true && job.state === "passed"));
  for (const previous of jobs) {
    const job = f.store.read().checkJobs.find(job => job.id === previous.id);
    const { invalidated, ...unchanged } = job;
    assert.equal(invalidated, true);
    assert.deepEqual(unchanged, previous);
  }
  assert.throws(() => f.call("Dev", "check", receipt.nextAction.args), /红阶段必须在实现文件未变化时运行/);
  f.put("implementation.cjs", base);
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  assert.equal(red.fingerprintEol, "normalize");
  assert.equal(red.receipt.failureOutputSeen, true);
  f.put("implementation.cjs", ready);
  for (const check of ["green", "full"]) assert.equal((await f.run(check)).state, "passed");
  const fresh = f.call("Dev", "report", { taskId, summary: "新口径下重新交付", dimensions });
  assert.notEqual(fresh.candidate, old.candidate);
  f.heartbeat();
  f.call("Review", "inbox");
  f.call("Review", "review", { taskId, candidate: fresh.candidate, verdict: "pass", findings: "核对重新交付", dimensions });
  f.heartbeat();
  assert.equal(f.snapshot().state, "ready");
  assert.equal(downstream().state, "assigned");
  assert.throws(blockedAccept, /汇总试用步骤/);
  assert.equal(f.call("Lead", "summarize", { taskId, instructions: "重新试用",
    decision: { candidate: fresh.candidate, limits: "无", acceptance: [{ id: "AC1", evidence: "新候选", checkIds: ["full"] }] } }).state, "awaiting_user");
  assert.equal(f.call("ui", "accept", { taskId, evidence: "用户实际验收" }).state, "accepted");
  const event = f.store.db.prepare("SELECT kind,data FROM events WHERE kind='fingerprint.realign'").get();
  assert.equal(JSON.parse(event.data).nextAction.args.checkId, "red");
});
