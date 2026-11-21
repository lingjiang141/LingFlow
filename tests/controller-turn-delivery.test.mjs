import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRelay } from "../adapters/dsh/relay.mjs";
import { createDshTelemetry } from "../adapters/dsh/telemetry.mjs";
import { dshWakeText } from "../src/role-context.mjs";
import { dshWakeSummary } from "../src/wake-card.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

async function setup(t) {
  const f = await fixture(t);
  const role = f.roles.find(item => item.kind === "controller");
  const events = [], listeners = new Map(), prompts = [];
  const agent = { id: role.name, status: "idle", inbox: { nextTurn: [], nextStep: [] },
    session: { snapshotEvents: () => events } };
  const observe = createDshTelemetry({ on: (name, listener) => listeners.set(name, listener) });
  let now = Date.now();
  const emit = (type, turn) => {
    const event = { type, time: ++now, seq: events.length + 1, data: { turn, reason: { kind: "completed" } } };
    events.push(event);
    listeners.get("session/event")(agent.session, event);
  };
  const relayOptions = {
    file: path.join(f.dir, "controller-turn-ledger.json"),
    agents: new Map([[agent.id, agent]]), activeJobs: () => 0, observe,
    api: (action, args) => action === "valid" ? f.wf.validWake(args.wakeId, args.sessionId, args.generation) :
      f.wf.acknowledge(args.wakeId, args.sessionId, "dsh", args.delivery),
    controller: { prompt(input) { prompts.push(input); return { accepted: true }; } },
  };
  const heartbeat = () => f.wf.heartbeat(f.roles.map(member => member.id === role.id ? {
    id: agent.id, state: agent.status, jobs: 0, pending: agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
    telemetry: observe(agent), ...createRelay(relayOptions).pendingInput(agent),
  } : { id: member.name, state: "idle", jobs: 0, pending: 0 }), now).deliveries.filter(wake => wake.sessionId === agent.id);
  const notice = (index) => f.store.change(s => {
    const notice = f.wf.notice(s, role.id, `report:fixture-${index}`, `报告 ${index}`, f.taskId);
    notice.at = ++now;
    return notice.id;
  });
  return { ...f, role, agent, emit, notice, heartbeat, relayOptions, prompts, observe,
    advance: ms => { now += ms; } };
}

test("controller returns accumulate across a turn and compaction, then queue once on the matched end", async t => {
  const f = await setup(t);
  const relay = createRelay(f.relayOptions);
  f.emit("turn/start", 1);
  f.agent.status = "running";
  const reports = [f.notice(1)];
  assert.deepEqual(f.heartbeat(), []);
  f.emit("compaction/start", 1);
  reports.push(f.notice(2));
  f.agent.status = "idle";
  assert.deepEqual(f.heartbeat(), []);
  f.emit("compaction/end", 1);
  reports.push(f.notice(3));
  f.emit("turn/end", 0);
  assert.deepEqual(f.heartbeat(), [], "an idle sample or the wrong end must not release the live turn");
  f.emit("turn/end", 1);
  const wakes = f.heartbeat();
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].noticeIds, reports);
  assert.ok(reports.every(id => f.store.read().notices.some(n => n.id === id && !n.readAt)));
  await relay.accept(wakes);
  await relay.accept(f.heartbeat());
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, "queue");
});

test("DSH controller short cards lead with ticket results and keep complete evidence in the original ticket", async t => {
  const f = await setup(t);
  f.call("Lead", "inbox");
  f.notice(1);
  const dimensions = {
    requirements: { state: "pass", evidence: "证据详情只在原票" },
    implementation: { state: "issues", evidence: "旧文件入口不一致" },
    system: { state: "unverified", evidence: "多项目选择尚未覆盖" },
  };
  f.store.change(s => {
    const task = s.tasks.find(task => task.id === f.taskId);
    task.ticketKey = "R8-04";
    task.title = "优化考核导出";
    task.reports.push({ id: "fixture-1", summary: "考核报表支持按部门导出", dimensions });
    task.reviews.push({ id: "fixture-review", verdict: "changes", findings: "跨部门导出时可能漏行", dimensions });
    f.wf.notice(s, f.role.id, "review:fixture-review", "审查需返工", task.id);
    f.wf.notice(s, f.role.id, "check:fixture-check:passed", "普通检查回执", task.id);
    const developer = s.roles.find(role => role.kind === "developer");
    s.messages.push({ id: "fixture-message", from: developer.id, to: f.role.id, projectId: task.projectId, text: "旧版模板是否保留？" });
    f.wf.notice(s, f.role.id, "message:fixture-message", "成员回复：fixture-message");
  });
  f.advance(30000);
  const [wake] = f.heartbeat();
  await createRelay(f.relayOptions).accept([wake]);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].content[0].text, wake.text);
  assert.ok(wake.text.indexOf("主控不得写业务代码") < wake.text.indexOf("当前事项"));
  for (const expected of ["R8-04《优化考核导出》", "考核报表支持按部门导出", "跨部门导出时可能漏行",
    "开发自测", "三维审查", "需求正确性 通过", "实现一致性 有问题", "系统影响 未验证", "旧版模板是否保留？", "inbox"])
    assert.ok(wake.text.includes(expected), expected);
  assert.doesNotMatch(wake.text, /actionable|动态详情|当前状态|HEAD：|taskId=|candidate=|context:v|普通检查回执|证据详情只在原票/);
  assert.ok(wake.text.length <= 760);
  assert.equal(f.call("Lead", "inbox").notices.length, 4);
  const { items: [review] } = f.call("Lead", "inspect", { taskId: f.taskId, section: "reviews" });
  assert.equal(review.findings, "跨部门导出时可能漏行");
  assert.deepEqual(review.dimensions, dimensions);
});

test("short cards keep all three results on each shown ticket within the display budget", () => {
  const dimensions = Object.fromEntries(["requirements", "implementation", "system"].map(key => [key, { state: "pass" }]));
  const tasks = Array.from({ length: 5 }, (_, index) => ({ id: `task-${index}`, ticketKey: `R8-0${index + 1}`,
    title: "考核结果😀".repeat(20), reviews: [{ id: `review-${index}`, verdict: "pass", dimensions, findings: "有结果😀".repeat(200) }] }));
  const notices = tasks.map((task, index) => ({ key: `review:review-${index}`, taskId: task.id, summary: "审查通过", actionable: true }));
  const summary = dshWakeSummary(notices, tasks, [], []);
  const card = dshWakeText({ name: "项目".repeat(50) }, { name: "主控".repeat(50), kind: "controller" }, summary);
  assert.ok(card.length <= 760);
  assert.equal((card.match(/系统影响 通过/g) ?? []).length, 4);
  assert.match(card, /另有 1 项，见收件箱。$/);
});

test("a stale boundary cannot admit a report while validating against a new turn or an open compaction", async t => {
  const f = await setup(t);
  f.emit("turn/start", 1);
  f.notice(1);
  f.emit("turn/end", 1);
  f.advance(30000);
  const [old] = f.heartbeat();
  assert.ok(old);
  const api = f.relayOptions.api;
  let raced = false;
  f.relayOptions.api = async (action, args) => {
    const result = await api(action, args);
    if (action === "valid" && !raced) {
      raced = true;
      f.emit("turn/start", 2);
    }
    return result;
  };
  const relay = createRelay(f.relayOptions);
  await relay.accept([old]);
  assert.deepEqual(f.prompts, []);
  f.emit("turn/end", 2);
  f.emit("compaction/start", 2);
  assert.deepEqual(f.heartbeat(), []);
  f.emit("compaction/end", 2);
  await relay.accept([old]);
  assert.deepEqual(f.prompts, [], "a wake offered at a previous turn boundary must be refreshed");
  await relay.accept(f.heartbeat());
  assert.equal(f.prompts[0]?.mode, "queue");
});

test("pending human input wins over a controller return even after the existing queue-drain delay", async t => {
  const f = await setup(t);
  f.emit("turn/start", 1);
  f.notice(1);
  f.emit("turn/end", 1);
  f.agent.inbox.nextTurn.push({ id: "next-user-input", source: { kind: "user" }, content: [{ type: "text", text: "继续规划" }] });
  assert.deepEqual(f.heartbeat(), []);
  f.advance(30000);
  assert.deepEqual(f.heartbeat(), []);
  assert.equal(f.agent.inbox.nextTurn[0].id, "next-user-input");
  f.agent.inbox.nextTurn.shift();
  f.emit("turn/start", 2);
  assert.deepEqual(f.heartbeat(), []);
  f.emit("turn/end", 2);
  const wakes = f.heartbeat();
  const relay = createRelay(f.relayOptions);
  assert.equal(wakes.length, 1);
  // The next user input reaches DSH after the service emitted this wake.
  f.agent.inbox.nextStep.push({ id: "new-host-input" });
  await relay.accept(wakes);
  assert.deepEqual(f.prompts, []);
  f.agent.inbox.nextStep.shift();
  f.emit("turn/start", 3);
  f.emit("turn/end", 3);
  await relay.accept(f.heartbeat());
  assert.equal(f.prompts[0]?.mode, "queue");
});

test("a restarted bridge observes an open turn and compaction beyond the recent event window", () => {
  const now = Date.now();
  const events = [
    { type: "turn/start", seq: 1, time: now, data: { turn: 4 } },
    { type: "compaction/start", seq: 2, time: now, data: { turn: 4 } },
    ...Array.from({ length: 250 }, (_, index) => ({ type: "tool/result", seq: index + 3, time: now })),
  ];
  const observe = createDshTelemetry({ on() {} });
  const observation = observe({ session: { snapshotEvents: () => events } });
  assert.equal(observation.turn.startedAt, now);
  assert.equal(observation.turn.endedAt, undefined);
  assert.equal(observation.compacting, true);
});
