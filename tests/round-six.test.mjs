import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { ownerStatus, recoveryHint } from "../src/owner-status.mjs";

const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
  .map(axis => [axis, { state: "pass", evidence: "实际核对", checkIds: ["full"] }]));
const taskOf = f => f.store.read().tasks[0];

test("A: state-inapplicable recovery returns concrete commands", async t => {
  const f = await fixture(t);
  const s = f.store.read();
  for (const [state, command] of [["trial", "accept"], ["ready", "summarize"], ["queued", "diagnoseTask"], ["reviewing", "diagnoseTask"]]) {
    const task = { ...s.tasks[0], state };
    if (state !== "reviewing") assert.equal(ownerStatus(s, task).blockers[0].code, "state-not-applicable");
    assert.match(recoveryHint(s, task), new RegExp(command));
    assert.doesNotMatch(recoveryHint(s, task), /：。$/);
  }
});

test("B: ready and trial reconcile the exact live ticket while the original candidate and acceptance stay frozen", async t => {
  const f = await fixture(t, "AssertionError", {risk:"medium"});
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'),'new');");
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports='new';");
  for (const check of ["green", "full"]) assert.equal((await f.run(check)).state, "passed");
  const report = f.call("Dev", "report", {taskId:f.taskId,summary:"原创交付",dimensions});
  await f.run("independent", false, "Lead");
  const frozen = taskOf(f);
  const diagnose = () => f.call("Lead", "diagnoseTask", {taskId:f.taskId});
  const review = args => f.call("Lead", "reviseSchedule", args);
  const assertReviewed = state => {
    const finding = diagnose();
    assert.equal(finding.classification, "contract-invalid");
    assert.equal(finding.nextAction.command, "reviseSchedule");
    assert.equal(finding.nextAction.args.refreshSourceDigest, true);
    const receipt = review(finding.nextAction.args);
    assert.equal(receipt.state, "applied");
    assert.equal(receipt.taskState, state);
    assert.equal(receipt.frozenContractPreserved, true);
    return finding;
  };
  f.put("tickets.md", "AC1: 用户提出不同的后续验收文本");
  assertReviewed("ready");
  f.call("Lead", "summarize", {taskId:f.taskId,instructions:"核对原要求",decision:{candidate:report.candidate,
    acceptance:[{id:"AC1",evidence:"核对派发时的条款",checkIds:["full"]}],limits:"仅覆盖派发口径"}});
  f.put("tickets.md", "AC1: 后续版本提案");
  const stale = diagnose().nextAction.args;
  f.put("tickets.md", "AC1: 后续版本提案继续修订");
  assert.throws(() => review(stale), /diagnoseTask/);
  const finding = assertReviewed("trial");
  assert.throws(() => review({...finding.nextAction.args,writes:["unexpected.txt"]}), error => {
    assert.equal(error.nextAction.command, "rework");
    assert.match(error.message, /dispatchPlan/);
    return true;
  });
  assert.throws(() => review({taskId:f.taskId,reason:"改变已验证输入",reads:["outside.txt"]}), /reads 会改变|rework/);
  assert.equal(review({taskId:f.taskId,reason:"重申同一读集",reads:frozen.reads,after:[]}).state, "applied");
  const trial = taskOf(f);
  for (const field of ["verification","sources","writes","resources","candidate","baseline"])
    assert.deepEqual(trial[field], frozen[field], field);
  f.put("tickets.md", "再次手改票面");
  assert.throws(() => f.call("ui", "accept", {taskId:f.taskId,evidence:"试用"}), /冻结票面已变化/);
  assertReviewed("trial");
  assert.equal(f.call("ui", "accept", {taskId:f.taskId,evidence:"原候选已试用"}).state, "accepted");
});

test("unsupported verification writes never change the frozen schedule version", async t => {
  const f = await fixture(t);
  f.call("Dev", "yieldForSchedule", {taskId:f.taskId,reason:"停写"});
  const before = taskOf(f);
  const receipt = f.call("Lead", "reviseSchedule", {taskId:f.taskId,reason:"申请预算",verification:{checks:[]}});
  assert.equal(receipt.error, "unsupported");
  assert.equal(receipt.nextAction.args.allowCheckRevision, true);
  assert.deepEqual(taskOf(f), before);
});
