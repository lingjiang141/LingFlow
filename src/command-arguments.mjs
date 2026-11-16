// Presence checks only. Contract, identity, ownership and value validation remain
// in the original command implementation; identifiers are never normalized.
export const requiredArguments = Object.freeze({
  guide: [], list: [], context: [], inbox: [], messages: [], operation: ['id'], schema: ['command'],
  inspect: ['taskId'], diagnoseTask: ['taskId'], deliveryEvidence: ['taskId'], checkEvidence: ['jobId'],
  checkStatus: [], inspectPlan: ['planId'], scopePreview: ['writes'],
  previewPlan: ['requirementId', 'sources', 'tickets'], dispatchPlan: ['requirementId', 'sources', 'tickets'],
  createProject: ['name', 'root'], deleteProject: ['projectId'], addRole: ['projectId', 'kind', 'name'],
  setControllerPolicy: ['projectId'], setAutoPatrol: ['projectId', 'enabled'],
  publishPlan: ['text', 'sources'], message: ['text'], savePromptPreset: ['name', 'identityPrompt'],
  deletePromptPreset: ['presetId'], editRole: ['roleId'], setPrimaryController: ['roleId'], archiveRole: ['roleId'],
  approve: ['text', 'source'], confirmBinding: ['requestId'], enable: ['roleId', 'enabled'],
  dispatch: ['requirementId', 'developerId', 'title', 'description', 'risk', 'writes'],
  redeliver: ['taskId'], resumeTask: ['taskId', 'reason'], supersede: ['taskId', 'supersededBy', 'reason'],
  abandonTask: ['taskId', 'reason'], confirmCommit: ['taskId', 'expectedBase', 'expectedHead', 'paths', 'reason'], cacheDiagnostics: ['roleId'],
  releaseSchedule: ['taskId', 'reason'], yieldForSchedule: ['taskId', 'reason'],
  rebindCommittedWork: ['taskId', 'expectedBase', 'expectedHead', 'confirmPaths', 'reason'],
  reviseSchedule: ['taskId', 'reason'], check: ['taskId', 'checkId'], reconcileCheck: ['jobId', 'evidence'],
  report: ['taskId', 'summary'], review: ['taskId', 'candidate', 'verdict', 'findings'],
  rework: ['taskId', 'reason'], summarize: ['taskId', 'instructions'], accept: ['taskId', 'evidence'],
  question: ['taskId', 'text'], answer: ['taskId', 'questionId', 'text'], progress: ['taskId', 'text'],
  retryBatch: ['batchId', 'reason'], reviseBatch: ['batchId', 'reason', 'groups'],
});

const absent = value => value === undefined || value === null || typeof value === 'string' && !value.trim();
const fieldsFor = command => Object.hasOwn(requiredArguments, command) ? requiredArguments[command] : [];
const shape = command => ({ command: 'string', args: 'JSON 字符串，含 ' + (fieldsFor(command).join('、') || '本命令参数') });
const parserFailures = new WeakSet();
const rejected = result => { parserFailures.add(result); return result; };
// Failures carry no serialized implementation tags. A private identity set
// distinguishes them from a legitimate payload containing an `error` field.
export function parseCommandArgs(raw) {
  let args = raw;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try { args = JSON.parse(trimmed); }
    catch (error) { return rejected({ error: 'invalid-argument-json', message: error.message, received: raw.slice(0, 80) }); }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    return rejected({ error: 'invalid-arguments-shape', expected: 'object',
      received: args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args });
  }
  return args;
}
export function parseCommandRequest(input, { envelope = true, required = [] } = {}) {
  const command = input?.command;
  const warnings = envelope ? Object.keys(input ?? {}).filter(key => !['command', 'args', 'operationId'].includes(key))
    .map(field => ({ field, message: `未知字段 ${field}，已忽略` })) : [];
  const failure = (error, fields = {}) => ({ error, command, ...fields, acceptedShape: shape(command),
    acceptedArgsFormats: ['JSON string', 'object'],
    hint: '嵌套负载必须放在 args 字段，内容为 JSON 字符串；也接受 JSON 对象' + (warnings.length ? '。' + warnings.map(item => item.message).join('；') : ''),
    ...(warnings.length && { warnings }) });
  if (absent(command)) return failure('missing-argument', { missing: ['command'] });
  const parsed = parseCommandArgs(input?.args);
  if (parserFailures.has(parsed)) return failure(parsed.error, { ...parsed, field: 'args' });
  const args = parsed;
  const fields = [...new Set([...fieldsFor(command), ...required, ...(command === 'report' && args.outcome === 'blocked' ? ['blocker'] : [])])];
  const missing = fields.filter(field => absent(args[field]));
  if (command === 'checkStatus' && absent(args.taskId) && absent(args.jobId)) missing.push('taskId|jobId');
  if (missing.length) return failure('missing-argument', { missing });
  return { command, args, operationId: input?.operationId, warnings };
}

export function commandCall(command, args, run, required = []) {
  const parsed = parseCommandRequest({ command, args }, { envelope: false, required });
  if (parsed.error) return parsed;
  try { return run(parsed.args); }
  catch (error) {
    if (error.argumentIssue) return error.argumentIssue;
    if (error.recordNotFound) return { error: 'not-found', command, ...error.recordNotFound, message: error.message };
    throw error;
  }
}

export function findRecord(records, id) {
  const record = records.find(item => item.id === id);
  if (record) return record;
  const display = typeof id === 'string' ? id : String(id);
  throw Object.assign(Error('记录不存在'), { recordNotFound: { id, scanned: records.length, idPrefix: display.slice(0, 8), idLength: display.length } });
}

const samples = { enabled: true, writes: [], sources: { spec: 'spec.md', tickets: 'tickets.md', attempts: 'attempts.md' },
  tickets: [{ key: 'R1-01', developerId: '<uuid>' }], confirmPaths: [], groups: [], root: 'E:/project',
  risk: 'low', kind: 'developer', command: 'previewPlan', verdict: 'pass' };
export const commandExamples = Object.entries(requiredArguments).map(([command, fields]) => {
  const args = Object.fromEntries(fields.map(field => [field, samples[field] ?? (/(Id$|^id$|^supersededBy$)/.test(field) ? '<uuid>' : '填写' + field)]));
  if (command === 'checkStatus') args.taskId = '<uuid>';
  if (command === 'dispatch') args.readOnly = true;
  return `${command}: ${JSON.stringify({ command, args: JSON.stringify(args) })}`;
}).join('\n');
