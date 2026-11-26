import assert from "node:assert/strict";
import test from "node:test";
import { gitState, scopeBaseline } from "../src/quality.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

const task = f => f.store.read().tasks.find(item => item.id === f.taskId);
const revise = (f, fields) => f.call("Lead", "reviseSchedule", { taskId: f.taskId, reason: "按当前快照核对", ...fields });
const diagnose = f => f.call("Lead", "diagnoseTask", { taskId: f.taskId });
const set = (f, fields) => f.store.change(s => Object.assign(s.tasks.find(item => item.id === f.taskId), fields));

test("an unclaimed dirty implementation gives the controller an exact admission action", async t => {
  const f = await fixture(t);
  f.put("implementation.cjs", "module.exports = 'inherited';");
  const root = task(f);
  assert.throws(() => scopeBaseline(f.root, root, []), error =>
    error.verificationCode === "contract-invalid" && error.unownedWrites?.join() === "implementation.cjs");
  set(f, { state: "queued", assignee: null, baseline: null });
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  const finding = diagnose(f);
  assert.equal(finding.nextAction?.command, "reviseSchedule");
  assert.deepEqual(finding.nextAction.args.ownedDirty, ["implementation.cjs"]);
  assert.deepEqual(finding.actionRequired.requiredParameters, ["reason"]);
  revise(f, finding.nextAction.args);
  assert.equal(task(f).state, "assigned");
});

test("an orphan outside file can be acknowledged by exact bytes without claiming any peer's scope", async t => {
  const file = "outside.txt";
  const f = await fixture(t, "AssertionError", { initialFiles: { [file]: "baseline" } });
  f.put(file, "new draft");
  set(f, { state: "queued", assignee: null });
  let finding = diagnose(f);
  assert.equal(finding.nextAction?.command, "confirmForeignDirty");
  assert.equal(finding.nextAction.args.confirmForeignDirty[file].taskId, null);
  const unowned = finding.nextAction.args;
  f.put(file, "changed draft");
  assert.throws(() => f.call("Lead", "confirmForeignDirty", unowned), /文件已变化/);

  const peer = { ...task(f), id: "trial-peer", ticketKey: "PEER", writes: [file], state: "trial" };
  f.store.change(s => {
    s.tasks.find(item => item.id === f.taskId).baseline.other = [[file, "older bytes"]];
    s.tasks.push(peer);
  });
  finding = diagnose(f);
  assert.deepEqual(finding.outsideOwnership.candidates, [{ taskId: peer.id, ticketKey: "PEER", state: "trial" }]);
  assert.equal(finding.nextAction.args.confirmByOwnership[file].taskId, peer.id);
  const { confirmByOwnership, ...args } = finding.nextAction.args;
  const invalid = { ...args, confirmForeignDirty: { [file]: { taskId: null, sha256: finding.outsideOwnership.sha256 } } };
  assert.throws(() => f.call("Lead", "confirmForeignDirty", invalid),
    error => error.rejected?.[0]?.reason === "unknown-owner");
  f.store.change(s => { s.tasks.find(item => item.id === peer.id).state = "abandoned"; });
  finding = diagnose(f);
  const receipt = f.call("Lead", finding.nextAction.command, finding.nextAction.args);
  assert.equal(receipt.confirmed[0].attributed, "unowned");
  assert.equal(task(f).state, "assigned");
});

test("when no prior red snapshot can be projected, diagnose offers current HEAD for human verification", async t => {
  const f = await fixture(t);
  const head = gitState(f.root).head;
  set(f, { redBaselinePending: true, redBaseline: { head: "0".repeat(40), writes: ["other.cjs"], sources: "unknown" } });
  const finding = diagnose(f);
  assert.equal(finding.classification, "red-baseline-unverified");
  assert.equal(finding.nextAction?.command, "reviseSchedule");
  assert.equal(finding.nextAction.args.redBaselineHead, head);
  assert.deepEqual(finding.actionRequired.requiredParameters, ["reason"]);
  const recovery = revise(f, finding.nextAction.args);
  assert.deepEqual(recovery.rerunRed, ["red"]);
  set(f, { state: "accepted" });
  assert.throws(() => revise(f, finding.nextAction.args), error =>
    error.blockers?.some(blocker => blocker.code === "red-baseline-state"));
});
