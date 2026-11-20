import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { fileSha256 } from "../src/files.mjs";

test("finished E2E-style receipt survives the next build while an in-run artifact edit rejects evidence", async t => {
  const testFile = "e2e/new-case.cjs", inputs = [testFile, "implementation.cjs"];
  const check = stage => ({ id: stage, stage, argv: ["node", testFile], inputs, covers: ["AC1"],
    ...(stage === "red" && { expectedOutput: "AssertionError" }) });
  const full = { ...check("full"), requiredArtifacts: ["dist"],
    preSteps: [{ argv: ["node", "-e", "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/app.txt','fixture')"], outputs: ["dist"] }] };
  const laterBuild = { ...full, id: "later-build", stage: "regression", covers: [],
    preSteps: [{ argv: ["node", "-e", "require('fs').writeFileSync('dist/app.txt','different build')"], outputs: ["dist"] }] };
  const f = await fixture(t, "AssertionError", { checks: [check("red"), check("green"), full, laterBuild] });
  const assertion = "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');";
  f.put(testFile, assertion);
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports = 'new';");
  assert.equal((await f.run("green")).state, "passed");
  const receipt = await f.run("full");
  assert.equal(receipt.state, "passed", receipt.error);
  assert.equal(receipt.receipt.preparation.artifactsVerified, true);
  assert.equal((await f.run("later-build")).state, "passed");
  const state = f.store.read(), task = state.tasks[0];
  const recipe = task.verification.checks.find(check => check.id === "full");
  assert.equal(f.wf.validCheck(state, task, recipe).id, receipt.id);
  state.checkJobs.find(job => job.id === receipt.id).receipt.preparation.artifactsVerified = undefined;
  assert.equal(f.wf.validCheck(state, task, recipe), undefined);
  f.put("dist/app.txt", "manual tampering");
  assert.equal(f.wf.validCheck(f.store.read(), task, recipe), undefined);
  f.put(testFile, assertion + "require('fs').writeFileSync('dist/app.txt','changed during test');");
  f.put("implementation.cjs", "module.exports = 'old';");
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports = 'new';");
  assert.equal((await f.run("green")).state, "passed");
  assert.equal((await f.run("full")).state, "stale");
});

test("foreign ownership confirmation stores only the reviewed bytes and refuses later drift", async t => {
  const f = await fixture(t);
  const file = "peer.cjs";
  f.put(file, "peer changed it");
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "stop for ownership" });
  f.store.change(s => {
    s.tasks[0].baseline.other = [[file, "older baseline"]];
    s.tasks.push({ ...s.tasks[0], id: "peer", ticketKey: "PEER", state: "queued", writes: [file], ownedDirty: [file] });
  });
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosis.outsideOwnership.candidates[0].taskId, "peer");
  const confirm = sha256 => f.call("Lead", "reviseSchedule", { taskId: f.taskId, reason: "confirm the peer owns the reviewed bytes",
    expectedHead: f.store.read().tasks[0].baseline.head, confirmForeignDirty: { [file]: { taskId: "peer", sha256 } } });
  assert.throws(() => confirm("old sha"), /文件已变化/);
  assert.equal(confirm(fileSha256(f.root, file)).state, "stored");
  assert.doesNotMatch(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).reason, /发现未归属/);
  f.put(file, "new content requires another review");
  assert.match(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).reason, /发现未归属/);
});

test("a job releases its explicitly declared resource after the previous job finishes", async t => {
  const input = ["e2e/new-case.cjs", "implementation.cjs"];
  const f = await fixture(t, "AssertionError", {
    checks: ["red", "green", "full"].map(stage => ({ id: stage, stage, argv: ["node", input[0]], inputs: input,
      covers: ["AC1"], resources: ["port:4174"], ...(stage === "red" && { expectedOutput: "AssertionError" }) })),
  });
  f.put(f.testFile, "require('node:assert/strict').equal(1, 2);");
  f.store.change(s => s.checkJobs.push({ id: "held", state: "launching", startedAt: Date.now(), taskId: "peer", root: f.root,
    check: { id: "held", timeoutMs: 60000, resources: ["port:4174"] } }));
  const job = f.call("Dev", "check", { taskId: f.taskId, checkId: "red", async: true });
  assert.equal(f.wf.claimCheck(job.jobId), null);
  assert.equal(f.store.read().checkJobs.find(item => item.id === job.jobId).state, "queued");
  f.store.change(s => { s.checkJobs.find(item => item.id === "held").state = "passed"; });
  assert.equal(f.wf.claimCheck(job.jobId)?.state, "launching");
});
