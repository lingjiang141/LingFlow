import { sessionIssue } from "./recovery.mjs";
import { activeWake, consumeWake } from './wake-state.mjs';
const FRESH_MS = 15000;
const IDLE_GRACE_MS = 90000;
const RUNNING_GRACE_MS = 10 * 60 * 1000;
const COOLDOWNS = [30000, 120000];
const taskStates = new Set(["assigned", "rework", "reviewing"]);
const decisionStates = new Set([
  "ready",
  "waiting_verification",
  "changes_requested",
]);
const activeJobs = new Set(["queued", "launching", "uncertain"]);

export function recordObservation(role, session, now) {
  const input = session.telemetry;
  if (!input || typeof input !== "object") {
    delete role.observation;
    return;
  }
  const old = role.observation;
  const time = (value) =>
    Number.isSafeInteger(value) && value > 0 && value <= now + 5000 ? value : 0;
  const turn =
    input.turn && typeof input.turn.id === "string"
      ? {
          id: input.turn.id.slice(0, 100),
          startedAt: time(input.turn.startedAt),
          endedAt: time(input.turn.endedAt),
          outcome: ["ended", "cancelled", "failed", "transient"].includes(
            input.turn.outcome,
          )
            ? input.turn.outcome
            : null,
          code:
            typeof input.turn.code === "string"
              ? input.turn.code.replace(/[^a-z0-9_-]/gi, "").slice(0, 60)
              : "",
        }
      : null;
  role.observation = {
    state: session.state,
    since:
      old?.state === session.state && now - old.at <= FRESH_MS
        ? old.since
        : now,
    at: now,
    activityAt: time(input.activityAt),
    turn,
    compacting: input.compacting === true,
  };
}

function outstanding(s, role, isLead) {
  const tasks = s.tasks.filter(
    (task) =>
      task.projectId === role.projectId &&
      ((task.assignee === role.id && taskStates.has(task.state)) ||
        (isLead &&
          (decisionStates.has(task.state) ||
            (taskStates.has(task.state) &&
              task.questions.some((question) => !question.answer))))),
  );
  const hasActiveJob = (task) =>
    s.checkJobs.some(
      (job) =>
        activeJobs.has(job.state) &&
        (task.id === job.taskId || job.taskIds?.includes(task.id)),
    );
  return {
    tasks,
    blocked:
      !isLead &&
      tasks.length > 0 &&
      tasks.every((task) => task.questions.some((q) => !q.answer)),
    checking: tasks.length
      ? tasks.every(hasActiveJob)
      : s.checkJobs.some(
          (job) => activeJobs.has(job.state) && job.requester === role.id,
        ),
  };
}

export function inspectRole({ s, role, project, lead, now, live, notify }) {
  const set = (state, label) => {
    role.patrolStatus = { state, label };
  };
  if (!role.enabled || !role.sessionId || project.autoPatrol === false) {
    delete role.patrolStatus;
    return;
  }
  const work = outstanding(s, role, role.id === lead?.id);
  const task = work.tasks[0];
  const scope =
    work.tasks
      .map((item) => `${item.id}:${item.revision}:${item.scheduleVersion ?? 0}`)
      .sort()
      .join("/") || "session";
  if (role.patrolEpisode?.scope !== scope)
    role.patrolEpisode = { scope, startedAt: now, attempts: 0, alerts: [] };
  const episode = role.patrolEpisode;
  const alert = (kind, label) => {
    set(kind, label);
    if (["offline", "retry-limit"].includes(kind)) for (const item of work.tasks)
      sessionIssue(item, kind === "retry-limit" ? "continuation-limit" : "session-not-connected", label, now, episode.attempts);
    if (
      task &&
      lead?.id !== role.id &&
      lead &&
      !episode.alerts.includes(kind)
    ) {
      episode.alerts.push(kind);
      notify(
        lead.id,
        `patrol-alert:${role.id}:${episode.startedAt}:${scope}:${kind}`,
        `${role.name}：${label}`,
        task.id,
      );
    }
  };
  if (role.toolsMissing?.length) return set("bridge-tools-missing", "bridge-tools-missing：成员工具未恢复，暂停自动续接");
  const seen = role.observation;
  if (!role.connectedAt || now - role.connectedAt >= FRESH_MS) {
    if (now - Math.max(role.connectedAt || 0, role.enabledAt || 0) >= FRESH_MS)
      alert("offline", "DSH 会话未响应，巡检暂停续接");
    else set("connecting", "等待 DSH 实时状态");
    return;
  }
  if (!seen) return set("unobserved", "等待新版 DSH 巡检遥测");
  const elapsed = now - Math.max(seen.since, seen.activityAt);
  if (seen.state === "running") {
    if (role.jobs > 0 || work.checking)
      set("running", "DSH 运行中，已有后台作业");
    else if (elapsed >= RUNNING_GRACE_MS)
      alert("slow", "DSH 仍显示运行，但长时间没有新活动");
    else set("running", "DSH 实时运行中");
    return;
  }
  if (seen.state === "error")
    return alert("error", "DSH 报告执行异常，会话尚未恢复空闲");
  if (seen.state !== "idle") return set("unknown", "DSH 状态尚不能确认");
  if (role.pending > 0) return set("pending", "DSH 有待处理输入");
  if (role.jobs > 0 || work.checking)
    return set("checking", "等待现有后台作业或作业对账");
  if (work.blocked) return set("blocked", "原票等待主控答复");
  if (role.pending !== 0 || role.jobs !== 0)
    return set("unknown", "待输入或作业状态尚不能确认");
  const turn = seen.turn?.endedAt >= (role.enabledAt ?? 0) ? seen.turn : null;
  if (turn?.code === "continuation-limit") return alert("retry-limit", "成员会话自动续接轮次用尽，需宿主侧恢复会话");
  if (turn?.outcome === "cancelled")
    return set("cancelled", "DSH 回合已取消，等待用户继续");
  if (turn?.outcome === "failed")
    return alert(
      "error",
      "DSH 执行异常，需要核对" + (turn.code ? "（" + turn.code + "）" : ""),
    );
  if (!task && turn?.outcome !== "transient") {
    if (episode.attempts) delete role.patrolEpisode;
    return set("idle", "DSH 空闲，当前无待续责任");
  }
  const retryable = turn?.outcome === "transient";
  if (role.kind === "controller" && !retryable && !work.tasks.some(task => task.ownerState === "silent" || task.deliveryIssue || task.state === "blocked"))
    return set("idle-duty", "主控无异常，待办仅保留在 inbox，不自动续接");
  const grace = retryable
    ? COOLDOWNS[Math.min(episode.attempts, COOLDOWNS.length - 1)]
    : IDLE_GRACE_MS;
  const started = Math.max(
    seen.since,
    retryable ? turn.endedAt : seen.activityAt,
    episode.lastRetryAt ?? 0,
  );
  if (now - started < grace) {
    return set(
      episode.attempts ? "recovering" : retryable ? "cooldown" : "idle-duty",
      episode.attempts
        ? `已安排原会话续接（${episode.attempts}/${COOLDOWNS.length}）`
        : retryable
          ? "DSH 暂时异常，等待冷却后续接"
          : "DSH 已空闲，巡检正在确认开放责任",
    );
  }
  if (episode.attempts >= COOLDOWNS.length)
    return alert("retry-limit", "已达到自动续接上限，需核对原会话");
  if (!live || now - seen.at > 6000) return;
  const wake = s.wakes.find(
    (item) => item.roleId === role.id && activeWake(item),
  );
  if (!wake && s.wakes.some(item => item.roleId === role.id && item.state === "failed" && !item.consumedAt &&
      s.notices.some(notice => item.noticeIds.includes(notice.id) && !notice.readAt && notice.taskId === (task?.id ?? null))))
    return set("delivery-failed", "原唤醒达到自动重投上限，等待原会话读取 inbox 或明确续接");
  if (wake?.state === "pending") {
    if (role.deliveryIssue)
      alert("delivery", "DSH 投递结果不明，需要在原会话对账");
    return;
  }
  if (wake?.state === "enqueued") {
    if (
      !turn?.endedAt ||
      (turn.endedAt <= (wake.admittedAt ?? wake.at) && turn.startedAt < wake.at)
    )
      return alert("delivery", "上一条唤醒已送达，尚无回合结束证据");
    consumeWake(wake,now,'patrol-continuation');
  }
  episode.attempts++;
  episode.lastRetryAt = now;
  const detail = retryable
    ? "DSH 暂时异常" + (turn.code ? "（" + turn.code + "）" : "")
    : "DSH 已空闲，但原责任尚未收口";
  notify(
    role.id,
    `patrol-resume:${episode.startedAt}:${scope}:${episode.attempts}`,
    detail,
    task?.id ?? null,
  );
  set(
    "recovering",
    `已安排原会话续接（${episode.attempts}/${COOLDOWNS.length}）`,
  );
}
