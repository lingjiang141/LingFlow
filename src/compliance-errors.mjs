import { requiredArguments } from './command-arguments.mjs';

const reads = new Set(['guide','list','governance','context','inbox','messages','operation','schema','inspect','diagnoseTask','deliveryEvidence','checkEvidence','checkStatus','inspectPlan','scopePreview','previewPlan','cacheDiagnostics']);
export const writeCommands = Object.keys(requiredArguments).filter(name => !reads.has(name));
export function operationIdIssue(command, id, { force = false } = {}) {
  if (!force && !writeCommands.includes(command)) return null;
  const missing = id == null || typeof id === 'string' && !id.trim();
  if (!missing && typeof id === 'string' && id.length <= 160) return null;
  return { error: missing ? 'missing-argument' : 'invalid-argument', command, path: 'operationId',
    ...(missing && { missing: ['operationId'] }), acceptedShape: '字符串，同一内容重试必须沿用同一 id', maxLength: 160,
    example: command === 'summarize' ? summarizeExample : {command,operationId:'<stable-operation-id>',args:Object.fromEntries((requiredArguments[command]??[]).map(field=>[field,'<'+field+'>']))},
    remedy: '为这次写操作填写非空 operationId（不超过160字符）；相同 command/args 重试沿用原 id，内容改变时使用新 id。' };
}
export function commandSignature(command) {
  if (!Object.hasOwn(requiredArguments, command)) throw Error('未知命令：' + command);
  const signature = { command, required: Object.hasOwn(requiredArguments, command) ? requiredArguments[command] : [], operationId: { required: writeCommands.includes(command), type: 'string', maxLength: 160,
    retry: '同一内容重试必须沿用同一 id' } };
  if (command === 'summarize') Object.assign(signature, { fields: { 'decision.testReview': { type: 'string', minLength: 1, maxLength: 16000,
    requiredWhen: '原需主控核对的报告 manifest.testChanges 非空' } }, example: summarizeExample });
  if (command === 'inspect') Object.assign(signature, { default: 'summary', maxBytes: 190000,
    sections: ['full','acceptance','baseline.other','checkJobs','reports','reviews','scheduleHistory','events'], paging: { offset: 0, limit: '1–200' } });
  if (command === 'checkStatus') Object.assign(signature, { default: 'compact', detail: ['compact','full'], paging: { offset: 0, limit: '1–200' },
    receiptFields: ['exitCode','failureOutputSeen','testCountSeen','environmentFailure','elapsedMs'] });
  if(command==='confirmCommit')Object.assign(signature,{role:'controller',gitWrites:false,
    preconditions:['已交付候选','提交与候选输入指纹完全等价','原检查仍有效','无未完成检查','冻结分支与祖先关系有效','paths 精确匹配提交重叠范围'],
    preserves:['candidate','reports','checkJobs','dependencies','dependencyReceipts','state']});
  if(command==='cacheDiagnostics')Object.assign(signature,{window:'last24h',readOnly:true,
    fields:['deliveries','averagePromptBytes','contextFullCount','toolsReinstallCount','toolsVersion']});
  if(command==='governance')Object.assign(signature,{readOnly:true,limit:{default:50,min:1,max:50},optional:['projectId','limit'],
    kinds:['released-work-committed','in-flight-work-committed'],attribution:'仅按文件范围与票生命周期识别风险，不根据 Git 作者名断言提交者身份'});
  if(command==='rework')Object.assign(signature,{optional:{evidence:'本票冻结的非 independent/controller 检查 id 数组'},effect:'回投原 developerId；逐条附上次回执分类与原因，通过有效检查后移除对应待办'});
  if(command==='reconcileCheck')Object.assign(signature,{roles:['ui','controller'],preconditions:['作业 state=uncertain','主控只能对账本项目','evidence 说明旧作业已退出且资源可安全复用的实际依据'],
    effect:'标记 interrupted，保留旧回执和证据；controller 路径记录 reconciledBy/reconciledById，不将 uncertain 转为 passed，也不修改冻结 checks'});
  return signature;
}
export const summarizeExample = {
  command: 'summarize', operationId: 'summarize-<unique-id>', args: { taskId: '<taskId>', instructions: '按已批准验收条款试用',
    decision: { candidate: '<candidate>', acceptance: [{ id: '<AC-id>', evidence: '填写实际核对结果', checkIds: ['<full-check-id>'] }],
      limits: '填写实际剩余限制', testReview: '纯新增 +77/-0，未削弱既有断言，整文件回归 15 passed' } },
};
export const writeSignatures = writeCommands.map(command => `${command}：operationId 必填；args 必填字段 ${requiredArguments[command].join('、') || '无'}。`).join('\n');

export function testReviewEvidence(task, review, { command = 'review', path = 'testReview' } = {}) {
  const report = task.reports.findLast(entry => entry.revision === task.revision && entry.candidate === task.candidate);
  const files = report?.manifest?.testChanges ?? task.verification.testWrites;
  const triggerPath = report?.manifest?.testChanges !== undefined ? 'report.manifest.testChanges' : 'verification.testWrites';
  if (!files.length) return;
  if (typeof review === 'string' && review.trim() && review.length <= 16000)
    return { files, evidence: review.trim(), candidate: task.candidate };
  const missing = review === undefined || review === null || typeof review === 'string' && !review.trim();
  const expected = { type: 'string', minLength: 1, maxLength: 16000, nonWhitespace: true };
  const remedy = `在 ${path} 填写非空字符串（≤16000字符），核对测试差异是否削弱断言及实际回归结果；示例文字须替换为真实证据。`;
  const example = structuredClone(summarizeExample.args);
  example.taskId = task.id; example.decision.candidate = task.candidate;
  example.decision.acceptance = (task.verification.acceptance ?? []).map(ac => ({ id: ac.id,
    evidence: '填写实际核对结果', checkIds: task.verification.checks.filter(check =>
      ['full', 'independent', 'controller'].includes(check.stage) && check.covers.includes(ac.id)).map(check => check.id) }));
  const issue = { error: missing ? 'missing-argument' : 'invalid-argument-type', command, path, expected,
    code: missing ? 'evidence-missing' : 'contract-invalid', acceptedShape: '非空字符串，≤16000字符',
    ...(missing ? { missing: [path] } : { received: Array.isArray(review) ? 'array' : typeof review }),
    message: `${path} 必须是非空字符串、≤16000字符；${triggerPath} 非空：${files.join(', ')}`,
    trigger: { path: triggerPath, files }, requiredWhen: `${triggerPath} 非空（本次文件：${files.join(', ')}）`, remedy,
    example: command === 'summarize' ? example : { taskId: task.id, candidate: task.candidate, testReview: example.decision.testReview },
    violations: [{ path, message: '既有测试断言变更需要独立核对说明', expected, remedy }] };
  throw Object.assign(Error(issue.message), { argumentIssue: issue, verificationCode: missing ? 'evidence-missing' : 'contract-invalid', violations: issue.violations });
}
