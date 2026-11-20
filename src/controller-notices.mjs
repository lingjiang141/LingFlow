import { parseCommandArgs } from './command-arguments.mjs';
import { activeWake } from './wake-state.mjs';
export const inspectionCommands = new Set(['inspect','list','checkStatus','checkEvidence','diagnoseTask','deliveryEvidence']);
export const inspectionMetadata = Symbol.for('lingflow.inspection.metadata');
export const silentResumeText = '本轮无你的责任，无需核对收件箱；如无异常请直接结束回合。';
export const resumeText = '角色已开启或请求续接。读取收件箱内原责任和恢复索引，核对实际工作区、候选与检查回执后续接。';
const reviewWakeKinds = /^(review|question|answer):/;

export function roleHasOpenResponsibility(role, state) {
  const reviewer = role.kind === 'reviewer';
  const wakeKinds = reviewer ? reviewWakeKinds : /^(question|answer|dispatch|review|check):/;
  return state.tasks.some(task => task.assignee === role.id && (['assigned', 'rework', 'reviewing'].includes(task.state) ||
    !reviewer && task.state === 'waiting_verification' && !task.candidate && task.fingerprintRecovery) &&
    (!reviewer || task.candidate && task.state === 'reviewing')) ||
    state.notices.some(notice => notice.roleId === role.id && !notice.readAt && !notice.workConfirmedAt && wakeKinds.test(notice.key));
}

export function isSilentNotice(role, notice) {
  return notice.silent === true || role.kind === 'reviewer' && !notice.key.startsWith('resume:') && !reviewWakeKinds.test(notice.key);
}
export function inspectedEntities(command, raw, result) {
  if (!inspectionCommands.has(command) || !result || ['missing-argument','not-found','invalid-argument-json','invalid-arguments-shape'].includes(result.error)) return null;
  const args = parseCommandArgs(raw), tasks = new Set(), jobs = new Set();
  if (typeof args.taskId === 'string') tasks.add(args.taskId);
  if (typeof args.jobId === 'string') jobs.add(args.jobId);
  if (command === 'list') for (const task of result.tasks ?? []) tasks.add(task.id);
  for (const job of Array.isArray(result) ? result : result.items ?? []) {
    if (job.id) jobs.add(job.id); if (job.taskId) tasks.add(job.taskId);
  }
  if (['checkStatus','checkEvidence'].includes(command) && result.id) jobs.add(result.id);
  if (result.taskId) tasks.add(result.taskId);
  return { tasks: [...tasks], jobs: [...jobs], ...result[inspectionMetadata] };
}

export function selectWakeNotices(s, role, unread, { ignoreFailed = false } = {}) {
  const reads = s.controllerReads?.[role.id];
  const controller = role.kind === 'controller';
  const abandoned = new Set(ignoreFailed ? [] : (s.wakes ?? []).filter(wake => wake.state === "failed" && !wake.consumedAt && wake.roleId === role.id)
    .flatMap(wake => wake.noticeIds));
  for (const wake of s.wakes ?? []) if (wake.roleId === role.id && activeWake(wake))
    for (const id of wake.noticeIds) abandoned.delete(id);
  const notices = unread.filter(notice => !notice.workConfirmedAt).map(notice => {
    const silent = isSilentNotice(role, notice);
    const kind = notice.key.split(':')[0], ref = notice.key.split(':')[1];
    const task = s.tasks.find(task => task.id === notice.taskId);
    const checkedAt = Math.max(reads?.tasks?.[notice.taskId] ?? 0, ['check','batch'].includes(kind) ? reads?.jobs?.[ref] ?? 0 : 0);
    const controllerChecked = Boolean(controller && reads && reads.sinceInbox === (role.lastInboxAt ?? 0) &&
      (reads.notices ? reads.notices[notice.id] : checkedAt >= notice.at));
    const critical = /^(question|report-blocked|review-blocked|preflight|preflight-blocked|check-reconcile|batch-stale|delivery-blocked|owner-silent|patrol-alert|wake-stuck|wake-abandoned|schedule)$/.test(kind) ||
      kind === 'review' && task?.state === 'changes_requested';
    const abnormal = ['failed','transient'].includes(role.observation?.turn?.outcome) ||
      s.tasks.some(task => task.projectId === role.projectId && (task.ownerState === 'silent' || task.state === 'blocked' || task.deliveryIssue));
    const quietPatrol = controller && kind === 'patrol-resume' && !abnormal;
    const informational = controller && (['check','batch','context','git-drift'].includes(kind) || quietPatrol ||
      ['dependency-ready','preflight-ready'].includes(kind) && !task?.deliveredAt ||
      kind === "wake-abandoned" && s.wakes.some(wake => wake.id === ref && wake.roleId === role.id));
    const noMemberWork = !controller && task && (task.state === "trial" || task.state === "accepted" ||
      task.candidate && task.developerId === role.id && !["assigned", "rework"].includes(task.state)) &&
      !["message", "question", "answer", "verification-resume"].includes(kind);
    const resolved = kind === 'preflight' && task && !task.preflightFailure ||
      kind === 'question' && task?.questions?.some(question => question.id === ref && question.answer) ||
      kind === 'wake-stuck' && !s.wakes.some(wake=>wake.id===ref&&wake.state!=="failed"&&wake.lostAt&&!wake.consumedAt&&!wake.supersededAt&&
        (!notice.wakeLossAt||notice.wakeLossAt===wake.lostAt));
    const alreadyCovered = controllerChecked && !critical && kind !== 'git-drift';
    const abandonedDelivery = abandoned.has(notice.id);
    return { ...notice, controllerChecked, ...(silent && { silent }),
      actionable: !silent && !informational && !noMemberWork && !abandonedDelivery, critical,
      suppress: Boolean(noMemberWork || abandonedDelivery || resolved || quietPatrol || alreadyCovered),
      suppressionReason: noMemberWork ? "no-member-responsibility" :
        abandonedDelivery ? "delivery-loss-limit" : resolved ? "resolved" :
        quietPatrol ? "healthy-patrol" : alreadyCovered ? "controller-checked" : null };
  });
  const eligible = notices.filter(notice => !notice.suppress);
  return { notices: eligible, actionable: eligible.some(notice => notice.actionable), suppressed: notices.length - eligible.length,
    suppressedNotices:notices.filter(notice=>notice.suppress).map(notice=>({id:notice.id,reason:notice.suppressionReason})) };
}
