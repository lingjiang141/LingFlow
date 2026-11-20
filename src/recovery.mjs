import { ownerStatus } from "./owner-status.mjs";
export function resumeTask(state, task, role, reason, now = Date.now()) {
  const fail = message => { throw Object.assign(Error(message), { verificationCode: "contract-invalid" }); };
  if (!role || role.kind !== "controller" || role.projectId !== task.projectId) fail("仅本项目主控可 resumeTask");
  if (!["assigned", "rework", "paused", "reviewing", "waiting_review", "waiting_verification"].includes(task.state) || task.releasedScope) fail("仅未释放范围且仍有开发、审查或独立验证责任的原票可恢复");
  const developerStage = ["assigned", "rework", "paused"].includes(task.state) && !task.pausedFrom;
  const ownerId = task.state === "reviewing" ? task.assignee : developerStage ? task.developerId : null;
  const member = state.roles.find(member => member.id === ownerId);
  if (ownerId) {
    const status = ownerStatus(state, task, now, ownerId);
    if (!status.silent) fail("责任正在执行或状态未确认：" + status.blockers.map(item => `${item.code}：${item.detail}`).join("；"));
  }
  const previous = { writes: [...task.writes], state: task.state, deliveredAt: task.deliveredAt, deliveryIssue: task.deliveryIssue };
  if (developerStage) {
    task.resumeState = task.state === "rework" || task.reworkReason ? "rework" : "assigned";
    task.state = "queued";
    task.deliveredAt = null;
    task.resumePending = true;
    member.resumeTaskAfter = now;
    delete member.patrolEpisode;
  } else {
    task.state = task.pausedFrom ?? (task.state === "reviewing" ? "waiting_review" : task.state);
    delete task.pausedFrom;
    task.assignee = null;
    task.reviewDeliveredAt = null;
  }
  task.waitReason = null;
  delete task.deliveryIssue;
  task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
  (task.scheduleHistory ??= []).push({ previous, reason, by: role.id, at: now, resumed: true });
  delete task.ownerSilentSince; delete task.ownerSilentForMs; delete task.ownerState; delete task.ownerSilentNotified;
  return { state: "stored", taskId: task.id, scheduleVersion: task.scheduleVersion, recoveredBy: "resume", previousOwnerState: ownerId ? "silent" : "none" };
}
export function sessionIssue(task, reason, detail, now, attempt = 0) {
  task.deliveryIssue = { reason, detail, at: now, attempt };
}
