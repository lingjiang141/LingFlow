import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { redEvidence, redFailure, redReceiptValid } from "../src/red-evidence.mjs";
import { fingerprint } from "../src/files.mjs";

const assertion = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";

test("new test written after dispatch supports real red then green and full", async t => {
  const f = await fixture(t);
  f.put(f.testFile, assertion);
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  assert.equal(red.receipt.failureOutputSeen, true);
  assert.deepEqual(red.receipt.redProofScope, ["implementation.cjs"]);
  assert.deepEqual(red.receipt.excludedTestWrites, [f.testFile]);
  f.put("implementation.cjs", "module.exports = 'new';");
  assert.equal((await f.run("green")).state, "passed");
  assert.equal((await f.run("full")).state, "passed");
});

test("changed tests cannot reuse old red and changed implementation cannot manufacture baseline red", async t => {
  const f = await fixture(t);
  f.put("implementation.cjs", "module.exports = 'broken';");
  f.put(f.testFile, assertion);
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "red" }), /实现文件未变化/);
  f.put("implementation.cjs", "module.exports = 'old';");
  const red = await f.run("red", true);
  assert.equal(red.receipt.failureOutputSeen, true);
  const task = f.store.read().tasks.find(t => t.id === f.taskId);
  const check = task.verification.checks.find(c => c.id === "red");
  const proof = redEvidence(f.root, task, check);
  f.put(f.testFile, "// empty replacement");
  const changed = redEvidence(f.root, task, check);
  assert.equal(changed.redProof, proof.redProof, "implementation proof excludes testWrites");
  assert.notEqual(changed.redTestProof, proof.redTestProof, "pairing still protects the assertions");
  f.put("implementation.cjs", "module.exports = 'new';");
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "green" }), /预期失败/);
});

test("red assertion detection rejects setup failures and false receipts", () => {
  const check = { expectedOutput: "Expected:" };
  const output = "Error: expect(locator).toBeVisible()\nExpected: visible\nReceived: hidden\n1 failed, 0 passed";
  assert.equal(redFailure(check, output), true);
  assert.equal(redFailure({ expectedOutput: "assertion: missing" }, "assertion: missing"), false);
  assert.equal(redFailure({ expectedOutput: "Expected:" }, "Error: Timed out 5000ms waiting for expect(locator).toBeVisible()\nExpected: visible\nReceived: hidden\nCall log:\n - waiting for locator\n  at e2e/page.spec.ts:12:4"), true);
  for (const text of ["No tests found", "SyntaxError: unexpected token", "Error: Cannot find module", "browserType.launch: executable missing"])
    assert.equal(redFailure({ expectedOutput: text }, text + "\n at expect (runner:1:1)"), false);
  assert.equal(redReceiptValid(check, { failureOutputSeen: false, exitCode: 1 }, output), false);
  assert.equal(redReceiptValid(check, { failureOutputSeen: true, exitCode: 0 }, output), false);
  assert.equal(redReceiptValid(check, { failureOutputSeen: true, exitCode: 1, truncated: true }, output), false);
});

test("unchanged existing tests preserve the legacy red fingerprint byte for byte", async t => {
  const f = await fixture(t, "AssertionError", { existingTest: assertion });
  const legacy = fingerprint(f.root, [f.testFile]);
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  assert.equal(red.redProof, legacy);
  // Simulate the persisted job shape from before versioned red evidence.
  f.store.change(state => { delete state.checkJobs.find(job => job.id === red.id).redProofVersion; });
  f.put("implementation.cjs", "module.exports = 'new';");
  assert.equal((await f.run("green")).state, "passed");
  assert.equal((await f.run("full")).state, "passed");
});

test("broken admitted implementation produces genuine assertion failure and empty replacement is rejected", async t => {
  const f = await fixture(t, "AssertionError", { implementation: "module.exports = 'broken';" });
  f.put(f.testFile, assertion);
  const red = await f.run("red");
  assert.equal(red.state, "passed");
  assert.equal(red.receipt.failureOutputSeen, true);
  f.put(f.testFile, "// zero assertions, exits successfully");
  const empty = await f.run("red");
  assert.equal(empty.state, "failed");
  assert.equal(empty.receipt.failureOutputSeen, false);
});

test("No tests found cannot qualify as red even when frozen as expected output", async t => {
  const f = await fixture(t, "No tests found");
  f.put(f.testFile, "console.error('No tests found'); process.exitCode = 1;");
  const red = await f.run("red", true);
  assert.equal(red.receipt.failureOutputSeen, false);
  assert.equal(red.state, "failed");
  assert.throws(() => f.call("Dev", "check", { taskId: f.taskId, checkId: "green" }), /预期失败/);
});
