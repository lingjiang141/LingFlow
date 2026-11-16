export function compactCheck(job) {
  const receipt = job.receipt ?? {};
  return { id: job.id, taskId: job.taskId, check: { id: job.check.id, stage: job.check.stage }, state: job.state,
    classification: job.classification ?? null, environmentFailure: job.environmentFailure ?? receipt.environmentFailure ?? false,
    ...(job.reason && { reason: String(job.reason).slice(0, 100) }),
    ...(job.membersCanRetry !== undefined && { membersCanRetry: job.membersCanRetry }),
    ...(receipt.evidenceKind && {evidenceKind:receipt.evidenceKind,caseReadback:receipt.caseReadback}),
    receipt: { exitCode: receipt.exitCode ?? null, failureOutputSeen: receipt.failureOutputSeen ?? false,
      testCountSeen: receipt.testCountSeen ?? false, environmentFailure: receipt.environmentFailure ?? job.environmentFailure ?? false,
      elapsedMs: receipt.elapsedMs ?? (Number.isFinite(receipt.finishedAt) && Number.isFinite(receipt.startedAt ?? job.startedAt) ? receipt.finishedAt - (receipt.startedAt ?? job.startedAt) : null) } };
}
export function checkStatusResponse(jobs, args) {
  if (args.detail !== undefined && !['full', 'compact'].includes(args.detail)) throw Error('detail 仅支持 compact 或 full');
  const offset = args.offset ?? 0, limit = args.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw Error('checkStatus offset 须非负，limit 须为1–200');
  const selected = jobs.slice(offset, offset + limit);
  const items = args.detail === 'full' ? selected : selected.map(compactCheck);
  // Small default responses remain arrays. Paging metadata is explicit when
  // requested or needed so no records silently disappear beyond the first page.
  return args.limit !== undefined || args.offset !== undefined || jobs.length > limit
    ? { items, offset, limit, scanned: jobs.length, total: jobs.length, truncated: offset + items.length < jobs.length,
      nextOffset: offset + items.length < jobs.length ? offset + items.length : null }
    : items;
}
