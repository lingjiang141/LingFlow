import assert from "node:assert/strict";
import test from "node:test";
import { fixture, reviewedRisk } from "./helpers/evidence-fixture.mjs";
import { gitState } from "../src/quality.mjs";

const localTest = "e2e/new-case.cjs";
const peerTest = "peer.test.cjs";
const source = "implementation.cjs";
const reason = "已逐项核对收口提交与原票写集";
const assertion = "if (process.argv.includes('--with-peer')) require('../peer.test.cjs');\n" +
  "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";
const checks = withPeerInput => ["red", "green", "full"].map(stage => ({
  id: stage, stage, argv: ["node", localTest, ...(stage === "full" && withPeerInput ? ["--with-peer"] : [])],
  inputs: [source, localTest, ...(stage === "full" && withPeerInput ? [peerTest] : [])],
  covers: ["AC1"], ...(stage === "red" && { expectedOutput: "AssertionError" }),
}));

async function setup(t, {
  withPeerInput = true, explicitRead = false, changeOwn = true, peerChanges = true, delivered = false, inputOnly = false,
} = {}) {
  const f = await fixture(t, "AssertionError", {
    checks: checks(withPeerInput), initialFiles: { [peerTest]: "module.exports = 'old peer';" },
    ...(inputOnly && { existingTest: assertion }),
  });
  const task = () => f.store.read().tasks.find(item => item.id === f.taskId);
  const command = (who, name, args = {}) => f.call(who, name, { taskId: f.taskId, ...args });
  const heartbeat = () => f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  const diagnose = () => command("Lead", "diagnoseTask");
  const before = task();
  const child = f.call("Lead", "dispatchPlan", {
    requirementId: before.requirementId, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "PEER", developerId: before.developerId, title: "Peer test", description: "Peer-owned test fixture",
      risk: "high", riskReason: "independent proof", writes: [peerTest], reads: [], verification: {
        acceptance: [{ id: "AC1", text: "peer behavior" }], testWrites: [peerTest],
        checks: checks(false).map(check => ({ ...check, argv: ["node", peerTest], inputs: [peerTest] })),
      } }],
  });
  const peerId = child.tasks[0].taskId;
  f.store.change(s => {
    // Starting from the recorded end state of the companion ticket isolates the original ticket's rebind.
    Object.assign(s.tasks.find(item => item.id === peerId), { state: "trial", assignee: null });
    if (explicitRead) s.tasks.find(item => item.id === f.taskId).reads.push(peerTest);
  });
  f.put(localTest, assertion);
  assert.equal((await f.run("red")).state, "passed");
  if (!delivered) command("Dev", "yieldForSchedule", { reason: "停写以核对收口提交" });
  if (changeOwn) f.put(source, "module.exports = 'new';");
  let oldGreen, oldFull;
  if (delivered) {
    oldGreen = await f.run("green");
    oldFull = await f.run("full");
    assert.equal(oldGreen.state, "passed", oldGreen.error);
    assert.equal(oldFull.state, "passed", oldFull.error);
    const dimensions = Object.fromEntries(["requirements", "implementation", "system"].map(key =>
      [key, { state: "pass", evidence: "核对真实断言和检查输入", checkIds: ["full"] }]));
    const report = command("Dev", "report", { summary: "完成原票", dimensions });
    heartbeat();
    f.call("Review", "inbox");
    command("Review", "review", { candidate: report.candidate, verdict: "pass", findings: "核对独立证据",
      dimensions, riskAssessment: reviewedRisk });
    command("Lead", "summarize", { instructions: "按原票试用", decision: {
      candidate: report.candidate, limits: "无", riskNote: "核对审查回执",
      acceptance: [{ id: "AC1", evidence: "核对原票验收条件", checkIds: ["full"] }],
    } });
    assert.equal(task().state, "trial");
  }
  if (peerChanges) f.put(peerTest, "module.exports = 'new peer';");
  f.git("add", "--", localTest, source, peerTest);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "close out both tickets");
  const head = gitState(f.root).head;
  const paths = inputOnly ? [] : changeOwn ? [localTest, source] : [localTest];
  const rebind = () => command("Lead", "rebindCommittedWork", {
    expectedBase: before.baseline.head, expectedHead: head, confirmPaths: paths, reason,
  });
  return { ...f, task, command, heartbeat, diagnose, before, head, rebind, peerId, paths, oldGreen, oldFull };
}

test("a peer-owned check input can rebind with the original ticket and fresh green/full receipts", async t => {
  const f = await setup(t, { delivered: true });
  assert.throws(() => f.command("Lead", "confirmCommit", {
    expectedBase: f.before.baseline.head, expectedHead: f.head, paths: f.paths, reason,
  }), /交付证据缺失、失效或已变化：full|检查输入已随提交变化/);
  const recovery = f.diagnose().nextAction;
  assert.equal(recovery?.command, "rework");
  f.call("Lead", recovery.command, recovery.args);
  assert.equal(f.task().candidate, null);
  const diagnostic = f.diagnose();
  assert.equal(diagnostic.nextAction?.command, "rebindCommittedWork", diagnostic.reason);
  assert.deepEqual(diagnostic.nextAction.args.confirmPaths, f.paths);
  const result = f.call("Lead", diagnostic.nextAction.command, diagnostic.nextAction.args);
  assert.equal(result.state, "applied");
  assert.deepEqual(result.rebind.checkInputDrift, [{ path: peerTest, checkIds: ["full"],
    owners: [{ taskId: f.peerId, ticketKey: "PEER" }] }]);
  assert.equal(f.task().baseline.head, f.head);
  assert.deepEqual(f.task().verification, f.before.verification);
  assert.deepEqual(result.rebind.rerunRed ?? [], []);
  f.heartbeat();
  assert.equal(f.task().state, "rework", f.task().waitReason);
  const green = await f.run("green");
  assert.equal(green.state, "passed");
  assert.notEqual(green.id, f.oldGreen.id);
  const full = await f.run("full");
  assert.equal(full.state, "passed");
  assert.notEqual(full.id, f.oldFull.id);
});

test("authorized check revision is recorded while drift awaits explicit rebind", async t => {
  const f = await setup(t);
  const replace = () => f.command("Dev", "registerChecks", { checks: checks(false), replace: true, reason });
  assert.throws(replace, /主控明确授权/);
  f.command("Lead", "reviseSchedule", { allowCheckRevision: true, reason });
  const revised = replace();
  assert.equal(revised.state, "stored");
  assert.equal(f.task().state, "paused");
  assert.equal(f.task().baseline.head, f.before.baseline.head);
  assert.equal(revised.nextAction.command, "rebindCommittedWork");
  const rebound = f.call("Lead", revised.nextAction.command, revised.nextAction.args);
  assert.equal(rebound.state, "applied");
  assert.equal(f.task().baseline.head, f.head);
  assert.ok(!f.task().verification.checks.find(check => check.id === "full").inputs.includes(peerTest));
});

test("an explicit read still blocks rebind and identifies its check and peer owner", async t => {
  const f = await setup(t, { explicitRead: true });
  assert.throws(f.rebind, /只读输入.*peer\.test\.cjs.*full.*PEER/);
  assert.equal(f.diagnose().nextAction, null);
  f.command("Lead", "reviseSchedule", { allowCheckRevision: true, reason });
  assert.throws(() => f.command("Dev", "registerChecks", { checks: checks(false), replace: true, reason }), /只读输入/);
  assert.equal(f.task().baseline.head, f.before.baseline.head);
});

test("committed inputs in the original ticket's own write set remain rebindable", async t => {
  const f = await setup(t, { withPeerInput: false, changeOwn: false, peerChanges: false });
  const rebound = f.rebind();
  assert.deepEqual(rebound.rebind.overlap, [localTest]);
  assert.equal(f.task().baseline.head, f.head);
});

test("removing the only changed check input returns an executable ordinary baseline refresh", async t => {
  const f = await setup(t, { inputOnly: true, changeOwn: false });
  const diagnosed = f.diagnose();
  assert.equal(diagnosed.nextAction?.command, "rebindCommittedWork");
  assert.deepEqual(diagnosed.nextAction.args.confirmPaths, []);
  f.put(peerTest, "module.exports = 'uncommitted version';");
  assert.throws(f.rebind, /冻结路径工作树仍有残留.*peer\.test\.cjs/);
  f.put(peerTest, "module.exports = 'new peer';");
  f.command("Lead", "reviseSchedule", { allowCheckRevision: true, reason });
  const { nextAction } = f.command("Dev", "registerChecks", { checks: checks(false), replace: true, reason });
  assert.equal(nextAction?.command, "reviseSchedule");
  assert.equal(nextAction.args.refreshBaseline, true);
  assert.equal(nextAction.args.expectedHead, f.head);
  f.call("Lead", nextAction.command, nextAction.args);
  assert.equal(f.task().baseline.head, f.head);
});
