import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fingerprint } from "../src/files.mjs";
import { candidateFingerprint } from "../src/quality.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

const input = "external.txt";
const implementation = "implementation.cjs";
const testFile = "e2e/new-case.cjs";
const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
  .map(axis => [axis, { state: "pass", evidence: "verified", checkIds: ["full"] }]));
const report = f => f.call("Dev", "report", { taskId: f.taskId, summary: "verified", dimensions });
const task = f => f.store.read().tasks[0];
const diagnose = f => f.call("Lead", "diagnoseTask", { taskId: f.taskId });
const evidence = (f, args = {}) => f.call("Lead", "deliveryEvidence", { taskId: f.taskId, ...args });
const commit = (f, ...files) => {
  f.git("add", "--", ...files);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture delivery");
};

async function deliver(t, { external = false, legacy = false } = {}) {
  const checks = ["red", "green", "full", "independent"].map(stage => ({
    id: stage, stage, covers: ["AC1"],
    argv: stage === "independent" ? ["node", "-e", "require('node:assert/strict').equal(require('./implementation.cjs'),'new')"] : ["node", testFile],
    inputs: stage === "independent" ? [implementation] : [implementation, testFile, ...(external && stage === "full" ? [input] : [])],
    ...(stage === "red" && { expectedOutput: "AssertionError" }),
  }));
  const f = await fixture(t, "AssertionError", { risk: "medium", checks, initialFiles: { [input]: "old" } });
  if (legacy) f.store.change(s => { delete s.tasks[0].candidateScope; });
  f.put(testFile, "require('node:assert/strict').equal(require('../implementation.cjs'),'new');");
  assert.equal((await f.run("red")).state, "passed");
  f.put(implementation, "module.exports='new';");
  assert.equal((await f.run("green")).state, "passed");
  assert.equal((await f.run("full")).state, "passed");
  report(f);
  assert.equal((await f.run("independent", false, "Lead")).state, "passed");
  assert.equal(task(f).state, "ready");
  return f;
}

function summarize(f) {
  return f.call("Lead", "summarize", { taskId: f.taskId, instructions: "Try the delivered version", decision: {
    candidate: task(f).candidate, limits: "isolated fixture", acceptance: [{ id: "AC1", evidence: "verified", checkIds: ["independent"] }],
  } });
}

async function commitNextTicket(f, file, contents, assertion) {
  const requirement = f.call("Lead", "approve", { text: "A subsequent change", source: "approved" });
  const nextTest = "e2e/next-case.cjs";
  const checks = ["red", "green", "full", "independent"].map(stage => ({
    id: stage, stage, covers: ["AC1"],
    argv: stage === "independent" ? ["node", "-e", assertion] : ["node", nextTest],
    inputs: stage === "independent" ? [file] : [file, nextTest],
    ...(stage === "red" && { expectedOutput: "AssertionError" }),
  }));
  // The test and controller probe have different entry points and resolve the same project file.
  const { tasks: [{ taskId }] } = f.call("Lead", "dispatchPlan", {
    requirementId: requirement.id, sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "NEXT", developerId: f.roles.find(role => role.kind === "developer").id,
      title: "Later change", description: "Verify the later change", risk: "medium", writes: [file, nextTest], reads: [],
      verification: { testWrites: [nextTest], checks, acceptance: [{ id: "AC1", text: "Later behavior" }] } }],
  });
  f.put(nextTest, assertion);
  assert.equal((await f.run("red", false, "Dev", taskId)).state, "passed");
  f.put(file, contents);
  for (const check of ["green", "full"]) assert.equal((await f.run(check, false, "Dev", taskId)).state, "passed");
  f.call("Dev", "report", { taskId, summary: "later delivery", dimensions });
  assert.equal((await f.run("independent", false, "Lead", taskId)).state, "passed");
  commit(f, file, nextTest);
}

test("a committed external check input invalidates its receipt without changing the delivered candidate", async t => {
  const f = await deliver(t, { external: true });
  const delivered = task(f);
  commit(f, implementation, testFile);
  await commitNextTicket(f, input, "new", "require('node:assert/strict').equal(require('node:fs').readFileSync('external.txt','utf8'),'new');");
  assert.equal(candidateFingerprint(f.root, delivered), delivered.candidate);
  const result = diagnose(f);
  assert.equal(result.classification, "evidence-missing");
  assert.equal(result.checkId, "full");
  assert.equal(result.contentDrift, false);
  assert.equal(evidence(f).checks.find(check => check.id === "full").reusable, false);
  assert.throws(() => summarize(f), /证据.*full/);
});

test("a historical delivery can be accepted after subsequent commits replace its writes", async t => {
  const f = await deliver(t);
  const delivered = task(f);
  commit(f, implementation, testFile);
  await commitNextTicket(f, implementation, "module.exports='later';",
    "require('node:assert/strict').equal(require(require('node:path').resolve('implementation.cjs')),'later');");
  const result = diagnose(f);
  assert.equal(result.classification, "ready");
  assert.equal(result.contentDrift, false);
  const index = evidence(f, { file: implementation });
  assert.equal(index.deliveryCommit, result.historicalCommit);
  assert.equal(index.checks.find(check => check.id === "full").reusable, false);
  assert.ok(index.checks.find(check => check.id === "full").historicalEvidence);
  assert.match(index.change.content, /module.exports='new'/);
  assert.doesNotMatch(index.change.content, /module.exports='later'/);
  const full = f.store.read().checkJobs.find(job => job.check.id === "full");
  const log = readFileSync(full.output);
  writeFileSync(full.output, "changed evidence");
  assert.throws(() => summarize(f), /证据.*full/);
  writeFileSync(full.output, log);
  const summary = summarize(f);
  assert.equal(summary.state, "awaiting_user");
  assert.equal(summary.deliveryCommit, result.historicalCommit);
  assert.equal(diagnose(f).classification, "awaiting-user");
  f.put(implementation, "module.exports='uncommitted';");
  assert.equal(diagnose(f).contentDrift, true);
  assert.throws(() => f.call("ui", "accept", { taskId: f.taskId, evidence: "tested" }), /候选/);
  f.put(implementation, "module.exports='later';");
  f.call("ui", "accept", { taskId: f.taskId, evidence: "tested original delivery" });
  assert.equal(task(f).acceptance.candidate, delivered.candidate);
  assert.equal(task(f).acceptance.deliveryCommit, result.historicalCommit);
});

test("a replaced delivery with no matching commit cannot be accepted from its manifest alone", async t => {
  const f = await deliver(t);
  f.put(implementation, "module.exports='different';");
  commit(f, implementation, testFile);
  assert.equal(diagnose(f).contentDrift, true);
  assert.throws(() => summarize(f), /候选/);
});

test("a legacy delivery keeps the exact wide fingerprint and never backfills a snapshot", async t => {
  const f = await deliver(t, { external: true, legacy: true });
  const delivered = task(f);
  assert.equal(delivered.deliveredManifest, undefined);
  assert.equal(delivered.candidate, fingerprint(f.root, [...delivered.writes, input], [], undefined, { rawPaths: [testFile] }));
  f.put(input, "changed");
  assert.notEqual(candidateFingerprint(f.root, delivered), delivered.candidate);
});
