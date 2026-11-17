import { executionFacts, redEvidenceRequirement } from './evidence-facts.mjs';
export const environmentFailureHint = '责任开发成员先跑 npm run build 或修复本机依赖，不算票面红/绿证据；主控不得在本机执行该命令后自称已验';

export function detectEnvironmentFailure(receipt = {}, output = '', startedAt = receipt?.startedAt, check) {
  receipt ??= {};
  const plain = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const facts = executionFacts(check ?? receipt.evidenceKind ?? 'test', plain);
  const {evidenceKind, testCountSeen, testCaseSeen} = facts;
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(receipt.finishedAt) && receipt.finishedAt >= startedAt
    ? receipt.finishedAt - startedAt : Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0 ? receipt.elapsedMs : null;
  const launchError = typeof receipt.launchError === 'string' && receipt.launchError.trim();
  // A successful quiet script is not a startup failure. Red's expected nonzero
  // exit still needs checking: an environment error must never count as red.
  const failed = launchError || receipt.signal || receipt.timedOut ||
    Number.isInteger(receipt.exitCode) && receipt.exitCode !== 0;
  let code = null, reason = null;
  const hit = (value, description) => { code = value; reason = description; };
  if (failed) {
    if (launchError) hit('launch-error', '检查进程或构建前置未能启动：' + launchError);
    else if (receipt.timedOut) hit('check-timeout', '检查进程超时，需要核对原进程与资源后再重跑');
    else if (receipt.signal) hit('process-signal', '检查进程被信号终止：' + receipt.signal);
    else if (/Process from config\.webServer was not able to start/i.test(plain)) hit('webserver-start-failed', 'Playwright webServer 启动失败');
    else if (/You installed esbuild for another platform/i.test(plain)) hit('esbuild-platform-mismatch', 'esbuild 依赖与当前平台不匹配');
    else if (/Cannot find (?:module|package)|\bERR_MODULE_NOT_FOUND\b/i.test(plain) && (evidenceKind !== 'test' || !testCountSeen)) hit('module-missing-before-tests', '检查执行前缺少本机模块或依赖');
    else if (/\b(?:EADDRINUSE|ECONNREFUSED)\b/.test(plain) && (!testCountSeen || /webServer/i.test(plain)))
      hit('webserver-port-or-connection', 'webServer 端口占用或连接失败');
    // Direct node assertion scripts are real test execution even without a
    // framework counter. Do not relabel fast, genuine assertion failures.
    else if (evidenceKind === 'test' && elapsedMs !== null && elapsedMs < 2000 && !testCaseSeen) hit('failed-before-tests', '检查在两秒内失败，未观察到测试用例执行');
  }
  return { environmentFailure: code !== null, environmentFailureReason: code, matchedRule: code, reason,
    evidenceKind, testCountSeen, testCaseSeen, elapsedMs, ...(code && { redEvidenceRequirement: redEvidenceRequirement(evidenceKind) }) };
}

export function environmentRetry(job) {
  return { hint: environmentFailureHint, membersCanRetry: !job.batchId,
    nextAction: job.batchId
      ? { command: 'retryBatch', args: { batchId: job.batchId, reason: '环境修复后重跑原累计检查' }, argv: job.check.argv, inputs: job.check.inputs }
      : { command: 'check', ownerRole:['independent','controller'].includes(job.check.stage)?'controller':'developer',ownerId:job.requester,
        message:['independent','controller'].includes(job.check.stage)?'主控仅通过 check 重跑本票冻结短探针':'该证据只能由责任开发成员重跑产生；主控不得在本机执行该命令后自称已验',
        args: { taskId: job.taskId, checkId: job.check.id,...(job.ticketKey&&{ticketKey:job.ticketKey}) }, argv: job.check.argv, inputs: job.check.inputs } };
}

export function taskEnvironmentFailure(jobs) {
  const latest = new Map();
  for (const job of jobs) if (!['queued', 'launching', 'uncertain'].includes(job.state)) latest.set((job.batchId ?? 'task') + ':' + job.check.id, job);
  const failed = [...latest.values()].reverse().find(job => job.environmentFailure && job.classification === 'environment-failed');
  return failed ? { environmentFailure: true, environmentFailureReason: failed.environmentFailureReason, reason: failed.reason,
    evidenceKind: failed.evidenceKind, matchedRule: failed.matchedRule, elapsedMs: failed.elapsedMs,
    redEvidenceRequirement: failed.redEvidenceRequirement, hint: failed.hint, membersCanRetry: failed.membersCanRetry, nextAction: failed.nextAction, environmentCheckId: failed.check.id }
    : { environmentFailure: false, environmentFailureReason: null };
}
