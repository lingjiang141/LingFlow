import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertOutsideScope, candidateFingerprint, gitState } from "../src/quality.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

const setTrial = f => f.store.change(s => {
  Object.assign(s.tasks[0], { state: "trial", assignee: null, candidate: "frozen candidate" });
});

test("controller can close a stopped trial without consulting the former assignee", async t => {
  const f = await fixture(t);
  setTrial(f);
  const snapshot = f.store.read();
  const developerId = snapshot.tasks[0].developerId;
  f.store.change(s => {
    s.roles.find(role => role.id === developerId).state = "running";
    s.checkJobs.push({ id: "pending", taskIds: [f.taskId], state: "uncertain" });
  });
  const abandon = () => f.call("Lead", "abandonTask", { taskId: f.taskId, reason: "结束试用" });
  assert.throws(abandon, /检查/);
  f.store.change(s => { s.checkJobs = []; });
  assert.equal(abandon().state, "abandoned");
  assert.equal(f.store.read().tasks[0].candidate, "frozen candidate");
  f.store.change(s => {
    Object.assign(s, structuredClone(snapshot));
    s.tasks.push({ ...s.tasks[0], id: "successor", ticketKey: "SUCCESSOR", state: "queued", candidate: null,
      dependencies: [f.taskId], dependencyStages: { [f.taskId]: "verified" } });
  });
  assert.equal(f.call("Lead", "supersede", { taskId: f.taskId, supersededBy: "successor", reason: "后继票承接" }).state, "superseded");
  assert.deepEqual(f.store.read().tasks[1].dependencies, []);
});

test("pruneOutside removes a stale digest for a clean tracked file even without a new commit", async t => {
  const f = await fixture(t);
  setTrial(f);
  const file = "historical.txt";
  f.put(file, "version in HEAD\n");
  f.git("add", "--", file);
  f.git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-m", "historical file");
  const git = gitState(f.root);
  f.store.change(s => {
    Object.assign(s.tasks[0].baseline, { head: git.head, index: git.index, sourcesHead: git.head, other: [[file, "obsolete"]] });
  });
  const prune = () => f.call("Lead", "reviseSchedule", { taskId: f.taskId, pruneOutside: true, reason: "核对已还原文件" });
  f.git("update-index", "--assume-unchanged", "--", file);
  f.put(file, "different despite clean status\n");
  assert.throws(prune, /未归属的改动/);
  f.put(file, "version in HEAD\r\n");
  assert.deepEqual(prune().prunedOutside, [file]);
  assert.deepEqual(f.store.read().tasks[0].baseline.other, []);
  const audit = f.store.db.prepare("SELECT data FROM events WHERE kind = 'baseline-other-pruned'").get();
  assert.deepEqual(JSON.parse(audit.data).removed, [[file, "obsolete"]]);
  assert.equal(JSON.parse(audit.data).remainingOutsidePaths, 0);
});

test("repository ignores still cover historical paths, with a frozen-scope exception", async t => {
  const f = await fixture(t);
  const file = "private-dir/scratch.txt";
  mkdirSync(path.join(f.root, "private-dir"));
  f.put(file, "changed");
  f.put(".gitignore", "/private-dir/\n");
  f.git("add", ".gitignore");
  f.git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-m", "repository ignore");
  const task = f.store.read().tasks[0];
  task.baseline.other = [[file, "old digest"]];
  const git = gitState(f.root, task, ["/logs/"]);
  assert.equal(git.dirty.includes(file), false);
  assert.doesNotThrow(() => assertOutsideScope(f.root, task, [], git));
  f.store.change(s => { s.tasks[0].baseline.other = task.baseline.other; });
  assert.doesNotMatch(f.call("Lead", "diagnoseTask", { taskId: f.taskId }).reason, /发现未归属的改动/);
  const owning = { ...task, writes: [...task.writes, "private-dir"] };
  assert.ok(gitState(f.root, owning, []).dirty.includes(file));
});

test("staged hunks can be checked and committed while the other ticket keeps its unsplit worktree bytes", async t => {
  const file = "implementation.cjs";
  const source = (first, last) => [first, "// one", "// two", "// three", "// four", last, ""].join("\n");
  const f = await fixture(t, "AssertionError", { implementation: source("// old first", "// old last") });
  const accepted = source("// new first", "// old last");
  const combined = source("// new first", "// new last");
  f.put(file, accepted);
  f.git("add", "--", file);
  f.store.change(s => {
    const task = s.tasks[0];
    const peer = { ...structuredClone(task), id: "peer", ticketKey: "PEER", state: "paused" };
    Object.assign(task, { state: "accepted", assignee: null, candidate: candidateFingerprint(f.root, task) });
    s.tasks.push(peer);
  });
  f.put(file, combined);
  const preview = () => f.call("Lead", "describeDrift", { taskId: f.taskId, partitionPeerTaskId: "peer" });
  f.put(file, source("// overlapping write", "// new last"));
  assert.throws(preview, /hunk 重叠/);
  f.put(file, source("// old first", "// new last"));
  f.git("add", "--", file);
  f.put(file, combined);
  assert.throws(preview, /无法完整重建/);
  f.put(file, accepted);
  f.git("add", "--", file);
  f.put(file, combined);
  const preflight = preview();
  assert.deepEqual(preflight.paths, [file]);
  assert.deepEqual(preflight.shared, [file]);
  f.git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-m", "commit only the first hunk");
  const git = gitState(f.root);
  const confirm = (proof) => f.call("Lead", "confirmCommit", { taskId: f.taskId, paths: preflight.paths,
    expectedBase: preflight.expectedBase, expectedHead: git.head, partition: { peerTaskId: "peer", proof }, reason: "确认已核对的两个 hunk" });
  assert.throws(() => confirm("different proof"), /分区证据不同/);
  assert.equal(confirm(preflight.proof).state, "applied");
  assert.notEqual(f.call("Lead", "diagnoseTask", { taskId: "peer" }).classification, "contract-invalid");
  assert.equal(f.store.read().tasks[1].baseline.head, git.head);
  assert.equal(execFileSync("git", ["show", "HEAD:" + file], { cwd: f.root, encoding: "utf8" }), accepted);
  assert.equal(readFileSync(path.join(f.root, file), "utf8"), combined);
  assert.deepEqual(gitState(f.root).shortStatus, [{ status: " M", file }]);
});
