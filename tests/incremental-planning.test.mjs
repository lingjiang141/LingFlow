import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import test from "node:test";
import { fixture, versionedSpec } from "./helpers/evidence-fixture.mjs";
import { browserCheckArgv } from "../src/verification-policy.mjs";

const fence = (kind, value) => ["```" + kind, JSON.stringify(value), "```"].join("\n");
const sessions = state => state.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 }));

async function planningFixture(t) {
  const f = await fixture(t);
  const requirementId = f.store.read().requirements[0].id;
  const projectId = f.store.read().projects[0].id;
  const member = f.call("ui", "addRole", { projectId, kind: "developer", name: "Other" });
  const binding = f.wf.request({ roleId: member.id, sessionId: "Other", cwd: f.root });
  f.call("ui", "confirmBinding", { requestId: binding.id });
  f.call("ui", "enable", { roleId: member.id, enabled: true });
  f.wf.heartbeat(sessions(f.store.read()));
  f.call("Other", "inbox");
  f.store.change(state => { state.tasks[0].ticketKey = "R39-01"; });
  mkdirSync(path.join(f.root, "issues"));
  const sources = { spec: "spec.md", ticketsDir: "issues", attempts: "attempts.md" };
  const task = taskId => f.store.read().tasks.find(item => item.id === taskId);
  const paper = (ticket, { after = "无", browser = false, recipe = true, developerChecks = false, risk = "高", riskItems } = {}) => {
    const file = browser ? "e2e/browser.spec.ts" : "e2e/verify.cjs";
    const useCase = { file, title: ticket + " 完整用例", reason: "真实浏览器行为", covers: ["AC-1"] };
    const argv = browser ? browserCheckArgv(useCase) : ["node", file];
    const checks = ["red", "green", "full"].map(stage => ({ id: stage, stage, argv, inputs: [file], covers: ["AC-1"],
      ...(stage === "red" && { expectedOutput: "AssertionError" }) }));
    const contract = { ticket, requiredWrites: ["changed.cjs"], requiredTestWrites: [file], requiredAcceptance: ["AC-1"],
      ...(riskItems && { riskItems }),
      ...(developerChecks && { developerChecks }) };
    f.put("issues/" + ticket + ".md", [
      "# 票 " + ticket + "：新要求", "## 需求与 AC", "", "**AC-1** 可观察行为", "",
      "## 依赖与归属", "- 前置：" + after, "- 共享资源：`fixture-port`", "## riskAssessment", "**等级：" + risk + "**",
      "风险理由：共享资源变更，需核对候选及回归",
      fence("lingflow-contract", contract), ...(recipe ? [fence("lingflow-checks", { checks, browserE2E: browser ? [useCase] : [] })] : []),
    ].join("\n"));
    return { key: ticket, developerId: member.id };
  };
  const plan = tickets => ({ requirementId, sources, tickets });
  return { ...f, task, paper, plan, requirementId, sources, member };
}

test("explicit after wins over the frozen text; omitted after still waits for verified evidence", async t => {
  const f = await planningFixture(t);
  assert.equal(f.task(f.taskId).state, "assigned");
  const ticket = f.paper("R39-02", { after: "R39-01" });
  const fallback = f.call("Lead", "previewPlan", f.plan([ticket]));
  assert.deepEqual(fallback.tickets[0].after, [{ ticket: "R39-01", stage: "verified" }]);
  const result = f.call("Lead", "dispatchPlan", f.plan([{ ...ticket, after: [] }]));
  assert.ok(result.warnings.some(warning => warning.message === "票面声明的前置未被采用" && warning.value.ticket === "R39-01"));
  assert.equal(result.tasks[0].state, "assigned");
  assert.deepEqual(f.task(result.tasks[0].taskId).dependencies, []);
});

test("insertSchedule admits queued work without editing the frozen source and rejects self/cycles", async t => {
  const f = await planningFixture(t);
  const waiting = f.paper("R39-02", { after: "R39-01" });
  const follower = f.paper("R39-03", { after: "R39-02" });
  const result = f.call("Lead", "dispatchPlan", f.plan([waiting, follower]));
  const [first, second] = result.tasks.map(ticket => ticket.taskId);
  const frozen = readFileSync(path.join(f.root, "issues/R39-02.md"));
  assert.equal(f.task(first).state, "queued");
  assert.match(f.task(first).waitReason, /等待前置.*有效验证/);
  const original = f.task(first);
  for (const ticket of ["R39-02", "R39-03"]) {
    assert.throws(() => f.call("Lead", "insertSchedule", { taskId: first, after: [{ ticket }], reason: "invalid graph" }), /自指|循环/);
    assert.deepEqual(f.task(first), original);
  }
  assert.throws(() => f.call("Other", "insertSchedule", { taskId: first, after: [], reason: "not controller" }), /主控/);
  const args = { taskId: first, after: [], reason: "本票不依赖原票" };
  const receipt = f.call("Lead", "insertSchedule", args, "insert-once");
  assert.deepEqual(f.call("Lead", "insertSchedule", args, "insert-once"), receipt);
  assert.deepEqual(receipt.dependencies, []);
  assert.equal(receipt.scheduleVersion, 1);
  assert.equal(f.task(first).state, "assigned");
  assert.equal(f.task(second).state, "queued");
  assert.deepEqual(f.task(first).writes, original.writes);
  assert.deepEqual(readFileSync(path.join(f.root, "issues/R39-02.md")), frozen);
});

test("a delta spec and selected new ticket insert ahead of queued work in the same issues directory", async t => {
  const f = await planningFixture(t);
  const before = f.task(f.taskId);
  assert.equal(before.state, "assigned");
  const b = f.paper("R39-02", { after: "R39-01" });
  const { tasks: [{ taskId: bId }] } = f.call("Lead", "dispatchPlan", f.plan([b]));
  assert.equal(f.task(bId).state, "queued");
  const read = file => readFileSync(path.join(f.root, file));
  const originalSpec = read("spec.md");
  const originalPaper = read("issues/R39-02.md");
  const originalAttempts = read("attempts.md");

  const change = f.call("Lead", "approve", { text: "插入独立新要求", source: "用户授权的变更" });
  f.put("spec-delta.md", versionedSpec("# 新要求\n仅补充新的可观察行为。"));
  f.paper("R39-03");
  appendFileSync(path.join(f.root, "attempts.md"), "\n\n## 本轮插入\n先执行 R39-03，然后回到 R39-02。\n");
  const inputs = { command: "dispatchPlan", requirementId: change.id, spec: "spec-delta.md",
    tickets: ["issues/R39-03.md"], attempts: "attempts.md", developerIds: { "R39-03": f.member.id } };
  const conflicting = f.call("Lead", "schema", { ...inputs, ticketsDir: "issues" });
  assert.equal(conflicting.state, "invalid");
  assert.ok(conflicting.violations.some(item => /只能选一种/.test(item.message)));
  const generated = f.call("Lead", "schema", inputs);
  assert.equal(generated.state, "valid", JSON.stringify(generated.violations));
  assert.deepEqual(generated.args.sources.tickets, ["issues/R39-03.md"]);
  assert.deepEqual(generated.args.tickets.map(ticket => ticket.key), ["R39-03"]);
  const { tasks: [{ taskId: xId }] } = f.call("Lead", "dispatchPlan", generated.args);
  assert.equal(f.task(xId).state, "assigned");

  const placed = f.call("Lead", "insertSchedule", { taskId: bId,
    after: [{ taskId: f.taskId, stage: "verified" }, { taskId: xId, stage: "verified" }],
    reason: "保留真实前置，并在原计划 B 之前插入新要求" });
  assert.deepEqual(new Set(placed.dependencies), new Set([f.taskId, xId]));
  assert.equal(f.task(bId).state, "queued");
  assert.deepEqual(f.task(f.taskId).baseline, before.baseline);
  assert.equal(f.task(f.taskId).state, "assigned");
  assert.deepEqual(read("spec.md"), originalSpec);
  assert.deepEqual(read("issues/R39-02.md"), originalPaper);
  assert.deepEqual(read("attempts.md").subarray(0, originalAttempts.length), originalAttempts);
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.ok(diagnosis.sourceNotes?.some(note => note.kind === "source-appended" && note.firstAppendedHeading === "## 本轮插入"));
});

test("dependency receipt failure alerts once after ten minutes but contract-invalid does not alert", async t => {
  const f = await planningFixture(t);
  const ticket = f.paper("R39-02", { after: "R39-01" });
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", f.plan([ticket]));
  const now = Date.now();
  f.store.change(state => { state.tasks.find(task => task.id === f.taskId).state = "ready"; });
  const realVerify = f.wf.verifyScope.bind(f.wf);
  let code = "contract-invalid";
  f.wf.verifyScope = (state, task) => {
    if (task.id !== f.taskId) return realVerify(state, task);
    throw Object.assign(Error("基线指纹暂时不可读取：具体原因"), { verificationCode: code });
  };
  const tick = at => f.store.change(state => f.wf.schedule(state, at));
  const alerts = () => f.store.read().notices.filter(notice => notice.key.startsWith("patrol-alert:dependency:"));
  tick(now);
  tick(now + 600000);
  assert.equal(alerts().length, 0);
  code = "evidence-missing";
  tick(now + 600001);
  tick(now + 1200000);
  assert.equal(alerts().length, 0);
  tick(now + 1200001);
  tick(now + 1300000);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].summary, /R39-02.*R39-01.*具体原因/);
  const commands = [...alerts()[0].summary.matchAll(/(reviseSchedule|rework) (\{[^\n]+\})/g)];
  assert.equal(JSON.parse(commands[0][2]).taskId, taskId);
  assert.deepEqual(JSON.parse(commands[0][2]).after, []);
  assert.equal(JSON.parse(commands[1][2]).taskId, f.taskId);
  assert.equal(f.task(taskId).state, "queued");
});

test("silent assigned shifts retain baseline and cannot override a live turn", async t => {
  const f = await planningFixture(t);
  const original = f.task(f.taskId);
  const args = { taskId: f.taskId, after: [], reason: "成员已静默" };
  const prepare = running => f.store.change(state => {
    const task = state.tasks.find(task => task.id === f.taskId);
    const member = state.roles.find(role => role.id === task.developerId);
    task.ownerState = "silent";
    Object.assign(member, { connectedAt: Date.now(), state: running ? "running" : "idle", pending: 0, jobs: 0 });
  });
  prepare(true);
  assert.throws(() => f.call("Lead", "reviseSchedule", args), /进行中的回合/);
  assert.throws(() => f.call("Lead", "releaseSchedule", args), /停写|paused/);
  prepare(false);
  assert.throws(() => f.call("Lead", "reviseSchedule", { ...args, writes: ["a"] }), /不得改写集/);
  const revised = f.call("Lead", "reviseSchedule", args);
  assert.equal(revised.recoveredBy, "reviseSchedule");
  assert.equal(revised.previousOwnerState, "silent");
  assert.deepEqual(f.task(f.taskId).baseline, original.baseline);
  f.wf.heartbeat(sessions(f.store.read()));
  prepare(false);
  const released = f.call("Lead", "releaseSchedule", { taskId: f.taskId, reason: "已无剩余责任" });
  assert.equal(released.recoveredBy, "releaseSchedule");
  assert.equal(released.previousOwnerState, "silent");
  assert.ok(f.task(f.taskId).releasedScope);
});

test("schema materializes a valid plan with complete AC coverage and no inline verification", async t => {
  const f = await planningFixture(t);
  const coordination = "本轮无额外跨票协调。\n";
  f.put(f.sources.attempts, coordination);
  const riskItems = [{ id: "RISK-1", reason: "复用共用入口", impact: "旧调用会受影响", coveredBy: ["AC-1"], verifiedBy: ["full"] }];
  f.paper("R39-02", { riskItems });
  const suggested = f.call("Lead", "schema", { command: "dispatchPlan", requirementId: f.requirementId, ...f.sources });
  assert.equal(suggested.args.tickets[0].developerId, f.member.id);
  const busy = f.task(f.taskId).developerId;
  const forced = f.call("Lead", "schema", { command: "dispatchPlan", requirementId: f.requirementId, ...f.sources,
    developerIds: { "R39-02": busy } });
  assert.equal(forced.args.tickets[0].developerId, busy);
  const generated = f.call("Lead", "schema", { command: "dispatchPlan", requirementId: f.requirementId, ...f.sources,
    developerIds: { "R39-02": f.member.id } });
  assert.equal(generated.state, "valid", JSON.stringify(generated.violations));
  assert.equal(generated.args.tickets[0].verification, undefined);
  assert.deepEqual(generated.args.tickets[0].riskItems, riskItems);
  assert.deepEqual(generated.checks[0].checks.find(check => check.stage === "full").covers, ["AC-1"]);
  assert.equal(f.call("Lead", "previewPlan", generated.args).state, "valid");
  const dispatched = f.call("Lead", "dispatchPlan", generated.args);
  assert.equal(dispatched.receipt, "accepted");
  const { taskId } = dispatched.tasks[0];
  assert.equal(f.task(f.taskId).state, "assigned");
  assert.equal(f.task(taskId).state, "assigned");
  assert.deepEqual(f.task(taskId).resources, ["fixture-port"]);
  assert.deepEqual(f.task(taskId).riskItems, riskItems);
  const progress = "复用现有入口；先跑原票红检查，范围变化时停手。";
  assert.equal(f.call("Other", "progress", { taskId, text: progress }).state, "stored");
  assert.equal(f.task(taskId).progress, progress);
  assert.equal(f.call("Lead", "inspectPlan", { planId: dispatched.planId, document: "attempts" }).text, coordination);
  assert.equal(readFileSync(path.join(f.root, f.sources.attempts), "utf8"), coordination);
});

test("preview flags shared ports and suspect ordering without changing explicit edges or resources", async t => {
  const f = await planningFixture(t);
  const first = f.paper("R39-02");
  const second = f.paper("R39-03", { after: "R39-02" });
  f.put("attempts.md", "R39-02/03 共用 4174 端口与同一临时库，必须串行。");
  const args = f.plan([{ ...first, resources: [] }, { ...second, resources: [] }]);
  const preview = f.call("Lead", "previewPlan", args);
  assert.equal(preview.state, "valid");
  assert.equal(preview.warnings.filter(warning => warning.code === "shared-resource-missing").length, 2);
  assert.deepEqual(preview.warnings.find(warning => warning.code === "dependency-shared-resource").sharedResources, ["port:4174"]);
  const actual = f.call("Lead", "dispatchPlan", args);
  const [a, b] = actual.tasks.map(ticket => f.task(ticket.taskId));
  assert.deepEqual(b.dependencies, [a.id]);
  assert.deepEqual(a.resources, []);
  assert.deepEqual(b.resources, []);
});

test("delegated checks freeze once before red, require the original scope and produce real red and green", async t => {
  const f = await planningFixture(t);
  f.paper("R39-02", { recipe: false, developerChecks: true });
  const { args, checks: pending, state } = f.call("Lead", "schema", { command:"dispatchPlan", requirementId: f.requirementId, ...f.sources });
  assert.equal(state, "valid");
  assert.equal(pending[0].developerChecksPending, true);
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", args);
  assert.equal(f.task(taskId).state, "assigned");
  const before = f.task(taskId).baseline.sources;
  assert.equal(f.call("Other", "inspect", { taskId }).developerChecksPending, true);
  assert.equal(f.call("Lead", "diagnoseTask", { taskId }).classification, "checks-not-registered");
  assert.throws(() => f.call("Other", "check", { taskId, checkId:"red", async:true }), /registerChecks/);
  assert.throws(() => f.call("Other", "report", { taskId, summary:"尚未取证" }), /registerChecks/);
  const file = "e2e/verify.cjs";
  f.put(file, "require('node:assert/strict').equal(require('node:fs').existsSync(require('node:path').join(__dirname,'../changed.cjs')),true);");
  const checks = ["red", "green", "full"].map(stage => ({ id: stage, stage, argv: ["node", file], inputs: [file],
    covers: ["AC-1"], ...(stage === "red" && { expectedOutput: "AssertionError" }) }));
  assert.throws(() => f.call("Dev", "registerChecks", { taskId, checks }), /责任开发/);
  assert.throws(() => f.call("Other", "registerChecks", { taskId, checks: checks.slice(0,2) }), /完整检查未覆盖/);
  assert.throws(() => f.call("Other", "registerChecks", { taskId, checks, resources:["port:9999"] }), /资源尚未获批/);
  const oversized = checks.map(check => ({ ...check, inputs: [file, "outside/config.json"] }));
  assert.throws(() => f.call("Other", "registerChecks", { taskId, checks: oversized }), /超出已批准读写范围/);
  f.put("changed.cjs", "module.exports = true;");
  assert.throws(() => f.call("Other", "registerChecks", { taskId, checks }), /原取红实现未变化/);
  unlinkSync(path.join(f.root,"changed.cjs"));
  const receipt = f.call("Other", "registerChecks", { taskId, checks }, "freeze-developer-checks");
  assert.deepEqual(receipt.nextAction, { command:"check", args:{ taskId, checkId:"red" } });
  assert.deepEqual(f.call("Other", "registerChecks", { taskId, checks }, "freeze-developer-checks"), receipt);
  assert.throws(() => f.call("Other", "registerChecks", { taskId, checks }), /已冻结/);
  assert.equal(f.task(taskId).baseline.sources, before);
  async function run(checkId) {
    const { jobId } = f.call("Other", "check", { taskId, checkId, async:true });
    for (let i = 0; i < 200; i++) {
      const job = f.store.read().checkJobs.find(entry => entry.id === jobId);
      if (job && !["queued","launching"].includes(job.state)) return job;
      await delay(50);
    }
    assert.fail("check did not finish");
  }
  assert.equal((await run("red")).receipt.failureOutputSeen, true);
  f.put("changed.cjs", "module.exports = true;");
  for (const checkId of ["green","full"]) assert.equal((await run(checkId)).state, "passed");
});

test("a paused developerChecks ticket can use one explicit authorization to register derived red", async t => {
  const f = await planningFixture(t);
  const paper = f.paper("R39-02", {recipe:false, developerChecks:true});
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", f.plan([paper]));
  const submit = checks => f.call("Other", "registerChecks", {taskId,checks,replace:true,reason:"明确冻结配方"});
  const file = "e2e/verify.cjs";
  const common = {argv:["node",file],inputs:[file],covers:["AC-1"]};
  const green = {id:"green",stage:"green",deriveRed:true,...common};
  const full = {id:"full",stage:"full",...common};
  f.call("Other", "yieldForSchedule", {taskId,reason:"交回准备检查"});
  assert.throws(() => submit([green,full]), /主控明确授权/);
  assert.equal(f.call("Lead", "reviseSchedule", {taskId,reason:"已核对原票",allowCheckRevision:true}).state,"stored");
  assert.throws(() => submit([green,full]), /缺少 failureOutput/);
  f.put(file, "require('node:assert/strict').equal(1, 2);");
  const receipt = submit([{...green,expectedOutput:"AssertionError"},full]);
  const derived = f.task(taskId).verification.checks.find(check => check.id === "green-red");
  assert.equal(derived.failureOutput,"AssertionError");
  assert.equal(derived.expectedOutput,"AssertionError");
  assert.equal(f.task(taskId).developerChecksPending,undefined);
  assert.equal(f.call("Lead", receipt.nextAction.command, receipt.nextAction.args).state,"stored");
  const red = await f.run("green-red",false,"Other",taskId);
  assert.equal(red.state,"passed");
  assert.equal(red.receipt.failureOutputSeen,true);
});

test("wait timings track each admission blocker once and separate check queue time", async t => {
  const f = await planningFixture(t);
  const ticket = f.paper("R39-02", { after: "R39-01" });
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", f.plan([ticket]));
  const start = f.task(taskId).admissionWait.current.since;
  const change = fn => f.store.change(s => fn(s, s.tasks.find(task => task.id === taskId), s.roles.find(role => role.id === f.member.id)));
  change((s, task) => {
    task.dependencies = [];
    task.dependencyStages = {};
    s.tasks[0].resources = ["fixture-port"];
    f.wf.schedule(s, start + 1000);
    f.wf.schedule(s, start + 1400);
    assert.equal(task.admissionWait.current.kind, "resource");
  });
  change((s, task, member) => {
    s.tasks[0].resources = [];
    member.enabled = false;
    f.wf.schedule(s, start + 3000);
    assert.equal(task.admissionWait.current.kind, "member");
  });
  change((s, task, member) => {
    member.enabled = true;
    member.connectedAt = start + 4000;
    f.wf.schedule(s, start + 6000);
    assert.equal(task.state, "assigned");
  });
  const expected = { trackedSince:start, dependencyMs:1000, resourceMs:2000, memberMs:3000, checkQueueMs:0, current:null };
  assert.deepEqual(f.call("Lead", "inspect", { taskId }).waitTimings, expected);
  assert.deepEqual(f.wf.snapshot().tasks.find(task => task.id === taskId).waitTimings, expected);
  const s = f.store.read(), task = s.tasks.find(entry => entry.id === taskId);
  s.checkJobs.push({ taskId, state:"passed", createdAt:start+6100, startedAt:start+6500, finishedAt:start+6800 });
  s.checkJobs.push({ taskId, state:"queued", createdAt:start+6800 });
  assert.deepEqual(f.wf.taskTimes(s, task, start+7000).waitTimings, { ...expected, checkQueueMs:600 });
});

test("delegated browser checks keep the controller probe and validate named cases before freezing", async t => {
  const f = await planningFixture(t);
  const ticket = f.paper("R39-02", { recipe:false, developerChecks:true, risk:"低", browser:true });
  const file = "e2e/browser.spec.ts";
  const probe = { id:"probe", stage:"independent", argv:["node","-e","console.log('local verification')"],
    inputs:["changed.cjs"], covers:["AC-1"] };
  const make = checks => f.plan([{ ...ticket, verification:{ checks, testWrites:[file] } }]);
  assert.equal(f.call("Lead", "previewPlan", make([])).state, "invalid");
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", make([probe]));
  const original = f.task(taskId).verification.checks[0];
  const entry = { file, title:"R39-02 真实浏览器行为", reason:"需浏览器验收", covers:["AC-1"] };
  const checks = ["red","green","full"].map(stage => ({ id:stage, stage, argv:browserCheckArgv(entry), inputs:[file],
    covers:["AC-1"], ...(stage === "red" && { expectedOutput:"AssertionError" }) }));
  assert.throws(() => f.call("Other", "registerChecks", { taskId, checks:[...checks,probe], browserE2E:[entry] }), /主控探针/);
  assert.throws(() => f.call("Other", "registerChecks", { taskId, checks }), /browserE2E|具名浏览器/);
  assert.equal(f.call("Other", "registerChecks", { taskId, checks, browserE2E:[entry] }).state, "stored");
  assert.deepEqual(f.task(taskId).verification.checks[0], original);
});

test("preview reports write-set differences and does not fabricate missing checks", async t => {
  const f = await planningFixture(t);
  const ticket = f.paper("R39-02");
  const preview = f.call("Lead", "previewPlan", f.plan([{ ...ticket, writes: ["changed.cjs", "e2e/verify.cjs", "extra.cjs"] }]));
  assert.equal(preview.state, "valid");
  assert.deepEqual(preview.warnings.find(warning => warning.difference).difference,
    [{ file: "extra.cjs", kind: "显式多声明", detail: "票面未声明" }]);
  f.paper("R39-02", { recipe: false });
  const invalid = f.call("Lead", "schema", { command: "dispatchPlan", requirementId: f.requirementId, ...f.sources });
  assert.equal(invalid.state, "invalid");
  assert.match(invalid.violations[0].message, /缺少 lingflow-checks/);
  assert.equal(invalid.violations[0].repair.requiresInput, true);
  assert.equal(f.call("Lead", "previewPlan", f.plan([ticket])).state, "invalid");
});

test("preview supplies exact browser argv replacement; inline verification override is audited", async t => {
  const f = await planningFixture(t);
  const ticket = f.paper("R39-02", { browser: true });
  const first = f.call("Lead", "previewPlan", f.plan([ticket]));
  assert.equal(first.state, "valid", JSON.stringify(first.violations));
  const verification = first.tickets[0].verification;
  for (const check of verification.checks) if (!check.expectedOutput) delete check.expectedOutput;
  verification.checks[2].argv[5] = "wrong-title";
  const args = f.plan([{ ...ticket, verification }]);
  const invalid = f.call("Lead", "previewPlan", args);
  assert.ok(invalid.warnings.some(warning => /使用调用方 verification/.test(warning.message)));
  assert.ok(invalid.violations.every(issue => Object.hasOwn(issue.repair, "value")));
  const mismatch = invalid.violations.find(issue => /必须绑定一个声明的文件和标题/.test(issue.message));
  assert.ok(mismatch, JSON.stringify(invalid.violations));
  const { repair } = mismatch;
  assert.equal(repair.path, "tickets[R39-02].verification.checks[2].argv");
  args.tickets[0].verification.checks[2].argv = repair.value;
  assert.equal(f.call("Lead", "previewPlan", args).state, "valid");
});
