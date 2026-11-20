import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRelay } from "../adapters/dsh/relay.mjs";
import { startServer } from "../src/server.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

async function setup(t) {
  const f = await fixture(t);
  const agent = { id: "Dev", status: "running", inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => [] } };
  const prompts = [];
  const relay = createRelay({
    file: path.join(f.dir, "intervention-delivery.json"), agents: new Map([[agent.id, agent]]), activeJobs: () => 1,
    api: (action, args) => action === "valid" ? f.wf.validWake(args.wakeId, args.sessionId, args.generation) :
      f.wf.acknowledge(args.wakeId, args.sessionId, "dsh", args.delivery),
    controller: { prompt(input) { prompts.push(input); return { accepted: true }; } },
  });
  const task = () => f.store.read().tasks.find(task => task.id === f.taskId);
  const call = (who, command, args, op) => f.call(who, command, { taskId: f.taskId, ...args }, op);
  const heartbeat = ({ member = agent.status, controller = "idle", memberJobs = 0, now = Date.now() } = {}) => f.wf.heartbeat(
    f.roles.filter(role => role.name !== "Dev" || member !== "offline").map(role => ({
      id: role.name, state: role.name === "Dev" ? member : role.name === "Lead" ? controller : "idle",
      ...(role.name === "Dev" ? {
        pending: agent.inbox.nextTurn.length + agent.inbox.nextStep.length, jobs: memberJobs, ...relay.pendingInput(agent),
      } : { pending: 0, jobs: 0 }),
    })),
    now,
  ).deliveries;
  return { ...f, agent, task, call, heartbeat, relay, prompts };
}

test("only the current ticket intervention steers a running member and records receipt separately", async t => {
  const f = await setup(t);
  const before = f.task();
  assert.throws(() => f.call("Dev", "interveneTask", { mode: "guide", reason: "越权" }), /主控/);
  f.call("Lead", "message", { roleId: before.developerId, text: "普通消息照常排队" });
  assert.equal(f.heartbeat().some(wake => wake.sessionId === "Dev"), false);
  const requestArgs = { mode: "guide", reason: "保持原 AC，调整实现顺序" };
  const requested = f.call("Lead", "interveneTask", requestArgs, "guide-once");
  assert.deepEqual(f.call("Lead", "interveneTask", requestArgs, "guide-once"), requested);
  const wake = f.heartbeat().find(item => item.sessionId === "Dev");
  assert.equal(wake.id, requested.intervention.id);
  assert.match(wake.text, /保持原 AC，调整实现顺序/);
  assert.throws(() => f.call("Review", "ackTaskIntervention", { requestId: wake.id, reason: "越权" }), /责任成员/);
  await f.relay.accept([wake, wake]);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, "steer");
  assert.equal(f.task().intervention.state, "requested");
  assert.ok(f.task().intervention.admittedAt);
  f.agent.status = "idle";
  assert.ok(f.heartbeat().some(item => item.sessionId === "Dev" && !item.taskIntervention));
  assert.equal(f.call("Dev", "ackTaskIntervention", { requestId: wake.id, reason: "已按原票纠偏" }).state, "acknowledged");
  assert.equal(f.task().state, "assigned");
  for (const field of ["verification", "writes", "revision", "scheduleVersion", "baseline"])
    assert.deepEqual(f.task()[field], before[field]);
});

test("stop fences new work immediately and pauses only after an uncertain check is reconciled", async t => {
  const f = await setup(t);
  const before = f.task();
  const { jobId: uncertain } = f.call("Dev", "check", { checkId: "red", async: true });
  f.store.change(s => { s.checkJobs.find(job => job.id === uncertain).state = "uncertain"; });
  const { jobId: queued } = f.call("Dev", "check", { checkId: "green", async: true });
  f.put("implementation.cjs", "module.exports = 'working copy';");
  const request = f.call("Lead", "interveneTask", { mode: "stop", reason: "用户取消这项需求" }).intervention;
  assert.equal(f.store.read().checkJobs.find(job => job.id === queued).state, "interrupted");
  assert.equal(f.wf.claimCheck(queued), null);
  for (const [command, args] of [["check", { checkId: "full" }], ["registerChecks", { checks: [] }], ["report", { summary: "旧口径" }]])
    assert.throws(() => f.call("Dev", command, args), /已请求停止/);
  assert.throws(() => f.call("Lead", "releaseSchedule", { reason: "仍未停写" }), /停写|收口/);
  const wake = f.heartbeat().find(wake => wake.id === request.id);
  await f.relay.accept([wake]);
  assert.equal(f.prompts[0].mode, "steer");
  assert.equal(f.call("Dev", "yieldForSchedule", { reason: "外部写入已停止" }).state, "draining");
  assert.equal(f.task().state, "assigned");
  const diagnosed = f.call("Lead", "diagnoseTask", {});
  assert.equal(diagnosed.nextAction.args.jobId, uncertain);
  assert.equal(diagnosed.actionRequired.command, "reconcileCheck");
  f.call("Lead", "reconcileCheck", { jobId: uncertain, evidence: "已核实旧进程退出且资源可复用" });
  assert.equal(f.task().state, "paused");
  const stopped = f.call("Lead", "diagnoseTask", {});
  assert.equal(stopped.classification, "task-stopped");
  assert.ok(stopped.stopRemedies.some(action => action.command === "supersede"));
  assert.equal(f.heartbeat({ controller: "running" }).some(wake => wake.sessionId === "Lead"), false);
  assert.equal(f.store.read().checkJobs.find(job => job.id === uncertain).state, "interrupted");
  assert.deepEqual(f.task().baseline, before.baseline);
  const released = f.call("Lead", "releaseSchedule", { reason: "本票已取消并安全停写" });
  assert.equal(released.scopeReleased, true);
  assert.ok(released.handoff.ownedDirty.includes("implementation.cjs"));
  assert.equal(readFileSync(path.join(f.root, "implementation.cjs"), "utf8"), "module.exports = 'working copy';");
});

test("stale intervention retries cannot deliver, and offline stop resolution requires actual evidence", async t => {
  const f = await setup(t);
  const old = f.call("Lead", "interveneTask", { mode: "guide", reason: "旧纠偏" }).intervention;
  const oldWake = f.heartbeat().find(wake => wake.id === old.id);
  const stop = f.call("Lead", "interveneTask", { mode: "stop", reason: "改为停写" }).intervention;
  await f.relay.accept([oldWake]);
  assert.equal(f.prompts.length, 0);
  assert.throws(() => f.call("Dev", "ackTaskIntervention", { requestId: old.id, reason: "过期" }), /已变化/);
  const resolve = (requestId, decision, evidence) => f.call("Lead", "resolveTaskIntervention", { requestId, decision, reason: "检查原会话", evidence });
  assert.throws(() => resolve(stop.id, "confirm-stopped", "自称已停止"), /尚有回合/);
  assert.equal(f.heartbeat({ member: "offline" }).some(wake => wake.id === stop.id), false);
  const finding = f.call("Lead", "diagnoseTask", {});
  assert.equal(finding.actionRequired.args.decision, "confirm-stopped");
  const retried = resolve(stop.id, "retry").intervention;
  assert.notEqual(retried.id, stop.id);
  assert.equal(f.wf.validWake(stop.id, "Dev", 0).valid, false);
  assert.throws(() => resolve(retried.id, "confirm-stopped"), /证据/);
  assert.equal(f.task().state, "assigned");
  assert.equal(resolve(retried.id, "confirm-stopped", "宿主确认原会话与所有写入子进程已退出").state, "paused");
});

test("withdrawal invalidates an unsent stop and a stopped predecessor exposes an explicit dependency decision", async t => {
  const f = await setup(t);
  const issueStop = () => f.call("Lead", "interveneTask", { mode: "stop", reason: "重新核对要求" }).intervention;
  const original = issueStop();
  const [oldWake] = f.heartbeat().filter(wake => wake.id === original.id);
  assert.equal(f.call("Lead", "resolveTaskIntervention", { requestId: original.id, decision: "withdraw", reason: "继续原要求" }).state, "withdrawn");
  await f.relay.accept([oldWake]);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.call("Dev", "check", { checkId: "red", async: true }).state, "queued");

  const predecessor = f.task();
  const followup = f.wf.call("Lead", "dispatch", {
    requirementId: predecessor.requirementId, developerId: predecessor.developerId,
    title: "下游读票", description: "等待前置结果", risk: "low", readOnly: true,
    writes: [], reads: ["spec.md"], dependencies: [predecessor.id],
  }, "dependent-stop");
  const stop = issueStop();
  f.agent.status = "idle";
  await f.relay.accept(f.heartbeat().filter(wake => wake.id === stop.id));
  assert.equal(f.prompts[0].mode, "queue");
  f.call("Dev", "ackTaskIntervention", { requestId: stop.id, reason: "原票已停止写入" });
  assert.equal(f.task().state, "paused");
  f.call("Lead", "releaseSchedule", { reason: "取消原票" });
  const downstream = f.wf.call("Lead", "diagnoseTask", { taskId: followup.taskId });
  assert.equal(downstream.classification, "dependency-released");
  assert.deepEqual(downstream.actionRequired.requiredParameters, ["after", "reason"]);
  const receipt = f.wf.call("Lead", "reviseSchedule", {
    ...downstream.actionRequired.args, after: [], reason: "用户确认下游无需原前置证据",
  }, "change-dependent");
  assert.equal(receipt.state, "stored");
  assert.deepEqual(f.store.read().tasks.find(task => task.id === followup.taskId).dependencies, []);
});

test("a stop acknowledgment cannot release live host jobs and an offline host has an explicit evidence path", async t => {
  const f = await setup(t);
  f.heartbeat({ memberJobs: 2 });
  const { intervention } = f.call("Lead", "interveneTask", { mode: "stop", reason: "停止后检查宿主作业" });
  assert.equal(f.call("Dev", "ackTaskIntervention", { requestId: intervention.id, reason: "已停止新增写入" }).state, "draining");
  assert.equal(f.call("Lead", "diagnoseTask", {}).hostJobsSettled, false);
  f.heartbeat({ member: "offline" });
  assert.equal(f.task().state, "assigned", "disconnection must not substitute for job exit");
  const finding = f.call("Lead", "diagnoseTask", {});
  assert.equal(finding.actionRequired.args.decision, "confirm-stopped");
  f.heartbeat({ member: "idle", memberJobs: 1 });
  assert.equal(f.task().state, "assigned", "the job needs a host receipt or explicit reconciliation");
  const receipt = f.call("Lead", "resolveTaskIntervention", { ...finding.actionRequired.args,
    reason: "核对重新连接的会话", evidence: "已在宿主核实本票的写入进程退出，剩余作业是其他项目的只读日志监听" });
  assert.equal(receipt.state, "paused");
});

test("the HTTP bridge offers live steering to the bound developer and records pause through the writer", async t => {
  const f = await fixture(t);
  f.close();
  const app = await startServer({ dataDir: f.dir, port: 0 });
  t.after(() => app.close());
  const { bridgeToken } = JSON.parse(readFileSync(path.join(f.dir, "config.json"), "utf8"));
  async function post(route, body) {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (route.startsWith("ui/") ? app.uiToken : bridgeToken) },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok && !data.error, JSON.stringify(data));
    return data;
  }
  for (const role of f.roles) await post("ui/call", { command: "enable", args: { roleId: role.id, enabled: true }, operationId: "enable-" + role.id });
  const heartbeat = () => post("bridge/heartbeat", { sessions: f.roles.map(role => ({
    id: role.name, state: role.name === "Dev" ? "running" : "idle", pending: 0, jobs: 0,
  })) });
  const call = (sessionId, command, args, operationId) => post("bridge/call",
    { sessionId, command, args: { taskId: f.taskId, ...args }, operationId });
  await heartbeat();
  const { intervention } = await call("Lead", "interveneTask", { mode: "stop", reason: "停止实时实现" }, "http-intervention");
  let wake;
  for (let attempt = 0; attempt < 5 && !wake; attempt++)
    wake = (await heartbeat()).deliveries.find(item => item.id === intervention.id);
  assert.equal(wake?.taskIntervention, true);
  assert.deepEqual(await post("bridge/valid", { wakeId: wake.id, sessionId: "Dev", generation: 0 }), { valid: true });
  await post("bridge/ack", { wakeId: wake.id, sessionId: "Dev", delivery: { generation: 0 } });
  assert.equal((await call("Dev", "ackTaskIntervention", { requestId: wake.id, reason: "已收束本票写入" }, "http-stop")).state, "paused");
});

test("a stopped ticket still exposes its Git rebind and waits for an explicit controller decision", async t => {
  const f = await setup(t);
  const file = "implementation.cjs";
  f.put(file, "module.exports = 'already committed';");
  f.git("add", "--", file);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "work before stop");
  const { intervention } = f.call("Lead", "interveneTask", { mode: "stop", reason: "先暂停核对提交" });
  assert.equal(f.call("Dev", "ackTaskIntervention", { requestId: intervention.id, reason: "写入进程已停止" }).state, "paused");
  const finding = f.call("Lead", "diagnoseTask", {});
  assert.equal(finding.nextAction.command, "rebindCommittedWork");
  assert.ok(finding.stopRemedies.some(action => action.command === "releaseSchedule"));
  assert.equal(f.call("Lead", "unblock", { reason: "仅核对恢复动作" }).state, "blocked");
  assert.equal(f.task().state, "paused");
  assert.equal(f.wf.call("Lead", finding.nextAction.command, finding.nextAction.args, "apply-rebind").state, "applied");
});

test("a stop can reach an idle member with a stalled known input without discarding that input", async t => {
  const f = await setup(t);
  f.agent.status = "idle";
  f.agent.inbox.nextTurn.push({ id: "queued-user-input", content: [{ type: "text", text: "原有输入" }] });
  const { intervention } = f.call("Lead", "interveneTask", { mode: "stop", reason: "暂停并保留现有输入" });
  const now = Date.now();
  assert.equal(f.heartbeat({ now }).some(item => item.id === intervention.id), false);
  const wake = f.heartbeat({ now: now + 7000 }).find(item => item.id === intervention.id);
  assert.match(wake.queuedInputFingerprint, /^[a-f0-9]{64}$/);
  await f.relay.accept([wake]);
  assert.equal(f.prompts[0].mode, "steer");
  assert.equal(f.agent.inbox.nextTurn[0].id, "queued-user-input");
});
