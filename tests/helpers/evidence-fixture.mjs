import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../../src/store.mjs";
import { Workflow } from "../../src/workflow.mjs";
import { startCheckRunner } from "../../src/check-runner.mjs";

export async function fixture(t, marker = "AssertionError", options = {}) {
  mkdirSync(".validation", { recursive: true });
  const dir = mkdtempSync(path.resolve(".validation/red-evidence-"));
  const root = path.join(dir, "project");
  mkdirSync(root); mkdirSync(path.join(root, "e2e"));
  const put = (file, text) => writeFileSync(path.join(root, file), text);
  const sources = { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" };
  for (const file of Object.values(sources)) put(file, "approved");
  put("implementation.cjs", options.implementation ?? "module.exports = 'old';");
  const testFile = options.testFile ?? "e2e/new-case.cjs";
  if (options.existingTest) put(testFile, options.existingTest);
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "ignore" });
  git("init"); git("add", "spec.md", "tickets.md", "attempts.md", "implementation.cjs");
  if (options.existingTest) git("add", testFile);
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  for (let i = 0; i < (options.untrackedFiles ?? 0); i++) put(`outside-${i}.txt`, "user-owned baseline");
  const store = new Store(path.join(dir, "workflow.sqlite"));
  const wf = new Workflow(store);
  const stop = startCheckRunner(wf, dir);
  let closed = false;
  const close = () => { if (!closed) { stop(); store.close(); closed = true; } };
  t.after(close);
  let op = 0;
  const call = (who, command, args = {}, operationId = "red-" + ++op) => wf.call(who, command, args, operationId);
  call("ui", "createProject", { name: "Red", root, members: [
    { kind: "controller", name: "Lead" }, { kind: "developer", name: "Dev" }, { kind: "reviewer", name: "Review" },
  ] });
  const roles = store.read().roles;
  for (const role of roles) {
    const req = wf.request({ roleId: role.id, sessionId: role.name, cwd: root });
    if (!req.bound) call("ui", "confirmBinding", { requestId: req.id });
    call("ui", "enable", { roleId: role.id, enabled: true });
  }
  wf.heartbeat(roles.map(r => ({ id: r.name, state: "idle", pending: 0, jobs: 0 })));
  for (const role of roles) call(role.name, "inbox");
  const requirement = call("Lead", "approve", { text: "New behavior and new test", source: "approved" });
  const checks = options.checks ?? ["red", "green", "full", ...(options.risk && options.risk !== "high" ? ["independent"] : [])].map(stage => ({ id: stage, stage,
    argv: options.argv ?? ["node", testFile], inputs: [testFile, "implementation.cjs"], covers: ["AC1"],
    ...(stage === "red" && { expectedOutput: marker }),
  }));
  const plan = call("Lead", "dispatchPlan", { requirementId: requirement.id, sources, tickets: [{
    key: "NEW-TEST", developerId: roles.find(r => r.kind === "developer").id,
    title: "New test", description: "New assertion", risk: options.risk ?? "high", riskReason: "critical behavior",
    writes: ["implementation.cjs", testFile], reads: [],
    verification: { testWrites: [testFile], checks, ...(options.browserE2E && {browserE2E:options.browserE2E}), acceptance: [{ id: "AC1", text: "new behavior" }] },
  }] });
  const taskId = plan.tasks[0].taskId;
  const run = async (checkId, async = false, actor = "Dev") => {
    const result = call(actor, "check", { taskId, checkId, async });
    for (let i = 0; i < 100; i++) {
      const job = store.read().checkJobs.find(j => j.id === result.jobId);
      if (!["queued", "launching"].includes(job.state)) return job;
      await delay(50);
    }
    assert.fail("check did not complete");
  };
  return { put, run, call, taskId, testFile, wf, store, root, dir, git, roles, close };
}
