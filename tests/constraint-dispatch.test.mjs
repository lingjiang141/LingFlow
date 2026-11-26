import { reviewedRisk } from "./helpers/evidence-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fixture, versionedSpec } from "./helpers/evidence-fixture.mjs";
import { gitState } from "../src/quality.mjs";
import { selectWakeNotices } from "../src/controller-notices.mjs";
import { WAKE_LOST_MS } from "../src/wake-state.mjs";

const impl = "implementation.cjs";
const testCode = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";
const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
  .map(axis => [axis, { state: "pass", evidence: "隔离项目校验", checkIds: ["full"] }]));
const task = f => f.store.read().tasks[0];
const argsFor = (f, args = {}) => ({ taskId: f.taskId, ...args });
const call = (f, role, command, args) => f.call(role, command, argsFor(f, args));
const commit = (f, file) => {
  f.git("add", "--", file);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "in flight");
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim();
};
async function passing(t, options) {
  const f = await fixture(t, "AssertionError", options);
  f.put(f.testFile, testCode);
  assert.equal((await f.run("red")).state, "passed");
  f.put(impl, "module.exports = 'new';");
  for (const check of ["green", "full"]) assert.equal((await f.run(check)).state, "passed");
  return f;
}
function report(f) {
  return call(f, "Dev", "report", { summary: "实际用例通过", dimensions });
}
function review(f, candidate) {
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  return call(f, "Review", "review", { candidate, verdict: "pass", findings: "核对真实差异", dimensions, riskAssessment: reviewedRisk,
    testReview: "新用例覆盖行为，既有断言保留" });
}
test("three disjoint commits preserve the original check jobs and allow report and review", async t => {
  const f = await passing(t);
  const ids = f.store.read().checkJobs.map(job => job.id);
  for (let i = 0; i < 3; i++) {
    f.put(`outside-${i}.js`, "// unrelated " + i);
    commit(f, `outside-${i}.js`);
  }
  assert.ok(call(f, "Lead", "diagnoseTask").historyAdvance);
  assert.equal(call(f, "Dev", "check", { checkId: "full" }).jobId, ids[2]);
  const delivered = report(f);
  review(f, delivered.candidate);
  assert.equal(task(f).state, "ready");
  assert.deepEqual(f.store.read().checkJobs.map(job => job.id), ids);
});
test("admitted queued ticket prunes four committed foreign entries and retains its live write set", async t => {
  const f = await fixture(t, "AssertionError", { untrackedFiles: 4 });
  const original = task(f).baseline;
  assert.equal(original.other.length, 4);
  f.put(impl, "module.exports = 'in flight';");
  let head;
  for (let i = 0; i < 4; i++) head = commit(f, `outside-${i}.txt`);
  f.store.change(s => {
    s.tasks[0].state = "queued";
    s.tasks[0].preflightFailure = { version: 0, checkedAt: Date.now(), reason: "stale Git preflight" };
  });
  const diagnosis = call(f, "Lead", "diagnoseTask");
  assert.equal(diagnosis.recovery.executable, true, JSON.stringify(diagnosis.recovery));
  const short = call(f, "Lead", "reviseSchedule", { refreshBaseline: true, expectedHead: head.slice(0, 7), reason: "对账" });
  assert.equal(short.rebind.to, head);
  assert.deepEqual(task(f).baseline.other, []);
  assert.equal(task(f).baseline.sources, original.sources);
  const event = f.store.db.prepare("SELECT data FROM events WHERE kind='baseline-other-pruned'").get();
  assert.equal(JSON.parse(event.data).removed.length, 4);
});
test("a committed foreign path with new local edits is not silently pruned", async t => {
  const f = await fixture(t, "AssertionError", { untrackedFiles: 1 });
  commit(f, "outside-0.txt");
  f.put("outside-0.txt", "new dirty content");
  assert.throws(() => call(f, "Dev", "check", { checkId: "red" }), /未归属的改动.*outside-0/);
});
test("staging the ticket input remains a contract violation", async t => {
  const f = await fixture(t);
  f.put(impl, "module.exports = 'staged';");
  f.git("add", "--", impl);
  assert.throws(() => call(f, "Dev", "check", { checkId: "red" }), /暂存区.*implementation/);
  const staged = gitState(f.root, task(f)).index;
  f.store.change(s => { s.tasks[0].baseline.index = staged; });
  assert.throws(() => call(f, "Dev", "check", { checkId: "red" }), /暂存区.*implementation/);
});
test("invalid expectedHead prefix includes the full compared commit", async t => {
  const f = await fixture(t);
  call(f, "Dev", "yieldForSchedule", { reason: "停写" });
  const head = task(f).baseline.head;
  assert.throws(() => call(f, "Lead", "reviseSchedule", { refreshBaseline: true, expectedHead: "fffffff", reason: "对账" }),
    error => error.message.includes("fffffff") && error.message.includes(head));
});
test("review blocking question only blocks that review, and the author can answer", async t => {
  const f = await passing(t);
  // This is a retained question from an earlier ownership round.
  f.store.change(s => {
    s.tasks[0].questions.push({ id: "review-question", from: f.roles[2].id,
      scope: "reviewer", blocking: true, text: "待核对", answer: null });
  });
  const delivery = report(f);
  assert.throws(() => review(f, delivery.candidate), /待核对/);
  call(f, "Review", "answer", { questionId: "review-question", text: "已核实" });
  review(f, delivery.candidate);
  assert.equal(task(f).state, "ready");
});
test("ordinary questions are informational and developer blockers resume paused work on answer", async t => {
  const f = await fixture(t);
  const ordinary = call(f, "Dev", "question", { text: "顺手核对" });
  assert.equal(ordinary.blocking, false);
  const blocker = call(f, "Dev", "question", { blocking: true, text: "需要确认" });
  call(f, "Dev", "yieldForSchedule", { reason: "等答复" });
  const response = call(f, "Lead", "answer", { questionId: blocker.questionId, text: "可以继续" });
  assert.equal(response.recovery.recoveredBy, "resume");
  assert.equal(task(f).resumePending, true);
});
test("resuming review redelivers a fresh review notice while retaining the same candidate", async t => {
  const f = await passing(t);
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  const delivery = report(f);
  const reviewed = task(f);
  assert.equal(reviewed.state, "reviewing");
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  call(f, "Lead", "resumeTask", { reason: "核对独立审查投递" });
  assert.equal(task(f).candidate, delivery.candidate);
  assert.equal(task(f).state, "reviewing");
  const notices = f.store.read().notices.filter(n => n.key.startsWith("review:" + f.taskId + ":"));
  assert.equal(notices.length, 2);
  assert.ok(notices[0].readAt);
});
test("rework preserves the revision and check receipts while pausing an unchanged delivery", async t => {
  const f = await passing(t);
  const delivery = report(f);
  const revision = task(f).revision;
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  call(f, "Lead", "rework", { reason: "停写待调度", adjustScope: true });
  assert.equal(task(f).state, "paused");
  assert.equal(task(f).revision, revision);
  assert.equal(task(f).candidate, delivery.candidate);
  assert.equal(f.wf.assertDeliveryProof(f.store.read(), task(f)).length, 3);
});
test("controller acceptance needs explicit evidence and records who accepted the tested candidate", async t => {
  const f = await passing(t);
  const delivery = report(f);
  review(f, delivery.candidate);
  call(f, "Lead", "summarize", { instructions: "运行独立演练", decision: {
    candidate: delivery.candidate, acceptance: [{ id: "AC1", evidence: "隔离用例复核", checkIds: ["full"] }], limits: "隔离项目", riskNote: "核对独立审查与隔离验证" } });
  assert.throws(() => call(f, "Dev", "accept", { evidence: "无权限" }), /仅用户工作台或本项目主控/);
  assert.equal(call(f, "Lead", "accept", { evidence: " " }).error, "missing-argument");
  const accepted = call(f, "Lead", "accept", { evidence: "用户已试用演练候选并确认" });
  assert.equal(accepted.state, "accepted");
  assert.equal(task(f).acceptance.acceptedBy, f.roles[0].id);
  assert.equal(task(f).acceptance.candidate, delivery.candidate);
});
test("messages can reply to participant notices but cannot target a system notice", async t => {
  const f = await fixture(t);
  const question = call(f, "Dev", "question", { text: "需确认" });
  const channel = f.call("Lead", "messages");
  const source = channel.find(n => n.key === "question:" + question.questionId);
  assert.equal(source.kind, "notice");
  const reply = f.call("Lead", "message", { replyTo: source.id, text: "已看到" });
  assert.equal(f.call("Dev", "messages", { messageId: reply.messageId }).replyToKind, "notice");
  const system = channel.find(n => !n.canReply);
  if (system) assert.throws(() => f.call("Lead", "message", { replyTo: system.id, text: "无发件人" }), /发件角色/);
});
test("three lost wakes wait for a bridge tool check, and trial state noise stays unread without a wake", async t => {
  const f = await fixture(t);
  const role = f.roles[1];
  const clock = Date.now() + 1;
  f.store.change(s => {
    const notice = f.wf.notice(s, role.id, "dispatch:test", "测试待办", f.taskId);
    const wake = { id: "lost", roleId: role.id, sessionId: role.name, state: "enqueued", noticeIds: [notice.id], at: clock - WAKE_LOST_MS,
      handedOffAt: clock - WAKE_LOST_MS };
    s.wakes.push(wake);
    s.roles.find(r => r.id === role.id).consecutiveWakeLosses = 2;
  });
  const peers = f.roles.map(r => ({ id: r.name, state: "idle", pending: 0, jobs: 0, toolHealthSupported: true }));
  const next = f.wf.heartbeat(peers, clock);
  assert.equal(next.toolHealthChecks[0].sessionId, role.name);
  assert.ok(!next.deliveries.some(wake => wake.roleId === role.id));
  const acknowledged = f.wf.heartbeat(peers.map(r => r.id === role.name
    ? { ...r, toolHealthCheck: { id: next.toolHealthChecks[0].id, ok: true } } : r), clock + 1);
  assert.equal(acknowledged.toolHealthChecks.length, 0);
  f.store.change(s => { s.tasks[0].state = "trial"; });
  const s = f.store.read();
  const unread = s.notices.filter(n => n.roleId === role.id && n.key === "dispatch:test");
  assert.equal(selectWakeNotices(s, role, unread).actionable, false);
  assert.equal(selectWakeNotices(s, role, unread).suppressedNotices[0].reason, "no-member-responsibility");
});


test("unblock preflights the original command without changing state when a member is running", async t => {
  const f = await fixture(t);
  f.store.change(s => {
    s.tasks[0].deliveryIssue = { reason: "member-silent", detail: "原票需要恢复" };
    s.roles.find(role => role.name === "Dev").state = "running";
  });
  const before = task(f).scheduleVersion ?? 0;
  const diagnosis = call(f, "Lead", "diagnoseTask");
  assert.equal(diagnosis.recovery.executable, false);
  assert.match(diagnosis.recovery.remainingBlockers[0], /进行中的回合/);
  const blocked = call(f, "Lead", "unblock", { reason: "检查原回合" });
  assert.equal(blocked.state, "blocked");
  assert.equal(task(f).scheduleVersion ?? 0, before);
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  const resumed = call(f, "Lead", "unblock", { reason: "原回合已结束" });
  assert.equal(resumed.state, "applied");
  assert.equal(resumed.chosen.command, "resumeTask");
  assert.equal(task(f).scheduleVersion, before + 1);
});

test("planning append records its digest without replacing the frozen plan", async t => {
  const f = await fixture(t);
  const original = versionedSpec();
  f.put("spec.md", original + "\n用户确认的后续工作。\n");
  const receipt = call(f, "Lead", "recordSourceAppend", { file: "spec.md", summary: "新增记录" });
  assert.match(receipt.toDigest, /^[a-f0-9]{64}$/);
  const frozen = f.call("Lead", "inspectPlan", { planId: task(f).planId, document: "spec" });
  assert.equal(frozen.text, original);
  f.put("spec.md", "replace frozen content");
  assert.throws(() => call(f, "Lead", "recordSourceAppend", { file: "spec.md", summary: "改写" }), /保留冻结原文/);
});


for (const legacy of [true, false]) {
  test(`confirmCommit accepts an admitted dirty test (${legacy ? "legacy without cleanWrites" : "partial cleanWrites"})`, async t => {
    const f = await passing(t, { ownedDirty: { "e2e/new-case.cjs": testCode } });
    f.store.change(s => {
      const baseline = s.tasks[0].baseline;
      if (legacy) {
        delete baseline.cleanWrites;
        delete baseline.admissionWrites;
        delete baseline.admissionOwnedDirty;
      } else baseline.cleanWrites = [impl];
    });
    const delivery = report(f);
    const base = task(f).baseline.head;
    commit(f, f.testFile);
    const head = commit(f, impl);
    const result = call(f, "Lead", "confirmCommit", { expectedBase: base, expectedHead: head,
      paths: [impl, f.testFile], reason: "确认等价的承接交付" });
    assert.equal(result.state, "applied");
    assert.equal(task(f).candidate, delivery.candidate);
    assert.equal(result.preservedChecks.length, 3);
  });
}

async function trialFixture(t) {
  const f = await passing(t);
  const delivery = report(f);
  review(f, delivery.candidate);
  call(f, "Lead", "summarize", { instructions: "试用用例", decision: {
    candidate: delivery.candidate, acceptance: [{ id: "AC1", evidence: "复核", checkIds: ["full"] }], limits: "隔离环境", riskNote: "核对独立审查与隔离证据" } });
  return f;
}

test("trial acceptance follows the delivered candidate across an equivalent protected commit", async t => {
  const f = await trialFixture(t);
  const before = task(f).candidate;
  const head = commit(f, impl);
  const result = call(f, "Lead", "accept", { evidence: "用户试用确认" });
  assert.equal(result.state, "accepted");
  assert.equal(task(f).acceptance.candidate, before);
  assert.equal(task(f).baseline.head, head);
});

test("trial acceptance still rejects later commits with changed content", async t => {
  const f = await trialFixture(t);
  f.put(impl, "module.exports = 'drift';");
  commit(f, impl);
  assert.throws(() => call(f, "Lead", "accept", { evidence: "旧候选的试用" }), /内容已变/);
  assert.equal(task(f).state, "trial");
});

test("a dirty checkout matching the candidate cannot hide an incompatible recorded commit or an unrelated edit", async t => {
  const f = await trialFixture(t);
  f.put(impl, "module.exports = 'drift';");
  commit(f, impl);
  f.put(impl, "module.exports = 'new';");
  assert.throws(() => call(f, "Lead", "accept", { evidence: "旧候选的试用" }), /尚未证明.*字节等价/);
  commit(f, impl);
  f.put("outside.txt", "unowned");
  assert.throws(() => call(f, "Lead", "accept", { evidence: "已有试用" }), /未归属的改动.*outside\.txt/);
  assert.equal(task(f).state, "trial");
});

test("unchanged independent receipts survive rework while explicit developer evidence still must be refreshed", async t => {
  const f = await passing(t, { risk: "medium" });
  report(f);
  const original = await f.run("independent", false, "Lead");
  assert.equal(original.state, "passed");
  const full = f.store.read().checkJobs.find(job => job.check.id === "full");
  call(f, "Lead", "rework", { reason: "要求一份新绿回执", evidence: ["green"] });
  const s = f.store.read(), current = task(f);
  const check = id => current.verification.checks.find(item => item.id === id);
  assert.equal(f.wf.validCheck(s, current, check("full"))?.id, full.id);
  assert.equal(f.wf.validCheck(s, current, check("independent"))?.id, original.id);
  assert.equal(f.wf.validCheck(s, current, check("green")), undefined);
  assert.equal((await f.run("green")).state, "passed");
  const delivered = report(f);
  assert.equal(delivered.independentRequired, false);
  assert.equal(task(f).state, "ready");
  assert.equal(f.store.read().checkJobs.filter(job => job.check.id === "independent").length, 1);
});

test("wake recovery uses 120/240/480 second deadlines, then rearms once on a fresh idle heartbeat", async t => {
  const f = await fixture(t);
  const role = f.roles[1];
  const clock = Date.now();
  let noticeId;
  f.store.change(s => {
    for (const notice of s.notices) notice.readAt ??= clock;
    const notice = f.wf.notice(s, role.id, "dispatch:backoff", "待办", f.taskId);
    noticeId = notice.id;
    s.wakes.push({ id: "backoff", roleId: role.id, sessionId: role.name, state: "enqueued", noticeIds: [noticeId],
      at: clock, handedOffAt: clock, deliveryRetry: 0 });
  });
  const sessions = f.roles.map(r => ({ id: r.name, state: "idle", pending: 0, jobs: 0 }));
  const wake = () => f.store.read().wakes.find(row => row.id === "backoff");
  let handedOffAt = clock;
  for (let i = 0; i < 3; i++) {
    const due = handedOffAt + WAKE_LOST_MS * 2 ** i;
    f.wf.heartbeat(sessions, due - 1);
    assert.equal(wake().state, "enqueued");
    const result = f.wf.heartbeat(sessions, due);
    if (i < 2) {
      assert.equal(wake().state, "pending");
      f.store.change(s => Object.assign(s.wakes.find(row => row.id === "backoff"), { state: "enqueued", handedOffAt: due }));
      handedOffAt = due;
    } else {
      assert.equal(wake().state, "failed");
      assert.ok(!result.deliveries.some(item => item.noticeIds.includes(noticeId)));
    }
  }
  assert.equal(f.store.db.prepare("SELECT count(*) AS total FROM events WHERE kind='wake.abandoned'").get().total, 1);
  assert.equal(f.wf.acknowledge("backoff", role.name, "dsh", { generation: wake().deliveryRetry }).state, "obsolete");
  const newNotice = f.store.change(s => f.wf.notice(s, role.id, "dispatch:new-responsibility", "新事项", f.taskId));
  const fresh = f.wf.heartbeat(sessions, handedOffAt + 5 * WAKE_LOST_MS);
  const delivery = fresh.deliveries.find(item => item.roleId === role.id);
  assert.equal(delivery.id, "backoff");
  assert.deepEqual(new Set(delivery.noticeIds), new Set([noticeId, newNotice.id]));
  assert.equal(f.store.db.prepare("SELECT count(*) AS total FROM events WHERE kind='wake.rearmed'").get().total, 1);
  assert.equal(f.call("Dev", "inbox").notices.find(notice => notice.id === noticeId)?.id, noticeId);
  assert.equal(wake().state, "consumed");
});
