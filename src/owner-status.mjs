export const SILENCE_THRESHOLD_MS = 10 * 60 * 1000;
const activeJob = job => ["queued", "launching", "uncertain"].includes(job.state);
export function ownerStatus(state, task, now = Date.now()) {
  const member = state.roles.find(member => member.id === task.developerId);
  const heartbeat = member?.connectedAt ?? 0, observed = member?.observation;
  if (!['assigned','rework','paused'].includes(task.state) || task.releasedScope) return {
    ownerState:'none',ownerSilentForMs:0,lastHeartbeatAt:heartbeat||null,lastTurnState:observed?.turn?.outcome??member?.state??'unknown',silent:false,blockers:[],
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
  if (!status.silent) return `责任正在执行或状态未确认：${status.blockers.map(item => item.detail).join("；")}。`;
  return `成员已静默 ${Math.floor(status.ownerSilentForMs / 60000)} 分钟；可执行 resumeTask ${JSON.stringify({taskId:task.id,reason:"确认静默后沿原票恢复"})}，或请成员 yieldForSchedule ${JSON.stringify({taskId:task.id,reason:"已停写，交回调度"})}。`;
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
