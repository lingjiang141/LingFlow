import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { Workflow } from "../src/workflow.mjs";
import { scopePaths } from "../src/files.mjs";

function setup(t) {
  const parent = path.resolve(".validation");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "workflow-"));
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot);
  const store = new Store(path.join(root, "state.sqlite"));
  const wf = new Workflow(store);
  t.after(() => store.close());
  let seq = 0;
  const call = (session, command, args = {}, operationId = "op-" + ++seq) => {
    // Load the original data shape to cover responsibilities persisted before this upgrade.
    if (session !== "主控" || command !== "dispatch" || args.readOnly)
      return wf.call(session, command, args, operationId);
    const writes = scopePaths(args.writes);
    return store.operation("old-fixture", operationId, { command, args }, (s) => {
      const task = {
        ...args, id: randomUUID(), projectId: project.id, writes,
        reads: args.reads ?? [], resources: args.resources ?? [], dependencies: args.dependencies ?? [],
        assignee: args.developerId, state: "queued", revision: 1, acceptedAt: Date.now(),
        reports: [], reviews: [], questions: [],
      };
      s.tasks.push(task);
      wf.schedule(s);
      return { taskId: task.id, receipt: "accepted" };
    });
  };
  const project = call("ui", "createProject", {
    name: "测试项目",
    root: projectRoot,
    members: [
      { kind: "controller", name: "主控" },
      { kind: "developer", name: "开发一" },
      { kind: "developer", name: "开发二" },
      { kind: "reviewer", name: "审查1" },
      { kind: "reviewer", name: "审查2" },
    ],
  });
  const roles = store.read().roles;
  for (const r of roles) {
    const request = wf.request({
      roleId: r.id,
      sessionId: r.name,
      cwd: projectRoot,
    });
    call("ui", "confirmBinding", { requestId: request.id });
    call("ui", "enable", { roleId: r.id, enabled: true });
  }
  const heartbeat = (state = "idle") =>
    wf.heartbeat(
      roles.map((r) => ({ id: r.name, state, pending: 0, jobs: 0 })),
    );
  heartbeat();
  for (const role of roles) call(role.name, "inbox");
  const requirement = call("主控", "approve", {
    projectId: project.id,
    text: "写入文本文件并验证内容",
    source: "用户要求执行验证用例",
  });
  const dispatch = (extra = {}, operationId) =>
    call("主控", "dispatch", {
      requirementId: requirement.id,
      developerId: roles[1].id,
      title: "测试任务",
      description: "交付并检查",
      risk: "high",
      writes: ["a.txt"],
      ...extra,
    }, operationId);
  const report = (taskId, session = "开发一") =>
    call(session, "report", {
      taskId,
      summary: "已实现",
      dimensions: {
        requirements: { state: "pass", evidence: "本夹具核对原票" },
        implementation: { state: "pass", evidence: "本夹具核对读取输出" },
        system: { state: "pass", evidence: "本夹具核对影响范围" },
      },
      checks: [
        { command: "read a.txt", exitCode: 0, evidence: "实际输出与预期一致" },
      ],
    });
  return {
    wf,
    store,
    call,
    project,
    roles,
    heartbeat,
    dispatch,
    report,
    root: projectRoot,
  };
}
test("deleting a project clears its workflow and frees its directory", (t) => {
  const f = setup(t);
  const otherRoot = path.join(path.dirname(f.root), "other");
  mkdirSync(otherRoot);
  const other = f.call("ui", "createProject", { name: "其他项目", root: otherRoot });
  assert.deepEqual(f.wf.catalog().find((p) => p.id === other.id).roles, []);
  const preset = f.call("ui", "savePromptPreset", { name: "预设", identityPrompt: "保留" });
  const file = path.join(f.root, "a.txt");
  writeFileSync(file, "保留文件");
  f.dispatch();
  const wake = f.heartbeat().deliveries.find((w) => w.sessionId === "开发一");
  const args = { projectId: f.project.id };
  assert.throws(() => f.call("主控", "deleteProject", args), /仅用户工作台/);
  const receipt = f.call("ui", "deleteProject", args, "delete-project");
  assert.deepEqual(receipt, { deleted: true });
  assert.deepEqual(f.call("ui", "deleteProject", args, "delete-project"), receipt);
  const state = f.store.read();
  assert.deepEqual(state.projects, [other]);
  for (const key of ["roles", "requests", "requirements", "tasks", "notices", "wakes"])
    assert.deepEqual(state[key], [], key);
  assert.deepEqual(state.promptPresets, [preset]);
  assert.deepEqual(f.wf.validWake(wake.id, wake.sessionId), { valid: false });
  assert.deepEqual(f.wf.acknowledge(wake.id, wake.sessionId), { state: "obsolete" });
  assert.equal(readFileSync(file, "utf8"), "保留文件");
  const recreated = f.call("ui", "createProject", { name: "重新添加", root: f.root });
  assert.notEqual(recreated.id, f.project.id);
  const primary = f.call("ui", "addRole", { projectId: recreated.id, kind: "controller", name: "新主控" });
  assert.equal(f.wf.snapshot().roles.find((r) => r.id === primary.id).isPrimary, true);
});

test("offline responsibilities stay queued and retry exhaustion is audited on the original wake", (t) => {
  const f = setup(t);
  const [lead, developer] = f.roles;
  const session = (role, data = {}) => ({ id: role.name, state: "idle", pending: 0, jobs: 0, ...data });
  f.wf.heartbeat([session(lead)]);
  const receipt = f.dispatch({ readOnly: true, writes: [] });
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.runnable, false);
  assert.match(receipt.blockedBy[0].detail, /打开原绑定会话/);
  const wake = f.wf.heartbeat([session(lead), session(developer)]).deliveries.find((item) => item.sessionId === developer.name);
  assert.equal(f.wf.validWake(wake.id, developer.name).valid, true);
  const view = () => f.call(lead.name, "list").tasks.find((item) => item.id === receipt.taskId);
  f.store.change((state) => { state.wakes.find((item) => item.id === wake.id).at -= 11000; });
  assert.equal(view().deliveryIssue.reason, "stalled");
  const outcomes = Array.from({ length: 4 }, (_, index) => ({ attempt: index + 1, result: "rejected", at: Date.now() }));
  const failure = { wakeId: wake.id, state: "exhausted", attempt: 4, generation: 0, at: Date.now(), outcomes };
  const update = () => f.wf.heartbeat([session(lead), session(developer, { deliveryResults: [failure] })]);
  update();
  update();
  assert.equal(view().deliveryState, "undeliverable");
  assert.equal(view().state, "assigned");
  assert.equal(view().deliveryIssue.attempt, 4);
  assert.equal(view().deliveryIssue.reason, "retry-limit");
  const retry = f.call(lead.name, "redeliver", { taskId: receipt.taskId });
  assert.equal(retry.wakeId, wake.id);
  const newOffer = update().deliveries.find((item) => item.id === wake.id);
  assert.equal(newOffer.deliveryRetry, 1);
  f.wf.acknowledge(wake.id, developer.name, "dsh", { attempt: 1, generation: 1, outcomes: [] });
  f.wf.acknowledge(wake.id, developer.name);
  assert.equal(view().deliveryState, "delivered");
  const events = f.store.db.prepare("SELECT data FROM events WHERE kind='deliver' ORDER BY seq").all().map((row) => JSON.parse(row.data));
  assert.deepEqual(events.map((item) => item.result), ["rejected", "rejected", "rejected", "rejected", "delivered"]);
  assert.ok(events.every((item) => item.taskId === receipt.taskId && item.wakeId === wake.id));
  assert.equal(f.call(developer.name, "inbox").tasks[0].id, receipt.taskId);
  assert.ok(!f.heartbeat().deliveries.some((item) => item.id === wake.id));
});
test("legacy high risk delivery keeps independent review history but cannot pass the native gate", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  writeFileSync(path.join(f.root, "a.txt"), "done");
  const receipt = f.report(taskId);
  assert.equal(receipt.state, "stored");
  let task = f.store.read().tasks[0];
  assert.equal(task.state, "reviewing");
  assert.notEqual(task.assignee, task.developerId);
  const reviewer = f.roles.find((r) => r.id === task.assignee);
  f.call(reviewer.name, "review", {
    taskId,
    candidate: receipt.candidate,
    verdict: "pass",
    findings: "已核对原需求、实际文件与空输入边界",
  });
  assert.throws(() => f.call("主控", "summarize", { taskId, instructions: "打开文件检查 done" }), /没有冻结契约/);
  assert.throws(
    () => f.call("主控", "accept", { taskId, evidence: "通过" }),
    /没有冻结契约/,
  );
  f.store.change((s) => { s.tasks[0].state = "trial"; }); // Previously summarized legacy ticket.
  assert.throws(() => f.call("ui", "accept", { taskId, evidence: "实际打开文件确认通过" }), /没有冻结契约/);
  assert.equal(f.store.read().tasks[0].state, "trial");
});
test("low and medium risks skip mandatory review", (t) => {
  const f = setup(t);
  for (const risk of ["low", "medium"]) {
    const { taskId } = f.dispatch({ risk });
    const result = f.report(taskId);
    assert.equal(result.reviewRequired, false);
    assert.equal(
      f.store.read().tasks.find((t) => t.id === taskId).state,
      "ready",
    );
  }
});
test("stable operation IDs return original dispatch and reject changed inputs", (t) => {
  const f = setup(t);
  const args = {
    requirementId: f.store.read().requirements[0].id,
    developerId: f.roles[1].id,
    title: "幂等",
    description: "测试",
    risk: "low",
    writes: ["x"],
  };
  const a = f.call("主控", "dispatch", args, "stable");
  const b = f.call("主控", "dispatch", args, "stable");
  assert.deepEqual(a, b);
  assert.equal(f.store.read().tasks.length, 1);
  assert.throws(
    () => f.call("主控", "dispatch", { ...args, title: "changed" }, "stable"),
    /不能用于不同/,
  );
});
test("read/write conflicts, resource contention and same developer serialize", (t) => {
  const f = setup(t);
  f.dispatch({ writes: ["src"], reads: ["config"], resources: ["db"] });
  for (const extra of [
    { writes: ["src/a"] },
    { writes: ["config"] },
    { writes: ["other"], resources: ["db"] },
  ]) {
    const { taskId } = f.dispatch({ developerId: f.roles[2].id, ...extra });
    assert.equal(
      f.store.read().tasks.find((t) => t.id === taskId).state,
      "queued",
    );
  }
  const { taskId } = f.dispatch({
    writes: ["independent"],
    developerId: f.roles[2].id,
  });
  assert.equal(
    f.store.read().tasks.find((t) => t.id === taskId).state,
    "assigned",
  );
});
test("busy sessions queue zero prompts; one wake merges many business notices", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  for (let i = 0; i < 10; i++)
    f.call("开发一", "question", { taskId, text: "阻塞 " + i });
  assert.equal(f.heartbeat("running").deliveries.length, 0);
  const first = f
    .heartbeat()
    .deliveries.filter((w) => w.roleId === f.roles[0].id);
  assert.equal(first.length, 1);
  assert.match(first[0].text, /成员遇到阻塞.*测试任务.*共 10 条/);
  assert.match(first[0].text, /下一步：查看问题并沿原票答复/);
  assert.equal(
    f.heartbeat().deliveries.find((w) => w.roleId === f.roles[0].id).id,
    first[0].id,
  );
  f.wf.acknowledge(first[0].id, "主控");
  assert.equal(
    f.heartbeat().deliveries.filter((w) => w.roleId === f.roles[0].id).length,
    0,
  );
  const inbox = f.call("主控", "inbox");
  assert.equal(inbox.notices.length, 10);
  assert.equal(
    f.heartbeat().deliveries.filter((w) => w.roleId === f.roles[0].id).length,
    0,
  );
});
test("background inbox consumption invalidates a pending notification", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  f.call("开发一", "question", { taskId, text: "缺少输入" });
  const wake = f.heartbeat().deliveries.find((w) => w.roleId === f.roles[0].id);
  assert.ok(wake);
  f.call("主控", "inbox");
  assert.equal(f.wf.validWake(wake.id, "主控").valid, false);
});
test("patrol uses live DSH status over an open task and only resumes an idle session", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch({ title: "仍有开放责任" });
  f.call("开发一", "inbox");
  const start = Date.now() + 100;
  const heartbeat = (now, state, pending = 0, jobs = 0, turn) => f.wf.heartbeat(
    f.roles.map((role) => ({
      id: role.name,
      state: role.name === "开发一" ? state : "idle",
      pending: role.name === "开发一" ? pending : 0,
      jobs: role.name === "开发一" ? jobs : 0,
      telemetry: { activityAt: start, ...(role.name === "开发一" && { turn }) },
    })), now).deliveries.filter((wake) => wake.sessionId === "开发一");
  const status = () => f.wf.snapshot().roles.find((role) => role.id === f.roles[1].id).patrolStatus.state;
  for (let elapsed = 0; elapsed <= 110000; elapsed += 10000)
    assert.equal(heartbeat(start + elapsed, "running").length, 0);
  assert.equal(status(), "running");
  for (let elapsed = 120000; elapsed <= 220000; elapsed += 10000)
    assert.equal(heartbeat(start + elapsed, "idle", 0, 1).length, 0);
  assert.equal(status(), "checking");
  assert.equal(heartbeat(start + 230000, "idle", 1).length, 0);
  assert.equal(status(), "pending");
  const [recovery] = heartbeat(start + 240000, "idle");
  assert.match(recovery.text, /巡检安排原会话续接.*仍有开放责任/);
  assert.equal(heartbeat(start + 241000, "idle")[0].id, recovery.id);
  const notice = f.call("开发一", "inbox").notices.find((item) => item.key.startsWith("patrol-resume:"));
  assert.equal(notice.taskId, taskId);
  const turn = { id: "manual", endedAt: start + 241000, outcome: "cancelled" };
  assert.equal(heartbeat(start + 242000, "idle", 0, 0, turn).length, 0);
  assert.equal(status(), "cancelled");
  f.wf.patrolTick(start + 260000);
  assert.equal(status(), "offline");
});

test("patrol retries a transient turn twice, respects prior admission and escalates once", (t) => {
  const f = setup(t);
  f.dispatch({ title: "供应商波动后的原票" });
  const original = f.heartbeat().deliveries.find((wake) => wake.sessionId === "开发一");
  f.wf.acknowledge(original.id, "开发一");
  const start = Date.now() + 100;
  const turn = { id: "failed-turn", startedAt: start, endedAt: start, outcome: "transient", code: "503" };
  const tick = (elapsed) => f.wf.heartbeat(f.roles.map((role) => ({
    id: role.name, state: "idle", pending: 0, jobs: 0,
    telemetry: { activityAt: start, ...(role.name === "开发一" && { turn }) },
  })), start + elapsed).deliveries;
  for (const elapsed of [0, 10000, 20000]) assert.equal(tick(elapsed).length, 0);
  const first = tick(30000).find((wake) => wake.sessionId === "开发一");
  assert.ok(first && first.id !== original.id);
  assert.match(first.text, /DSH 暂时异常（503）/);
  f.call("开发一", "inbox");
  for (let elapsed = 40000; elapsed < 150000; elapsed += 10000)
    assert.equal(tick(elapsed).filter((wake) => wake.sessionId === "开发一").length, 0);
  const second = tick(150000).find((wake) => wake.sessionId === "开发一");
  assert.ok(second && second.id !== first.id);
  f.call("开发一", "inbox");
  for (let elapsed = 160000; elapsed < 270000; elapsed += 10000)
    assert.equal(tick(elapsed).filter((wake) => wake.sessionId === "开发一").length, 0);
  const alert = tick(270000).find((wake) => wake.sessionId === "主控");
  assert.match(alert.text, /达到自动续接上限/);
  assert.equal(tick(271000).find((wake) => wake.sessionId === "主控").id, alert.id);
  assert.equal(f.call("主控", "inbox").notices.filter((notice) => notice.key.startsWith("patrol-alert:")).length, 1);
  f.call("ui", "setAutoPatrol", { projectId: f.project.id, enabled: false });
  assert.equal(tick(280000).length, 0);
});
test("patrol can resume the controller's original DSH chat before a ticket exists", (t) => {
  const f = setup(t);
  const start = Date.now() + 100;
  const tick = (elapsed) => f.wf.heartbeat(f.roles.map((role) => ({
    id: role.name, state: "idle", pending: 0, jobs: 0,
    telemetry: { activityAt: start, ...(role.name === "主控" && {
      turn: { id: "lead-planning", startedAt: start, endedAt: start, outcome: "transient", code: "ETIMEDOUT" },
    }) },
  })), start + elapsed).deliveries;
  for (const elapsed of [0, 10000, 20000]) assert.equal(tick(elapsed).length, 0);
  const wake = tick(30000).find((item) => item.sessionId === "主控");
  assert.match(wake.text, /核对当前会话中断前的事项/);
  assert.equal(f.call("主控", "inbox").notices[0].taskId, null);
});
test("DSH wake text distinguishes dispatch, review, review outcome and rework", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch({ title: "修复积分扣减" });
  const wakeFor = (session) => f.heartbeat().deliveries.find((wake) => wake.sessionId === session)?.text;
  assert.match(wakeFor("开发一"), /新开发任务.*修复积分扣减/);
  assert.match(wakeFor("开发一"), /下一步：查看原票范围和验收条件/);
  f.call("开发一", "inbox");
  writeFileSync(path.join(f.root, "a.txt"), "candidate");
  const report = f.report(taskId);
  const task = f.store.read().tasks.find((item) => item.id === taskId);
  const reviewer = f.roles.find((role) => role.id === task.assignee);
  assert.match(wakeFor(reviewer.name), /新独立审查.*修复积分扣减/);
  assert.match(wakeFor(reviewer.name), /下一步：核对当前候选、原需求、差异和检查证据/);
  f.call(reviewer.name, "inbox");
  f.call(reviewer.name, "review", {
    taskId, candidate: report.candidate, verdict: "changes",
    findings: "扣减缺少余额不足的回归用例",
  });
  assert.match(wakeFor("主控"), /审查要求返工.*修复积分扣减/);
  assert.match(wakeFor("主控"), /摘要：扣减缺少余额不足的回归用例/);
  assert.match(wakeFor("主控"), /下一步：查看阻塞发现，在原票安排返工/);
  f.call("主控", "inbox");
  f.call("主控", "rework", { taskId, reason: "补余额不足的回归用例" });
  assert.match(wakeFor("开发一"), /返工续接.*修复积分扣减[\s\S]*摘要：补余额不足的回归用例/);
});
test("a waiting candidate wakes a newly enabled reviewer immediately, unlike routine changes", (t) => {
  const f = setup(t);
  const [,,, reviewer, otherReviewer] = f.roles;
  f.store.change(state => {
    for (const kind of ["context", "patrol-resume", "dependency-ready", "check"])
      f.wf.notice(state, reviewer.id, `${kind}:routine`, "仅账本动态");
  });
  assert.equal(f.heartbeat().deliveries.some(wake => wake.roleId === reviewer.id), false);
  assert.equal(f.store.read().notices.filter(notice => notice.roleId === reviewer.id && !notice.readAt && notice.silent && !notice.actionable).length, 4);
  for (const role of [reviewer, otherReviewer]) f.call("ui", "enable", { roleId: role.id, enabled: false });
  const { taskId } = f.dispatch();
  f.report(taskId);
  assert.equal(f.store.read().tasks.find(task => task.id === taskId).state, "waiting_review");
  f.call("ui", "enable", { roleId: reviewer.id, enabled: true, resume: true });
  const [wake] = f.heartbeat().deliveries.filter(item => item.roleId === reviewer.id);
  assert.equal(wake.actionable, true);
  assert.match(wake.text, /新独立审查/);
  assert.doesNotMatch(wake.text, /仅账本动态|本轮无责任/);
  const inbox = f.call(reviewer.name, "inbox");
  assert.equal(inbox.notices.find(notice => notice.key.startsWith("review:")).actionable, true);
  assert.equal(inbox.notices.find(notice => notice.key.startsWith("resume:")).actionable, true);
  assert.equal(inbox.notices.filter(notice => notice.silent && !notice.actionable).length, 3);
});

test("candidate input change rejects stale review and stale user acceptance", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  writeFileSync(path.join(f.root, "a.txt"), "first");
  const receipt = f.report(taskId);
  const task = f.store.read().tasks[0],
    reviewer = f.roles.find((r) => r.id === task.assignee);
  writeFileSync(path.join(f.root, "a.txt"), "changed");
  assert.throws(
    () =>
      f.call(reviewer.name, "review", {
        taskId,
        candidate: receipt.candidate,
        verdict: "pass",
        findings: "ok",
      }),
    /候选输入已变化/,
  );
  f.call("主控", "rework", { taskId, reason: "重新验证输入" });
  assert.equal(f.store.read().tasks[0].revision, 2);
});
test("restart preserves original responsibility and receipts but disables roles", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  const restarted = new Workflow(f.store);
  assert.ok(restarted.snapshot().roles.every((r) => !r.enabled));
  assert.equal(restarted.snapshot().tasks[0].id, taskId);
  assert.throws(() => restarted.call("主控", "inbox"), /未开启/);
});
test("member prompt is delivered once per revision without changing the bound session", (t) => {
  const f = setup(t);
  const developer = f.roles[1];
  f.call("ui", "editRole", {
    roleId: developer.id,
    name: "前端开发",
    identityPrompt: "先核对键盘交互。\n保留原始测试证据。",
  });
  const firstWake = f
    .heartbeat()
    .deliveries.find((w) => w.roleId === developer.id);
  assert.match(firstWake.text, /前端开发/);
  assert.match(firstWake.text, /测试项目/);
  assert.equal(
    f.heartbeat().deliveries.find((w) => w.roleId === developer.id).id,
    firstWake.id,
  );
  const first = f.call("开发一", "inbox");
  assert.equal(first.context.project.root, f.root);
  assert.equal(first.context.role.kind, "developer");
  assert.equal(
    first.context.customPrompt,
    "先核对键盘交互。\n保留原始测试证据。",
  );
  assert.equal(f.call("开发一", "inbox").context, undefined);
  assert.equal(
    f.call("开发一", "context").customPrompt,
    first.context.customPrompt,
  );
  f.dispatch();
  const laterWake = f
    .heartbeat()
    .deliveries.find((w) => w.roleId === developer.id);
  assert.match(laterWake.text, /有待处理事项/);
  assert.doesNotMatch(laterWake.text, /键盘交互/);
});
test("each re-enable with responsibility redelivers unchanged context once without duplicating the wake", (t) => {
  const f = setup(t);
  const roleId = f.roles[1].id;
  f.call("ui", "editRole", {
    roleId,
    name: "开发一",
    identityPrompt: "保留测试证据。",
  });
  const initial = f.call("开发一", "inbox").context;
  f.dispatch();
  f.call("开发一", "inbox");
  for (const operationId of ["open-again", "open-later"]) {
    f.call("ui", "enable", { roleId, enabled: false });
    f.call("ui", "enable", { roleId, enabled: true }, operationId);
    const [wake] = f.heartbeat().deliveries.filter((w) => w.roleId === roleId);
    assert.match(wake.text, /角色上下文/);
    f.call("ui", "enable", { roleId, enabled: true }, operationId);
    assert.deepEqual(
      f
        .heartbeat()
        .deliveries.filter((w) => w.roleId === roleId)
        .map((w) => w.id),
      [wake.id],
    );
    assert.deepEqual(f.call("开发一", "inbox").context, initial);
    assert.equal(f.call("开发一", "inbox").context, undefined);
  }
});
test("startup uses role defaults, live bindings and updated personal prompts", (t) => {
  const f = setup(t);
  const [lead, developer, , reviewer] = f.roles;
  f.store.change((s) => {
    delete s.roles.find((r) => r.id === lead.id).identityPrompt;
    s.roles.find((r) => r.id === reviewer.id).identityPrompt = "undefined";
  });
  const expected = [
    [lead, /用户的直接联系人/],
    [developer, /范围内最小且正确的改动/],
    [reviewer, /每项发现写清位置、触发条件/],
  ];
  for (const [role, identity] of expected) {
    f.store.change(s => f.wf.notice(s, role.id, `question:startup-${role.id}`, "待回答问题"));
    f.call("ui", "enable", { roleId: role.id, enabled: false });
    f.call("ui", "enable", { roleId: role.id, enabled: true });
    const [wake] = f.heartbeat().deliveries.filter((w) => w.roleId === role.id);
    assert.match(wake.text, identity);
    assert.ok(wake.text.includes("projectId=" + f.project.id));
    assert.ok(wake.text.includes("roleId=" + role.id));
    assert.ok(wake.text.includes(f.root));
    assert.doesNotMatch(wake.text, /undefined|hive_team/);
    assert.match(f.call(role.name, "context").identityPrompt, identity);
  }
  assert.equal(f.wf.snapshot().roles.find((role) => role.id === lead.id).identityPrompt, "");
  const oldWake = f.heartbeat().deliveries.find((w) => w.roleId === lead.id);
  f.call("ui", "setControllerPolicy", { projectId: f.project.id, policy: "项目主控准则" });
  f.call("ui", "editRole", { roleId: lead.id, identityPrompt: "主控个人提醒" });
  const newWake = f.heartbeat().deliveries.find((w) => w.roleId === lead.id);
  assert.equal(newWake.id, oldWake.id);
  assert.match(newWake.text, /主控个人提醒/);
  assert.match(newWake.text, /项目主控准则/);
  const context = f.call("主控", "inbox").context;
  assert.equal(context.identityPrompt, "主控个人提醒");
  assert.equal(context.duties, "项目主控准则");
  assert.equal(context.role.name, lead.name);
  f.call("ui", "editRole", { roleId: lead.id, identityPrompt: "" });
  assert.match(f.call("主控", "context").identityPrompt, /用户的直接联系人/);
});
test("custom roster, primary routing and safe archival preserve existing obligations", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  f.call("开发一", "question", { taskId, text: "缺少输入" });
  const member = f.call("ui", "addRole", {
    projectId: f.project.id,
    kind: "controller",
    name: "协同主控",
    identityPrompt: "负责通知归集。",
  });
  assert.throws(
    () => f.call("ui", "archiveRole", { roleId: f.roles[0].id }),
    /通知负责人/,
  );
  f.call("ui", "setPrimaryController", { roleId: member.id });
  assert.equal(
    f.wf.snapshot().roles.find((r) => r.id === member.id).isPrimary,
    true,
  );
  assert.ok(
    f.store
      .read()
      .notices.some(
        (n) =>
          n.roleId === member.id && n.key.startsWith("question:") && !n.readAt,
      ),
  );
  f.call("ui", "enable", { roleId: f.roles[1].id, enabled: false });
  assert.throws(
    () => f.call("ui", "archiveRole", { roleId: f.roles[1].id }),
    /未收口/,
  );
  f.call("ui", "enable", { roleId: f.roles[2].id, enabled: false });
  f.call("ui", "archiveRole", { roleId: f.roles[2].id });
  assert.ok(!f.wf.catalog()[0].roles.some((r) => r.id === f.roles[2].id));
  assert.equal(f.store.read().tasks[0].id, taskId);
});
test("only the DSH controller records requirements and dispatches read-only work", (t) => {
  const f = setup(t);
  const input = { text: "回复 Hello", source: "用户说：让开发一回复 Hello" };
  for (const actor of ["ui", "开发一"])
    assert.throws(() => f.call(actor, "approve", input), /DSH 主控/);
  const missingSource = f.call("主控", "approve", { text: input.text });
  assert.equal(missingSource.error, "missing-argument");
  assert.deepEqual(missingSource.missing, ["source"]);
  const requirement = f.call("主控", "approve", input, "confirmed-hello");
  assert.deepEqual(
    f.call("主控", "approve", input, "confirmed-hello"),
    requirement,
  );
  const args = {
    requirementId: requirement.id,
    developerId: f.roles[1].id,
    title: "回复",
    description: "返回 Hello",
    risk: "low",
    writes: [],
    readOnly: true,
  };
  assert.throws(() => f.call("ui", "dispatch", args), /DSH 主控/);
  assert.throws(() => f.call("开发一", "dispatch", args), /DSH 主控/);
  assert.throws(
    () => f.call("主控", "dispatch", { ...args, writes: ["src"] }),
    /只读票/,
  );
  const receipt = f.call("主控", "dispatch", args);
  assert.equal(
    f.call("开发一", "inspect", { taskId: receipt.taskId, section: "full" }).requirement.source,
    input.source,
  );
  assert.equal(f.report(receipt.taskId).state, "stored");
});
test("prompt presets persist and a custom reviewer keeps its copied prompt and review duty", (t) => {
  const f = setup(t);
  const preset = f.call("ui", "savePromptPreset", {
    name: "质量审查",
    identityPrompt: "检查边界。\n记录反例。",
  });
  assert.throws(
    () =>
      f.call("ui", "savePromptPreset", {
        name: preset.name,
        identityPrompt: "重复",
      }),
    /同名/,
  );
  assert.throws(
    () => f.call("主控", "deletePromptPreset", { presetId: preset.id }),
    /仅用户工作台/,
  );
  const custom = f.call("ui", "addRole", {
    projectId: f.project.id,
    kind: "reviewer",
    customLabel: "质量工程师",
    name: "质量一",
    identityPrompt: preset.identityPrompt,
  });
  for (const role of f.roles.filter((r) => r.kind === "reviewer"))
    f.call("ui", "enable", { roleId: role.id, enabled: false });
  const request = f.wf.request({
    roleId: custom.id,
    sessionId: "quality-session",
    cwd: f.root,
  });
  f.call("ui", "confirmBinding", { requestId: request.id });
  f.call("ui", "enable", { roleId: custom.id, enabled: true });
  f.wf.heartbeat([
    { id: "开发一", state: "idle", pending: 0, jobs: 0 },
    { id: "quality-session", state: "idle", pending: 0, jobs: 0 },
  ]);
  const { taskId } = f.dispatch();
  f.report(taskId);
  const inbox = f.call("quality-session", "inbox");
  assert.equal(inbox.tasks[0].id, taskId);
  assert.equal(inbox.context.role.label, "质量工程师");
  assert.equal(inbox.context.role.kind, "reviewer");
  assert.equal(inbox.context.customPrompt, preset.identityPrompt);
  assert.equal(
    f.wf.catalog()[0].roles.find((r) => r.id === custom.id).label,
    "质量工程师",
  );
  f.call("ui", "savePromptPreset", {
    presetId: preset.id,
    name: "新版",
    identityPrompt: "新的内容",
  });
  const reopened = new Store(path.join(path.dirname(f.root), "state.sqlite"));
  try {
    assert.equal(reopened.read().promptPresets[0].identityPrompt, "新的内容");
  } finally {
    reopened.close();
  }
  f.call("ui", "deletePromptPreset", { presetId: preset.id });
  assert.equal(
    f.call("quality-session", "context").customPrompt,
    preset.identityPrompt,
  );
});
test("role authorization, failed checks and out-of-root scopes are rejected", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  assert.throws(() => f.report(taskId, "开发二"), /责任开发者/);
  assert.throws(
    () =>
      f.call("开发一", "report", {
        taskId,
        summary: "失败",
        checks: [{ command: "test", exitCode: 1, evidence: "failure" }],
      }),
    /通过的必要检查/,
  );
  for (const writes of [["../escape"], [".git/config"], ["C:/outside"], [""]])
    assert.throws(() => f.dispatch({ writes }));
});
test("questions notify controller; progress does not; answers retain original task", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch();
  const before = f.store.read().notices.length;
  f.call("开发一", "progress", { taskId, text: "完成一半" });
  assert.equal(f.store.read().notices.length, before);
  const q = f.call("开发一", "question", { taskId, text: "验收输入是什么？" });
  f.call("主控", "answer", {
    taskId,
    questionId: q.questionId,
    text: "见原需求",
  });
  assert.equal(f.store.read().tasks[0].questions[0].answer, "见原需求");
});


test("restarting and reopening replaces an abandoned wake, but keeps the original ticket and operation receipt", (t) => {
  const f = setup(t);
  const role = f.roles[1];
  const { taskId } = f.dispatch({}, "original-dispatch");
  f.call(role.name, "progress", { taskId, text: "已经检查原始输入" });
  // Progress confirms the dispatch. Keep an independent unread input in the old wake.
  f.call("主控", "message", { roleId: role.id, text: "继续核对原责任" });
  const original = f.heartbeat().deliveries.find((wake) => wake.roleId === role.id);
  f.wf.acknowledge(original.id, role.name);
  const persisted = new Store(path.join(path.dirname(f.root), "state.sqlite"));
  t.after(() => persisted.close());
  const wf = new Workflow(persisted);
  const heartbeat = (sessions = []) => wf.heartbeat(sessions).deliveries.filter((wake) => wake.roleId === role.id);
  const live = (state, pending = 0) => [{ id: role.name, state, pending, jobs: 0 }];
  wf.call("ui", "enable", { roleId: role.id, enabled: true }, "reopen-developer");
  assert.deepEqual(heartbeat(), []);
  assert.deepEqual(heartbeat(live("running")), []);
  assert.deepEqual(heartbeat(live("idle", 1)), []);
  const [wake] = heartbeat(live("idle"));
  assert.notEqual(wake.id, original.id);
  assert.match(wake.text, /沿原责任续接/);
  assert.equal(wf.validWake(original.id, role.name).valid, false);
  assert.equal(wf.acknowledge(original.id, role.name).state, "obsolete");
  assert.equal(heartbeat(live("idle"))[0].id, wake.id);
  wf.acknowledge(wake.id, role.name);
  const inbox = wf.call(role.name, "inbox");
  assert.equal(inbox.tasks[0].id, taskId);
  assert.equal(inbox.recovery.tasks[0].progress, "已经检查原始输入");
  assert.equal(inbox.recovery.tasks[0].revision, 1);
  assert.equal(wf.call("ui", "operation", { id: "reopen-developer" }).result.enabled, true);
  assert.equal(persisted.receipt("old-fixture", "original-dispatch").result.taskId, taskId);
  assert.deepEqual(heartbeat(live("idle")), []);
});

test("manual continuation after cancellation recovers a read event and an unfinished original task", (t) => {
  const f = setup(t);
  const [lead, member] = f.roles;
  const { taskId } = f.dispatch();
  f.call(member.name, "inbox");
  f.call(member.name, "question", { taskId, text: "原问题" });
  f.call(lead.name, "inbox");
  const at = Date.now();
  f.wf.heartbeat([{ id: lead.name, state: "idle", pending: 0, jobs: 0, telemetry: {
    state: "idle", since: at, activityAt: at, turn: { id: "cancelled", endedAt: at, outcome: "cancelled" },
  } }], at);
  f.call(member.name, "question", { taskId, text: "新增未读问题" });
  const args = { roleId: lead.id, enabled: true, resume: true };
  assert.deepEqual(f.call("ui", "enable", args, "manual-resume"), { enabled: true, resumeStatus: "waiting-idle" });
  f.call("ui", "enable", args, "manual-resume");
  const card = f.heartbeat().deliveries.find((wake) => wake.roleId === lead.id);
  const status = () => f.wf.snapshot().roles.find((role) => role.id === lead.id).resumeStatus;
  assert.equal(status(), "pending");
  f.wf.acknowledge(card.id, lead.name);
  assert.equal(status(), "delivered");
  assert.match(card.text, /沿原责任续接/);
  const { notices, recovery } = f.call(lead.name, "inbox");
  assert.equal(status(), "read");
  assert.equal(notices.filter((notice) => notice.key.startsWith("resume:")).length, 1);
  assert.equal(recovery.tasks[0].id, taskId);
  assert.equal(recovery.tasks[0].openQuestions.length, 2);
  for (const questionId of recovery.tasks[0].openQuestions)
    f.call(lead.name, "answer", { taskId, questionId, text: "继续原工作" });
  assert.equal(f.report(taskId).state, "stored");
});

test("new read-only delivery requires all three recorded dimensions without inventing evidence", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch({ risk: "low", readOnly: true, writes: [] });
  const proof = { taskId, summary: "核对完成", checks: [{ command: "read a.txt", exitCode: 0, evidence: "确认实际内容" }] };
  assert.throws(() => f.call("开发一", "report", proof), /三维检查结果/);
  const dimensions = { requirements: { state: "pass", evidence: "对照原票" }, implementation: { state: "pass", evidence: "实际输出" }, system: { state: "unverified", evidence: "未运行受影响环境" } };
  assert.equal(f.call("开发一", "report", { ...proof, dimensions }).state, "stored");
  assert.deepEqual(f.store.read().tasks.find((task) => task.id === taskId).reports[0].dimensions, dimensions);
});


test("reviewer reopening preserves the assigned candidate and requires three reviewed dimensions", (t) => {
  const f = setup(t);
  const { taskId } = f.dispatch({ risk: "high", readOnly: true, writes: [] });
  const { candidate } = f.report(taskId);
  const task = f.store.read().tasks.find((item) => item.id === taskId);
  const role = f.roles.find((item) => item.id === task.assignee);
  const wake = f.heartbeat().deliveries.find((item) => item.roleId === role.id);
  f.wf.acknowledge(wake.id, role.name);
  f.call("ui", "enable", { roleId: role.id, enabled: true, resume: true });
  const recovered = f.call(role.name, "inbox").recovery.tasks[0];
  assert.deepEqual([recovered.id, recovered.candidate, recovered.state], [taskId, candidate, "reviewing"]);
  const review = { taskId, candidate, verdict: "pass", findings: "独立核对输出与范围" };
  const dimensions = { requirements: { state: "pass", evidence: "对照冻结目标" }, implementation: { state: "pass", evidence: "复核读取结果" }, system: { state: "pass", evidence: "确认无写入" } };
  assert.throws(() => f.call(role.name, "review", review), /三维检查结果/);
  assert.throws(() => f.call(role.name, "review", { ...review, dimensions: { ...dimensions, system: { state: "issues", evidence: "输出触发了下游副作用" } } }), /三维证据全部通过/);
  assert.equal(f.call(role.name, "review", { ...review, dimensions }).state, "stored");
});

test("read-only scope preview and dispatch distinguish unknown reads, real overlaps and background reads", (t) => {
  const f = setup(t);
  const { taskId: writer } = f.dispatch({ writes: ["web/page.ts", "web/page.test.ts"] });
  const preview = (scope) => f.call("主控", "scopePreview", { writes: [], readOnly: true, ...scope }).conflicts;
  const task = (taskId) => f.call("主控", "inspect", { taskId });
  const reader = { developerId: f.roles[2].id, readOnly: true, risk: "low", writes: [] };
  const unknown = preview({})[0];
  const { taskId, scopeConflict } = f.dispatch(reader);
  assert.equal(task(taskId).state, "queued");
  assert.deepEqual(scopeConflict, unknown);
  const diagnosis = f.call("主控", "diagnoseTask", { taskId });
  assert.equal(diagnosis.reason, unknown.message);
  assert.equal(diagnosis.nextAction, null);
  assert.equal(diagnosis.actionRequired.command, "reviseSchedule");
  assert.deepEqual(diagnosis.actionRequired.requiredParameters, ["reads"]);
  assert.equal(unknown.kind, "read-scope-unknown");
  assert.equal(unknown.taskId, writer);
  assert.equal(unknown.peerRole, "developer");
  assert.match(unknown.message, /scopePreview.*reads/);
  assert.deepEqual(task(taskId).scopeConflict, unknown);
  const overlap = preview({ reads: ["web/page.ts"] })[0];
  assert.equal(overlap.kind, "read/write");
  assert.deepEqual(overlap.paths, ["web/page.ts", "web/page.ts"]);
  assert.match(overlap.message, /web\/page\.ts/);
  assert.deepEqual(preview({ reads: ["server/committed.ts"] }), []);
  assert.deepEqual(preview({ reads: [] }), []);
  const wide = preview({ reads: ["web", "web/page.ts", "web/page.test.ts"] })[0];
  assert.equal(wide.total, 4);
  assert.equal(wide.pairs.length, 4);
  f.call("主控", "reviseSchedule", { taskId, reason: "只读服务端文件", reads: ["server/committed.ts"] });
  assert.equal(task(taskId).state, "assigned");
  assert.equal(task(writer).state, "assigned");

  f.report(taskId, "开发二");
  const background = { reads: [], contextReads: ["web/page.ts"] };
  assert.deepEqual(preview(background), []);
  const next = f.dispatch({ ...reader, ...background });
  assert.equal(task(next.taskId).state, "assigned");
  assert.equal(task(writer).state, "assigned");
});

test("a running investigation with undeclared reads also blocks a later writer", (t) => {
  const f = setup(t);
  const { taskId: reader } = f.dispatch({ risk: "low", readOnly: true, writes: [] });
  const { taskId: writer } = f.dispatch({ developerId: f.roles[2].id, writes: ["service.ts"] });
  const task = () => f.call("主控", "inspect", { taskId: writer });
  assert.equal(task().state, "queued");
  assert.equal(task().scopeConflict.kind, "read-scope-unknown");
  assert.equal(task().scopeConflict.taskId, reader);
  assert.match(task().scopeConflict.message, /对端未声明 reads/);
  f.report(reader);
  assert.equal(task().state, "assigned");
});
