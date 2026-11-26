import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, reviewedRisk } from "./helpers/evidence-fixture.mjs";
import { fileSha256 } from "../src/files.mjs";

const taskOf = f => f.store.read().tasks.find(task => task.id === f.taskId);
const argsFor = f => ({ taskId: f.taskId, expectedHead: taskOf(f).baseline.head, reason: "核对票外归属" });
const confirm = (f, args) => f.call("Lead", "confirmForeignDirty", { ...argsFor(f), ...args });
const sha = (f, file) => fileSha256(f.root, file);

test("strict confirmation persists the successful members of a mixed batch and supports retry", async t => {
  const f = await fixture(t, "AssertionError", { initialFiles: { "vanished.txt": "tracked" } });
  const files = ["one.txt", "two.txt", "three.txt"];
  for (const file of files) f.put(file, file);
  const claims = Object.fromEntries(files.map(file => [file, { taskId: null, sha256: sha(f, file) }]));
  claims["vanished.txt"] = { taskId: null, sha256: sha(f, "vanished.txt") };
  claims["never-dirty.txt"] = claims["one.txt"];
  unlinkSync(join(f.root, "vanished.txt"));
  f.put("three.txt", "changed");
  const result = confirm(f, { confirmForeignDirty: claims });
  assert.equal(result.state, "stored");
  assert.deepEqual(result.confirmed.map(item => item.file), files.slice(0, 2));
  assert.equal(result.rejected[0].reason, "sha-mismatch");
  assert.equal(result.rejected[0].expected, sha(f, "three.txt"));
  assert.deepEqual(result.rejected.map(item => item.reason), ["sha-mismatch", "vanished", "not-dirty"]);
  assert.deepEqual(Object.keys(taskOf(f).baseline.confirmedForeignDirty), files.slice(0, 2));
  assert.equal(confirm(f, { confirmForeignDirty: { "one.txt": claims["one.txt"] } }).confirmed.length, 1);
});

test("ownership confirmation samples live bytes and preserves frozen inputs", async t => {
  const f = await fixture(t);
  const file = "peer.txt";
  function addPeer(id) {
    f.store.change(s => s.tasks.push({ ...structuredClone(taskOf(f)), id, ticketKey: id,
      state: "assigned", writes: [file], admittedAt: undefined, verification: null, assignee: "other" }));
  }
  addPeer("PEER");
  f.put(file, "first");
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.ok(diagnosis.outsideOwnership.snapshotAt > 0);
  assert.deepEqual(diagnosis.nextAction.args.confirmByOwnership, { [file]: { taskId: "PEER" } });
  f.put(file, "edited after diagnosis");
  assert.throws(() => confirm(f, { confirmByOwnership: { [file]: { taskId: "wrong" } } }),
    error => error.rejected?.[0].reason === "unknown-owner" && error.rejected[0].candidates[0].taskId === "PEER");
  const receipt = f.call("Lead", diagnosis.nextAction.command, diagnosis.nextAction.args);
  assert.equal(receipt.confirmed[0].sha256, sha(f, file));
  const event = f.store.db.prepare("SELECT data FROM events WHERE kind='baseline-foreign-ownership-confirmed' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(event.data).mode, "ownership");
  f.put(file, "edited again");
  assert.notEqual(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).outsideOwnership?.file, file);
  f.store.change(s => { s.tasks.find(task => task.id === "PEER").state = "accepted"; });
  assert.equal(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).outsideOwnership.file, file);
  f.put("implementation.cjs", "module.exports = 'edited';");
  assert.throws(() => confirm(f, { confirmForeignDirty: { "implementation.cjs": { taskId: null, sha256: sha(f, "implementation.cjs") } } }),
    error => error.rejected?.[0].reason === "protected-input");
  const schema = f.call("Lead", "schema", { command: "confirmForeignDirty" });
  assert.ok(schema.fields.confirmByOwnership);
  assert.ok(schema.fields.byTask);
});

test("diagnosis offers each possible owner and byTask covers more than twenty outside files", async t => {
  const f = await fixture(t);
  const files = Array.from({ length: 21 }, (_, index) => `peer-${index}.txt`);
  for (const file of files) f.put(file, file);
  f.store.change(s => {
    for (const [id, writes] of [["A", files], ["B", [files[0]]]]) {
      s.tasks.push({ ...structuredClone(taskOf(f)), id, ticketKey: id,
        state: "assigned", writes, admittedAt: undefined, verification: null, assignee: id });
    }
  });
  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.deepEqual(diagnosis.actionRequired.choices.map(choice => choice.taskId), ["A", "B"]);
  assert.ok(diagnosis.actionRequired.snapshotStaleMs >= 0);
  const receipt = confirm(f, { byTask: { A: true } });
  assert.equal(receipt.confirmed.length, files.length);
  assert.ok(receipt.confirmed.every(item => item.taskId === "A" && item.mode === "ownership"));
});

test("trial ticket pauses before renewing a stale confirmation for a peer in trial", async t => {
  const f = await fixture(t);
  const file = "peer.txt";
  const peerId = "PEER";
  f.put(file, "first draft");
  f.store.change(s => {
    s.tasks.push({ ...structuredClone(taskOf(f)), id: peerId, ticketKey: peerId,
      state: "assigned", writes: [file], verification: null, assignee: "other" });
  });
  assert.equal(confirm(f, { confirmForeignDirty: { [file]: { taskId: peerId, sha256: sha(f, file) } } }).state, "stored");
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');");
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports = 'new';");
  assert.equal((await f.run("green")).state, "passed");
  assert.equal((await f.run("full")).state, "passed");
  const dimensions = Object.fromEntries(["requirements", "implementation", "system"]
    .map(name => [name, { state: "pass", evidence: "核对候选和真实检查", checkIds: ["full"] }]));
  const report = f.call("Dev", "report", { taskId: f.taskId, summary: "实现已就绪", dimensions });
  f.wf.heartbeat(f.roles.map(role => ({ id: role.name, state: "idle", pending: 0, jobs: 0 })));
  f.call("Review", "inbox");
  f.call("Review", "review", { taskId: f.taskId, candidate: report.candidate, verdict: "pass",
    findings: "核对实际检查", dimensions, riskAssessment: reviewedRisk });
  f.call("Lead", "summarize", { taskId: f.taskId, instructions: "按票面试用",
    decision: { candidate: report.candidate, limits: "无", riskNote: "已核对审查与回执",
      acceptance: [{ id: "AC1", evidence: "核对 full", checkIds: ["full"] }] } });
  f.put(file, "delivered draft");
  f.store.change(s => { s.tasks.find(task => task.id === peerId).state = "trial"; });

  const diagnosis = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnosis.state, "trial");
  assert.deepEqual(diagnosis.outsideOwnership.candidates, [{ taskId: peerId, ticketKey: peerId, state: "trial" }]);
  assert.equal(diagnosis.outsideOwnership.canConfirmNow, false);
  assert.equal(diagnosis.nextAction?.command, "rework");
  assert.equal(diagnosis.nextAction.args.taskId, f.taskId);
  assert.equal(diagnosis.nextAction.args.adjustScope, true);
  assert.equal(diagnosis.afterStop?.command, "confirmForeignDirty");
  assert.throws(() => f.call("Lead", diagnosis.afterStop.command, diagnosis.afterStop.args),
    error => error.nextAction?.command === "rework" && error.nextAction.args.adjustScope === true);

  assert.equal(f.call("Lead", diagnosis.nextAction.command, diagnosis.nextAction.args).state, "paused");
  const retry = f.call("Lead", "diagnoseTask", { taskId: f.taskId }).nextAction;
  assert.equal(retry?.command, "confirmForeignDirty");
  const receipt = f.call("Lead", retry.command, retry.args);
  assert.deepEqual(receipt.confirmed.map(({ file, taskId }) => ({ file, taskId })), [{ file, taskId: peerId }]);
});
