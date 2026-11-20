import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { implementationFingerprint } from "../src/files.mjs";
import { gitState } from "../src/quality.mjs";
import { startServer } from "../src/server.mjs";
import { Store } from "../src/store.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

test("HTTP server recovers an aligned paused baseline, rejects new foreign edits and runs a real red", async t => {
  const original = "module.exports = 'old';\n";
  const f = await fixture(t, "AssertionError", { implementation: original, untrackedFiles: 1 });
  const file = "outside-0.txt";
  f.git("config", "core.autocrlf", "true");
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "暂停以核对基线" });
  const [requirement] = f.store.read().requirements;
  const peer = f.call("ui", "addRole", { projectId: requirement.projectId, kind: "developer", name: "Peer" });
  const binding = f.wf.request({ roleId: peer.id, sessionId: "Peer", cwd: f.root });
  if (!binding.bound) f.call("ui", "confirmBinding", { requestId: binding.id });
  f.call("ui", "enable", { roleId: peer.id, enabled: true });
  f.wf.heartbeat([...f.roles, peer].map(r => ({ id: r.name, state: "idle", pending: 0, jobs: 0 })));
  f.call("Lead", "dispatchPlan", { requirementId: requirement.id,
    sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "OUTSIDE", developerId: peer.id, title: "承接票外文件", description: "更新已分配的文件",
      risk: "high", riskReason: "核对文件所有权", writes: [file, "peer-test.cjs"], reads: [], ownedDirty: [file],
      verification: { acceptance: [{ id: "AC1", text: "文件已更新" }], testWrites: ["peer-test.cjs"],
        checks: ["red", "green", "full"].map(stage => ({ id: stage, stage, argv: ["node", "peer-test.cjs"],
          inputs: ["peer-test.cjs", file], covers: ["AC1"], ...(stage === "red" && { expectedOutput: "AssertionError" }) })) } }] });
  const admitted = f.store.read();
  assert.ok(f.wf.foreignWrites(admitted, admitted.tasks[0]).includes(file));
  f.put(file, "committed outside\n");
  f.git("add", "--", file);
  f.git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-m", "outside change");
  f.put("implementation.cjs", "module.exports = 'new';\n");
  f.store.change(s => {
    const task = s.tasks[0], git = gitState(f.root, task);
    Object.assign(task.baseline, implementationFingerprint(f.root, task),
      { sourcesHead: task.baseline.head, head: git.head, index: git.index });
    task.redBaseline = null;
  });
  f.put("implementation.cjs", original.replaceAll("\n", "\r\n"));
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');");
  f.close();
  const app = await startServer({ dataDir: f.dir, port: 0 });
  t.after(() => app.close());
  const db = new Store(path.join(f.dir, "workflow.sqlite"), { readOnly: true });
  t.after(() => db.close());
  const config = JSON.parse(readFileSync(path.join(f.dir, "config.json"), "utf8"));
  const post = async (route, body) => {
    const res = await fetch("http://127.0.0.1:" + app.port + "/api/" + route, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (route.startsWith("ui/") ? app.uiToken : config.bridgeToken) },
      body: JSON.stringify(body) });
    const value = await res.json();
    if (!res.ok || value.error) throw Error(JSON.stringify(value));
    return value;
  };
  let n = 0;
  const call = (sessionId, command, args) => post("bridge/call", { sessionId, command,
    args: { taskId: f.taskId, ...args }, operationId: "http-" + ++n });
  for (const role of f.roles) await post("ui/call", { command: "enable", args: { roleId: role.id, enabled: true }, operationId: "enable-" + role.id });
  const heartbeat = () => post("bridge/heartbeat", { sessions: f.roles.map(r => ({ id: r.name, state: "idle", pending: 0, jobs: 0 })) });
  await heartbeat();
  f.put(file, "third version\n");
  const blocked = await call("Lead", "diagnoseTask");
  assert.match(blocked.reason, /未归属的改动：outside-0.txt/);
  await assert.rejects(call("Lead", "reviseSchedule", { pruneOutside: true, reason: "核对已提交文件" }), /outside-0.txt/);
  f.put(file, "committed outside\n");
  const diagnosis = await call("Lead", "diagnoseTask");
  assert.doesNotMatch(diagnosis.reason, /未归属的改动/);
  const event = () => db.db.prepare("SELECT data FROM events WHERE kind='baseline-other-pruned'").get();
  for (let i = 0; !event() && i < 100; i++) await delay(50);
  assert.equal(JSON.parse(event().data).removed[0][0], file);
  assert.deepEqual(db.read().tasks[0].baseline.other, []);
  const refresh = () => call("Lead", "reviseSchedule", { refreshBaseline: true, ownedDirty: ["implementation.cjs", f.testFile], reason: "恢复冻结红基线" });
  const first = await refresh();
  assert.equal(first.redBaselineRealigned, true);
  await heartbeat();
  await post("bridge/call", { sessionId: "Dev", command: "inbox", operationId: "dev-inbox" });
  const { jobId } = await call("Dev", "check", { checkId: first.nextAction.args.checkId, async: true });
  let job;
  for (let i = 0; i < 200; i++) {
    job = db.read().checkJobs.find(j => j.id === jobId);
    if (job?.receipt) break;
    await delay(100);
  }
  assert.equal(job.state, "passed");
  assert.equal(job.receipt.exitCode, 1);
  assert.equal(job.receipt.failureOutputSeen, true);
  await call("Dev", "yieldForSchedule", { reason: "再次核对" });
  assert.equal((await refresh()).newSources, first.newSources);
  t.diagnostic(JSON.stringify({ redBaselineRealigned: true, checkId: first.nextAction.args.checkId,
    exitCode: job.receipt.exitCode, failureOutputSeen: job.receipt.failureOutputSeen,
    repeatedRefresh: true, pruned: file, dirtyRejected: blocked.classification }));
});
