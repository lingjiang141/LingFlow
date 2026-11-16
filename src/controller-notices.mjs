import { parseCommandArgs } from './command-arguments.mjs';
export const inspectionCommands = new Set(['inspect','list','checkStatus','checkEvidence','diagnoseTask','deliveryEvidence']);
export const inspectionMetadata = Symbol.for('lingflow.inspection.metadata');
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

export function selectWakeNotices(s, role, unread) {
  const reads = s.controllerReads?.[role.id];
  const controller = role.kind === 'controller';
  const notices = unread.map(notice => {
    const kind = notice.key.split(':')[0], ref = notice.key.split(':')[1];
    const task = s.tasks.find(task => task.id === notice.taskId);
    const checkedAt = Math.max(reads?.tasks?.[notice.taskId] ?? 0, ['check','batch'].includes(kind) ? reads?.jobs?.[ref] ?? 0 : 0);
    const controllerChecked = Boolean(controller && reads && reads.sinceInbox === (role.lastInboxAt ?? 0) &&
      (reads.notices ? reads.notices[notice.id] : checkedAt >= notice.at));
    const critical = /^(question|report-blocked|review-blocked|preflight|preflight-blocked|check-reconcile|batch-stale|delivery-blocked|owner-silent|patrol-alert|wake-stuck|schedule)$/.test(kind) ||
      kind === 'review' && task?.state === 'changes_requested';
    const abnormal = ['failed','transient'].includes(role.observation?.turn?.outcome) ||
      s.tasks.some(task => task.projectId === role.projectId && (task.ownerState === 'silent' || task.state === 'blocked' || task.deliveryIssue));
    const quietPatrol = controller && kind === 'patrol-resume' && !abnormal;
    const informational = controller && (['check','batch','context'].includes(kind) || quietPatrol ||
      ['dependency-ready','preflight-ready'].includes(kind) && !task?.deliveredAt);
    const resolved = kind === 'preflight' && task && !task.preflightFailure ||
      kind === 'question' && task?.questions?.some(question => question.id === ref && question.answer) ||
      kind === 'wake-stuck' && !s.wakes.some(wake=>wake.id===ref&&wake.lostAt&&!wake.consumedAt&&!wake.supersededAt&&
        (!notice.wakeLossAt||notice.wakeLossAt===wake.lostAt));
    return { ...notice, controllerChecked, actionable: !informational, critical, suppress: Boolean(resolved || quietPatrol || controllerChecked && !critical),
      suppressionReason:resolved?'resolved':quietPatrol?'healthy-patrol':controllerChecked&&!critical?'controller-checked':null };
  });
  const eligible = notices.filter(notice => !notice.suppress);
  return { notices: eligible, actionable: eligible.some(notice => notice.actionable), suppressed: notices.length - eligible.length,
    suppressedNotices:notices.filter(notice=>notice.suppress).map(notice=>({id:notice.id,reason:notice.suppressionReason})) };
}
