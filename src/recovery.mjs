import { ownerStatus } from "./owner-status.mjs";
export function resumeTask(state, task, role, reason, now = Date.now()) {
  const fail = message => { throw Object.assign(Error(message), { verificationCode: "contract-invalid" }); };
  if (!role || role.kind !== "controller" || role.projectId !== task.projectId) fail("仅本项目主控可 resumeTask");
  if (!["assigned", "rework", "paused"].includes(task.state) || task.releasedScope) fail("仅未释放范围的 assigned/rework/paused 原票可恢复");
  const member = state.roles.find(member => member.id === task.developerId);
  const status = ownerStatus(state, task, now);
  if (!status.silent) fail("责任正在执行或状态未确认：" + status.blockers.map(item => `${item.code}：${item.detail}`).join("；"));
  const previous = { state: task.state, deliveredAt: task.deliveredAt, deliveryIssue: task.deliveryIssue };
  task.resumeState = task.state === "rework" ? "rework" : "assigned";
  task.state = "queued"; task.waitReason = null; task.deliveredAt = null;
  task.scheduleVersion = (task.scheduleVersion ?? 0) + 1; task.resumePending = true;
  (task.scheduleHistory ??= []).push({ previous, reason, by: role.id, at: now, resumed: true });
  member.resumeTaskAfter = now; delete member.patrolEpisode;
  delete task.ownerSilentSince; delete task.ownerSilentForMs; delete task.ownerState; delete task.ownerSilentNotified;
  return { state: "stored", taskId: task.id, scheduleVersion: task.scheduleVersion, recoveredBy: "resume", previousOwnerState: "silent" };
}
export function sessionIssue(task, reason, detail, now, attempt = 0) {
  task.deliveryIssue = { reason, detail, at: now, attempt };
}
