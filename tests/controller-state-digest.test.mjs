import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { promptMetrics } from "../src/cache-diagnostics.mjs";
import { controllerStateDigest, markContextSeen, policyVersion, roleContext, wakeText } from "../src/role-context.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

const project = { id: "test", name: "Workflow", root: "" };
const lead = { id: "lead", kind: "controller", name: "Lead" };
const dev = { id: "dev", kind: "developer", name: "Dev" };
const secret = "33a4e3d0f1029384756ededaed99a1572e203948576685918393827455561288";
const task = (id, ticketKey, extra = {}) => ({
  id, ticketKey, projectId: project.id, state: "assigned", scheduleVersion: 2, developerId: dev.id, ...extra,
});
const state = (tasks = [], checkJobs = []) => ({ projects: [project], roles: [lead, dev], tasks, checkJobs });

test("digest filters projects and terminal states and counts only passed jobs", () => {
  const a = task("task-a", "K-01");
  const b = task("task-b", "K-02", { state: "queued", blockedBy: [{ reason: "等待前置" }] });
  const closed = ["summarized", "abandoned", "superseded", "trial"].map((value, i) =>
    task("closed-" + i, "CLOSED", { state: value }));
  const digest = controllerStateDigest(state([a, b, ...closed, task("foreign", "OTHER", { projectId: "elsewhere" })], [
    { taskId: a.id, state: "passed" }, { taskId: a.id, state: "failed" },
    { taskId: b.id, state: "running" }, { taskId: "foreign", state: "passed" },
  ]), project.id);
  assert.match(digest, /^当前状态（自动生成，勿手工核对以下事实）\nHEAD：/);
  assert.ok(digest.includes("K-01 | assigned | sv=2 | 检查 1/2 | Dev | task-a"));
  assert.ok(digest.includes("K-02 | queued | sv=2 | 检查 0/1 | Dev | task-b"));
  assert.match(digest, /阻塞：K-02 → 等待前置/);
  assert.doesNotMatch(digest, /CLOSED|OTHER/);
  assert.ok(digest.length <= 1200);
});

test("digest reports no open task even without a Git checkout", () => {
  assert.match(controllerStateDigest(state(), project.id), /下一步：无在途票$/);
});

test("digest excludes ownership hashes, file confirmations, and URLs", () => {
  const digest = controllerStateDigest(state([task("task-a", "K-01", {
    baseline: { other: [["private.txt", secret]] },
    blockedBy: [{ reason: "等待 https://example.invalid/action " + "阻".repeat(100) }],
    scopeConflict: { nextAction: { command: "rebindCommittedWork", args: { taskId: "task-a", confirmPaths: ["private.txt"] } } },
  })]), project.id);
  assert.doesNotMatch(digest, new RegExp(secret + "|private\\.txt|https:"));
  assert.match(digest, /下一步：diagnoseTask \{"taskId":"task-a"\}$/);
  assert.ok(digest.split("\n").find(line => line.startsWith("阻塞：")).split(" → ")[1].length <= 80);
});

test("only the controller receives state and the controller policy revs independently", () => {
  assert.ok(roleContext(project, lead, true, state()).stateDigest);
  for (const [role, expected] of [[lead, 11], [dev, 7], [{ kind: "reviewer" }, 4], [{ kind: "supervisor" }, 1]]) {
    assert.equal(policyVersion(role), expected);
    if (role !== lead) assert.equal(roleContext(project, { id: "member", ...role }, false, state()).stateDigest, "");
  }
});

test("lean planning and incremental sequencing apply alongside a custom controller policy", () => {
  const context = roleContext({ ...project, controllerPolicy: "用户自定义工作方式" }, lead, true, state());
  assert.equal(context.duties, "用户自定义工作方式");
  assert.match(context.rules, /planned-attempts 只记跨票协调/);
  assert.match(context.rules, /开发决定票内路线并设计具体断言、夹具和反例/);
  assert.match(context.rules, /queued 原票用 insertSchedule/);
  assert.match(context.rules, /前票 summarize 后，按已有 Git 授权提交可安全隔离的本票改动，核对提交及工作区后再派下一票/);
  assert.match(context.rules, /本次决定缺事实时只核对相关原票/);
});

test("cold and compact wakes keep whole digest rows ahead of the current notice", () => {
  const role = { ...lead };
  const data = state([task("task-a", "K-01")]);
  const short = "这是一条新通知";
  const long = short.repeat(1000);
  const cold = wakeText(project, role, true, long, data);
  assert.match(cold, /工作流边界[\s\S]*\n当前状态\n[\s\S]*task-a\n下一步：[\s\S]*\n当前事项\n/);
  assert.ok(cold.length - cold.indexOf("\n\n当前状态\n") <= 760);
  markContextSeen(role);
  const compact = wakeText(project, role, true, long, data);
  assert.ok(compact.length <= 760);
  assert.ok(compact.includes(controllerStateDigest(data, project.id)));
  assert.equal(promptMetrics(compact, false).stableBytes,
    promptMetrics(wakeText(project, role, true, short, state()), false).stableBytes);
  const many = state(Array.from({ length: 100 }, (_, i) => task("test-task-" + i, "K-" + i)));
  assert.ok(wakeText(project, role, true, long, many).length <= 760);
  assert.ok(controllerStateDigest(many, project.id).length <= 1200);
  assert.doesNotMatch(wakeText(project, dev, false, short, data), /当前状态/);
});

test("workflow context and refreshed inbox use live Git and the latest explicit diagnosis", async t => {
  const f = await fixture(t);
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: f.root, encoding: "utf8", windowsHide: true }).trim();
  const result = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  const digest = f.call("Lead", "context").stateDigest;
  assert.ok(digest.includes("HEAD：" + head));
  assert.ok(digest.includes(f.taskId));
  assert.ok(digest.endsWith("下一步：" + result.nextAction.command + " " + JSON.stringify(result.nextAction.args)));
  f.store.change(s => {
    s.roles.find(role => role.kind === "controller").seenSupervisionPolicy = 8;
    s.roles.find(role => role.kind === "developer").seenSupervisionPolicy = 6;
  });
  assert.equal(f.call("Lead", "inbox").context.stateDigest, digest);
  const developerContext = f.call("Dev", "inbox").context;
  assert.equal(developerContext.stateDigest, "");
  assert.match(developerContext.duties, /自行选择实现路线，常规票直接推进/);
  assert.match(developerContext.duties, /用 progress 在原票简记/);
  f.store.change(s => { s.tasks[0].scheduleVersion = (s.tasks[0].scheduleVersion ?? 0) + 1; });
  assert.doesNotMatch(f.call("Lead", "context").stateDigest, new RegExp("下一步：" + result.nextAction.command + " "));
});
