export const defaultTimeouts = Object.freeze({ lightMs: 5000, evidenceMs: 60000, writeMs: 300000 });

const light = new Set(["list", "messages", "inbox", "context", "guide", "schema", "operation", "scopePreview"]);
const evidence = new Set(["inspect", "inspectPlan", "diagnoseTask", "deliveryEvidence", "rebindCommittedWork", "checkStatus", "checkEvidence", "previewPlan", "governance"]);

export function executionPolicy(config = {}, projectId) {
  config ??= {};
  const project = projectId && Object.hasOwn(config.projects ?? {}, projectId) ? config.projects[projectId] : undefined;
  const timeouts = { ...defaultTimeouts };
  for (const settings of [config.timeouts, project?.timeouts]) {
    for (const key of Object.keys(defaultTimeouts)) {
      const ms = settings?.[key];
      if (Number.isSafeInteger(ms) && ms >= 100 && ms <= 3600000) timeouts[key] = ms;
    }
  }
  return { timeouts, ownershipIgnores: project?.ownershipIgnores ?? config.ownershipIgnores };
}

export function commandTimeout(command, { timeouts }) {
  return timeouts[light.has(command) ? "lightMs" : evidence.has(command) ? "evidenceMs" : "writeMs"];
}

export function commandTimeoutResult({ command, args, operationId }, elapsedMs, progress = {}) {
  return {
    error: "timeout", command, phase: progress.phase ?? "transport", elapsedMs,
    scannedFiles: progress.scannedFiles ?? null,
    ...(operationId && { state: command === "rebindCommittedWork" ? "unknown" : "unconfirmed", operationId, confirmationRequired: false, nextAction: { command: "operation", args: { id: operationId } } }),
    next: operationId ? "用原 operationId 查回执；未入库时使用原命令、参数和同一 operationId 重试。" :
      "按需重查原事项。已有检查编号时用 checkStatus 查询。",
    ...(args?.taskId && { taskId: args.taskId }),
    ...(args?.jobId && { jobId: args.jobId, ...(!operationId && { nextAction: { command: "checkStatus", args: { jobId: args.jobId } } }) }),
  };
}

let report;
let commandBudget;
export function withCommandProgress(onProgress, work, timeoutMs) {
  const previous = report, previousBudget = commandBudget;
  report = onProgress;
  commandBudget = timeoutMs;
  try { return work(); } finally { report = previous; commandBudget = previousBudget; }
}

export function commandProgress(progress) {
  report?.(progress);
}

export function gitCommandTimeout() {
  return commandBudget ?? defaultTimeouts.writeMs;
}
