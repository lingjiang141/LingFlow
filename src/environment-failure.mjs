export const environmentFailureHint = '先跑 npm run build 或修复本机依赖，不算票面红/绿证据';

export function detectEnvironmentFailure(receipt = {}, output = '', startedAt = receipt?.startedAt) {
  receipt ??= {};
  const plain = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const testCountSeen = /\bRunning\s+\d+\s+tests?\b|^\s*(?:#\s*)?(?:tests?|test suites?)\s*:?\s+\d+\b|^\s*#\s*Subtest:|^\s*\[\d+\/\d+\]/im.test(plain);
  const assertionSeen = /\bAssertionError\b|\bERR_ASSERTION\b|\bexpect\([^\n]*\)|^\s*(?:Expected|Received)\s*:/im.test(plain);
  const testCaseSeen = assertionSeen || /\bRunning\s+[1-9]\d*\s+tests?\b|^\s*(?:#\s*)?tests?\s*:?\s+[1-9]\d*\b|^\s*#\s*Subtest:|^\s*(?:[✓✔✘✖×]|(?:not )?ok\s+\d+)\s+\S|^\s*\[\d+\/\d+\]/im.test(plain);
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(receipt.finishedAt) && receipt.finishedAt >= startedAt
    ? receipt.finishedAt - startedAt : null;
  const launchError = typeof receipt.launchError === 'string' && receipt.launchError.trim();
  // A successful quiet script is not a startup failure. Red's expected nonzero
  // exit still needs checking: an environment error must never count as red.
  const failed = launchError || receipt.signal || receipt.timedOut ||
    Number.isInteger(receipt.exitCode) && receipt.exitCode !== 0;
  let code = null, reason = null;
  const hit = (value, description) => { code = value; reason = description; };
  if (failed) {
    if (launchError) hit('launch-error', '检查进程或构建前置未能启动：' + launchError);
    else if (/Process from config\.webServer was not able to start/i.test(plain)) hit('webserver-start-failed', 'Playwright webServer 启动失败');
    else if (/You installed esbuild for another platform/i.test(plain)) hit('esbuild-platform-mismatch', 'esbuild 依赖与当前平台不匹配');
    else if (/Cannot find module/i.test(plain) && !testCountSeen) hit('module-missing-before-tests', '测试开始前缺少本机模块或依赖');
    else if (/\b(?:EADDRINUSE|ECONNREFUSED)\b/.test(plain) && (!testCountSeen || /webServer/i.test(plain)))
      hit('webserver-port-or-connection', 'webServer 端口占用或连接失败');
    // Direct node assertion scripts are real test execution even without a
    // framework counter. Do not relabel fast, genuine assertion failures.
    else if (elapsedMs !== null && elapsedMs < 2000 && !testCaseSeen) hit('failed-before-tests', '检查在两秒内失败，未观察到测试用例执行');
  }
  return { environmentFailure: code !== null, environmentFailureReason: code, reason, testCountSeen, testCaseSeen, elapsedMs };
}

export function environmentRetry(job) {
  return { hint: environmentFailureHint, membersCanRetry: !job.batchId,
    nextAction: job.batchId
      ? { command: 'retryBatch', args: { batchId: job.batchId, reason: '环境修复后重跑原累计检查' }, argv: job.check.argv, inputs: job.check.inputs }
      : { command: 'check', args: { taskId: job.taskId, checkId: job.check.id }, argv: job.check.argv, inputs: job.check.inputs } };
}

export function taskEnvironmentFailure(jobs) {
  const latest = new Map();
  for (const job of jobs) if (!['queued', 'launching', 'uncertain'].includes(job.state)) latest.set((job.batchId ?? 'task') + ':' + job.check.id, job);
  const failed = [...latest.values()].reverse().find(job => job.environmentFailure && job.classification === 'environment-failed');
  return failed ? { environmentFailure: true, environmentFailureReason: failed.environmentFailureReason, reason: failed.reason,
    hint: failed.hint, membersCanRetry: failed.membersCanRetry, nextAction: failed.nextAction, environmentCheckId: failed.check.id }
    : { environmentFailure: false, environmentFailureReason: null };
}
