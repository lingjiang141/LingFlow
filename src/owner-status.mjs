export const SILENCE_THRESHOLD_MS = 10 * 60 * 1000;
const activeJob = job => ["queued", "launching", "uncertain"].includes(job.state);
export function ownerStatus(state, task, now = Date.now(), ownerId = task.developerId) {
  const member = state.roles.find(member => member.id === ownerId);
  const heartbeat = member?.connectedAt ?? 0, observed = member?.observation;
  if (!['assigned','rework','paused','reviewing','waiting_review','waiting_verification'].includes(task.state) || task.releasedScope) return {
    ownerState:'none',applicable:false,ownerSilentForMs:0,lastHeartbeatAt:heartbeat||null,lastTurnState:observed?.turn?.outcome??member?.state??'unknown',silent:false,
    blockers:[{code:'state-not-applicable',detail:`当前状态 ${task.state} 不适用成员静默恢复`}],
  };
  const fresh = Boolean(heartbeat && now - heartbeat < 15000 && member.bridgePresent !== false);
  const blockers = [];
  if (!fresh) blockers.push({ code: "heartbeat-unavailable", detail: "心跳过期或会话未连接，先等待原会话新心跳" });
  if (member?.state === "running" || (observed?.at > heartbeat && observed.state === "running"))
    blockers.push({ code: "running-turn", detail: "成员存在进行中的回合" });
  if (member?.pending > 0) blockers.push({ code: "queued-input", detail: `成员有 ${member.pending} 条排队输入` });
  if (member?.jobs > 0) blockers.push({ code: "background-jobs", detail: `成员有 ${member.jobs} 个后台作业` });
  if (state.checkJobs.some(job => activeJob(job) && (job.taskId === task.id || job.taskIds?.includes(task.id) || job.requester === member?.id)))
    blockers.push({ code: "unfinished-check", detail: "成员仍有未收口或待对账后台检查" });
  if (!Number.isSafeInteger(member?.pending) || member.pending < 0 || !Number.isSafeInteger(member?.jobs) || member.jobs < 0 || !["idle", "running"].includes(member?.state))
    blockers.push({ code: "owner-state-unknown", detail: "成员实时状态、排队输入或后台作业数量未知，先核对宿主遥测" });
  const silent = !blockers.length && member?.state === "idle";
  const since = silent ? task.ownerSilentSince ?? Math.max(task.deliveredAt ?? task.admittedAt ?? heartbeat, member.ownerIdleSince ?? observed?.since ?? heartbeat) : null;
  return { ownerState: silent ? "silent" : blockers.some(item => item.code === "running-turn") ? "running" : "unavailable",
    ownerSilentForMs: since == null ? 0 : Math.max(task.ownerSilentForMs ?? 0, now - since),
    lastHeartbeatAt: heartbeat || null, lastTurnState: observed?.turn?.outcome ?? member?.state ?? "unknown", heartbeatState: member?.state ?? "unknown", silent, blockers };
}
export function recoveryHint(state, task) {
  const status = ownerStatus(state, task);
  const inspect = `diagnoseTask ${JSON.stringify({taskId:task.id})}`;
  if (status.applicable === false || ["waiting_review", "reviewing", "waiting_verification", "waiting_batch"].includes(task.state)) {
    const id = JSON.stringify({taskId:task.id});
    const guidance = task.releasedScope ? `用 inspect ${id} 核对已释放责任` : {
      trial: `用户已试用时用 accept 提交实际 evidence。需要变更契约时先用 rework ${JSON.stringify({taskId:task.id,adjustScope:true,reason:"交回原票核对新范围"})}`,
      ready: `用 summarize ${id} 提交试用步骤与验收证据，或先执行 ${inspect} 核对返工路径`,
      queued: `用 ${inspect} 核对待投递的准入条件`,
      waiting_review: `用 ${inspect} 核对待审查回执`,
      reviewing: `用 ${inspect} 核对当前审查，等待原审查回合收口`,
      waiting_verification: `用 ${inspect} 核对待执行的冻结探针`,
      waiting_batch: `用 ${inspect} 核对累计验证`,
    }[task.state] ?? `执行 ${inspect} 核对原票`;
    return `当前状态 ${task.state}。 ${guidance}。`;
  }
  if (!status.silent) {
    const widening = !task.readOnly && ["assigned", "rework"].includes(task.state) && status.blockers.some(item => item.code === "running-turn")
      ? `仅扩写集时保留全部旧路径，把核对后的新增文件填进 writes，再执行 reviseSchedule ${JSON.stringify({
        taskId: task.id, writes: task.writes, reason: "已核对新增文件和原取红范围",
      })}。缩窄或改变其他字段时由成员停写并 yieldForSchedule。` : "";
    return `${status.blockers.map(item => item.detail).join("。") || "暂无法确认成员责任"}。${widening}执行 ${inspect} 核对当前阻塞。`;
  }
  return `成员已静默 ${Math.floor(status.ownerSilentForMs / 60000)} 分钟；需要调整时先用 reviseSchedule。仅恢复原责任时可执行 resumeTask ${JSON.stringify({taskId:task.id,reason:"确认静默后沿原票恢复"})}，或请成员 yieldForSchedule ${JSON.stringify({taskId:task.id,reason:"已停写，交回调度"})}。`;
}
export function updateOwnerSilence(state, task, now) {
  const status = ownerStatus(state, task, now);
  task.lastHeartbeatAt=status.lastHeartbeatAt;task.lastTurnState=status.lastTurnState;
  if (!status.silent || !["assigned", "rework"].includes(task.state) || !task.deliveredAt) {
    delete task.ownerSilentSince; delete task.ownerSilentForMs; delete task.ownerSilentNotified; delete task.ownerState;
    return status;
  }
  task.ownerSilentSince = Math.max(task.ownerSilentSince ?? 0, task.deliveredAt,
    state.roles.find(member=>member.id===task.developerId)?.ownerIdleSince ?? now);
  task.ownerSilentForMs = Math.max(0, now - task.ownerSilentSince);
  if (task.ownerSilentForMs >= SILENCE_THRESHOLD_MS) task.ownerState = "silent";
  return { ...status, ownerSilentForMs: task.ownerSilentForMs };
}
export function recordOwnerHeartbeat(member, session, now) {
  const wasIdle=member.state==="idle"&&member.pending===0&&member.jobs===0&&now-(member.connectedAt??0)<15000;
  if(session.state==="idle"&&session.pending===0&&session.jobs===0) {
    member.ownerIdleSince=wasIdle ? member.ownerIdleSince ?? now : now;
    const activity=session.telemetry?.activityAt;
    if(Number.isSafeInteger(activity)&&activity<=now)member.ownerIdleSince=Math.max(member.ownerIdleSince,activity);
  } else delete member.ownerIdleSince;
}
