import { createHash, randomUUID } from "node:crypto";
import { inspectedEntities, selectWakeNotices, inspectionMetadata, inspectionCommands, roleHasOpenResponsibility, isSilentNotice, resumeText, silentResumeText } from "./controller-notices.mjs";
import { operationIdIssue, commandSignature, writeSignatures, summarizeExample, testReviewEvidence } from "./compliance-errors.mjs";
import { checkStatusResponse } from "./check-status-response.mjs";
import { proveCommitPartition } from "./commit-partition.mjs";
import { checkEvidenceFacts } from "./check-evidence.mjs";
import { dependencyReceipt, dependencyReceiptValid, recoverAdmittedDependency } from "./dependency-receipts.mjs";
import { cacheDiagnostics, promptMetrics, recordPromptAdmission } from "./cache-diagnostics.mjs";
import { activeWake, normalizeWake, consumeWake, requeueWake, mergeWakeNotices, recoverLostWakes, rearmLostWake, auditWakeCoverage, wakeHealth, countDeliveryAttempts,
  consolidateActiveWakes, handoffAge, lossDeadline, selfDiagnosticNotice, wakeGeneration, wakeRecipientBusy } from "./wake-state.mjs";
import { relatedTestWarnings } from "./test-scope-hints.mjs";
import { detectEnvironmentFailure, environmentRetry, taskEnvironmentFailure } from "./environment-failure.mjs";
import { commandCall, findRecord, commandExamples } from "./command-arguments.mjs";
import { bridgeToolsBlocker, recordBridgeTools } from "./bridge-tools.mjs";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { assertPaths, coversPath, fileSha256, fingerprint, fingerprintEol, implementationFingerprint, overlaps, scopePaths } from "./files.mjs";
import { redEvidence, redFailureObservation, redReceiptValid } from "./red-evidence.mjs";
import { resumeTask } from "./recovery.mjs";
import { ownerStatus, recoveryHint, updateOwnerSilence, recordOwnerHeartbeat, SILENCE_THRESHOLD_MS } from "./owner-status.mjs";
import { inspectResponse } from "./inspect-response.mjs";
import { turnBlocksDelivery, wakeCoalesceMs, wakeDelay } from "./wake-policy.mjs";
import { artifactsIntact } from "./check-preparation.mjs";
import { buildCacheStats } from "./build-cache.mjs";
import { reconcileRoleDuplicates } from "./role-duplicates.mjs";
import { assertStoppedTask, includeIgnoredScopeWrites, originalTaskWrites, releasedTaskScope, releaseStoppedScope, supersedeStoppedTask, abandonStoppedTask, supersessionHint, scopeConflictRemedy, scopeReplacementRemedy, taskScopeSchemas } from "./task-scope.mjs";
import { releaseHandoff, projectGovernance, evidenceNextAction, takeoverMessage, releasedConfirmationMessage, developerEvidenceMessage } from './controller-governance.mjs';
import { probeSeparationIssues } from './probe-separation.mjs';
import { preparationRecovery,preparationActionView,preparationRevision } from './check-recovery.mjs';
import { checkWithoutBudgets, preparationTiming } from './preparation-budget.mjs';
import { commandTimeout, executionPolicy } from "./execution-policy.mjs";
import {
  CONTROLLER_POLICY,
  CONTROLLER_TURN_RULE,
  ROLE_IDENTITIES,
  ROLE_LABELS,
  contextRevision,
  digestNextAction,
  hasCurrentContext,
  markContextSeen,
  roleContext,
  roleLabel,
  savedPrompt,
  wakeText,
  dshWakeText,
} from "./role-context.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseHiveTicket, splitHiveTickets, substituteTicket } from "./hive-plan.mjs";
import { invalidPlan, planSchema, unknownFields, violation } from "./plan-schema.mjs";
import { planningResourceWarnings, recommendDevelopers } from "./plan-scheduling.mjs";
import { dshWakeSummary, wakeSummary } from "./wake-card.mjs";
import { activeTaskIntervention, interventionHostJobsSettled, interventionPrompt } from "./task-intervention.mjs";
import { formatQualitySummary } from "../ui/quality-summary.js";
import { hasSpecChangeLog, planningDecisionOptions, readSpecVersion, specVersionSummary } from "./spec-revision.mjs";
import { assertCheckOwnership, browserCheckArgv, CONTROLLER_WAKE_BOUNDARY } from "./verification-policy.mjs";
import { inspectRole, recordObservation } from "./patrol.mjs";
import { assertTicketContract, readTicketChecks, readTicketContracts } from "./planning-contract.mjs";
import {
  assertScope,
  assertFingerprintMode,
  assertOutsideScope,
  baselineDrift,
  cumulativeCheck,
  evidenceJobs,
  gitState,
  candidateDiff,
  candidateFiles,
  candidateFingerprint,
  candidateTreeFingerprint,
  snapshotFingerprint,
  protectsAdmittedWrites,
  changedFromBaseline,
  committedFiles,
  convertImplementationBaseline,
  convertOutsideBaseline,
  implementationAtCommit,
  implementationSnapshotAtCommit,
  implementationScopeMatches,
  projectImplementationBaseline,
  summarizePaths,
  key,
  list,
  planSources,
  readVerification,
  scopeBaseline,
  unownedWriteError,
  scopeNotes,
  readGit,
  planningSourceNotes,
  assertFrozenTicket,
  ticketSourceObservation,
  ticketSourceReviewStates,
  inspectPlanningDocument,
  recordedBaselineChanges,
  committedOutsideBaseline,
  threeDimensions,
  verificationCodes,
  verify,
} from "./quality.mjs";

const id = () => randomUUID();
function diagnosisForDigest(state, task, diagnosis, blocker) {
  const jobs = state.checkJobs.filter(job => job.taskId === task.id);
  const last = jobs.at(-1);
  return {
    taskId: task.id, state: task.state, revision: task.revision, scheduleVersion: task.scheduleVersion ?? 0,
    head: diagnosis.to ?? task.baseline?.head, jobCount: jobs.length, lastJob: last && [last.id, last.state],
    passed: jobs.filter(job => job.state === "passed").length, action: digestNextAction(task, diagnosis.nextAction), blocker,
  };
}

function assertCommitReference(value, sha, field) {
  verify(typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) && sha.startsWith(value.toLowerCase()),
    "contract-invalid", `${field} 预期 ${sha}，收到 ${JSON.stringify(value)}；请按当前 Git 状态重试`);
}
function sameCheckRecipe(saved, current) {
  // Legacy check rows may omit empty optional fields. A defined contract must still match exactly.
  const normalize = check => Object.entries(check).filter(([, value]) => value != null && value !== "" &&
    !(Array.isArray(value) && !value.length)).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(normalize(saved)) === JSON.stringify(normalize(current));
}
const isController = (role, task) => role?.kind === "controller" && role.projectId === task.projectId;

const need = (value, message) => {
  if (!value) throw Error(message);
  return value;
};
const text = (value, label) =>
  need(
    typeof value === "string" && value.trim() && value.length <= 16000,
    label + "不能为空或过长",
  ) && value.trim();
function handoffFields(args) {
  const request = args.request === undefined ? undefined : text(args.request, "需要收信者处理的事项");
  const openItems = list(args.openItems ?? [], "开放事项", 20).map((item) => {
    need(typeof item?.blocking === "boolean", "开放事项须明确 blocking");
    return { text: text(item.text, "开放事项"), blocking: item.blocking,
      ...Object.fromEntries(["trigger", "impact", "evidence"].filter((field) => item[field] !== undefined)
        .map((field) => [field, text(item[field], field)])) };
  });
  const artifacts = scopePaths(list(args.artifacts ?? [], "证据文件", 20));
  return { ...(request && { request }), ...(openItems.length && { openItems }), ...(artifacts.length && { artifacts }) };
}
export function exactConfirmations(input, expected) {
  const actual = input ?? {};
  return actual && typeof actual === "object" && !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([file, digest]) => typeof digest === "string" && /^[a-f0-9]{64}$/i.test(digest) &&
      Object.hasOwn(actual, file) && actual[file] === digest);
}
const find = findRecord;
const controller = (s, projectId) => {
  const project = find(s.projects, projectId);
  const controllers = s.roles.filter(
    (r) =>
      r.projectId === projectId && r.kind === "controller" && !r.archivedAt,
  );
  return (
    controllers.find((r) => r.id === project.primaryControllerId) ??
    controllers[0]
  );
};
const activeRole = (s, id) => {
  const role = find(s.roles, id);
  need(!role.archivedAt, "成员已归档");
  return role;
};
const activeCheck = (job) => ["queued", "launching", "uncertain"].includes(job.state);
const teamMessageRole = role => ["developer", "reviewer", "planner", "tester"].includes(role?.kind);
function recordAdmissionWait(task, kind, now) {
  const current = task.admissionWait?.current;
  if ((current?.kind ?? null) === kind) return;
  const wait = task.admissionWait ??= { trackedSince: now, totalsMs: {} };
  if (current) wait.totalsMs[current.kind] = (wait.totalsMs[current.kind] ?? 0) + Math.max(0, now - current.since);
  wait.current = kind ? { kind, since: Math.max(now, current?.since ?? now) } : null;
}
function checkQueueDuration(job, now) {
  const end = job.startedAt ?? job.finishedAt ?? (job.state === "queued" ? now : undefined);
  return Number.isFinite(job.createdAt) && Number.isFinite(end) ? Math.max(0, end - job.createdAt) : 0;
}
function waitTimings(task, checkQueueMs, now) {
  const wait = task.admissionWait;
  const elapsed = kind => (wait?.totalsMs[kind] ?? 0) + (wait?.current?.kind === kind ? Math.max(0, now - wait.current.since) : 0);
  return { trackedSince: wait?.trackedSince ?? null, dependencyMs: elapsed("dependency"),
    resourceMs: elapsed("resource"), memberMs: elapsed("member"), checkQueueMs, current: wait?.current ?? null };
}
const recoveringFingerprint = task => task.state === "waiting_verification" && !task.candidate && task.fingerprintRecovery;
const terminalDependency = ["ready", "trial", "accepted"];
const reviewNotice = task => `review:${task.id}:${task.revision}` + (task.scheduleVersion ? `:${task.scheduleVersion}` : "");
const dispatchNotice = (task) => `dispatch:${task.id}:${task.revision}${task.scheduleVersion ? ":" + task.scheduleVersion : ""}`;
const interventionPauseReason = "成员已停写，等待主控调整或释放原票";
const pausedByIntervention = task => task.state === "paused" && task.waitReason === interventionPauseReason && !task.releasedScope;
const jobIncludes = (job, taskId) => job.taskId === taskId || job.taskIds?.includes(taskId);
const readsFor = (task) => [...task.reads, ...(task.verification?.checks.flatMap((check) => [...check.inputs, ...(check.requiredArtifacts ?? [])]) ?? [])];
const occupied = (task) => !releasedTaskScope(task) && ["assigned", "rework", "paused", "blocked", "reviewing", "waiting_review", "waiting_verification"].includes(task.state);
const leadCheck = (check) => ["independent", "controller"].includes(check.stage);
const connected = (role, now = Date.now()) => Boolean(role.sessionId && role.connectedAt &&
  now - role.connectedAt < 15000 && role.state !== "offline" && role.bridgePresent !== false);
const validQueueFingerprint = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isDshController = role => role.kind === "controller" && providerOf(role) === "dsh";
const queueDrainDelayMs = 6000;
function queueFingerprintForDelivery(role) {
  if (isDshController(role)) return null;
  const fingerprint = role.pendingInputFingerprint;
  if (!(role.pending > 0) || !validQueueFingerprint(fingerprint)) return null;
  if (role.pendingInputKinds?.length === 1 && role.pendingInputKinds[0] === "lingflow" ||
      role.queuedInputApproval?.sessionId === role.sessionId && role.queuedInputApproval.fingerprint === fingerprint ||
      role.queueIdle?.fingerprint === fingerprint && role.queueIdle.lastAt - role.queueIdle.since >= queueDrainDelayMs) return fingerprint;
  return null;
}
function pendingInputStatus(role, wake) {
  const pendingInputCount = Number.isSafeInteger(role?.pending) && role.pending >= 0 ? role.pending : null;
  return { pendingInputCount, pendingInputKinds: role?.pendingInputKinds ?? (pendingInputCount > 0 ? ["unknown"] : []),
    blockReason: pendingInputCount > 0 && !queueFingerprintForDelivery(role) ? "queued-input" : null,
    blockingWakeId: role?.inputDrop?.id ?? wake?.id ?? null,
    lastTurnState: role?.observation?.turn?.outcome ?? role?.state ?? "unknown" };
}
function queuedInputRecovery(task, role, wake, now = Date.now()) {
  if (!role?.enabled || !connected(role, now) || role.state !== "idle" || !(role.pending > 0) ||
      task.deliveredAt || !["queued", "assigned", "rework"].includes(task.state)) return null;
  const nextAction = validQueueFingerprint(role.pendingInputFingerprint) && role.jobs === 0 && !role.resumeWake &&
    !role.pendingToolHealthCheck && !bridgeToolsBlocker(role) && !queueFingerprintForDelivery(role) ? {
      command: "unblock", args: { taskId: task.id, reason: "核对原会话排队输入后，允许保留输入并与原票同轮处理",
        drainQueuedInput: true, expectedQueueFingerprint: role.pendingInputFingerprint },
    } : null;
  const dropAction = role.canDropPendingInput && validQueueFingerprint(role.pendingInputFingerprint) ? {
    command: "dropPendingInput", args: { roleId: role.id, expectedQueueFingerprint: role.pendingInputFingerprint, reason: "已确认快照中的排队输入均为误投" },
  } : null;
  const status = pendingInputStatus(role, wake);
  const hint = `${nextAction ? `${nextAction.command} ${JSON.stringify(nextAction.args)}` : "执行 list 核对自动排空进度"}。 ${JSON.stringify(status)}`;
  return { state: queueFingerprintForDelivery(role) ? "pending" : "blocked", taskId: task.id,
    blocker: "queued-input", ...status, hint, nextAction: nextAction ?? { command: "list", args: {} }, ...(dropAction && { dropAction }) };
}
function dispatchAvailability(role, now = Date.now(), allowResume = false) {
  if (bridgeToolsBlocker(role)) return "bridge-tools-missing";
  if (!role.sessionId) return "unbound";
  if (!role.enabled) return "disabled";
  if (!connected(role, now)) return "offline";
  if (role.state !== "idle" || role.pending !== 0 && !queueFingerprintForDelivery(role) || role.jobs > 0 || role.inputDrop) return "busy";
  if (role.resumeWake && !allowResume) return "resuming";
  if (role.jobs == null) return "jobs-unknown";
  return null;
}
const deliveryLabels = {
  "bridge-tools-missing": "bridge-tools-missing：成员工具尚未恢复，等待 DSH 桥接重新注册后投递",
  unbound: "尚未绑定成员会话",
  disabled: "成员的新投递已暂停",
  offline: "成员会话未连接。请在宿主中打开原绑定会话",
  busy: "等待原会话空闲且没有待处理输入",
  "session-busy": "等待原会话空闲",
  "controller-turn": "主控当前回合或上下文压缩尚未结束",
  "turn-boundary-changed": "主控已切换回合，等待下一次投递校验",
  "inbox-not-empty": "原会话仍有待处理输入",
  "queued-input": "原会话仍有待处理输入",
  "background-jobs": "原会话的后台作业仍在运行",
  "jobs-unknown": "无法确认原会话的后台作业，请检查桥接或打开原会话",
  "ledger-unavailable": "投递账本暂不可写，正在等待本地存储恢复",
  "validation-unavailable": "投递校验暂不可用，系统会沿原唤醒重新校验",
  "host-rejected": "宿主明确拒绝投递，系统将按原编号重试",
  "retry-limit": "宿主多次拒绝投递，可沿原票重试",
  uncertain: "宿主是否已接收仍待对账，可在原会话读取 inbox",
  stalled: "没有收到桥接的投递回执，请核对原会话和 LingFlow 连接",
};
const reviewedState = (task) => task.verification?.checks.some(leadCheck) ? "waiting_verification" : task.batchId ? "waiting_batch" : "ready";
const verificationMode = (task) => task.verification ? "frozen" : task.readOnly ? "read-only" : "missing-contract";
const requireContract = (task) => verify(task.verification || task.readOnly === true, "contract-invalid",
  `旧实施票没有冻结契约，不能走原生验收。保留原票历史，为剩余工作用 dispatchPlan 登记新的唯一票 key 和 verification；用 diagnoseTask ${JSON.stringify({ taskId: task.id })} 核对。`);

function scopeConflict(task, peer, peerRole, remedyFor) {
  if (releasedTaskScope(peer)) return;
  const writes = peer.state === "queued" ? peer.retainedWrites : peer.writes;
  const reads = peer.state === "queued" ? [] : readsFor(peer);
  const details = { taskId: peer.id, ...(peer.ticketKey && { ticketKey: peer.ticketKey }), peerRole, peerState: peer.state };
  const peerLabel = `${peer.ticketKey ? peer.ticketKey + " / " : ""}${peer.id}（${peerRole}，state=${peer.state}）`;
  if (peer.projectId === task.projectId) {
    for (const [kind, left, right] of [
      ["write/write", task.writes, writes],
      ["write/read", task.writes, reads],
      ["read/write", readsFor(task), writes],
    ]) {
      const pairs = [];
      let total = 0;
      for (const file of new Set(left ?? [])) for (const other of new Set(right ?? [])) {
        if (!overlaps([file], [other])) continue;
        if (++total <= 8) pairs.push([file, other]);
      }
      if (total) {
        const remedy = remedyFor(kind);
        return { ...details, kind, paths: pairs[0], pairs, total, remedy, nextAction: remedy,
          message: `写入、读取或共享资源冲突：${kind} · ${peerLabel} · ${pairs.map((pair) => pair.join(" ↔ ")).join("、")}（共 ${total} 对）；下一步：${remedy.command} ${JSON.stringify(remedy.args)}。也可在责任人停写后用 reviseSchedule 修正实际范围。` };
      }
    }
    if ((task.readScopeKnown === false && writes?.length) ||
        (peer.state !== "queued" && peer.readScopeKnown === false && task.writes.length)) {
      const currentUnknown = task.readScopeKnown === false;
      const refine = { command: "scopePreview", args: { writes: [], readOnly: true, reads: ["替换为实际读取的相对路径"] } };
      const remedy = remedyFor("read-scope-unknown");
      return { ...details, kind: "read-scope-unknown", paths: (currentUnknown ? writes : task.writes).slice(0, 8),
        remedy, nextAction: currentUnknown ? refine : remedy,
        message: `read-scope-unknown：${currentUnknown ? "本票未声明 reads，遇到写入中的对端" : "对端未声明 reads"} ${peerLabel}。${currentUnknown ? `先替换示例路径：scopePreview ${JSON.stringify(refine.args)}；确实不读工作区才填 reads:[]。已排队票用 reviseSchedule 补同一份 reads。` : `下一步：${remedy.command} ${JSON.stringify(remedy.args)}；主控核对对端实际 reads。`}`,
      };
    }
  }
  const resource = occupied(peer) && task.resources.find((item) => peer.resources.includes(item));
  if (resource) {
    const remedy = remedyFor("resource");
    return { ...details, kind: "resource", resource, remedy, nextAction: remedy,
      message: `写入、读取或共享资源冲突：resource · ${peerLabel} · ${resource}；${remedy.message}` };
  }
}

function activeScope(task) {
  if (releasedTaskScope(task)) return false;
  return occupied(task) || task.state === "waiting_batch" ||
    (task.state === "queued" && task.retainedWrites?.length);
}

function writeExpansionRemedy(root, task) {
  if (!/写集|write\s*(?:set|scope)/i.test(task.waitReason ?? "")) return null;
  const suggestedTests = relatedTestWarnings(root, task);
  if (!suggestedTests.length) return null;
  return { suggestedTests, nextAction: { command: "reviseSchedule", ownerRole: "controller",
    args: { taskId: task.id, writes: scopePaths([...task.writes, ...suggestedTests.map(item => item.file)]),
      reason: "已核对旧测试断言与本票批准的行为变化" } } };
}

function newTask(s, role, requirement, input, taskId, sources, ticketKey, warnings = [], prefix = "ticket") {
  need(role?.kind === "controller" && role.projectId === requirement.projectId, "请在本项目已开启的 DSH 主控会话派单");
  const worker = activeRole(s, input.developerId);
  need(worker.projectId === requirement.projectId, "开发者无效");
  need(["low", "medium", "high"].includes(input.risk), "风险必须为 low/medium/high");
  const writes = scopePaths(input.writes), reads = scopePaths(input.reads ?? []);
  const contextReads = scopePaths(input.contextReads ?? []);
  const readOnly = input.readOnly === true;
  need(input.readOnly === undefined || typeof input.readOnly === "boolean", "readOnly 必须为布尔值");
  need(readOnly ? writes.length === 0 : writes.length > 0, "实施票须声明写入范围，只读票须设置 readOnly=true 且 writes=[]");
  need(worker.kind === "developer", "角色不具备该任务的实施权限；新票仅派给开发成员");
  const resources = list(input.resources ?? [], "共享资源").map((resource) => text(resource, "资源名称").toLowerCase());
  const project = find(s.projects, requirement.projectId);
  const developerChecksPending = input.developerChecks === true;
  need(input.developerChecks === undefined || typeof input.developerChecks === "boolean", "developerChecks 须为布尔值");
  need(!developerChecksPending || !readOnly && sources, "开发登记检查仅支持引用规划文件的实施票");
  const verification = readOnly ? null : readVerification(input.verification,
    { root: project.root, writes, risk: input.risk, warnings, prefix: prefix + ".verification", developerChecksPending });
  if (verification) need(sources, "实施票必须引用已批准的规划文件");
  const ownedDirty = scopePaths(input.ownedDirty ?? []);
  need(ownedDirty.every((file) => coversPath(writes, file)), "已有改动授权必须在本票写入范围内");
  return {
    id: taskId, projectId: project.id, requirementId: requirement.id, ticketKey,
    sources, title: text(input.title, "任务标题"), description: text(input.description, "任务及验收条件"),
    dispatchedBy: role.id,
    ...Object.fromEntries(["brief", "boundaries", "stopConditions", "riskReason"].filter((field) => input[field] !== undefined)
      .map((field) => [field, text(input[field], field)])),
    developerId: worker.id, assignee: worker.id, risk: input.risk, readOnly, dimensionsRequired: true,
    writes, reads, contextReads, ...(readOnly && { readScopeKnown: Array.isArray(input.reads) || contextReads.length > 0 }),
    resources: [...new Set(resources)], ownedDirty, verification, ...(verification && { candidateScope: 2, redContractVersion: 2 }),
    ...(developerChecksPending && { developerChecksPending: true }),
    dependencies: [], dependencyStages: {}, state: "queued", revision: 1,
    acceptedAt: Date.now(), deliveredAt: null, reportedAt: null,
    reports: [], reviews: [], questions: [],
  };
}

function dependencyOrder(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set(), complete = new Set(), order = [];
  function visit(task) {
    need(!visiting.has(task.id), "规划依赖存在循环：" + (task.ticketKey ?? task.id));
    if (complete.has(task.id)) return;
    visiting.add(task.id);
    for (const dependency of task.dependencies ?? []) {
      const predecessor = byId.get(dependency);
      if (predecessor) visit(predecessor);
    }
    visiting.delete(task.id);
    complete.add(task.id);
    order.push(task);
  }
  for (const task of tasks) visit(task);
  return order;
}

function resolveAfter(tasks, task, after, warnings = [], at = "after") {
  const dependencies = [], dependencyStages = {};
  for (const dep of list(after, "前置依赖")) {
    unknownFields(dep, ["ticket", "taskId", "stage"], at, warnings);
    const stage = dep?.stage ?? "verified";
    need(["verified", "accepted"].includes(stage), "前置门槛必须为 verified 或 accepted");
    need(!!dep?.ticket !== !!dep?.taskId, "前置依赖须指定 ticket 或 taskId");
    const predecessor = dep.ticket ? need(tasks.find(item => item.projectId === task.projectId && item.ticketKey === dep.ticket),
      "前置票不存在：" + dep.ticket) : find(tasks, dep.taskId);
    need(predecessor.projectId === task.projectId, "依赖必须同项目");
    need(predecessor.id !== task.id, "前置依赖不能自指");
    need(!Object.hasOwn(dependencyStages, predecessor.id), "前置依赖重复");
    dependencies.push(predecessor.id);
    dependencyStages[predecessor.id] = stage;
  }
  return { dependencies, dependencyStages };
}

function validateDependencyEdit(state, task, next) {
  const tasks = state.tasks.filter(item => item.projectId === task.projectId)
    .map(item => item.id === task.id ? { ...item, ...next } : item);
  if (!state.validationBatches.some(batch => batch.projectId === task.projectId)) {
    dependencyOrder(tasks);
    return;
  }
  const ancestors = new Map();
  for (const item of dependencyOrder(tasks)) {
    ancestors.set(item.id, new Set((item.dependencies ?? []).flatMap(dep => [dep, ...(ancestors.get(dep) ?? [])])));
  }
  for (const batch of state.validationBatches.filter(item => item.projectId === task.projectId)) {
    need(!batch.taskIds.some(id => batch.taskIds.some(peer => ancestors.get(id)?.has(peer))),
      "调度会使同批次互等，请主控先调整累计验证的分组方案");
  }
}

function retainDependencyReceipts(task, next) {
  if (!task.dependencyReceipts) return;
  for (const dependency of Object.keys(task.dependencyReceipts))
    if (!next.dependencies.includes(dependency) || (task.dependencyStages?.[dependency] ?? "verified") !== next.dependencyStages[dependency])
      delete task.dependencyReceipts[dependency];
}

function freezePlan(s, role, args, preview = false, materialize = false) {
  const requirement = find(s.requirements, args.requirementId);
  need(role?.kind === "controller" && role.projectId === requirement.projectId, "请在本项目已开启的 DSH 主控会话派单");
  const project = find(s.projects, role.projectId);
  let documents;
  try { documents = planSources(project.root, args.sources, true); } catch (error) {
    throw invalidPlan([violation("sources", error.message, planSchema.sources, "指定存在的项目相对规划文件或 issues 目录")]);
  }
  const sources = Object.fromEntries(Object.entries(documents).map(([name, doc]) => [name, { file: doc.file, digest: doc.digest }]));
  const specVersion = readSpecVersion(documents.spec.text);
  const planId = id();
  const ticketDocuments = Object.entries(documents).filter(([name]) => name === "tickets" || name.startsWith("ticket:"));
  const contracts = new Map(), hiveTickets = new Map(), ticketChecks = new Map();
  const violations = [], warnings = [], normalized = [];
  if (!specVersion || !hasSpecChangeLog(documents.spec.text)) {
    const missing = [!specVersion && "Version: N", !hasSpecChangeLog(documents.spec.text) && "## 变更记录"].filter(Boolean);
    violations.push(violation("sources.spec", `规格缺少 ${missing.join("、")}`, "Version: 1 和 ## 变更记录",
      "在 spec 顶部补版本及变更记录，再用相同参数执行 previewPlan，随后 dispatchPlan"));
  }
  unknownFields(args, ["requirementId","sources","tickets","batches","developerIds"], "plan", warnings);
  unknownFields(args.sources, ["spec","tickets","ticketsDir","attempts"], "sources", warnings);
  for (const [name, document] of ticketDocuments) {
    let declared;
    try { declared = readTicketContracts(document); } catch(error) {
      violations.push(violation("sources."+name,error.message,{ticket:"R35-01",requiredWrites:[],requiredTestWrites:[],requiredAcceptance:["AC-1"]},"修正机读约束块，保留工单正文"));
      continue;
    }
    for(const [key, contract] of declared) {
      if (contracts.has(key)) violations.push(violation("sources."+name,"重复的票面契约："+key,"每票一个块","移除重复引用或重复块"));
      else contracts.set(key,contract);
    }
    let parsed;
    try { parsed = splitHiveTickets(document).map((part) => parseHiveTicket(part, { exists: (file) => existsSync(resolve(project.root,file)) })); }
    catch(error) { violations.push(violation("sources."+name,error.message,"项目相对路径","在派发字段填写有效相对路径，核对票面中的越界或无效引用")); continue; }
    for (const hive of parsed) {
      if (hiveTickets.has(hive.key)) violations.push(violation("sources."+name,"重复的 Hive H1 票号："+hive.key,"每票一个 H1","选择唯一原票文件"));
      else hiveTickets.set(hive.key,{...hive,name});
    }
    try {
      const keys = [...new Set([...declared.keys(), ...parsed.map(ticket => ticket.key)])];
      for (const [key, checks] of readTicketChecks(document, keys.length === 1 ? keys[0] : undefined)) {
        need(keys.includes(key), "lingflow-checks 票号与所在文档不匹配：" + key);
        need(!ticketChecks.has(key), "重复的 lingflow-checks：" + key);
        ticketChecks.set(key, checks);
      }
    } catch (error) {
      violations.push(violation("sources."+name, error.message, null, "修正对应票的 lingflow-checks JSON 围栏"));
    }
    if (!parsed.length && name.startsWith("ticket:") && !declared.size)
      violations.push(violation("sources."+name, "找不到票面 H1："+document.file, "# 票 R35-01：标题", "选择原始票面文件，或使用含 lingflow-contract 的原生票面"));
  }
  if (materialize) {
    const developers = s.roles.filter(member => member.projectId === project.id && member.kind === "developer" && !member.archivedAt);
    need(developers.length, "本项目没有可用开发成员");
    const keys = [...new Set([...hiveTickets.keys(), ...contracts.keys()])];
    const selected = recommendDevelopers(developers, s.tasks, keys, args.developerIds,
      member => dispatchAvailability(member) === null && !s.tasks.some(task => task.assignee === member.id && occupied(task)) &&
        !s.checkJobs.some(job => job.requester === member.id && activeCheck(job)));
    const tickets = keys.map((ticket, index) => {
      const contract = contracts.get(ticket), hive = hiveTickets.get(ticket);
      if (!contract) violations.push(violation(`tickets[${ticket}].ticketContract`, "缺少 lingflow-contract", null, "在未冻结的新票补齐机读契约，旧票使用副本转录"));
      if (!ticketChecks.has(ticket) && !contract?.developerChecks) violations.push(violation(`tickets[${ticket}].verification.checks`, "缺少 lingflow-checks，不能推测实际检查或红标记", null,
        "声明真实 checks 和 browserE2E；仅有自然语言检查描述无法直接派发"));
      return { key: ticket, developerId: selected[index],
        ...(contract && { writes: scopePaths([...contract.requiredWrites, ...contract.requiredTestWrites, ...(hive?.writes ?? [])]) }) };
    });
    if (violations.length) throw invalidPlan(violations, warnings);
    args = { requirementId: args.requirementId, sources: args.sources, tickets };
  }
  if (!Array.isArray(args.tickets) || !args.tickets.length || args.tickets.length > 30)
    throw invalidPlan([violation("tickets", "规划须含 1–30 张票", planSchema.tickets, "按票编号分批登记")]);
  const inputs = args.tickets;
  const seenKeys = new Set();
  const byKey = new Map();
  const collect = (path,error,expected,remedy) => violations.push(...(error.violations ?? [violation(path,error.message,expected,remedy)]));
  for (const [index, raw] of inputs.entries()) {
    const prefix = "tickets["+(raw?.key ?? index)+"]";
    try {
      const ticketKey = key(raw?.key,"票");
      need(!seenKeys.has(ticketKey) && !s.tasks.some((t)=>t.projectId===project.id&&t.ticketKey===ticketKey),"票编号已存在，请沿原票续接："+ticketKey);
      seenKeys.add(ticketKey);
      unknownFields(raw,["key","developerId","title","description","brief","boundaries","stopConditions","risk","riskReason","writes","reads","contextReads","resources","ownedDirty","after","readOnly","verification","browserE2E","developerChecks","upstreamRedTaskId"],prefix,warnings);
      const hive=hiveTickets.get(ticketKey);
      if (hiveTickets.size && !hive && !raw.readOnly) need(contracts.has(ticketKey),"未找到匹配的 Hive H1："+ticketKey);
      const merged = {...raw};
      const contract = contracts.get(ticketKey), checks = ticketChecks.get(ticketKey);
      merged.developerChecks ??= contract?.developerChecks;
      if (merged.developerChecks) need(contract, "由开发登记检查须有 lingflow-contract 约束写入、测试和 AC");
      if ((checks || merged.developerChecks) && contract && !raw.readOnly)
        merged.writes ??= scopePaths([...contract.requiredWrites, ...contract.requiredTestWrites, ...(hive?.writes ?? [])]);
      if (raw.verification !== undefined) {
        if (checks) warnings.push({ path: prefix + ".verification",
          message: "同时提供 lingflow-checks 与 verification，使用调用方 verification；仍须满足票面契约" });
      } else if ((checks || merged.developerChecks) && !raw.readOnly) {
        need(contract, "使用 lingflow-checks 须同时提供匹配的 lingflow-contract");
        merged.verification = { ...checks, testWrites: contract.requiredTestWrites };
      }
      if (raw.browserE2E !== undefined) {
        need(raw.verification?.browserE2E === undefined || JSON.stringify(raw.verification.browserE2E)===JSON.stringify(raw.browserE2E),"票根和 verification.browserE2E 不一致，请只保留一份");
        merged.verification={...merged.verification,browserE2E:raw.browserE2E};
        warnings.push({path:prefix+".browserE2E",message:"已归并到 verification.browserE2E"});
      }
      const inferred = hive && contract && !hive.writes.length && !hive.unresolved.length
        ? { ...hive, writes: scopePaths([...contract.requiredWrites, ...contract.requiredTestWrites]) } : hive;
      const input=substituteTicket(merged,inferred,warnings,prefix);
      const refs=Object.fromEntries(Object.entries(sources).filter(([name])=>!name.startsWith("ticket:")));
      const ticketSource = hive?.name ?? ticketDocuments.find(([, document])=>document.file===contracts.get(ticketKey)?.source)?.[0];
      if(ticketSource) refs.tickets=sources[ticketSource];
      const task={...newTask(s,role,requirement,input,id(),refs,ticketKey,warnings,prefix),planId,
        ...(specVersion && { specVersion })};
      if (raw.upstreamRedTaskId !== undefined) {
        const upstream = s.tasks.find(item => item.id === raw.upstreamRedTaskId && item.projectId === project.id && item.verification);
        need(upstream && task.ownedDirty.length && !task.readOnly, "承接红证据须指定本项目实际有冻结检查的 upstreamRedTaskId，并核对 ownedDirty");
        task.upstreamRedTaskId = upstream.id;
      }
      need(task.readOnly || !contracts.size || contract,"缺少 "+ticketKey+" 的 lingflow-contract");
      assertTicketContract(task,contract);
      if(contract) task.ticketContract=contract;
      for (const hit of relatedTestWarnings(project.root, task))
        warnings.push({ path: prefix + ".writes", ...hit,
          message: `可能被本票变更影响且未列入写集的测试：${hit.file}:${hit.line}。请核对旧断言后补齐范围。` });
      byKey.set(ticketKey,task);
      normalized.push(input);
    } catch(error) {
      if (raw?.verification === undefined && ticketChecks.has(raw?.key) && error.violations) {
        const source = contracts.get(raw.key)?.source;
        for (const issue of error.violations) {
          if (issue.repair && !issue.repair.requiresInput && source)
            issue.repair = { ...issue.repair, source, fence: "lingflow-checks" };
        }
      }
      collect(prefix,error,planSchema.tickets[0],"补齐这张票的派发字段；保留原票正文");
    }
  }
  for(const input of normalized) {
    const task=byKey.get(input.key);
    const at="tickets["+input.key+"].after";
    try {
      const dependencies = list(input.after === undefined ? [] : input.after, "前置依赖");
      for (const needed of hiveTickets.get(input.key)?.after ?? []) {
        const counterpart = byKey.get(needed.ticket) ?? s.tasks.find((t)=>t.projectId===project.id&&t.ticketKey===needed.ticket);
        const provided = dependencies.find((dep)=>dep?.ticket===needed.ticket || (counterpart && dep?.taskId===counterpart.id));
        if (!provided) {
          warnings.push({path:at,message:"票面声明的前置未被采用",value:needed});
        } else if (provided.stage === "accepted" && needed.stage === "verified") {
          warnings.push({ path: at, message: `前置 ${needed.ticket} 被设为等待用户验收。技术前置请选择 verified；仅用户明确要求验收后再推进时保留 accepted。`, value: provided });
        }
      }
      input.after = dependencies;
      const resolved = dependencies.filter(dep => !dep?.ticket || byKey.has(dep.ticket) || !inputs.some(item => item?.key === dep.ticket));
      Object.assign(task, resolveAfter([...byKey.values(), ...s.tasks], task, resolved, warnings, at));
    } catch(error) { collect(at,error,[{ticket:"R35-01",stage:"verified"}],"引用同项目实际前置票"); }
  }
  if(violations.length) throw invalidPlan(violations, warnings);
  const byId = new Map([...byKey.values()].map((task) => [task.id, task]));
  let order;
  try { order = dependencyOrder([...byKey.values()]); }
  catch(error) { throw invalidPlan([violation("tickets.after",error.message,[{ticket:"R35-01",stage:"verified"}],"只保留实际依赖，取消互相等待的边")]); }
  warnings.push(...planningResourceWarnings(order, s.tasks.filter(task => task.projectId === project.id), documents));
  for (const task of order) for (const dependency of task.dependencies) {
    const peer = s.tasks.find(peer => peer.id === dependency);
    if (!/^[a-f0-9]{40,64}$/.test(peer?.confirmedCommit?.to ?? "") || task.dependencyStages?.[dependency] === "accepted") continue;
    try {
      readGit(project.root, ["merge-base", "--is-ancestor", peer.confirmedCommit.to, "HEAD"]);
      warnings.push({ path: `tickets.${task.ticketKey}.after`, kind: "dependency-already-committed",
        message: `${peer.ticketKey} 的候选已确认入库于 ${peer.confirmedCommit.to}。若只需现有代码，可改为声明实际 reads；保留 verified 边则继续要求有效验证。` });
    } catch { /* The recorded commit is not a proven ancestor of the active checkout. */ }
  }
  const frozenBatches = [];
  let batches;
  try { batches = list(args.batches ?? [], "累计检查批次", 15); }
  catch(error) { throw invalidPlan([violation("batches",error.message,[],"用数组声明累计检查；没有批次则省略")]); }
  for (const [index,input] of batches.entries()) { try {
    unknownFields(input, ["key","tickets","argv","inputs","covers","resources","timeoutMs","expectedOutput","failureOutput"], "batches["+index+"]",warnings);
    const members = [...new Set(list(input?.tickets, "批次成员"))].map((name) => {
      const member = byKey.get(name);
      return need(member?.verification && !member.batchId && member, "累计检查仅支持同一计划中未编入批次的实施票");
    });
    need(members.length >= 2, "共享累计检查至少需要两张成员票");
    const names = new Set(members.map((task) => task.id));
    const ancestors = (task) => task.dependencies.some((dep) => names.has(dep) || (byId.has(dep) && ancestors(byId.get(dep))));
    need(!members.some(ancestors), "批次成员不能等待同批次的最终验证或用户验收");
    for (const a of members) for (const b of members)
      need(a === b || !overlaps(a.writes, [...b.writes, ...readsFor(b)]), "共享累计检查只合并能同时稳定的候选");
    const check = cumulativeCheck(input, members, project.root);
    const batch = { id: id(), projectId: project.id, taskIds: members.map((task) => task.id), check, state: "waiting" };
    for (const member of members) member.batchId = batch.id;
    frozenBatches.push(batch);
  } catch(error) { collect("batches["+index+"]",error,{key:"batch",tickets:["A","B"],argv:["node","verify.cjs"],inputs:["verify.cjs"],covers:[{ticket:"A",acceptance:["AC-1"]},{ticket:"B",acceptance:["AC-1"]}]},"核对批次成员、实际输入和覆盖；不能批次互等或冲突"); } }
  if(violations.length) throw invalidPlan(violations, warnings);
  if (materialize) return { state: "valid", warnings, args, checks: order.map(task => ({
    ticket: task.ticketKey, checks: task.verification.checks, browserE2E: task.verification.browserE2E,
    ...(task.developerChecksPending && { developerChecksPending: true }),
  })) };
  if (preview) return { state: "valid", violations: [], warnings, sources, tickets: order.map((task) => ({ key: task.ticketKey, writes: task.writes, reads: task.reads, after: normalized.find((input)=>input.key===task.ticketKey)?.after ?? [], verification: task.verification, verificationMode: verificationMode(task), ...(task.developerChecksPending && { developerChecksPending: true }) })) };
  s.validationBatches.push(...frozenBatches);
  s.tasks.push(...order);
  s.plans.push({ id: planId, projectId: project.id, requirementId: requirement.id, documents, createdAt: Date.now(),
    ...(specVersion && { specVersion }) });
  return { receipt: "accepted", planId, warnings, tasks: order.map((task) => ({ key: task.ticketKey, taskId: task.id })) };
}
function saveRoleProfile(s, role, args) {
  const name = text(args.name === undefined ? role.name : args.name, "成员名称");
  const identityPrompt = args.identityPrompt ?? role.identityPrompt ?? "";
  const customLabel =
    args.customLabel === undefined
      ? (role.customLabel ?? "")
      : text(args.customLabel, "自定义角色名称");
  need(name.length <= 80, "成员名称不能超过 80 个字符");
  need(customLabel.length <= 80, "自定义角色名称不能超过 80 个字符");
  need(
    typeof identityPrompt === "string" && identityPrompt.length <= 16000,
    "身份提示词不能超过 16000 个字符",
  );
  need(
    !s.roles.some(
      (r) =>
        r.id !== role.id &&
        r.projectId === role.projectId &&
        !r.archivedAt &&
        r.name.toLowerCase() === name.toLowerCase(),
    ),
    "同一项目已有同名成员",
  );
  const changed =
    role.name !== name ||
    (role.identityPrompt ?? "") !== identityPrompt ||
    (role.customLabel ?? "") !== customLabel;
  if (changed && role.name) role.contextRevision = contextRevision(role) + 1;
  Object.assign(role, { name, identityPrompt });
  if (customLabel) role.customLabel = customLabel;
  return changed;
}
function addRole(s, projectId, args) {
  need(args && typeof args === "object", "成员资料无效");
  need(
    typeof args.kind === "string" && Object.hasOwn(ROLE_LABELS, args.kind),
    "新成员的工作流职责必须为主控、开发、审查或监管",
  );
  const provider = args.provider ?? "dsh";
  need(["dsh", "codex"].includes(provider), "未知会话类型");
  const role = {
    id: id(),
    projectId,
    kind: args.kind,
    provider,
    sessionId: null,
    enabled: false,
    connectedAt: 0,
    state: "offline",
  };
  saveRoleProfile(s, role, args);
  s.roles.push(role);
  return role;
}

const providerOf = (role) => role.provider ?? "dsh";

export class Workflow {
  constructor(store, { readOnly = false, execution } = {}) {
    this.store = store;
    this.readOnly = readOnly;
    this.execution = execution;
    if (readOnly) return;
    store.change((s) => {
      s.promptPresets ??= [];
      s.checkJobs ??= [];
      s.validationBatches ??= [];
      s.plans ??= [];
      s.messages ??= [];
      reconcileRoleDuplicates(s);
      for (const task of s.tasks) {
        if (!task.reworkEvidenceRevisions) continue;
        for (const job of s.checkJobs)
          if (job.taskId === task.id && job.revision < (task.reworkEvidenceRevisions[job.check.id] ?? 0)) job.invalidated = true;
        delete task.reworkEvidenceRevisions;
      }
      for (const task of s.tasks) for (const question of task.questions ?? []) {
        if (question.answer || Object.hasOwn(question, "scope") && typeof question.blocking === "boolean") continue;
        question.scope = this.questionScope(s, task, question);
        question.blocking = question.blocking === true;
        this.store.event("question-scope-backfill", { taskId: task.id, questionId: question.id,
          scope: question.scope, blocking: question.blocking, source: "legacy-author-and-explicit-blocking" });
      }
      this.normalizeNotices(s);
      const oldLosses = s.wakes.some(wake => wake.deliveryLosses === undefined && (wake.lostAt || wake.deliveryRetry))
        ? this.store.wakeLossCounts() : new Map();
      for (const wake of s.wakes) {
        wake.deliveryLosses ??= oldLosses.get(wake.id) ?? 0;
        normalizeWake(wake, Date.now());
      }
      for (const role of s.roles) {
        role.enabled = false;
        role.connectedAt = 0;
        delete role.observation;
        delete role.patrolStatus;
      }
    });
  }
  normalizeNotices(s) {
    for(const notice of s.notices)if(!notice.readAt || typeof notice.actionable!=='boolean') {
      const role=s.roles.find(role=>role.id===notice.roleId);
      if(selfDiagnosticNotice(notice)) Object.assign(notice,{selfDiagnostic:true,actionable:false});
      else if(role && isSilentNotice(role,notice)) Object.assign(notice,{silent:true,actionable:false});
      else if(typeof notice.actionable!=='boolean') notice.actionable=role?Boolean(selectWakeNotices(s,role,[notice]).notices[0]?.actionable):false;
    }
  }
  actor(s, sessionId, provider = "dsh") {
    return need(
      s.roles.find(
        (r) => !r.archivedAt && providerOf(r) === provider && r.sessionId === sessionId && r.enabled,
      ),
      "当前会话未绑定或角色未开启",
    );
  }
  notice(s, roleId, key, summary, taskId = null, silent = false) {
    if (!s.notices.some((n) => n.roleId === roleId && n.key === key)) {
      const notice = {
        id: id(),
        roleId,
        key,
        summary,
        taskId,
        readAt: null,
        at: Date.now(),
        ...(silent && { silent }),
      };
      const role=s.roles.find(role=>role.id===roleId);
      if (selfDiagnosticNotice(notice)) notice.selfDiagnostic = true;
      if (role && isSilentNotice(role, notice)) notice.silent = true;
      notice.actionable=role ? Boolean(selectWakeNotices(s,role,[notice]).notices[0]?.actionable) : false;
      s.notices.push(notice);
      return notice;
    }
    return s.notices.find(notice=>notice.roleId===roleId&&notice.key===key);
  }
  noticeMessage(s, notice) {
    const [kind, ref] = notice.key.split(":");
    const task = s.tasks.find(task => task.id === notice.taskId);
    const question = task?.questions?.find(question => question.id === ref);
    const from = kind === "message" ? s.messages.find(message => message.id === ref)?.from :
      kind === "question" ? question?.from :
      kind === "answer" ? question?.answeredBy :
      kind === "report" ? task?.reports?.find(report => report.id === ref)?.developerId :
      kind === "report-blocked" ? task?.blockedReports?.find(report => report.id === ref)?.developerId :
      kind === "review" ? task?.reviews?.find(review => review.id === ref)?.reviewerId : null;
    return { ...notice, kind: "notice", from: from ?? null, to: notice.roleId,
      projectId: s.roles.find(role => role.id === notice.roleId)?.projectId,
      text: notice.summary, canReply: Boolean(from && from !== notice.roleId) };
  }
  specNotices(s, task, notes) {
    const spec = notes.find(note => note.specVersion);
    if (!spec) return [];
    const root = find(s.projects, task.projectId).root;
    const notices = [];
    for (const peer of s.tasks) {
      if (peer.projectId !== task.projectId || peer.sources?.spec?.file !== spec.file ||
          !peer.admittedAt || peer.state === "accepted" || releasedTaskScope(peer)) continue;
      const note = peer.id === task.id ? spec : planningSourceNotes(root, peer, s.plans.find(plan => plan.id === peer.planId))
        .find(note => note.specVersion && note.toDigest === spec.toDigest);
      if (!note) continue;
      const impacted = Boolean(note.impact);
      notices.push({ kind: impacted ? "spec-impact" : "spec-revision", file: spec.file, digest: spec.toDigest,
        affectedTickets: [{ taskId: peer.id, ticketKey: peer.ticketKey, ...(note.impact ?? { acceptance: [], named: false }) }],
        options: impacted ? planningDecisionOptions(peer) : [] });
    }
    return notices;
  }
  recordSpecNotices(s, task, notices) {
    const lead = controller(s, task.projectId);
    if (!lead) return;
    for (const details of notices) {
      const [{ taskId, ticketKey, acceptance }] = details.affectedTickets;
      const summary = details.kind === "spec-impact"
        ? `spec 变更影响在飞票 ${ticketKey}${acceptance.length ? "（" + acceptance.join("、") + "）" : ""}。主控可保持冻结口径、追加票或作废重派。`
        : `spec 已更新。${ticketKey} 继续按冻结票面收口。执行 inspectPlan {planId,document:"spec"} 核对差异。`;
      const notice = this.notice(s, lead.id, `spec-impact:${taskId}:${details.digest}`, summary, taskId);
      notice.details = details;
    }
  }
  retire(s, taskId) {
    for (const n of s.notices)
      if (n.taskId === taskId && !n.readAt && !/^(question|answer|spec-impact):/.test(n.key)) n.readAt = Date.now();
  }
  recordDelivery(s, notice, roleId, at) {
    if (!notice.taskId) return;
    const task = find(s.tasks, notice.taskId);
    if (
      roleId === task.developerId &&
      notice.key === dispatchNotice(task)
    )
      { task.deliveredAt ??= at; task.firstDeliveredAt ??= at; }
    if (
      roleId === task.assignee &&
      (notice.key === reviewNotice(task) || notice.key === `review:${task.id}:${task.revision}`)
    )
      task.reviewDeliveredAt ??= at;
  }
  responsibilityNotice(s, role, taskId) {
    if (!["developer", "reviewer"].includes(role?.kind)) return;
    const task = s.tasks.find(item => item.id === taskId && item.projectId === role.projectId && item.assignee === role.id);
    if (!task || releasedTaskScope(task)) return;
    const key = role.kind === "reviewer" && task.state === "reviewing" && task.candidate ? reviewNotice(task) :
      role.kind === "developer" && (["assigned", "rework"].includes(task.state) || recoveringFingerprint(task)) ? dispatchNotice(task) : null;
    return key && s.notices.find(notice => notice.roleId === role.id && notice.taskId === task.id &&
      notice.key === key && !notice.readAt && !notice.workConfirmedAt);
  }
  confirmResponsibility(s, role, notice, command, at = Date.now()) {
    notice.workConfirmedAt = at;
    notice.actionable = false;
    this.recordDelivery(s, notice, role.id, at);
    role.consecutiveWakeLosses = 0;
    const wakes = s.wakes.filter(wake => wake.roleId === role.id && wake.noticeIds.includes(notice.id) &&
      (activeWake(wake) || wake.state === "failed" && !wake.consumedAt));
    for (const wake of wakes) {
      normalizeWake(wake, at);
      const remaining = s.notices.some(item => wake.noticeIds.includes(item.id) && !item.readAt && !item.workConfirmedAt);
      if (!remaining) consumeWake(wake, at, "work-confirmed");
      else if (wake.state === "pending" && wake.text && wake.payloadGeneration === wakeGeneration(wake))
        requeueWake(wake, at, "work-confirmed");
    }
    this.store.event("wake.work-confirmed", { taskId: notice.taskId, roleId: role.id, noticeId: notice.id,
      command, wakeIds: wakes.map(wake => wake.id) });
  }
  logWakeDelivery(s, wake, result, attempt, at = Date.now()) {
    const payload = wake.payloadNoticeIds ?? wake.noticeIds;
    const taskIds = s.notices.filter((notice) => payload.includes(notice.id) && notice.taskId).map((notice) => notice.taskId);
    for (const taskId of new Set(taskIds.length ? taskIds : [null]))
      this.store.event("deliver", { wakeId: wake.id, taskId, roleId: wake.roleId, attempt, result, at,
        generation: wakeGeneration(wake), deliveryRetry: wake.deliveryRetry, deliveryAttempts: wake.deliveryAttempts });
  }
  trackWakeAttempts(s, wake, data) {
    if (data?.generation !== wakeGeneration(wake) || !Array.isArray(data.outcomes)) return;
    for (const outcome of data.outcomes.slice(0, 64)) {
      if (!Number.isSafeInteger(outcome?.attempt) || outcome.attempt <= (wake.loggedAttempt ?? 0) ||
          !["rejected", "uncertain"].includes(outcome.result)) continue;
      countDeliveryAttempts(wake,outcome.attempt);
      this.logWakeDelivery(s, wake, outcome.result, outcome.attempt, Number.isSafeInteger(outcome.at) ? outcome.at : undefined);
      wake.loggedAttempt = outcome.attempt;
    }
  }
  deliveryDiagnostic(s, role, since) {
    const wake = s.wakes.find(item => item.roleId === role.id && item.state === "pending");
    const failed = s.wakes.findLast(item => item.roleId === role.id && item.state === "failed" && !item.consumedAt && item.closeReason === "delivery-loss-limit");
    if (failed) {
      const nextAction = { command: "rearmWake", args: { roleId: role.id, reason: "恢复原会话未读责任" } };
      return { reason: "delivery-loss-limit", wakeId: failed.id, at: failed.failedAt, attempt: failed.deliveryLosses,
        actions: ["rearmWake", "resumeTask", "inbox-from-original-session"], nextAction,
        detail: `投递异常，原唤醒已达重投上限。执行 rearmWake ${JSON.stringify(nextAction.args)} 或在原会话读取 inbox。` };
    }
    const availability = dispatchAvailability(role);
    const input = pendingInputStatus(role, wake);
    const reason = ["bridge-tools-missing", "offline", "unbound", "disabled", "jobs-unknown"].includes(availability) ? availability :
      (role.state === "idle" ? input.blockReason : null) ?? wake?.diagnostic?.reason ??
      (role.pending > 0 ? "queued-input" : role.deliveryIssue?.startsWith("投递结果待对账") ? "uncertain" :
        Date.now() - (wake?.at ?? since ?? Date.now()) >= 10000 ? (availability === "busy" ? "busy" : "stalled") : null);
    return reason ? { reason, at: wake?.diagnostic?.at ?? wake?.at ?? since ?? role.connectedAt ?? Date.now(),
      attempt: wake?.diagnostic?.attempt ?? 0, detail: `${reason === "offline" ? "连接未确认。执行 list 检查绑定状态" : deliveryLabels[reason] ?? reason}。 ${JSON.stringify(input)}`, ...input,
      ...(wake && { wakeId: wake.id }) } : null;
  }
  resumeStatus(s, role) {
    if (!role.enabled) return null;
    if (this.deliveryDiagnostic(s, role)?.reason === "delivery-loss-limit") return "delivery-issue";
    const notice = s.notices.findLast((item) => item.roleId === role.id && item.key.startsWith("resume:"));
    if (!notice) return null;
    if (notice.silent) return "silent";
    if (notice.readAt) return "read";
    if (role.deliveryIssue || s.wakes.some(wake => wake.roleId === role.id && wake.state === "failed" && !wake.consumedAt &&
      wake.noticeIds.includes(notice.id))) return "delivery-issue";
    if (role.resumeWake) return dispatchAvailability(role, Date.now()) === "offline" ? "offline" : "waiting-idle";
    return s.wakes.some((wake) => wake.roleId === role.id && wake.state === "enqueued" && wake.noticeIds.includes(notice.id))
      ? "delivered" : "pending";
  }
  snapshot() {
    const s = this.store.read();
    const now = Date.now(), checkWait = new Map();
    for (const job of s.checkJobs ?? []) {
      const ms = checkQueueDuration(job, now);
      for (const taskId of job.taskIds ?? [job.taskId]) checkWait.set(taskId, (checkWait.get(taskId) ?? 0) + ms);
    }
    const { plans, projects, controllerReads, promptAdmissions, toolsRepairHistory, roleIdentityConflicts, ...workbench } = s;
    return {
      ...workbench,
      tasks: s.tasks.map(task => ({ ...task, ...this.taskDelivery(s, task), waitTimings: waitTimings(task, checkWait.get(task.id) ?? 0, now) })),
      projects: projects.map(({ checkPolicy, allowedChecks, proposedChecks, ...project }) => project),
      controllerPolicyDefault: CONTROLLER_POLICY,
      roleIdentityDefaults: ROLE_IDENTITIES,
      notices: s.notices.slice(-100),
      wakes: s.wakes.slice(-100),
      roles: s.roles.map((r) => ({
        ...r,
        wakeHealth:wakeHealth(s,r.id),
        provider: providerOf(r),
        identityPrompt: savedPrompt(r.identityPrompt),
        isPrimary: controller(s, r.projectId)?.id === r.id,
        connected: connected(r),
        ...pendingInputStatus(r),
        resumeStatus: this.resumeStatus(s, r),
        deliveryDiagnostic: r.enabled ? this.deliveryDiagnostic(s, r) : null,
      })),
    };
  }
  commandPolicy(sessionId, command, args, provider = "dsh") {
    const projectId = sessionId === "ui" ? args?.projectId : this.actor(this.store.read(), sessionId, provider).projectId;
    return { timeoutMs: commandTimeout(command, executionPolicy(this.execution, projectId)) };
  }
  call(sessionId, command, args = {}, operationId, provider = "dsh", partialReason, source) {
    const operationIssue = operationIdIssue(command, operationId);
    if (operationIssue) return operationIssue;
    const observedAt = Date.now();
    this.inspectionContext = undefined;
    const result = commandCall(command, args, parameters => {
      try {
        return this.callValidated(sessionId, command, parameters, operationId, provider, partialReason, source);
      } catch (error) {
        if (!this.readOnly && ["check", "report"].includes(command) && error.verificationCode === "contract-invalid") {
          this.store.change(s => {
            const task = s.tasks.find(item => item.id === parameters.taskId);
            const actor = sessionId === "ui" ? null : this.actor(s, sessionId, provider);
            if (task && actor?.projectId === task.projectId && (actor.id === task.developerId || actor.kind === "controller"))
              this.recordContract(s, task, true, error.drift);
          });
        }
        throw error;
      }
    }, sessionId === "ui" && command === "scopePreview" ? ["projectId"] : []);
    if (this.inspectionContext && result && typeof result === "object") {
      Object.defineProperty(result, inspectionMetadata, { value: this.inspectionContext });
      if (!this.readOnly) this.recordInspection(sessionId, inspectedEntities(command, args, result), observedAt, provider);
    }
    return result;
  }
  recordInspection(sessionId, observed, at, provider = "dsh") {
    if (!observed) return;
    if (observed.workNotice) {
      return this.store.change(s => {
        const role = s.roles.find(item => item.sessionId === sessionId && providerOf(item) === provider && !item.archivedAt &&
          item.id === observed.workNotice.roleId);
        const notice = this.responsibilityNotice(s, role, observed.workNotice.taskId);
        if (notice?.id === observed.workNotice.id) this.confirmResponsibility(s, role, notice, "inspect", at);
      });
    }
    if (observed.contractObservation || observed.digestDiagnosis || observed.specNotices) {
      const { contractObservation: observation, digestDiagnosis } = observed;
      this.store.change(s => {
        const task = s.tasks.find(item => item.id === (observation ?? digestDiagnosis ?? observed.specNotices).taskId);
        if (!task) return;
        if (observed.specNotices) this.recordSpecNotices(s, task, observed.specNotices.items);
        if (observed.outsidePruneHead && ["paused", "trial"].includes(task.state) &&
            !releasedTaskScope(task) && task.baseline?.other.length) {
          const git = this.ownershipGit(s, task);
          if (git.head === observed.outsidePruneHead) {
            try { this.pruneOutside(s, task, git); }
            catch (error) { if (error.verificationCode !== "contract-invalid") throw error; }
          }
        }
        if (observation && !releasedTaskScope(task) && task.state !== "accepted" && task.baseline?.head === observation.head &&
          (task.scheduleVersion ?? 0) === observation.scheduleVersion && task.revision === observation.revision) {
          this.recordContract(s, task, observation.blocked, observation.drift, observation.at);
        }
        if (digestDiagnosis && task.state === digestDiagnosis.state && task.revision === digestDiagnosis.revision &&
          (task.scheduleVersion ?? 0) === digestDiagnosis.scheduleVersion) task.digestDiagnosis = digestDiagnosis;
      });
    }
    if (sessionId === "ui") return;
    const state = this.store.read();
    if (!state.roles.some(role => role.kind === "controller" && role.sessionId === sessionId && providerOf(role) === provider && !role.archivedAt)) return;
    this.store.change(s => {
      const role = s.roles.find(role => role.kind === "controller" && role.sessionId === sessionId && providerOf(role) === provider && !role.archivedAt);
      if (!role || at < (role.lastInboxAt ?? 0) || observed.generation !== (role.inboxGeneration ?? 0)) return;
      s.controllerReads ??= {};
      const reads = s.controllerReads[role.id] ??= { sinceInbox: role.lastInboxAt ?? 0, tasks: {}, jobs: {}, notices: {} };
      const taskIds = new Set(observed.tasks), jobIds = new Set(observed.jobs), visible = new Set(observed.noticeIds ?? []);
      for (const notice of s.notices) if (notice.roleId === role.id && !notice.readAt && visible.has(notice.id) &&
          (taskIds.has(notice.taskId) || ["check", "batch"].includes(notice.key.split(":")[0]) && jobIds.has(notice.key.split(":")[1]))) reads.notices[notice.id] = true;
      for (const id of observed.tasks) reads.tasks[id] = Math.max(reads.tasks[id] ?? 0, at);
      for (const id of observed.jobs) reads.jobs[id] = Math.max(reads.jobs[id] ?? 0, at);
    });
  }
  callValidated(sessionId, command, args = {}, operationId, provider = "dsh", partialReason, source) {
    need(
      args !== null && typeof args === "object" && !Array.isArray(args),
      "args 必须为 JSON 对象",
    );
    const state = this.store.read();
    const role = sessionId === "ui" ? null : this.actor(state, sessionId, provider);
    if (role?.kind === "controller" && inspectionCommands.has(command)) this.inspectionContext = {
      generation: role.inboxGeneration ?? 0, noticeIds: state.notices.filter(notice => notice.roleId === role.id && !notice.readAt).map(notice => notice.id),
    };
    if (role?.kind === "supervisor")
      need(["guide", "context", "inbox", "messages", "message", "operation"].includes(command), "监管者使用独立消息频道");
    const scope = role?.id ?? "ui";
    const controllerBoundary = role?.kind === "controller" ? { controllerBoundary: CONTROLLER_WAKE_BOUNDARY } : {};
    if (partialReason) {
      const evidence = { available: false, reason: partialReason, at: Date.now() };
      if (command === "previewPlan") {
        need(role?.kind === "controller" && find(state.requirements, args.requirementId).projectId === role.projectId, "仅本项目主控可预检计划");
        return { state: "unavailable", evidence };
      }
      if(command==='governance') {
        need(!role||role.kind==='controller'&&(args.projectId===undefined||args.projectId===role.projectId),'仅本项目主控可读取治理记录');
        return {state:'unavailable',records:[],evidence,nextAction:{command:'governance',args}};
      }
      if (command === "checkEvidence") {
        const job = find(state.checkJobs, args.jobId);
        need(!role || job.projectId === role.projectId, "不可跨项目读取");
        return { ...job, log: null, evidence };
      }
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      return { taskId: task.id, state: task.state, candidate: task.candidate, deliveredAt: task.deliveredAt ?? null, ...this.taskDelivery(state, task),
        ...this.taskTimes(state, task),
        classification: "evidence-missing", reason: "本地 Git 或文件证据暂不可用", evidence,
        ...controllerBoundary, nextAction: null, reference: { command: "inspect", ownerRole: "developer", ownerId: task.developerId,
          args: { taskId: task.id, ticketKey: task.ticketKey }, message: developerEvidenceMessage } };
    }
    if (command === "operation") return { ...controllerBoundary, ...this.store.receipt(scope, args.id) };
    if (command === "guide") return { guide: GUIDE, examples: commandExamples };
    if (command === "context") {
      need(role, "请从角色会话读取上下文");
      return roleContext(
        find(state.projects, role.projectId),
        role,
        controller(state, role.projectId)?.id === role.id,
        state,
      );
    }
    if (command === "checkStatus") {
      if (args.jobId !== undefined) {
        const job = find(state.checkJobs, args.jobId);
        need(!role || job.projectId === role.projectId, "不可跨项目读取");
        if(job.classification==='preparation-timeout') {
          const nextAction=preparationActionView(state,job,find(state.tasks,job.taskId));
          const timing=preparationTiming(job.check,job.receipt);
          return {...job,...timing,nextAction,hint:nextAction?.message??job.hint,
            receipt:{...job.receipt,...timing,nextAction,hint:nextAction?.message??job.hint}};
        }
        return job;
      }
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      return checkStatusResponse(state.checkJobs.filter((job) => jobIncludes(job, task.id)), args);
    }
    if (command === "inspectPlan") {
      const plan = find(state.plans, args.planId);
      need(!role || plan.projectId === role.projectId, "不可跨项目读取");
      if (args.document !== undefined) {
        const document = Object.hasOwn(plan.documents, args.document) ? plan.documents[args.document] :
          Object.values(plan.documents).find((item) => item.file === args.document);
        need(document, "没有该规划文档；多票计划用文档相对路径或索引键");
        const root = find(state.projects, plan.projectId).root;
        const inspected = inspectPlanningDocument(root, document);
        const tickets = state.tasks.filter(task => task.planId === plan.id && task.sources?.tickets?.file === document.file);
        const selected = args.taskId === undefined ? tickets : tickets.filter(task => task.id === args.taskId);
        if (args.taskId !== undefined) need(selected.length, "该票不使用此计划文档");
        const git = selected.length ? this.ownershipGit(state, selected[0]) : undefined;
        const ticketSources = selected.map(task => {
          const live = ticketSourceObservation(root, task, git, inspected.currentDigest);
          return { taskId: task.id, ticketKey: task.ticketKey, taskState: task.state,
            frozenDigest: live.source.digest, expectedDigest: live.expected, liveDigest: live.digest,
            status: live.staged ? "staged" : !live.digest ? "unavailable" : live.digest === live.expected ? "unchanged" : "changed" };
        });
        return { ...inspected, ...(ticketSources.length && { ticketSources }),
          ...(ticketSources.length === 1 && { ticketSource: ticketSources[0] }) };
      }
      return { ...plan, documents: Object.fromEntries(Object.entries(plan.documents).map(([name, doc]) => [name, { file: doc.file, digest: doc.digest }])) };
    }
    if (command === "checkEvidence") {
      const job = find(state.checkJobs, args.jobId);
      need(!role || job.projectId === role.projectId, "不可跨项目读取");
      if (!job.output) return { ...job, log: null };
      let bytes;
      try {
        bytes = readFileSync(job.output);
      } catch {
        verify(false, "evidence-missing", "检查日志无法读取：" + job.id);
      }
      verify(createHash("sha256").update(bytes).digest("hex") === job.receipt?.outputHash,
        "evidence-missing", "检查日志已变化，须重新核对：" + job.id);
      return { ...job, log: bytes.toString("utf8").slice(0, 24000) };
    }
    if (command === "messages") {
      need(["controller", "supervisor"].includes(role?.kind) || teamMessageRole(role), "该角色没有独立频道");
      const channel = state.messages.filter(item => item.projectId === role.projectId &&
        (item.from === role.id || item.to === role.id)).map(item => ({ ...item, kind: "message" }));
      const notices = state.notices.filter(item => item.roleId === role.id).map(item => this.noticeMessage(state, item));
      if (args.messageId !== undefined) return find([...channel, ...notices], args.messageId);
      // Bound the sidebar history, while always retaining the role's unread inbox entries.
      const history = [...channel, ...notices.filter(notice => notice.readAt)].sort((a, b) => a.at - b.at).slice(-50);
      return [...history, ...notices.filter(notice => !notice.readAt)].sort((a, b) => a.at - b.at);
    }
    if (command === "list") return { ...controllerBoundary, ...this.view(state, role) };
    if (command === 'governance') {
      need(!role || role.kind==='controller', '仅本项目主控可读取治理记录');
      need(!role || args.projectId===undefined || args.projectId===role.projectId, '不可跨项目读取');
      const limit=args.limit??50;
      need(Number.isSafeInteger(limit)&&limit>=1&&limit<=50, 'governance limit 必须为 1–50');
      const projectId=role?.projectId??args.projectId;
      if(projectId!==undefined)find(state.projects,projectId);
      const projects=state.projects.filter(project=>projectId===undefined||project.id===projectId).map(project=>({projectId:project.id,
        ...projectGovernance(project.root,state.tasks.filter(task=>task.projectId===project.id),limit)}));
      return {limit,projects,records:projects.flatMap(project=>project.records.map(record=>({projectId:project.projectId,...record})))};
    }
    if (command === 'cacheDiagnostics') {
      const member=find(state.roles,args.roleId);
      need(!role||member.projectId===role.projectId,'不可跨项目读取');
      return cacheDiagnostics(state,member.id);
    }
    if (command === 'buildCache') {
      const project = find(state.projects, args.projectId);
      need(!role || project.id === role.projectId, "不可跨项目读取");
      return buildCacheStats(this.store.directory, project.id);
    }
    if (command === "scopePreview") {
      const projectId = role?.projectId ?? args.projectId;
      need(!role || role.kind === "controller", "仅主控可预检草案范围");
      find(state.projects, projectId);
      const task = {
        projectId, writes: scopePaths(args.writes), reads: scopePaths(args.reads ?? []),
        ...(args.readOnly === true && { readScopeKnown: Array.isArray(args.reads) || scopePaths(args.contextReads ?? []).length > 0 }),
        resources: list(args.resources ?? [], "共享资源").map((resource) => text(resource, "资源").toLowerCase()),
      };
      if (args.taskId) need(find(state.tasks, args.taskId).projectId === projectId, "不可跨项目调整");
      return { conflicts: state.tasks.filter((peer) => peer.id !== args.taskId && activeScope(peer))
        .map((peer) => this.scopeConflict(state, task, peer)).filter(Boolean) };
    }
    if (command === "schema") {
      const name = typeof args === "string" ? args : args.command;
      const signature = commandSignature(name);
      if (name === "dispatchPlan" && ["requirementId", "spec", "ticketsDir", "tickets", "attempts"].some(field => args[field] !== undefined)) {
        try {
          const sources = Object.fromEntries(["spec", "ticketsDir", "tickets", "attempts"]
            .filter(field => args[field] !== undefined).map(field => [field, args[field]]));
          return freezePlan(state, role, { requirementId: args.requirementId, developerIds: args.developerIds, sources }, true, true);
        } catch (error) {
          if (!error.violations) throw error;
          return { state: "invalid", violations: error.violations, warnings: error.warnings ?? [] };
        }
      }
      if (name === "resumeTask") return { ...signature, required: ["taskId", "reason"], states: ["assigned", "rework", "paused"],
        preconditions: ["本项目主控", "成员不在运行，无排队输入或后台检查", "新心跳恢复后正常准入"], preserves: ["baseline", "candidate", "reports", "checkJobs", "reworkReason"] };
      if (name === "interveneTask") return { ...signature, role: "controller", modes: ["guide", "stop"],
        preconditions: ["同项目在飞开发票且责任成员已绑定 DSH 会话"], effect: "运行中递交给下一执行步骤；stop 即时冻结新检查和成功交付" };
      if (name === "ackTaskIntervention") return { ...signature, role: "developer",
        effect: "原绑定成员确认纠偏或停写。stop 等宿主作业及 LingFlow 检查收口后进入 paused" };
      if (name === "resolveTaskIntervention") return { ...signature, role: "controller",
        decisions: ["retry", "withdraw", "confirm-stopped"],
        evidence: "confirm-stopped 必填，说明如何证实原会话及外部写入进程已停止" };
      if (name === "unblock") return { ...signature, queuedInput: {
        args: { taskId: "<taskId>", reason: "核对并保留原会话输入", drainQueuedInput: true, expectedQueueFingerprint: "<复制 redeliver.nextAction.args>" },
        effect: "等待原绑定会话的空闲心跳，保留当前输入并与未送达的原票同轮处理" } };
      if (name === "reviseSchedule") return { ...signature, pruneOutside: {
        args: { taskId: "<taskId>", reason: "清理已提交的票外旧指纹", pruneOutside: true },
        states: ["queued", "paused", "trial", "assigned", "rework"], effect: "仅移除已核实收口的票外指纹并记录 baseline-other-pruned",
        combined: "可与 refreshBaseline 一起使用，同时满足基线刷新状态和校验门槛" },
        redBaselineHead: { optional: true, requires: ["refreshBaseline:true", "expectedHead", "reason"],
          effect: "显式选定与现有实现一致的当前 Git HEAD 为取红快照，仍须取得真实断言失败" },
        allowCheckRevision: { optional: true, effect: "停写后授权责任开发修订同一调度版本的冻结检查" },
        realignRedBaseline: { args: { taskId: "<taskId>", realignRedBaseline: true, expectedHead: "<当前 HEAD>",
          redBaselineHead: "<已核对的原分支提交>", reason: "核对未实现版本" },
          effect: "仅续接取红快照，活动票和待验证票可在检查结束后执行，保留已有检查和交付" },
        refreshSourceDigest: { states: ticketSourceReviewStates, requires: ["expectedSourceDigest", "reason"],
          effect: "确认诊断给出的当前票面摘要，保存对账记录，派发票面及原验收和检查仍冻结" } };
      if (name === "registerChecks") return { ...signature, role: "developer", optional: ["browserE2E", "resources", "replace", "reason"],
        check: planSchema.tickets[0].verification.checks[0],
        preconditions: ["原票选择 developerChecks:true 且已准入", "保持原实现基线", "冻结 AC、testWrites、主控探针和已批准范围保持有效"] };
      if (Object.hasOwn(taskScopeSchemas, name)) return { ...signature, ...taskScopeSchemas[name] };
      if (["previewPlan","dispatchPlan"].includes(name)) return { ...signature, ...planSchema };
      return signature;
    }
    if (command === "previewPlan") {
      try { return freezePlan(state, role, args, true); } catch(error) {
        if (!error.violations) throw error;
        return { state:"invalid", violations:error.violations, warnings:error.warnings ?? [] };
      }
    }
    if (command === "diagnoseTask") {
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      const diagnosis = this.diagnoseTask(state, task);
      if (args.supersedeConflict !== undefined) {
        need(role?.kind === "controller", "仅本项目主控可核对冲突承接");
        const peer = find(state.tasks, args.supersedeConflict);
        const conflict = this.scopeConflict(state, task, peer);
        need(conflict?.kind === "write/write", "仅可为真实写集冲突核对承接");
        const nextAction = scopeReplacementRemedy(state, task, peer, this.scopeReleaseGit(state, peer));
        Object.assign(diagnosis, { classification: "scope-conflict", reason: nextAction.message,
          scopeConflict: { ...conflict, message: nextAction.message, remedy: nextAction, nextAction }, nextAction });
      }
      const lead = controller(state, task.projectId);
      const recovery = this.recoveryPlan(state, task, diagnosis, lead);
      if (recovery.candidate || diagnosis.recovery)
        diagnosis.recovery = { ...diagnosis.recovery, ...recovery };
      if (recovery.executable && diagnosis.nextAction && diagnosis.nextAction.ownerRole !== "developer" &&
          diagnosis.nextAction.command !== "yieldForSchedule")
        diagnosis.nextAction = recovery.candidate;
      else if (diagnosis.classification !== "scope-conflict" && ["inspect", "guide", "checkEvidence"].includes(diagnosis.nextAction?.command)) {
        diagnosis.reference = diagnosis.nextAction;
        diagnosis.nextAction = null;
      }
      const blocked = ["contract-invalid", "baseline-drift-blocked", "unrecoverable"].includes(diagnosis.classification);
      if (this.inspectionContext) {
        this.inspectionContext.digestDiagnosis = diagnosisForDigest(state, task, diagnosis, blocked ? diagnosis.classification : undefined);
      }
      if (diagnosis.notices?.length && isController(role, task))
        this.inspectionContext = { ...this.inspectionContext, specNotices: { taskId: task.id, items: diagnosis.notices } };
      const drift = diagnosis.from && diagnosis.to && diagnosis.from !== diagnosis.to ? {
        from: diagnosis.from, to: diagnosis.to, committedBetween: diagnosis.committedBetween, conflicts: diagnosis.conflicts,
      } : undefined;
      if (task.baseline && !releasedTaskScope(task) && task.state !== "accepted" && (blocked || drift))
        this.inspectionContext = { ...this.inspectionContext, contractObservation: { taskId: task.id, head: task.baseline.head,
          scheduleVersion: task.scheduleVersion ?? 0, revision: task.revision, blocked, drift, at: Date.now() } };
      return { ...controllerBoundary, ...diagnosis, ...this.taskDelivery(state, task), ...this.taskTimes(state, task) };
    }
    if (command === "describeDrift") {
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      if (args.partitionPeerTaskId !== undefined) {
        need(isController(role, task), "仅本项目主控可核对部分提交");
        const peer = find(state.tasks, args.partitionPeerTaskId);
        const { git, partition } = this.commitPartition(state, task, peer);
        return { state: "verified", taskId: task.id, peerTaskId: peer.id, expectedBase: git.head, ...partition };
      }
      const root = find(state.projects, task.projectId).root;
      const drift = task.baseline && baselineDrift(root, task, this.ownershipGit(state, task), [...task.writes, ...readsFor(task)],
        { compareCandidate: true });
      return { taskId: task.id, from: task.baseline?.head ?? null, to: task.baseline?.head ?? null,
        committedBetween: [], conflicts: [], ...drift, origin: "unattributed", ...this.taskTimes(state, task) };
    }
    if (command === "inspect") {
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      if(args.section==='events') return this.store.taskEvents(task.id,args);
      const events=this.store.taskEvents(task.id);
      const response = inspectResponse({
        ...task,
        ...supersessionHint(state,task),events:events.items,eventCount:events.total,
        ...ownerStatus(state, task),
        ...this.taskDelivery(state, task),
        ...this.taskTimes(state, task),
        ...taskEnvironmentFailure(state.checkJobs.filter(job => jobIncludes(job, task.id) && (job.batchId || job.revision === task.revision))),
        ...(!task.candidate && { evidence: { available: false, reason: "no-candidate", at: Date.now() } }),
        verificationMode: verificationMode(task),
        requirement: find(state.requirements, task.requirementId),
        checkJobs: state.checkJobs.filter((job) => jobIncludes(job, task.id)),
        batch: state.validationBatches.find((batch) => batch.id === task.batchId),
      }, args);
      if (response.assignee === role?.id && (args.section === undefined || args.section === "full")) {
        const notice = this.responsibilityNotice(state, role, task.id);
        if (notice) this.inspectionContext = { ...this.inspectionContext,
          workNotice: { taskId: task.id, roleId: role.id, id: notice.id } };
      }
      return { ...controllerBoundary, ...response };
    }
    if (command === "deliveryEvidence") {
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      if (!task.verification || !task.candidate) return { taskId: task.id, state: task.state, ...this.taskDelivery(state, task),
        evidence: { available: false, reason: "no-candidate", at: Date.now() } };
      return this.deliveryEvidence(state, task, args);
    }
    if (command === "inbox")
      return this.store.change((s) => {
        need(role, "请从角色会话读取收件箱");
        this.normalizeNotices(s);
        const current = activeRole(s, role.id);
        let context;
        if (!hasCurrentContext(current)) {
          context = roleContext(
            find(s.projects, current.projectId),
            current,
            controller(s, current.projectId)?.id === current.id,
            s,
          );
          markContextSeen(current);
        }
        current.lastInboxAt = Date.now();
        current.inboxGeneration = (current.inboxGeneration ?? 0) + 1;
        s.controllerReads ??= {};
        delete s.controllerReads[current.id];
        const notices = s.notices.filter(
          (n) => n.roleId === role.id && !n.readAt,
        );
        const resuming = notices.some((n) => n.key.startsWith("resume:") && !n.silent);
        delete current.resumeWake;
        current.consecutiveWakeLosses = 0;
        delete current.pendingToolHealthCheck;
        for (const n of notices) {
          n.readAt = Date.now();
          this.recordDelivery(s, n, role.id, n.readAt);
        }
        for (const wake of s.wakes)
          if (wake.roleId === role.id && !wake.consumedAt && (activeWake(wake) || wake.state === "failed"))
            consumeWake(wake,Date.now());
        const messageIds = new Set(notices.filter((n) => n.key.startsWith("message:")).map((n) => n.key.slice(8)));
        return {
          ...controllerBoundary,
          notices,
          ...(resuming && { recovery: this.recovery(s, current) }),
          ...(messageIds.size ? { messages: s.messages.filter((item) => item.to === role.id && messageIds.has(item.id)) } : {}),
          tasks: role.kind === "supervisor" ? [] : s.tasks.filter(
            (t) =>
              t.assignee === role.id &&
              ["assigned", "reviewing", "rework"].includes(t.state),
          ),
          ...(context ? { context } : {}),
        };
      });
    const receipt = this.store.operation(scope, operationId, { command, args }, (s) => {
      const currentRole = role ? this.actor(s, sessionId, provider) : null;
      if (["check", "registerChecks", "reviseSchedule", "confirmForeignDirty", "rework", "resumeTask", "redeliver", "insertSchedule"].includes(command) ||
          command === "report" && args.outcome !== "blocked") {
        const task = s.tasks.find(task => task.id === args.taskId && task.projectId === currentRole?.projectId);
        if (activeTaskIntervention(task)?.mode === "stop") {
          const nextAction = { command: "diagnoseTask", args: { taskId: task.id } };
          throw Object.assign(Error("原票已请求停止。完成停写回执及作业收口后再调整。执行 diagnoseTask 核对。"),
            { verificationCode: "contract-invalid", nextAction });
        }
      }
      const workNotice = ["check", "registerChecks", "progress", "report", "review", "yieldForSchedule"].includes(command)
        ? this.responsibilityNotice(s, currentRole, args.taskId) : null;
      const ui = () => need(!currentRole, "仅用户工作台可执行");
      const lead = (projectId) =>
        need(
          !currentRole ||
            (currentRole.kind === "controller" &&
              currentRole.projectId === projectId),
          "仅本项目主控可执行",
        );
      let result;
      switch (command) {
        case "createProject": {
          ui();
          const directory = text(args.root, "项目目录");
          need(isAbsolute(directory), "请选择项目的绝对目录");
          const root = realpathSync(directory);
          need(statSync(root).isDirectory(), "项目目录无效");
          need(
            !s.projects.some((p) =>
              overlaps(
                [p.root.replaceAll("\\", "/")],
                [root.replaceAll("\\", "/")],
              ),
            ),
            "项目目录已存在或与已有项目重叠",
          );
          const project = { id: id(), name: text(args.name, "项目名称"), root };
          s.projects.push(project);
          const members = args.members ?? [];
          need(Array.isArray(members), "团队成员必须为列表");
          for (const member of members) addRole(s, project.id, member);
          const primary = controller(s, project.id);
          if (primary) project.primaryControllerId = primary.id;
          result = project;
          break;
        }
        case "deleteProject": {
          ui();
          const project = find(s.projects, args.projectId);
          need(!s.checkJobs.some((job) => job.projectId === project.id && activeCheck(job)), "项目有后台检查或待对账检查，需先收口");
          const roleIds = new Set(
            s.roles.filter((role) => role.projectId === project.id).map((role) => role.id),
          );
          s.projects = s.projects.filter((p) => p.id !== project.id);
          s.roles = s.roles.filter((role) => !roleIds.has(role.id));
          s.requirements = s.requirements.filter((r) => r.projectId !== project.id);
          s.tasks = s.tasks.filter((task) => task.projectId !== project.id);
          s.notices = s.notices.filter((notice) => !roleIds.has(notice.roleId));
          s.wakes = s.wakes.filter((wake) => !roleIds.has(wake.roleId));
          s.requests = s.requests.filter((request) => !roleIds.has(request.roleId));
          s.checkJobs = s.checkJobs.filter((job) => job.projectId !== project.id);
          s.validationBatches = s.validationBatches.filter((batch) => batch.projectId !== project.id);
          s.plans = s.plans.filter((plan) => plan.projectId !== project.id);
          s.messages = s.messages.filter((item) => item.projectId !== project.id);
          result = { deleted: true };
          break;
        }
        case "addRole": {
          ui();
          find(s.projects, args.projectId);
          result = addRole(s, args.projectId, args);
          break;
        }
        case "setControllerPolicy": {
          ui();
          const project = find(s.projects, args.projectId);
          const policy = args.policy ?? "";
          need(typeof policy === "string" && policy.length <= 16000, "主控提示词过长");
          if (project.controllerPolicy !== policy) {
            project.controllerPolicy = policy;
            for (const member of s.roles.filter((r) => r.projectId === project.id && r.kind === "controller" && !r.archivedAt)) {
              member.contextRevision = contextRevision(member) + 1;
              if (member.enabled)
                this.notice(s, member.id, `context:${contextRevision(member)}`, "主控行为规范已更新，读取 inbox 应用。");
            }
          }
          result = { policy };
          break;
        }
        case "setAutoPatrol": {
          ui();
          const project = find(s.projects, args.projectId);
          need(typeof args.enabled === "boolean", "巡检状态必须为布尔值");
          project.autoPatrol = args.enabled;
          if (!project.autoPatrol) {
            const roles = new Set(s.roles.filter((member) => member.projectId === project.id).map((member) => member.id));
            for (const member of s.roles.filter((member) => roles.has(member.id))) delete member.patrolStatus;
            for (const notice of s.notices)
              if (roles.has(notice.roleId) && !notice.readAt && notice.key.startsWith("patrol-"))
                notice.readAt = Date.now();
          }
          result = { enabled: project.autoPatrol };
          break;
        }
        case "publishPlan":
        case "message": {
          const planner = command === "publishPlan";
          const sender = currentRole;
          need(sender && (planner ? sender.kind === "planner" :
            ["controller", "supervisor"].includes(sender.kind) || teamMessageRole(sender)), "该角色不能向此频道发送消息");
          const notice = s.notices.find(item => item.id === args.replyTo && item.roleId === sender.id);
          const previous = args.replyTo === undefined ? null : s.messages.find(message => message.id === args.replyTo) ??
            (notice ? this.noticeMessage(s, notice) : null);
          if (args.replyTo !== undefined) verify(previous?.from && previous.from !== sender.id &&
            previous.to === sender.id && previous.projectId === sender.projectId,
            "contract-invalid", "replyTo 必须是本角色收到、且能核对发件角色的消息或通知。系统通知请按其操作指引处理。");
          const lead = sender.kind === "controller";
          if (!previous && (lead && args.roleId === undefined || !lead && sender.kind !== "supervisor" && !planner))
            verify(false, "contract-invalid", "主控直达成员须指定 roleId；回复须用 replyTo 引用实际收到的原消息");
          const target = previous ? s.roles.find(role => role.id === previous.from) :
            lead ? s.roles.find(role => role.id === args.roleId) : controller(s, sender.projectId);
          if (lead && target?.kind === "supervisor")
            verify(previous, "contract-invalid", "主控回复须引用原监管消息 replyTo；用 messages 查询并复制原消息 id。");
          need(target && target.projectId === sender.projectId &&
            !target.archivedAt && (lead ? target.kind === "supervisor" || teamMessageRole(target) : target.kind === "controller") &&
            (args.roleId === undefined || args.roleId === target.id), "频道成员无效：请核对同项目 roleId");
          const message = { id: id(), projectId: sender.projectId, from: sender.id, to: target.id,
            text: text(args.text, "消息"), replyTo: args.replyTo ?? null,
            ...(previous && { replyToKind: previous.kind ?? "message" }), at: Date.now() };
          if (planner) message.sources = planSources(find(s.projects, sender.projectId).root, args.sources);
          s.messages.push(message);
          const label = planner ? "规划已交付：" : sender.kind === "supervisor" ? "监管者转达用户消息：" :
            target.kind === "supervisor" ? "主控已回复监管消息：" : lead ? "主控直达消息：" : "成员回复：";
          this.notice(s, target.id, "message:" + message.id, label + message.id);
          result = { state: "stored", messageId: message.id };
          break;
        }
        case "savePromptPreset": {
          ui();
          const name = text(args.name, "预设名称");
          const identityPrompt = args.identityPrompt;
          need(name.length <= 80, "预设名称不能超过 80 个字符");
          need(
            typeof identityPrompt === "string" &&
              identityPrompt.trim() &&
              identityPrompt.length <= 16000,
            "预设提示词不能为空，且不能超过 16000 个字符",
          );
          const preset =
            args.presetId === undefined
              ? { id: id() }
              : find(s.promptPresets, args.presetId);
          need(
            !s.promptPresets.some(
              (p) =>
                p.id !== preset.id &&
                p.name.toLowerCase() === name.toLowerCase(),
            ),
            "已有同名提示词预设",
          );
          Object.assign(preset, { name, identityPrompt });
          if (args.presetId === undefined) s.promptPresets.push(preset);
          result = preset;
          break;
        }
        case "deletePromptPreset": {
          ui();
          const preset = find(s.promptPresets, args.presetId);
          s.promptPresets = s.promptPresets.filter((p) => p.id !== preset.id);
          result = { deleted: true };
          break;
        }
        case "editRole": {
          ui();
          const target = activeRole(s, args.roleId);
          if (saveRoleProfile(s, target, args) && target.enabled) {
            this.notice(
              s,
              target.id,
              `context:${contextRevision(target)}`,
              "角色资料已更新。读取收件箱中的新上下文。",
            );
          }
          result = target;
          break;
        }
        case "setPrimaryController": {
          ui();
          const target = activeRole(s, args.roleId);
          need(target.kind === "controller", "只能将主控设为通知负责人");
          const project = find(s.projects, target.projectId);
          const previous = controller(s, project.id);
          if (previous.id !== target.id) {
            project.primaryControllerId = target.id;
            for (const role of [previous, target])
              role.contextRevision = contextRevision(role) + 1;
            for (const notice of s.notices.filter(
              (n) =>
                n.roleId === previous.id &&
                !n.readAt &&
                /^(requirement|report|review|question|schedule|preflight|message|batch|batch-stale|check|check-reconcile|review-blocked|patrol-alert):/.test(n.key),
            )) {
              notice.readAt = Date.now();
              this.notice(
                s,
                target.id,
                notice.key,
                notice.summary,
                notice.taskId,
              );
            }
            if (target.enabled)
              this.notice(
                s,
                target.id,
                `context:${contextRevision(target)}`,
                "你已成为项目通知负责人。读取收件箱查看当前事项。",
              );
            if (previous.enabled)
              this.notice(
                s,
                previous.id,
                `context:${contextRevision(previous)}`,
                "项目通知负责人已切换。读取收件箱查看当前职责。",
              );
          }
          result = { roleId: target.id };
          break;
        }
        case "archiveRole": {
          ui();
          const target = activeRole(s, args.roleId);
          need(
            controller(s, target.projectId)?.id !== target.id,
            "请先指定另一位主控为通知负责人",
          );
          need(
            !target.enabled,
            "请先暂停该成员的新投递，并确认 DSH 会话已空闲",
          );
          need(
            target.state !== "running" &&
              !(target.pending > 0) &&
              !(target.jobs > 0),
            "该成员的 DSH 会话仍有运行或待处理输入",
          );
          need(
            !s.tasks.some(
              (t) =>
                (t.state !== "accepted" &&
                  (t.developerId === target.id || t.assignee === target.id)) ||
                t.questions.some((q) => q.from === target.id && q.blocking === true && !q.answer),
            ),
            "该成员仍有未收口的任务或未答复问题",
          );
          target.archivedAt = Date.now();
          target.archivedSessionId = target.sessionId;
          target.sessionId = null;
          for (const notice of s.notices)
            if (notice.roleId === target.id && !notice.readAt)
              notice.readAt = Date.now();
          for (const wake of s.wakes)
            if (wake.roleId === target.id) consumeWake(wake,Date.now(),'role-archived');
          result = { archived: true };
          break;
        }
        case "approve": {
          need(
            currentRole?.kind === "controller",
            "请在已开启的 DSH 主控会话登记用户确认的需求",
          );
          const projectId = currentRole.projectId;
          need(
            args.projectId === undefined || args.projectId === projectId,
            "不可登记其他项目的需求",
          );
          const requirement = {
            id: id(),
            projectId,
            text: text(args.text, "需求及验收条件"),
            source: text(args.source, "用户确认的对话摘录或引用"),
            recordedBy: currentRole.id,
            approvedAt: Date.now(),
          };
          s.requirements.push(requirement);
          const primary = controller(s, projectId);
          if (primary.id !== currentRole.id) {
            this.notice(
              s,
              primary.id,
              "requirement:" + requirement.id,
              "协同主控已登记需求：" + requirement.text,
            );
          }
          result = requirement;
          break;
        }
        case "confirmBinding": {
          ui();
          const request = find(s.requests, args.requestId),
            target = activeRole(s, request.roleId);
          need(providerOf(target) === "dsh", "会话类型不匹配");
          need(
            !target.sessionId || target.sessionId === request.sessionId,
            "角色已绑定其他会话",
          );
          need(
            !s.roles.some(
              (r) => r.id !== target.id && providerOf(r) === "dsh" && r.sessionId === request.sessionId,
            ),
            "会话已绑定其他角色",
          );
          target.sessionId = request.sessionId;
          target.enabled = false;
          request.confirmed = true;
          result = { bound: true, started: false };
          break;
        }
        case "enable": {
          ui();
          const target = activeRole(s, args.roleId);
          need(target.sessionId, "请先在 DSH 绑定角色");
          need(typeof args.enabled === "boolean", "enabled 必须是布尔值");
          need(args.resume === undefined || (args.resume === true && args.enabled), "续接必须开启角色");
          const starting = args.enabled && (!target.enabled || args.resume);
          target.enabled = args.enabled;
          if (starting) {
            // Reopening a long-lived session needs fresh context even when the profile is unchanged.
            delete target.seenContextRevision;
            target.resumeWake = true;
            target.enabledAt = Date.now();
            for (const notice of s.notices)
              if (notice.roleId === target.id && !notice.readAt && /^(resume|patrol-resume):/.test(notice.key))
                notice.readAt = target.enabledAt;
            delete target.patrolEpisode;
            const silent = !roleHasOpenResponsibility(target, s);
            this.notice(
              s,
              target.id,
              "resume:" + operationId,
              silent ? silentResumeText : resumeText,
              null, silent,
            );
          } else if (!target.enabled) {
            delete target.resumeWake;
            delete target.patrolStatus;
            for (const notice of s.notices)
              if (notice.roleId === target.id && !notice.readAt && notice.key.startsWith("patrol-resume:"))
                notice.readAt = Date.now();
          }
          result = { enabled: target.enabled };
          break;
        }
        case "dispatchPlan":
          result = freezePlan(s, currentRole, args);
          break;
        case "rearmWake": {
          const target = activeRole(s, args.roleId);
          need(!currentRole || isController(currentRole, target), "仅工作台或本项目主控可续接失效唤醒");
          const reason = text(args.reason, "续接依据");
          const now = Date.now();
          const blocker = dispatchAvailability(target, now, true);
          if (blocker || target.jobs !== 0 || target.pendingToolHealthCheck) {
            const code = blocker ?? "bridge-health-check";
            return { state: "blocked", roleId: target.id, blockedBy: [{code}],
              nextAction: { command:"list",args:{} }, detail: "执行 list 核对角色连接、队列和工具健康" };
          }
          const rearmed = rearmLostWake(s, target, now, (kind, data) => this.store.event(kind, data),
            (role, unread) => selectWakeNotices(s, role, unread, { ignoreFailed: true }).notices, { reason, manual: true });
          result = rearmed ? { state: "pending", ...rearmed } : { state: "no-failed-wake", roleId: target.id,
            nextAction: { command:"list",args:{} } };
          break;
        }
        case "redeliver": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.kind === "controller" && currentRole.projectId === task.projectId, "仅本项目主控可重试投递");
          if (task.deliveredAt && ["assigned","rework"].includes(task.state)) {
            result = this.resumeSilentTask(s, task, currentRole, args.reason ?? "member-silent：主控重投已送达但静默的原票");
            break;
          }
          const recipient = s.roles.find(role => role.id === (task.assignee ?? task.developerId));
          const queued = queuedInputRecovery(task, recipient, s.wakes.find(item => item.roleId === recipient?.id && activeWake(item)));
          if (queued) return queued;
          need(task.assignee && ["assigned", "rework"].includes(task.state) && !task.deliveredAt, `no-pending-delivery：当前 state=${task.state}，执行 inspect {"taskId":"${task.id}"}。 ${JSON.stringify(pendingInputStatus(recipient))}`);
          const wake = s.wakes.find(item => item.roleId === task.assignee && item.state === "pending" &&
            s.notices.some(notice => item.noticeIds.includes(notice.id) && notice.key === dispatchNotice(task)));
          if (wake?.diagnostic?.reason !== "retry-limit") return { state: "pending", taskId: task.id,
            blocker: wake?.diagnostic?.reason ?? (recipient && dispatchAvailability(recipient)) ?? "heartbeat-pending",
            ...pendingInputStatus(recipient, wake), nextAction: { command: "diagnoseTask", args: { taskId: task.id } },
            detail: `执行 diagnoseTask {"taskId":"${task.id}"} 核对原票。 ${JSON.stringify(pendingInputStatus(recipient, wake))}` };
          requeueWake(wake,Date.now(),'controller-retry');
          result = { state: "pending", taskId: task.id, wakeId: wake.id };
          break;
        }
        case "dropPendingInput": {
          const recipient = find(s.roles, args.roleId);
          need(currentRole?.kind === "controller" && currentRole.projectId === recipient.projectId, "仅本项目主控可取消排队输入");
          const status = pendingInputStatus(recipient);
          if (!recipient.enabled || !connected(recipient) || recipient.state !== "idle" || recipient.jobs !== 0 ||
              !recipient.canDropPendingInput || bridgeToolsBlocker(recipient) || !validQueueFingerprint(args.expectedQueueFingerprint) ||
              args.expectedQueueFingerprint !== recipient.pendingInputFingerprint || recipient.inputDrop) {
            return { state: "blocked", roleId: recipient.id, ...status, nextAction: { command: "list", args: {} },
              detail: `队列待对账。执行 list 核对当前绑定、空闲状态和队列。 ${JSON.stringify(status)}` };
          }
          const drop = { id: id(), sessionId: recipient.sessionId, fingerprint: args.expectedQueueFingerprint,
            count: recipient.pending, requestedIds: [...recipient.pendingInputIds], by: currentRole.id,
            reason: text(args.reason, "取消排队输入的依据"), at: Date.now(), operationId };
          const active = s.tasks.find(task => task.assignee === recipient.id && ["assigned", "rework"].includes(task.state) && !task.deliveredAt);
          if (active) drop.taskId = active.id;
          recipient.inputDrop = drop;
          this.store.event("input.drop-requested", { roleId: recipient.id, ...drop });
          result = { state: "pending", roleId: recipient.id, dropId: drop.id, ...pendingInputStatus(recipient),
            nextAction: { command: "list", args: {} } };
          break;
        }
        case "dispatch": {
          const requirement = find(s.requirements, args.requirementId);
          need(currentRole?.kind === "controller" && currentRole.projectId === requirement.projectId, "请在本项目已开启的 DSH 主控会话派单");
          verify(args.readOnly === true, "contract-invalid", "新实施票请用 dispatchPlan 并提供 tickets[].verification；纯调查才用 dispatch，例如 {\"readOnly\":true,\"writes\":[]}");
          const task = newTask(s, currentRole, requirement, args, id());
          task.dependencies = list(args.dependencies ?? [], "依赖");
          for (const dependency of task.dependencies)
            need(find(s.tasks, dependency).projectId === task.projectId, "依赖必须同项目");
          s.tasks.push(task);
          result = { taskId: task.id, receipt: "accepted" };
          break;
        }
        case "unblock": {
          const task = find(s.tasks, args.taskId);
          need(isController(currentRole, task), "仅本项目主控可 unblock");
          const reason = text(args.reason, "恢复原因");
          const recipient = s.roles.find(role => role.id === (task.assignee ?? task.developerId));
          const queued = queuedInputRecovery(task, recipient, s.wakes.find(item => item.roleId === recipient?.id && activeWake(item)));
          if (args.drainQueuedInput === true) {
            if (queued?.nextAction?.command !== "unblock" || queued.nextAction.args.expectedQueueFingerprint !== args.expectedQueueFingerprint) {
              return queued ? { ...queued, detail: "队列或会话状态已变，请按当前回执重新核对" } :
                { state: "blocked", taskId: task.id, blocker: "queue-changed", ...pendingInputStatus(recipient),
                  hint: "重新读取原票投递状态，当前队列无需授权或会话状态已变化" };
            }
            recipient.queuedInputApproval = { sessionId: recipient.sessionId, fingerprint: recipient.pendingInputFingerprint };
            this.store.event("task.queue-drain-authorized", { taskId: task.id, roleId: recipient.id, by: currentRole.id,
              pendingInputCount: recipient.pending, fingerprint: recipient.pendingInputFingerprint, reason });
            result = { state: "pending", taskId: task.id, ...pendingInputStatus(recipient), recovery: "drain-queued-input" };
            break;
          }
          if (queued) return queued;
          const diagnosis = this.diagnoseTask(s, task);
          const recovery = this.recoveryPlan(s, task, diagnosis, currentRole, reason);
          if (!recovery.executable) return { state: "blocked", taskId: task.id, chosen: recovery.candidate,
            remainingBlockers: recovery.remainingBlockers, nextAction: recovery.candidate };
          const chosen = recovery.candidate;
          if (recovery.requiresConfirmation) return { state: "confirmation-required", taskId: task.id, chosen,
            nextAction: chosen, remainingBlockers: ["请主控核对实际提交归属并明确执行所列命令"] };
          result = this.runRecovery(s, currentRole, chosen);
          this.store.event("task.unblocked", { taskId: task.id, command: chosen.command, by: currentRole.id, reason });
          const current = this.diagnoseTask(s, task);
          const after = this.recoveryPlan(s, task, current, currentRole);
          return { state: "applied", taskId: task.id, taskState: task.state, waitReason: task.waitReason ?? null, chosen, result,
            nextAction: current.nextAction ?? after.candidate,
            remainingBlockers: after.requiresConfirmation && after.executable ? ["待主控确认提交归属"] :
              after.candidate || ["contract-invalid", "baseline-drift-blocked", "scope-conflict"].includes(current.classification)
                ? after.remainingBlockers : [] };
        }
        case "resumeTask": {
          const task = find(s.tasks, args.taskId);
          result = this.resumeSilentTask(s, task, currentRole, text(args.reason, "恢复原因"));
          break;
        }
        case "supersede": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.kind === "controller" && currentRole.projectId === task.projectId, "仅本项目主控可替代原票");
          assertStoppedTask(s, task, { allowTrial: true });
          const successor = find(s.tasks, args.supersededBy);
          const git = this.scopeReleaseGit(s, task);
          const audit = { reason: text(args.reason, "替代原因"), by: currentRole.id, at: Date.now(), head: git.head };
          result = supersedeStoppedTask(s, task, successor, git, audit);
          this.recordContract(s, task, false);
          Object.assign(result,releaseHandoff(s,task,git));
          this.retire(s, task.id);
          this.notice(s, task.developerId, "superseded:" + task.id, "原票已被替代，停止原票工作并保留证据：" + task.title, task.id);
          break;
        }
        case 'abandonTask': {
          const task=find(s.tasks,args.taskId);
          need(currentRole?.kind==='controller'&&currentRole.projectId===task.projectId,'仅本项目主控可终止原票');
          const git=this.scopeReleaseGit(s,task);
          const audit={reason:text(args.reason,'终止原因'),by:currentRole.id,at:Date.now(),head:git.head};
          result=abandonStoppedTask(s,task,git,audit);
          this.recordContract(s, task, false);
          Object.assign(result,releaseHandoff(s,task,git));
          this.retire(s,task.id);this.store.event('abandon-task',{taskId:task.id,...audit});
          break;
        }
        case "recordSourceAppend": {
          const task = find(s.tasks, args.taskId);
          need(isController(currentRole, task), "仅本项目主控可登记规划追加");
          const file = scopePaths([args.file])[0];
          verify(task.sources?.tickets?.file !== file, "contract-invalid", "冻结票面不可追加记录，请更新 spec 或 planned attempts");
          const root = find(s.projects, task.projectId).root;
          const note = planningSourceNotes(root, task, s.plans.find(item => item.id === task.planId))
            .find(note => note.file === file && note.kind === "source-appended");
          verify(note?.toDigest, "contract-invalid", "只可登记能证明保留冻结原文的行边界追加");
          const receipt = { file, fromDigest: note.fromDigest, toDigest: note.toDigest,
            summary: text(args.summary, "追加内容"), at: Date.now(), by: currentRole.id };
          (task.sourceAppends ??= []).push(receipt);
          this.store.event("source.appended", { taskId: task.id, ...receipt });
          result = { state: "stored", taskId: task.id, ...receipt };
          break;
        }
        case 'confirmCommit': {
          const task=find(s.tasks,args.taskId);lead(task.projectId);
          need(currentRole?.kind==='controller','仅本项目主控可确认提交');
          result=this.confirmCommit(s,task,args,currentRole,operationId);
          break;
        }
        case "releaseSchedule": {
          result = this.releaseSchedule(s, currentRole, args);
          break;
        }
        case "proposeOwnedDirty": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.id === task.developerId && !releasedTaskScope(task) &&
            ["assigned", "rework", "queued", "paused"].includes(task.state), "仅本票责任开发者可提报写集归属");
          const files = list(args.files, "归属文件", 100);
          need(files.length, "须提供至少一个写集文件");
          const hashes = Object.create(null);
          for (const item of files) {
            const [file] = scopePaths([item?.file]);
            need(coversPath(task.writes, file) && !Object.hasOwn(hashes, file), "文件超出冻结写集或重复：" + file);
            need(typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256), "须填写小写 SHA-256：" + file);
            hashes[file] = item.sha256;
          }
          this.verifyOwnedDirty(s, task, hashes);
          const proposal = { files: hashes, state: "pending", by: currentRole.id, at: Date.now(),
            ...(args.reason !== undefined && { reason: text(args.reason, "归属提报说明") }) };
          task.ownedDirtyProposal = proposal;
          this.notice(s, controller(s, task.projectId).id, "schedule:owned-dirty:" + id(),
            "责任成员提报写集归属，须核对 SHA-256 后确认或拒绝：" + task.title, task.id);
          result = { state: "pending", taskId: task.id, proposal };
          break;
        }
        case "insertSchedule": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.kind === "controller" && currentRole.projectId === task.projectId, "仅本项目主控可调整前置");
          need(task.state === "queued" && !releasedTaskScope(task), "insertSchedule 仅允许未释放的 queued 票");
          need(Object.keys(args).every(key => ["taskId", "after", "reason"].includes(key)), "insertSchedule 只调整前置依赖");
          const next = resolveAfter(s.tasks, task, args.after);
          validateDependencyEdit(s, task, next);
          const previous = { dependencies: task.dependencies, stages: task.dependencyStages, writes: [...task.writes] };
          const reason = text(args.reason, "调整原因");
          retainDependencyReceipts(task, next);
          Object.assign(task, next, { scheduleVersion: (task.scheduleVersion ?? 0) + 1 });
          (task.scheduleHistory ??= []).push({ previous, reason, by: currentRole.id, at: Date.now() });
          result = { state: "stored", taskId: task.id, ...next, scheduleVersion: task.scheduleVersion };
          break;
        }
        case "interveneTask":
        case "ackTaskIntervention":
        case "resolveTaskIntervention": {
          const task = find(s.tasks, args.taskId);
          result = this.taskIntervention(s, task, currentRole, command, args);
          break;
        }
        case "yieldForSchedule": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.id === task.assignee && ["assigned", "rework"].includes(task.state), "只有已停写的责任成员可以交回调度");
          const request = activeTaskIntervention(task);
          if (request?.mode === "stop") {
            result = this.taskIntervention(s, task, currentRole, "ackTaskIntervention", { ...args, requestId: request.id });
            break;
          }
          need(!s.checkJobs.some((job) => jobIncludes(job, task.id) && activeCheck(job)), "先等待或对账后台检查，再交回调度");
          task.state = "paused";
          task.waitReason = text(args.reason, "现场冲突或调度原因");
          this.notice(s, controller(s, task.projectId).id, "schedule:" + id(), "待调整调度：" + task.title, task.id);
          const remedy = writeExpansionRemedy(find(s.projects, task.projectId).root, task);
          result = { state: "paused", taskId: task.id, reason: task.waitReason, ...remedy };
          break;
        }
        case "rebindCommittedWork": {
          const task = find(s.tasks, args.taskId);
          lead(task.projectId);
          need(currentRole?.kind === "controller", "仅本项目主控可确认提交归属");
          verify(!releasedTaskScope(task),'contract-invalid',releasedConfirmationMessage);
          need(task.state === "paused" && !task.candidate, '重绑顺序：1. diagnoseTask {taskId} 获取 nextAction；2. 已交付票由主控 rework {taskId,adjustScope:true,reason} 暂停，活动票由开发停写后 yieldForSchedule {taskId,reason}；3. 再 diagnoseTask，复制 nextAction.args 调 rebindCommittedWork。');
          const reason = text(args.reason, "主控确认提交归属的理由");
          need(reason !== "填写核对提交差异和归属的实际依据", "请填写主控核对提交差异和归属的实际依据");
          const root = find(s.projects, task.projectId).root;
          const git = this.ownershipGit(s, task);
          const drift = baselineDrift(root, task, git, [...task.writes, ...readsFor(task)]);
          const plan = s.plans.find((item) => item.id === task.planId);
          const sourceNotes = planningSourceNotes(root, task, plan);
          assertFrozenTicket(root, task, git);
          const records = recordedBaselineChanges(root, task, plan, git, drift);
          const overlap = this.committedRebindScope(s, task, root, git, drift, records);
          const expectedRecords = Object.fromEntries(records.map(({ file, toDigest }) => [file, toDigest]));
          verify(exactConfirmations(args.confirmRecordedBaseline, expectedRecords), "contract-invalid",
            '请按 diagnoseTask 确认已入库规划记录；confirmRecordedBaseline 必须是对象 {"规划相对路径":"<sha256>"}，不是布尔值；从 diagnoseTask.nextAction.args 复制实际路径与指纹，未要求确认时省略该字段。');
          assertCommitReference(args.expectedHead, drift.to, "expectedHead");
          assertCommitReference(args.expectedBase, drift.from, "expectedBase");
          verify(
            JSON.stringify(scopePaths(args.confirmPaths)) === JSON.stringify(scopePaths(overlap)),
            "contract-invalid", "基线或重叠文件与确认不一致；请重新用 diagnoseTask 核对");
          const previous = { writes: [...task.writes], baseline: structuredClone(task.baseline) };
          const rerunRed = drift.conflicts.length ? task.verification.checks
            .filter(check => check.stage === "red" && !this.validCheck(s, task, check)).map(check => check.id) : [];
          const redBaseline = task.redBaseline ?? { head: task.baseline.sourcesHead ?? task.baseline.head, sources: task.baseline.sources, sourceFiles: task.baseline.sourceFiles };
          const committedRed = implementationSnapshotAtCommit(root, task, git.head);
          const redBaselineRebound = Boolean(committedRed && committedRed.sources === redBaseline.sources);
          const deliveryBase = task.baseline.deliveryBase ?? task.baseline.head;
          const baseline = { ...scopeBaseline(root, task, this.foreignWrites(s, task), git), deliveryBase };
          const current = this.ownershipGit(s, task);
          verify(current.head === git.head && current.branch === git.branch && current.index === git.index &&
            JSON.stringify(current.dirty) === JSON.stringify(git.dirty), "contract-invalid", "核对期间 Git 状态已变化，请重新运行 diagnoseTask");
          assertFrozenTicket(root, task, current);
          verify(JSON.stringify(recordedBaselineChanges(root, task, plan, current, drift)) === JSON.stringify(records),
            "contract-invalid", "核对期间规划来源已变化，请重新运行 diagnoseTask");
          task.baseline = baseline;
          this.auditOutsidePrune(task, drift, committedOutsideBaseline(root, { ...task, baseline: previous.baseline }, drift, git));
          this.recordContract(s, task, false);
          delete task.pausedFrom;
          task.candidate = null;
          task.controllerEvidence = null;
          task.reportedAt = null;
          task.resumeState = "rework";
          task.redBaseline = redBaselineRebound ? { head: git.head, writes: [...task.writes], ...committedRed } : redBaseline;
          if (rerunRed.length) {
            task.revision++;
            this.invalidateCheckReceipts(s, task, rerunRed);
          }
          task.retainedWrites = [];
          task.state = "queued";
          task.waitReason = null;
          task.deliveredAt = null;
          task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
          const rebind = { from: drift.from, to: drift.to, overlap, reason, at: Date.now(), by: currentRole.id,
            redBaselineRebound, redBaselineHead: task.redBaseline.head,
            redBaselineReason: redBaselineRebound ? "当前提交与原取红实现等价，红基线已重绑" : "红基线保留原取证版本。可用 reviseSchedule {refreshBaseline:true,expectedHead,redBaselineHead,reason} 指定已核对历史提交",
            ...(sourceNotes.length && { sourceNotes }),
            ...(records.length && { recordedBaseline: records }),
            ...(rerunRed.length && { rerunRed,
              nextAction: { command: "check", args: { taskId: task.id, checkId: rerunRed[0] },
                message: "保留当前提交和改动；先在原写集恢复取红实现基线，再重取真实红；不要回退 Git HEAD。" } }) };
          (task.scheduleHistory ??= []).push({ previous, reason, by: currentRole.id, at: rebind.at, rebind });
          this.retire(s, task.id);
          result = { state: "applied", taskId: task.id, rebind, operationId,
            scannedFiles: git.ownershipMetrics?.scannedFiles ?? 0, ownership: git.ownershipMetrics,
            summary: { from: rebind.from, to: rebind.to, confirmedPaths: overlap, scheduleVersion: task.scheduleVersion } };
          break;
        }
        case "confirmForeignDirty":
        case "reviseSchedule": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.kind === "controller" && currentRole.projectId === task.projectId, "仅本项目 DSH 主控可调整调度");
          if (command === "confirmForeignDirty" || args.confirmForeignDirty !== undefined) {
            need(Object.keys(args).every(key => ["taskId", "reason", "confirmForeignDirty", "expectedHead"].includes(key)),
              "确认票外归属须单独执行");
            result = this.confirmForeignDirty(s, task, args, currentRole);
            break;
          }
          if (args.realignRedBaseline === true) {
            result = this.realignRedBaseline(s, task, args, currentRole);
            break;
          }
          if (Object.hasOwn(args, "verification")) {
            return { error: "unsupported", path: "args.verification", taskId: task.id,
              message: "reviseSchedule.verification 不支持直接替换检查。停写后由主控授权，再由责任开发 registerChecks {replace:true}",
              nextAction: { command: "reviseSchedule", args: { taskId: task.id, allowCheckRevision: true, reason: args.reason } } };
          }
          if (args.refreshSourceDigest === true) {
            result = this.refreshTicketSource(s, task, args, currentRole);
            break;
          }
          if (args.allowCheckRevision === true) {
            need(Object.keys(args).every(key => ["taskId", "reason", "allowCheckRevision", "preparationJobId"].includes(key)),
              "授权修订检查须单独执行");
            need(task.verification && task.baseline && task.state === "paused" && !task.candidate && task.assignee === task.developerId,
              "仅可授权已准入、停写且责任未转移的原票。先用 diagnoseTask 核对原票阶段");
            assertStoppedTask(s, task);
            const reason = text(args.reason, "修订检查的授权依据");
            task.checkRevisionApproval = { reason, by: currentRole.id, at: Date.now(), scheduleVersion: task.scheduleVersion ?? 0 };
            let nextAction;
            if (args.preparationJobId !== undefined) {
              const job = s.checkJobs.find(item => item.id === args.preparationJobId);
              const proposal = verify(preparationRevision(s, task, job), "contract-invalid",
                "该构建超时记录已变化或缺少同配方历史。执行 diagnoseTask 核对原票");
              task.checkRevisionApproval.preparationJobId = job.id;
              nextAction = proposal.registration;
            }
            this.store.event("checks.revision-approved", { taskId: task.id, ...task.checkRevisionApproval });
            result = { state: "stored", taskId: task.id, checkRevisionApproval: task.checkRevisionApproval, ...(nextAction && { nextAction }) };
            break;
          }
          need(args.redBaselineHead === undefined || args.refreshBaseline === true && args.expectedHead !== undefined,
            "显式确认取红 HEAD 须同时填写 refreshBaseline:true 和 expectedHead");
          if (args.pruneOutside === true && args.refreshBaseline !== true || task.state === "trial" && args.refreshBaseline === true &&
              task.baseline?.fingerprintEol === fingerprintEol) {
            need(Object.keys(args).every(key => ["taskId", "reason", "pruneOutside", "expectedHead", "refreshBaseline"].includes(key)),
              "单独清理票外指纹时只接受清理和 Git 快照参数");
            need(task.baseline && !releasedTaskScope(task),
              "仅可清理仍持有冻结基线的原票");
            text(args.reason, "清理原因");
            const git = this.ownershipGit(s, task);
            if (args.expectedHead !== undefined) assertCommitReference(args.expectedHead, git.head, "expectedHead");
            const prunedOutside = this.pruneOutside(s, task, git);
            result = { state: "stored", taskId: task.id, prunedOutside,
              ...(!prunedOutside.length && { pruneOutsideReason: !task.baseline.other.length
                ? "票外基线为空，没有可证明可清理的记录。冻结票面入库请用 diagnoseTask 核对。"
                : task.baseline.other.every(([file]) => overlaps([file], git.protectedPaths))
                  ? "现有记录均属于冻结来源、写集或检查输入，票外清理不会移除这些记录。"
                  : "没有可证明已收口、可从票外基线移除的文件" }) };
            break;
          }
          if (task.state === "trial" && args.refreshBaseline === true) {
            need(Object.keys(args).every(key => ["taskId", "reason", "refreshBaseline", "expectedHead", "pruneOutside"].includes(key)),
              "试用票口径续接只接受口径续接和清理参数");
            result = this.realignTrialFingerprint(s, task, args, currentRole);
            break;
          }
          if (["trial", "ready"].includes(task.state)) {
            result = this.reviseDeliveredSchedule(s, task, args, currentRole);
            break;
          }
          if (task.admittedAt && task.baseline?.fingerprintEol === fingerprintEol && !task.pausedFrom &&
              !task.redBaselinePending && task.verification && implementationScopeMatches(task, task.redBaseline ?? task.baseline) &&
              ["queued", "paused"].includes(task.state) && !releasedTaskScope(task) && args.refreshBaseline === true &&
              Object.keys(args).every(key => ["taskId", "reason", "refreshBaseline", "expectedHead"].includes(key))) {
            const root = find(s.projects, task.projectId).root;
            const git = this.ownershipGit(s, task);
            if (args.expectedHead !== undefined) assertCommitReference(args.expectedHead, git.head, "expectedHead");
            const scope = assertScope(root, task, this.foreignWrites(s, task), git);
            const drift = scope.drift;
            const plan = s.plans.find(item => item.id === task.planId);
            if (drift && drift.from !== drift.to && !recordedBaselineChanges(root, task, plan, git, drift).length) {
              const reason = text(args.reason, "调整原因");
              verify(this.advanceScope(s, task, scope, { by: currentRole.id, reason }), "contract-invalid",
                "票外旧脏文件仍有工作区版本，已保留原基线，请确认其归属");
              task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
              task.state = "queued";
              task.waitReason = null;
              task.deliveredAt = null;
              delete task.preflightFailure;
              this.retire(s, task.id);
              result = { state: "stored", taskId: task.id, scheduleVersion: task.scheduleVersion,
                rebind: { from: drift.from, to: drift.to, committedBetween: drift.committedBetween }, redBaselineReused: true };
              break;
            }
          }
          if (!task.readOnly && Array.isArray(args.writes) && args.writes.length === 0) {
            if (["assigned", "rework"].includes(task.state))
              need(false, recoveryHint(s, task) + " 活动票不可用空 writes 调整；符合静默条件时用 releaseSchedule。");
            need(Object.keys(args).every(key => ["taskId", "reason", "writes"].includes(key)), "释放范围请单独传 taskId、writes:[]、reason；其他调度调整另行核对。");
            result = this.releaseSchedule(s, currentRole, args);
            break;
          }
          const silentOwner = this.silentScheduleOwner(s, task, "reviseSchedule");
          need(!releasedTaskScope(task), "原票已释放或被替代，不再准入；剩余工作请登记后继票。");
          const root = find(s.projects, task.projectId).root;
          const reason = text(args.reason, "调整原因");
          const nextReads = args.reads === undefined ? task.reads : scopePaths(args.reads);
          const nextContextReads = args.contextReads === undefined ? task.contextReads ?? [] : scopePaths(args.contextReads);
          const nextWrites = args.writes === undefined ? task.writes : scopePaths(args.writes);
          const addedWrites = nextWrites.filter(file => !task.writes.includes(file));
          const pureWiden = addedWrites.length > 0 && task.writes.every(file => nextWrites.includes(file)) &&
            Object.keys(args).every(key => ["taskId", "reason", "writes"].includes(key));
          const member = s.roles.find(role => role.id === task.assignee);
          // Additive authorization retains all current paths and never transfers
          // peer ownership. New paths still need clean Git scope and proof.
          const widening = pureWiden && !task.readOnly && task.verification && task.baseline && !task.candidate && !task.pausedFrom &&
            ["assigned", "rework"].includes(task.state) && member?.id === task.developerId &&
            ((member?.state === "running" && connected(member)) || ownerStatus(s, task).silent);
          const recovered = widening ? null : silentOwner;
          if (recovered) need((args.after !== undefined || args.reads !== undefined) &&
            Object.keys(args).every(key => ["taskId", "reason", "after", "reads"].includes(key)),
            recoveryHint(s, task) + " 静默恢复调整 after 或 reads 时不得改写集；纯扩写集请单独执行。");
          need(widening || recovered || ["queued", "paused"].includes(task.state),
            recoveryHint(s, task) + "。成员运行时仅允许经核对的纯增写集。");
          if (widening) {
            need(member.jobs === 0 && !s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job)),
              "先收口已运行或待对账的检查和宿主作业，再扩写集");
            const target = { ...task, writes: nextWrites };
            const peer = s.tasks.find(item => item.id !== task.id && activeScope(item) && this.scopeConflict(s, target, item));
            need(!peer, "新增写集与在飞责任冲突：" + (peer?.ticketKey ?? peer?.id ?? ""));
            const sources = Object.values(task.sources ?? {}).map(source => source.file);
            need(!overlaps(addedWrites, sources), "新增写集不能覆盖冻结的规划文件");
          }
          let nextOwnedDirty = args.ownedDirty === undefined ? task.ownedDirty ?? [] : scopePaths(args.ownedDirty);
          need(args.rejectOwnedDirty === undefined || typeof args.rejectOwnedDirty === "boolean", "rejectOwnedDirty 须为布尔值");
          const disposition = args.confirmOwnedDirty !== undefined ? "confirmed" : args.rejectOwnedDirty === true ? "rejected" : null;
          if (disposition) {
            const proposal = task.ownedDirtyProposal;
            need(proposal?.state === "pending", "没有待核对的写集归属提报");
            need(!(args.confirmOwnedDirty !== undefined && args.rejectOwnedDirty === true), "不得同时确认与拒绝归属提报");
            if (disposition === "confirmed") {
              verify(exactConfirmations(args.confirmOwnedDirty, proposal.files), "contract-invalid", "须精确确认成员提报的路径和 SHA-256");
              this.verifyOwnedDirty(s, task, proposal.files);
              nextOwnedDirty = scopePaths([...nextOwnedDirty, ...Object.keys(proposal.files)]);
            }
            Object.assign(proposal, { state: disposition, reviewedBy: currentRole.id, reviewedAt: Date.now(), reviewReason: reason });
          }
          need(task.readOnly ? !nextWrites.length : nextWrites.length, "调整后仍须保留正确的写入范围");
          need(nextOwnedDirty.every((file) => coversPath(nextWrites, file)), "已有改动授权必须在调整后的写入范围内");
          const nextResources = args.resources === undefined ? task.resources : [...new Set(list(args.resources, "共享资源").map((r) => text(r, "资源").toLowerCase()))];
          const previous = { reads: task.reads, contextReads: task.contextReads ?? [], writes: [...task.writes], resources: task.resources, dependencies: task.dependencies, stages: task.dependencyStages, ownedDirty: task.ownedDirty };
          const next = args.after === undefined ? { dependencies: task.dependencies, dependencyStages: task.dependencyStages } :
            resolveAfter(s.tasks, task, args.after);
          const { dependencies: nextDependencies, dependencyStages: nextStages } = next;
          if (args.after !== undefined) validateDependencyEdit(s, task, next);
          if (task.batchId) {
            const batch = find(s.validationBatches, task.batchId);
            const peers = batch.taskIds.filter((id) => id !== task.id).map((id) => find(s.tasks, id));
            const batchAncestor = (id) => batch.taskIds.includes(id) || find(s.tasks, id).dependencies.some(batchAncestor);
            need(!nextDependencies.some(batchAncestor), "调度会使同批次互等，请主控先调整累计验证的分组方案");
            const nextTask = { ...task, reads: nextReads, writes: nextWrites };
            need(!peers.some((peer) => overlaps(nextWrites, [...peer.writes, ...readsFor(peer)]) ||
              overlaps(readsFor(nextTask), peer.writes)), "实际写入与同批候选冲突，请主控重新安排累计验证");
          }
          assertTicketContract({ ...task, writes: nextWrites });
          let rebind, redBaselineResult, prunedOutside;
          const invalidatedChecks = [];
          if (args.refreshBaseline === true) verify(task.verification && task.baseline, "contract-invalid", "尚无可重绑的冻结基线；请用 diagnoseTask 核对原票");
          if (task.verification) {
            need(task.verification.testWrites.every((file) => nextWrites.some((write) => file === write || file.startsWith(write + "/"))), "调整不能移除冻结的测试文件");
            if (task.baseline) {
              const previousBaseline = structuredClone(task.baseline);
              const modeChanged = task.baseline.fingerprintEol !== fingerprintEol;
              if (modeChanged && !args.refreshBaseline) assertFingerprintMode(task);
              const git = this.ownershipGit(s, { ...task, reads: nextReads, contextReads: nextContextReads, writes: nextWrites });
              if (widening) {
                assertFrozenTicket(root, task, git);
                need(git.head === task.baseline.head && git.branch === task.baseline.branch && git.indexClean &&
                  addedWrites.every(file => git.tracked.has(file.toLowerCase())) && !overlaps(addedWrites, git.dirty),
                  "运行中只可添加当前冻结分支上未改动的已跟踪文件。其他情况请停写后对账");
              }
              const touched = git.dirty.filter((file) => coversPath(task.writes, file));
              need(touched.every((file) => nextWrites.some((write) => file === write || file.startsWith(write + "/"))), "调整会释放仍有修改的文件，请先处理写入归属");
              const expanded = git.dirty.filter((file) => coversPath(nextWrites, file) && !coversPath(task.writes, file));
              need(expanded.every((file) => nextOwnedDirty.includes(file)), "新增写入包含已有改动，需先核实用户授权与归属");
              task.retainedWrites = [...new Set([...touched, ...expanded])];
              const sameWrites = JSON.stringify(scopePaths(task.writes)) === JSON.stringify(scopePaths(nextWrites));
              const readsChanged = JSON.stringify(scopePaths(task.reads)) !== JSON.stringify(scopePaths(nextReads));
              const reference = task.redBaseline ?? previousBaseline;
              const needsRedRepair = task.redBaselinePending || !implementationScopeMatches(task, reference);
              const scopeEdited = !sameWrites || readsChanged;
              let projected;
              if (scopeEdited || needsRedRepair || args.redBaselineHead !== undefined || args.refreshBaseline === true && reference.writes) {
                previous.baseline = previousBaseline;
                previous.redBaseline = task.redBaseline;
                const target = { ...task, writes: nextWrites };
                if (args.redBaselineHead !== undefined) {
                  verify(!modeChanged, "contract-invalid", "请先续接指纹口径，再显式确认取红提交");
                  projected = this.redCommitSnapshot(root, target, git, args);
                } else if (!modeChanged && (!sameWrites || needsRedRepair)) {
                  projected = projectImplementationBaseline(root, task, nextWrites, reference);
                  if (!projected && args.refreshBaseline === true && args.expectedHead !== undefined) {
                    assertCommitReference(args.expectedHead, git.head, "expectedHead");
                    const proof = implementationSnapshotAtCommit(root, target, git.head);
                    if (proof) projected = { head: git.head, writes: [...nextWrites], ...proof };
                  }
                } else if (reference.writes && args.refreshBaseline === true && !modeChanged) {
                  const proof = implementationSnapshotAtCommit(root, target, reference.head);
                  if (proof?.sources === reference.sources) projected = { ...reference, ...proof };
                }
                if (projected) {
                  task.redBaseline = projected;
                  Object.assign(task.baseline, { sources: projected.sources, sourceFiles: projected.sourceFiles, sourcesHead: projected.head });
                  delete task.redBaselinePending;
                  if (projected.sources !== reference.sources || !pureWiden) {
                    const rerunRed = task.verification.checks.filter(check => check.stage === "red").map(check => check.id);
                    redBaselineResult = { redBaselineRealigned: true, redBaselineHead: projected.head,
                      previousSources: reference.sources, newSources: projected.sources, rerunRed };
                  }
                } else if (!sameWrites || needsRedRepair) {
                  need(!widening, "新增范围无法从原取红快照证明。请停写后确认取红基线");
                  task.redBaseline ??= { ...reference, writes: [...task.writes] };
                  task.redBaselinePending = true;
                  redBaselineResult = { redBaselinePending: true, reason: "无法证明原取红快照在当前写集下的内容；请核对取红提交或登记承接票" };
                }
                if (scopeEdited || projected && (projected.sources !== reference.sources || needsRedRepair)) {
                  const checkIds = task.verification.checks.filter(check =>
                    check.stage !== "red" || !pureWiden || projected?.sources !== reference.sources).map(check => check.id);
                  for (const job of s.checkJobs) if (job.taskId === task.id && job.state === "passed" &&
                      !job.invalidated && checkIds.includes(job.check.id))
                    invalidatedChecks.push({ checkId: job.check.id, jobId: job.id,
                      reason: job.check.stage === "red" ? "写集变化导致红基线内容变化" : "调度范围变化，须按新范围核对检查" });
                  this.invalidateCheckReceipts(s, task, checkIds);
                }
              }
              if (!recovered) task.baseline.other = task.baseline.other.filter(([file]) => !expanded.includes(file));
              if (args.refreshBaseline === true) {
                const drift = baselineDrift(root, task, git, [...task.writes, ...nextWrites, ...readsFor(task), ...nextReads]);
                if (args.expectedHead !== undefined) assertCommitReference(args.expectedHead, git.head, "expectedHead");
                verify(!drift?.blockingCondition, "contract-invalid", `${drift?.blockingCondition}；请主控先核对 Git 或用 dispatchPlan 建立后继票，保留原票证据`);
                const pruned = committedOutsideBaseline(root, task, drift, git, [...nextWrites, ...nextReads, ...nextContextReads]);
                prunedOutside = pruned.map(([file]) => file);
                const records = recordedBaselineChanges(root, task, s.plans.find((item) => item.id === task.planId), git, drift);
                verify(!records.length, "contract-invalid", "前移包含冻结时未提交的规划记录：" + summarizePaths(records.map((note) => note.file)) + "；请用 diagnoseTask 核对显式接纳条件");
                assertOutsideScope(root, { ...task, writes: nextWrites }, this.foreignWrites(s, task), git, pruned);
                need(touched.every((file) => nextOwnedDirty.includes(file)), "重新绑定基线前须逐项确认现有改动归属");
                previous.baseline = previousBaseline;
                const { sources, sourceFiles, sourcesHead, deliveryBase } = task.baseline;
                const sameScope = JSON.stringify([task.writes, task.reads, task.dependencies, task.dependencyStages, task.resources]) ===
                  JSON.stringify([nextWrites, nextReads, nextDependencies, nextStages, nextResources]);
                const evidenceBase = sameScope && !modeChanged ? this.evidenceBase(task) : null;
                if (modeChanged) {
                  const reference = task.redBaseline ?? task.baseline;
                  verify(sameWrites &&
                    reference.sources === this.sourceInput(root, task, task.baseline.fingerprintEol ?? "raw"), "contract-invalid",
                    "切换指纹口径前须恢复原取红实现内容并保持冻结写集；不能从已推进的实现静默重算。");
                  if (task.redBaseline) Object.assign(task.redBaseline, implementationFingerprint(root, task));
                  task.revision++;
                  this.invalidateCheckReceipts(s, task, task.verification.checks.map(check => check.id));
                }
                const refreshed = scopeBaseline(root, { ...task, writes: nextWrites, ownedDirty: nextOwnedDirty }, this.foreignWrites(s, task), git);
                const redBaseline = task.redBaseline ?? previousBaseline;
                const rerunRed = task.verification.checks.filter(check => check.stage === "red").map(check => check.id);
                const proof = !redBaselineResult && !modeChanged && sameWrites && rerunRed.length && redBaseline.head === previousBaseline.head
                  ? implementationAtCommit(root, task, previousBaseline.head) : null;
                const realigned = proof && proof.sources === refreshed.sources;
                const sourceChanged = realigned && (sources !== proof.sources || redBaseline.sources !== proof.sources);
                if (realigned) {
                  task.redBaseline = { head: previousBaseline.head, ...proof };
                  if (sourceChanged) {
                    task.revision++;
                    this.invalidateCheckReceipts(s, task, task.verification.checks.map(check => check.id));
                  }
                  redBaselineResult = { redBaselineRealigned: true, previousSources: sources !== proof.sources ? sources : redBaseline.sources,
                    newSources: proof.sources, rerunRed,
                    nextAction: { command: "check", args: { taskId: task.id, checkId: rerunRed[0] } } };
                } else if (!modeChanged && !redBaselineResult) {
                  redBaselineResult = { redBaselineReused: true, reason: "实现文件仍与基线提交不同",
                    nextAction: { command: "diagnoseTask", args: { taskId: task.id } } };
                }
                task.baseline = {
                  ...refreshed,
                  ...(!modeChanged && !realigned && { sources, sourceFiles, ...(sourcesHead && { sourcesHead }) }),
                  ...(deliveryBase && { deliveryBase }),
                  ...(evidenceBase && !sourceChanged && { evidenceBase }),
                };
                this.recordContract(s, task, false);
                if (drift) rebind = { from: drift.from, to: drift.to, committedBetween: drift.committedBetween };
                this.auditOutsidePrune(task, drift, pruned);
              }
            }
          }
          if (task.baseline && !args.refreshBaseline && JSON.stringify(task.writes) !== JSON.stringify(nextWrites))
            task.baseline.admissionWrites ??= [...task.writes];
          if (disposition === "confirmed") {
            for (const [file, sha256] of Object.entries(task.ownedDirtyProposal.files))
              verify(fileSha256(root, file) === sha256, "contract-invalid", "核对期间文件 SHA-256 已变，须重新提报：" + file);
          }
          if (args.after !== undefined) retainDependencyReceipts(task, next);
          if (recovered) {
            Object.assign(previous, { state: task.state, deliveredAt: task.deliveredAt });
            find(s.roles, task.developerId).resumeTaskAfter = Date.now();
          }
          Object.assign(task, {
            reads: nextReads, contextReads: nextContextReads, writes: nextWrites, resources: nextResources, ownedDirty: nextOwnedDirty,
            ...(task.readOnly && (args.reads !== undefined || nextContextReads.length > 0) && { readScopeKnown: true }),
            dependencies: nextDependencies, dependencyStages: nextStages,
            ...(!widening ? { state: "queued", waitReason: null, deliveredAt: null } : {}),
            ...(task.pausedFrom && { candidate: null, controllerEvidence: null, reportedAt: null, pausedFrom: null, resumeState: "rework" }),
            scheduleVersion: (task.scheduleVersion ?? 0) + 1,
          });
          (task.scheduleHistory ??= []).push({ previous, reason, by: currentRole.id, at: Date.now(), ...recovered, ...(rebind && { rebind }) });
          if (!widening) this.retire(s, task.id);
          if (pureWiden) {
            this.store.event("schedule.writes-widened", { taskId: task.id, added: addedWrites, by: currentRole.id, reason, scheduleVersion: task.scheduleVersion,
              ...(invalidatedChecks.length && { invalidatedChecks }) });
            this.notice(s, task.developerId, `schedule:${task.id}:${task.scheduleVersion}`,
              "写集已扩：" + summarizePaths(addedWrites) + "。继续原责任，核对取红与检查回执。", task.id);
          }
          result = { state: redBaselineResult?.redBaselineRealigned ? "applied" : "stored", taskId: task.id, scheduleVersion: task.scheduleVersion,
            ...(pureWiden && { addedWrites }),
            ...(invalidatedChecks.length && { invalidatedChecks }),
            ...(args.pruneOutside === true && { prunedOutside: prunedOutside ?? [],
              ...(!prunedOutside?.length && { pruneOutsideReason: "没有可证明已收口、可从票外基线移除的文件" }) }),
            ...recovered, ...(rebind && { rebind }), ...redBaselineResult };
          break;
        }
        case "registerChecks": {
          const task = find(s.tasks, args.taskId);
          const replacing = args.replace === true;
          const initial = Boolean(task.developerChecksPending);
          const approval = task.checkRevisionApproval;
          need(currentRole?.kind === "developer" && currentRole.id === task.developerId &&
            currentRole.id === task.assignee && (replacing ? task.state === "paused" : ["assigned", "rework"].includes(task.state)),
          "仅原票责任开发可登记或修订检查");
          verify(task.baseline && task.verification && !releasedTaskScope(task) && (replacing
            ? approval?.scheduleVersion === (task.scheduleVersion ?? 0) && !task.candidate
            : task.developerChecksPending), "contract-invalid", "该票的检查已冻结或未选择开发登记模式；修订须先停写并由主控明确授权");
          need(Object.keys(args).every(key => ["taskId", "checks", "browserE2E", "resources", "replace", "reason"].includes(key)),
            "只能登记检查、浏览器用例和已批准的共享资源");
          if (replacing) need(!s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job)), "修订前先收口所有在途检查");
          if (replacing && approval.preparationJobId) {
            result = this.registerPreparationBudgets(s, task, args, currentRole);
            break;
          }
          const checks = list(args.checks, "开发检查", 20);
          verify(checks.every(check => check && !leadCheck(check)), "contract-invalid", "主控探针只能由主控在派发时冻结");
          const resources = list(args.resources ?? [], "检查共享资源").map(resource => text(resource, "资源名称").toLowerCase());
          const undeclared = resources.filter(resource => !task.resources.includes(resource));
          verify(!undeclared.length, "contract-invalid", "检查资源尚未获批：" + undeclared.join("、") + "；请停写后由主控调整原票");
          const root = find(s.projects, task.projectId).root;
          const git = this.verifyScope(s, task, currentRole, true);
          const frozen = task.verification;
          const warnings = [];
          const probes = frozen.checks.filter(leadCheck).map(check => {
            const { expectedOutput, ...recipe } = check;
            return expectedOutput ? check : recipe;
          });
          const browserE2E = [...(replacing && args.browserE2E !== undefined ? [] : frozen.browserE2E ?? []),
            ...list(args.browserE2E ?? [], "浏览器用例", 20)];
          const verification = readVerification({ ...frozen, browserE2E, checks: [...probes, ...checks] },
            { root, writes: task.writes, risk: task.risk, warnings });
          const previousChecks = new Map(frozen.checks.map(check => [check.id, check]));
          const replacements = new Map(verification.checks.map(check => [check.id, check]));
          const sameRecipe = (left, right) => right && left.stage === right.stage && sameCheckRecipe(left, right);
          const invalidatedChecks = frozen.checks.filter(check => !sameRecipe(check, replacements.get(check.id)));
          if (initial || !replacing || invalidatedChecks.some(check => check.stage === "red") ||
              verification.checks.some(check => check.stage === "red" && !sameRecipe(check, previousChecks.get(check.id)))) {
            const basis = task.redBaseline ?? task.baseline;
            if (task.redBaselinePending || !implementationScopeMatches(task, basis) || basis.sources !== this.sourceInput(root, task)) {
              const nextAction = this.redBaselineRecovery(s, task, root, git) ??
                { command: "diagnoseTask", args: { taskId: task.id } };
              throw Object.assign(Error("须在原取红实现未变化时登记新红检查。先保留当前实现和测试，再按诊断核对取红基线。"),
                { verificationCode: "contract-invalid", nextAction });
            }
          }
          const approvedResources = new Set([...task.resources, ...frozen.checks.flatMap(check => check.resources ?? [])]);
          verify(verification.checks.every(check => (check.resources ?? []).every(resource => approvedResources.has(resource))),
            "contract-invalid", "修订检查只能使用已批准的共享资源");
          const unapproved = scopePaths(verification.checks.filter(check => !leadCheck(check))
            .flatMap(check => [...check.inputs, ...(check.requiredArtifacts ?? [])]))
            .filter(file => !coversPath([...task.writes, ...task.reads], file));
          verify(!unapproved.length, "contract-invalid", "检查输入或产物超出已批准读写范围：" + unapproved.join("、") + "；请停写后由主控调整原票");
          assertTicketContract({ ...task, verification, developerChecksPending: false });
          if (replacing) {
            const audit = { previous: { writes: [...task.writes], verification: frozen }, approval,
              invalidatedChecks: invalidatedChecks.map(check => check.id),
              reason: text(args.reason, "检查修订依据"), at: Date.now(), by: currentRole.id };
            (task.scheduleHistory ??= []).push(audit);
            this.invalidateCheckReceipts(s, task, audit.invalidatedChecks);
            task.revision++;
            task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
            delete task.checkRevisionApproval;
            this.retire(s, task.id);
            this.store.event("checks.revised", { taskId: task.id, ...audit });
          }
          task.verification = verification;
          delete task.developerChecksPending;
          task.checksRegisteredAt = Date.now();
          const checkIds = verification.checks.filter(check => !leadCheck(check)).map(check => check.id);
          const nextAction = task.state === "paused"
            ? { command: "reviseSchedule", args: { taskId: task.id, reason: "检查修订已登记，沿原票恢复调度" } }
            : { command: "check", args: { taskId: task.id, checkId: verification.checks.find(check => check.stage === "red").id } };
          this.store.event("checks.registered", { taskId: task.id, by: currentRole.id, checkIds, at: task.checksRegisteredAt });
          result = { state: "stored", taskId: task.id, checkIds, nextAction, warnings };
          break;
        }
        case "check": {
          const task = find(s.tasks, args.taskId);
          need(task.verification && currentRole?.projectId === task.projectId, "只有本项目责任成员可以提交冻结检查");
          verify(!task.developerChecksPending, "contract-invalid", "责任开发须先用 registerChecks 冻结检查");
          const check = find(task.verification.checks, args.checkId);
          this.checkResponsibility(task, check, currentRole);
          const upstreamRed = this.upstreamRed(s, task, check);
          if (upstreamRed) {
            this.verifyScope(s, task, currentRole, true);
            result = { state: "red-not-applicable", redNotApplicable: true, jobId: upstreamRed.id, upstreamTaskId: upstreamRed.taskId };
            break;
          }
          need(args.async === undefined || typeof args.async === "boolean", "async 须为布尔值");
          const project = find(s.projects, task.projectId);
          const running = s.checkJobs.find((job) => job.taskId === task.id && job.check.id === check.id && activeCheck(job));
          const job = { id: id(), taskId: task.id, ticketKey:task.ticketKey, projectId: task.projectId, root: project.root,
            check, files: this.checkPaths(task, check), revision: task.revision, scheduleVersion: task.scheduleVersion ?? 0, requester: currentRole.id,
            fingerprintEol, rawPaths: task.verification.testWrites,
            state: "queued", createdAt: Date.now(), ...(source && { source }) };
          if (args.async) {
            if (running) { result = { jobId: running.id, state: running.state }; break; }
            job.preparing = true;
            s.checkJobs.push(job);
            result = { jobId: job.id, state: job.state };
            break;
          }
          // Keep pre-policy frozen responsibilities resumable under their original terms.
          if (leadCheck(check) || task.verification.browserE2E) assertCheckOwnership(project.root, check, task.verification.browserE2E);
          const scope = this.verifyScope(s, task, currentRole, true);
          const input = this.checkInput(project.root, task, check);
          const notes = planningSourceNotes(project.root, task, s.plans.find((item) => item.id === task.planId));
          const advisory = { ownership: scope.ownershipMetrics, ...(notes.length && { sourceNotes: notes }) };
          if (running) { result = { jobId: running.id, state: running.state, ...advisory }; break; }
          if (check.stage !== "red") this.checkPrerequisites(s, task, check, project.root);
          const cached = this.validCheck(s, task, check);
          if (cached) {
            if (leadCheck(check)) this.completeIndependentChecks(s, task);
            this.recordContract(s, task, false);
            result = { jobId: cached.id, state: "passed", ...advisory };
            break;
          }
          if (check.stage === "red") this.checkPrerequisites(s, task, check, project.root);
          Object.assign(job, { input, ownership: scope.ownershipMetrics });
          if (check.stage === "red") Object.assign(job, redEvidence(project.root, task, check, task.redBaseline?.sources));
          this.recordContract(s, task, false);
          s.checkJobs.push(job);
          result = { jobId: job.id, state: job.state, ...advisory,
            ...(job.redProofVersion && { redProofScope: job.redProofScope, excludedTestWrites: job.excludedTestWrites }) };
          break;
        }
        case "reconcileCheck": {
          const job = find(s.checkJobs, args.jobId);
          need(!currentRole||currentRole.kind==='controller'&&currentRole.projectId===job.projectId,'仅本项目主控或用户工作台可对账检查；不可跨项目操作');
          need(job.state === "uncertain", "只有待对账的检查可人工收口");
          job.reconciliation = text(args.evidence, "已确认旧进程退出及资源安全的依据");
          job.state = "interrupted";
          job.finishedAt = Date.now();
          if(currentRole)Object.assign(job,{reconciledBy:'controller',reconciledById:currentRole.id,reconciledAt:job.finishedAt});
          if (job.batchId) find(s.validationBatches, job.batchId).state = "interrupted";
          result = { state: job.state,...(currentRole&&{jobId:job.id,reconciledBy:'controller',reconciledById:currentRole.id}) };
          break;
        }
        case "report": {
          const task = find(s.tasks, args.taskId);
          need(
            currentRole?.id === task.developerId &&
              (["assigned", "rework"].includes(task.state) || recoveringFingerprint(task) ||
                args.outcome === "blocked" && task.state === "paused" && !releasedTaskScope(task)),
            "仅责任开发者可以交付活动任务；暂停时可回报阻塞",
          );
          need(args.outcome === undefined || ["success", "blocked"].includes(args.outcome), "report outcome 为 success 或 blocked");
          const handoff = handoffFields(args);
          if (args.outcome === "blocked") {
            const diagnostic = this.diagnoseTask(s, task);
            const sourceNotes = diagnostic.sourceNotes ?? [];
            const planning = specVersionSummary(sourceNotes);
            const notices = diagnostic.notices ?? [];
            if (["contract-invalid", "baseline-drift-blocked"].includes(diagnostic.classification))
              this.recordContract(s, task, true, diagnostic);
            const report = {
              id: id(), revision: task.revision, developerId: currentRole.id, outcome: "blocked",
              summary: text(args.summary, "实现与自测结果"), blocker: text(args.blocker, "未交付原因"),
              ...handoff, dimensions: threeDimensions(args.dimensions), at: Date.now(),
              ...(sourceNotes.length && { sourceNotes, ...planning }),
              ...(task.verification && { gate: { classification: diagnostic.classification, reason: diagnostic.reason, nextAction: diagnostic.nextAction,
                ...Object.fromEntries(["checkId", "from", "to", "committedBetween", "conflicts", "blockingCondition", "blockingConditions", "sourceNotes", "afterStop", "recovery", "shortStatus", "recordedBaseline"].filter((key) => diagnostic[key] !== undefined).map((key) => [key, diagnostic[key]])) } }),
            };
            (task.blockedReports ??= []).push(report);
            task.digestDiagnosis = diagnosisForDigest(s, task, diagnostic, diagnostic.classification);
            this.recordSpecNotices(s, task, notices);
            this.notice(s, controller(s, task.projectId).id, "report-blocked:" + report.id, "开发报告 · 交付受阻：" + task.title, task.id);
            result = { state: "stored", outcome: "blocked", reportId: report.id, taskId: task.id, qualitySummary: formatQualitySummary(report),
              ...(sourceNotes.length && { sourceNotes, ...planning }), ...(notices.length && { notices }) };
            break;
          }
          verify(!task.developerChecksPending, "contract-invalid", "责任开发须先用 registerChecks 冻结检查并取得真实检查回执");
          need(!handoff.openItems?.some((item) => item.blocking), "有阻塞项请用 report outcome=blocked，不能作为成功交付");
          this.assertQuestionsAnswered(s, task, "developer");
          let checks = args.checks, findings, manifest, deliveredFiles;
          if (task.verification) {
            const git = this.verifyScope(s, task, currentRole, true);
            checks = task.verification.checks.filter((check) => !leadCheck(check)).map((check) => {
              const job = verify(this.deliveryCheck(s, task, check), "evidence-missing", "缺少通过且仍有效的程序检查：" + check.id);
              return this.checkReference(check, job, task);
            });
            findings = threeDimensions(args.dimensions, checks);
            this.recordContract(s, task, false);
            verify(Object.values(findings).every((item) => item.state === "pass"), "evidence-missing", "交付前需收口三维检查中的阻塞或未验证项");
            const root = find(s.projects, task.projectId).root;
            const deliveryBase = task.baseline.deliveryBase;
            const changed = [...new Set([...(deliveryBase ? changedFromBaseline(root, deliveryBase) : []), ...git.dirty])]
              .filter((file) => coversPath(task.writes, file)).sort();
            const originallyTracked = deliveryBase ? committedFiles(root, deliveryBase) : git.tracked;
            manifest = {
              head: git.head,
              ...(deliveryBase && { deliveryBase }),
              scopeNotes: scopeNotes(root, task, this.foreignWriteOwners(s, task), git, s.plans.find((item) => item.id === task.planId)),
              files: changed.map((file) => ({ file, fingerprint: fingerprint(root, [file], [], undefined, { rawPaths: task.verification.testWrites }) })),
              testChanges: changed.filter((file) =>
                originallyTracked.has(file.toLowerCase()) && coversPath(task.verification.testWrites, file)),
            };
            if (task.candidateScope === 2) deliveredFiles = candidateFiles(root, task);
          } else {
            assertFrozenTicket(find(s.projects, task.projectId).root, task);
            need(Array.isArray(checks) && checks.length && checks.every((c) =>
              typeof c.command === "string" && c.command.trim() && c.exitCode === 0 &&
              typeof c.evidence === "string" && c.evidence.trim()), "请提供通过的必要检查 command/exitCode/evidence");
            if (task.dimensionsRequired || args.dimensions !== undefined) findings = threeDimensions(args.dimensions);
          }
          const candidate = deliveredFiles ? snapshotFingerprint(deliveredFiles) : this.hash(s, task);
          delete task.reworkReason;
          const sourceNotes = manifest ? manifest.scopeNotes.filter(note => note.kind !== "foreign-in-flight") :
            planningSourceNotes(find(s.projects, task.projectId).root, task, s.plans.find(item => item.id === task.planId));
          const planning = specVersionSummary(sourceNotes);
          const citedSpec = args.specVersion === undefined ? task.specVersion : readSpecVersion(`Version: ${args.specVersion}`);
          const currentSpec = planning.specVersion?.current ?? (planning.specVersion ? null : task.specVersion);
          verify(args.specVersion === undefined || citedSpec && [task.specVersion, currentSpec].includes(citedSpec),
            "contract-invalid", "report.specVersion 须引用派发或当前规格版本。先执行 diagnoseTask {taskId} 核对版本");
          const implementationSpec = citedSpec ? { implementedSpecVersion: citedSpec, implementationSummary: `按 spec ${citedSpec} 实现。` } : {};
          const notices = this.specNotices(s, task, sourceNotes);
          const report = {
            id: id(),
            revision: task.revision,
            candidate,
            summary: text(args.summary, "交付说明"),
            developerId: currentRole.id, ...handoff,
            checks,
            ...(checks.some(check => check.redNotApplicable) && { redNotApplicable: checks.filter(check => check.redNotApplicable) }),
            verificationMode: verificationMode(task),
            ...implementationSpec,
            ...(manifest && { manifest }),
            ...(sourceNotes.length && { sourceNotes, ...planning }),
            ...(findings && { dimensions: findings }),
            at: Date.now(),
          };
          task.reports.push(report);
          task.candidate = candidate;
          if (deliveredFiles) {
            task.deliveredManifest = { reportId: report.id, revision: task.revision, head: manifest.head, files: deliveredFiles };
            delete task.deliveryVerification;
          }
          if (task.fingerprintRecovery) {
            delete task.fingerprintRecovery;
            task.waitReason = null;
          }
          task.reportedAt = report.at;
          task.state = task.risk === "high" ? "waiting_review" : task.verification ? "waiting_verification" : "ready";
          task.assignee = null;
          if (task.state === "waiting_verification") this.completeIndependentChecks(s, task);
          this.retire(s, task.id);
          this.recordSpecNotices(s, task, notices);
          if (task.state !== "waiting_review") this.notice(
            s,
            controller(s, task.projectId).id,
            "report:" + report.id,
            (task.state === "waiting_verification" ? "免审候选待独立验证：" : "开发已报告：") + task.title,
            task.id,
          );
          result = {
            state: "stored",
            taskId: task.id,
            candidate,
            verificationMode: verificationMode(task),
            reviewRequired: task.risk === "high",
            qualitySummary: formatQualitySummary(report),
            ...implementationSpec,
            ...(report.redNotApplicable && { redNotApplicable: report.redNotApplicable }),
            ...(sourceNotes.length && { sourceNotes, ...planning }),
            ...(notices.length && { notices }),
            independentRequired: task.state === "waiting_verification",
          };
          break;
        }
        case "review": {
          const task = find(s.tasks, args.taskId);
          need(
            currentRole?.kind === "reviewer" &&
              currentRole.id === task.assignee &&
              task.state === "reviewing",
            "仅已派审的独立审查者可报告",
          );
          verify(
            args.candidate === task.candidate &&
              this.hash(s, task) === task.candidate,
            "contract-invalid",
            "候选输入已变化，需主控返工并重新交付",
          );
          need(
            ["pass", "changes"].includes(args.verdict),
            "审查 verdict 为 pass 或 changes",
          );
          const handoff = handoffFields(args);
          if (args.verdict === "pass") this.assertQuestionsAnswered(s, task, "reviewer");
          need(args.verdict !== "pass" || !handoff.openItems?.some((item) => item.blocking), "审查通过不能含阻塞项，请用 verdict=changes");
          let dimensions, testReview, classification;
          if (task.verification) {
            if (args.verdict === "pass") {
              this.verifyScope(s, task, undefined, true);
              const checks = this.assertDeliveryProof(s, task);
              dimensions = threeDimensions(args.dimensions, checks);
              testReview = this.reviewTestChanges(task, args.testReview);
            } else {
              classification = args.classification ?? "evidence-missing";
              need(verificationCodes.includes(classification), "未知审查结论分类");
              dimensions = threeDimensions(args.dimensions);
            }
          } else if (task.dimensionsRequired || args.dimensions !== undefined) {
            dimensions = threeDimensions(args.dimensions);
          }
          if (args.verdict === "pass" && dimensions)
            verify(Object.values(dimensions).every((item) => item.state === "pass"), "evidence-missing", "审查通过需要三维证据全部通过");
          const review = {
            revision: task.revision,
            id: id(),
            reviewerId: currentRole.id,
            candidate: task.candidate,
            verdict: args.verdict,
            findings: text(args.findings, "审查证据及反例"),
            ...handoff,
            ...(dimensions && { dimensions }),
            ...(classification && { classification }),
            ...(testReview && { testReview }),
            at: Date.now(),
          };
          task.reviews.push(review);
          task.state = args.verdict === "pass" ? reviewedState(task) : "changes_requested";
          if (task.state === "ready") this.recordDeliveryVerification(s, task);
          task.assignee = null;
          this.retire(s, task.id);
          this.notice(
            s,
            controller(s, task.projectId).id,
            "review:" + review.id,
            "审查" +
              (args.verdict === "pass" ? "通过" : "需返工") +
              "：" +
              task.title + (task.state === "waiting_verification" ? " · 待主控收口检查" : ""),
            task.id,
          );
          result = { state: "stored", qualitySummary: formatQualitySummary(review), ...(classification && { classification }) };
          break;
        }
        case "rework": {
          const task = find(s.tasks, args.taskId);
          lead(task.projectId);
          verify(!releasedTaskScope(task),'contract-invalid',releasedConfirmationMessage);
          const allowedEvidence=(task.verification?.checks??[]).filter(check=>!leadCheck(check)).map(check=>check.id);
          need(args.evidence===undefined || Array.isArray(args.evidence)&&args.evidence.length<=allowedEvidence.length&&
            args.evidence.every(checkId=>typeof checkId==='string'&&allowedEvidence.includes(checkId))&&new Set(args.evidence).size===args.evidence.length,
            'evidence 必须是本票冻结的非主控检查 id 数组；可选 id：'+allowedEvidence.join('、'));
          const reworkEvidence=args.evidence??[];
          const evidenceItems=reworkEvidence.map(checkId=>{
            const job=s.checkJobs.findLast(job=>job.taskId===task.id&&job.check.id===checkId);
            return {checkId,classification:job?.classification??(job?.state==='passed'?'passed':'evidence-missing'),
              reason:job?.error??job?.reason??job?.receipt?.reason??job?.environmentFailureReason??'未取得可核对的有效回执'};
          });
          need(
            [
              "assigned",
              "queued",
              "paused",
              "blocked",
              "changes_requested",
              "ready",
              "trial",
              "waiting_review",
              "waiting_verification",
              "waiting_batch",
              "reviewing",
            ].includes(task.state),
            "当前状态不能返工；" + recoveryHint(s, task),
          );
          need(!s.checkJobs.some((job) => jobIncludes(job, task.id) && activeCheck(job)), "请先收口后台检查");
          if (["assigned", "rework"].includes(task.state))
            need(ownerStatus(s, task).silent, recoveryHint(s, task));
          if (["reviewing"].includes(task.state))
            need(ownerStatus(s, task, Date.now(), task.assignee).silent, "独立审查正在执行或状态未确认，等原回合结束后返工");
          const hadCandidate = Boolean(task.candidate);
          const sameContent = !hadCandidate || this.candidateFingerprint(s, task, task.baseline?.fingerprintEol ?? fingerprintEol) === task.candidate;
          const retain = sameContent && !reworkEvidence.length;
          if (!retain) task.revision++;
          if (task.batchId && (!retain || hadCandidate && !args.adjustScope)) {
            const batch = find(s.validationBatches, task.batchId);
            const members = batch.taskIds.map((id) => find(s.tasks, id));
            need(!members.some((member) => member.state === "accepted"), "批次已有业务验收，请通过后继票处理，保留已验收历史");
            for (const member of members) {
              if (["ready", "trial"].includes(member.state)) {
                member.state = "waiting_batch";
                member.trialInstructions = null;
                member.controllerEvidence = null;
              }
            }
            batch.state = "waiting";
          }
          need(args.adjustScope === undefined || typeof args.adjustScope === "boolean", "adjustScope 必须为布尔值");
          const previousStage = task.state;
          if (args.adjustScope && retain && hadCandidate) task.pausedFrom = task.pausedFrom ?? previousStage;
          else delete task.pausedFrom;
          if (!args.adjustScope) task.resumeState = "rework";
          task.state = args.adjustScope ? "paused" : "queued";
          task.waitReason = args.adjustScope ? "等待主控在原票调整范围" : null;
          task.assignee = task.developerId;
          if (!task.pausedFrom) {
            task.candidate = null;
            task.controllerEvidence = null;
            task.reportedAt = null;
          }
          task.deliveredAt = null;
          task.reviewDeliveredAt = null;
          task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
          task.reworkReason = text(args.reason, "返工原因");
          task.reworkEvidence=[...reworkEvidence];
          task.reworkEvidenceDetails=evidenceItems;
          this.invalidateCheckReceipts(s, task, reworkEvidence);
          this.retire(s, task.id);
          if(evidenceItems.length)this.notice(s,task.developerId,`rework-evidence:${task.id}:${task.revision}`,
            `返工证据清单 ${task.ticketKey??task.id}：`+evidenceItems.map(item=>`${item.checkId} · ${item.classification} · ${item.reason}`).join('\n'),task.id);
          result = { taskId: task.id, revision: task.revision, ...(args.adjustScope && { state: "paused" }) };
          break;
        }
        case "summarize": {
          const task = find(s.tasks, args.taskId);
          lead(task.projectId);
          requireContract(task);
          verify(task.state === "ready", "evidence-missing", "尚未满足交付门槛");
          if (task.verification) need(currentRole?.kind === "controller", "实施票须由 DSH 主控核对证据并汇总");
          const testReview = task.verification && task.risk !== "high"
            ? this.reviewTestChanges(task, args.decision?.testReview, { command: "summarize", path: "decision.testReview" }) : undefined;
          let historicalCommit;
          if (task.verification) {
            historicalCommit = this.verifyScope(s, task, undefined, true).drift?.historicalCommit;
            const checks = this.assertDeliveryProof(s, task, true, historicalCommit);
            const decision = args.decision;
            verify(decision?.candidate === task.candidate, "contract-invalid", "主控须核对并引用当前候选");
            const acceptance = list(decision.acceptance, "主控核对的验收证据").map((item) => ({
              id: key(item?.id, "验收条款"), evidence: text(item?.evidence, "主控核对的验收证据"),
              evidenceJobs: evidenceJobs(item?.checkIds, checks, item?.id, item?.id),
            }));
            need(acceptance.length === task.verification.acceptance.length &&
              task.verification.acceptance.every((ac) => acceptance.filter((item) => item.id === ac.id).length === 1),
              "主控须逐项核对冻结的验收条款");
            task.controllerEvidence = { candidate: task.candidate, acceptance,
              limits: text(decision.limits, "主控核对后的剩余限制"), by: currentRole.id, at: Date.now(),
              ...(historicalCommit && { deliveryCommit: historicalCommit }) };
            if (task.risk !== "high") {
              if (testReview) task.controllerEvidence.testReview = testReview;
            }
          }
          if (task.batchId) this.verifyBatchReceipt(s, task, historicalCommit);
          verify(
            historicalCommit || this.hash(s, task) === task.candidate,
            "contract-invalid",
            "候选输入已变化，需重新交付",
          );
          task.trialInstructions = text(args.instructions, "试用步骤");
          task.summarizedAt??=Date.now();
          task.state = "trial";
          const notes = task.verification ? planningSourceNotes(find(s.projects, task.projectId).root, task, s.plans.find((item) => item.id === task.planId)) : [];
          const planning = specVersionSummary(notes);
          const notices = this.specNotices(s, task, notes);
          this.recordSpecNotices(s, task, notices);
          result = { state: "awaiting_user", verificationMode: verificationMode(task), ...(notes.length && { sourceNotes: notes, ...planning }),
            ...(notices.length && { notices }), ...(historicalCommit && { deliveryCommit: historicalCommit }) };
          break;
        }
        case "accept": {
          const task = find(s.tasks, args.taskId);
          need(!currentRole || isController(currentRole, task), "仅用户工作台或本项目主控可验收");
          requireContract(task);
          const evidence = text(args.evidence, "用户试用验收记录");
          need(task.state === "trial", "请先由主控汇总试用步骤");
          let historicalCommit;
          if (task.verification) {
            historicalCommit = this.verifyScope(s, task, undefined, true).drift?.historicalCommit;
            this.assertDeliveryProof(s, task, true, historicalCommit);
          }
          if (task.batchId) this.verifyBatchReceipt(s, task, historicalCommit);
          verify(
            historicalCommit || this.hash(s, task) === task.candidate,
            "contract-invalid",
            "试用候选已变化，不能验收旧候选",
          );
          const notes = task.sources ? planningSourceNotes(find(s.projects, task.projectId).root, task,
            s.plans.find(item => item.id === task.planId)) : [];
          const planning = specVersionSummary(notes);
          const acceptance = { evidence, acceptedBy: currentRole?.id ?? "ui", candidate: task.candidate, at: Date.now(),
            ...(historicalCommit && { deliveryCommit: historicalCommit }) };
          task.acceptance = acceptance;
          task.acceptedAt = acceptance.at;
          task.state = "accepted";
          this.retire(s, task.id);
          this.store.event("task.accepted", { taskId: task.id, ...acceptance });
          result = { state: "accepted", acceptedBy: acceptance.acceptedBy, ...planning,
            ...(historicalCommit && { deliveryCommit: historicalCommit }) };
          break;
        }
        case "question": {
          const task = find(s.tasks, args.taskId);
          need(isController(currentRole, task) || currentRole &&
            [task.developerId, task.assignee].includes(currentRole.id), "仅本项目主控或责任成员可提问");
          need(!releasedTaskScope(task) && task.state !== "accepted", "已退出执行的票请使用 message");
          need(args.blocking === undefined || typeof args.blocking === "boolean", "blocking 须为布尔值");
          const question = {
            id: id(), from: currentRole.id, text: text(args.text, "问题"), answer: null,
            blocking: args.blocking === true, scope: currentRole.kind, at: Date.now(),
          };
          task.questions.push(question);
          const target = isController(currentRole, task) ? task.assignee ?? task.developerId : controller(s, task.projectId).id;
          this.notice(s, target, "question:" + question.id,
            (question.blocking ? "任务阻塞：" : "任务提问：") + question.text, task.id);
          result = { state: "stored", questionId: question.id, blocking: question.blocking, scope: question.scope };
          break;
        }
        case "answer": {
          const task = find(s.tasks, args.taskId);
          const q = find(task.questions, args.questionId);
          need(isController(currentRole, task) || currentRole?.projectId === task.projectId &&
            (currentRole.id === q.from || this.questionScope(s, task, q) === "controller" &&
              [task.developerId, task.assignee].includes(currentRole.id)), "仅本项目主控、提问者或主控点名的责任成员可答复");
          need(!q.answer, "问题已经答复");
          need(args.resume === undefined || typeof args.resume === "boolean", "resume 须为布尔值");
          q.answer = text(args.text, "答复");
          q.answeredBy = currentRole.id;
          const receipt = { state: "stored" };
          if (args.resume !== false && isController(currentRole, task) && task.state === "paused" &&
              this.questionScope(s, task, q) === "developer" && q.blocking && !this.blockingQuestions(s, task, "developer").length) {
            const action = { command: "resumeTask", args: { taskId: task.id, reason: "责任开发的阻塞问题已答复" } };
            const recovery = this.tryRecovery(s, currentRole, action);
            if (recovery.executable) receipt.recovery = this.resumeSilentTask(s, task, currentRole, action.args.reason);
            else receipt.remainingBlockers = recovery.remainingBlockers;
          }
          if (q.from !== currentRole.id) this.notice(s, q.from, "answer:" + q.id,
            "问题已答复：" + q.answer, task.id);
          result = receipt;
          break;
        }
        case "progress": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.id === task.assignee, "仅责任成员可更新进度");
          task.progress = text(args.text, "进度");
          result = { state: "stored" };
          break;
        }
        case "retryBatch": {
          const batch = find(s.validationBatches, args.batchId);
          need(currentRole?.kind === "controller" && currentRole.projectId === batch.projectId, "仅本项目 DSH 主控可重新安排累计检查");
          need(["failed", "stale", "interrupted"].includes(batch.state), "累计检查尚未失败或待对账");
          batch.retryReason = text(args.reason, "重跑依据");
          batch.state = "waiting";
          result = { state: "waiting", batchId: batch.id };
          break;
        }
        case "reviseBatch": {
          const batch = find(s.validationBatches, args.batchId);
          need(currentRole?.kind === "controller" && currentRole.projectId === batch.projectId, "仅本项目 DSH 主控可调整累计验证");
          need(["waiting", "failed", "stale", "interrupted"].includes(batch.state), "请先收口进行中的累计检查");
          const reason = text(args.reason, "调整批次依据");
          const remaining = new Set(batch.taskIds);
          const groups = list(args.groups, "调整后的检查分组", 15).map((input) => {
            const members = list(input?.tickets, "分组成员").map((ticket) => {
              const member = s.tasks.find((task) => task.batchId === batch.id && task.ticketKey === ticket);
              need(member && remaining.delete(member.id), "分组必须逐票分配原成员一次");
              return member;
            });
            need(members.length, "分组至少一张票");
            const ids = new Set(members.map((member) => member.id));
            const dependsOnGroup = (dep) => ids.has(dep) || find(s.tasks, dep).dependencies.some(dependsOnGroup);
            need(!members.some((member) => member.dependencies.some(dependsOnGroup)), "分组内前置依赖会导致互等");
            for (const a of members) for (const b of members)
              need(a === b || !overlaps(a.writes, [...b.writes, ...readsFor(b)]), "分组候选仍有读写冲突");
            const check = cumulativeCheck(input, members, find(s.projects, batch.projectId).root);
            for (const member of members) {
              const covered = check.covers.filter((entry) => entry.taskId === member.id).flatMap((entry) => entry.acceptance);
              need(batch.check.covers.filter((entry) => entry.taskId === member.id).flatMap((entry) => entry.acceptance).every((ac) => covered.includes(ac)), "调整不能丢弃原累计检查的验收范围");
            }
            return { id: id(), projectId: batch.projectId, taskIds: [...ids], check, state: "waiting", supersedes: batch.id, reason };
          });
          need(!remaining.size, "还有原批次成员缺少累计验证");
          batch.state = "superseded";
          s.validationBatches.push(...groups);
          for (const group of groups)
            for (const id of group.taskIds) find(s.tasks, id).batchId = group.id;
          result = { state: "stored", batches: groups.map((group) => group.id) };
          break;
        }
        default:
          throw Error("未知命令");
      }
      if (workNotice) this.confirmResponsibility(s, currentRole, workNotice, command);
      if (command !== "check" || !args.async) this.schedule(s);
      if (result.intervention?.mode === "stop" && result.intervention.state === "stopped") result.state = "paused";
      if (command === "enable") result.resumeStatus = this.resumeStatus(s, activeRole(s, args.roleId));
      if (command === "supersede") {
        const successor = find(s.tasks, result.supersededBy);
        result.successor = { taskId: successor.id, state: successor.state,
          runnable: ["assigned", "rework"].includes(successor.state) && !dispatchAvailability(find(s.roles, successor.developerId)),
          waitReason: successor.waitReason ?? null };
      }
      if (command === "dispatch" || command === "dispatchPlan") {
        result.confirmationRequired = false;
        for (const item of result.tasks ?? [result]) {
          const task = find(s.tasks, item.taskId);
          if (task.scopeConflict) item.scopeConflict = task.scopeConflict;
          item.state = task.state;
          const target = find(s.roles, task.developerId);
          const unavailable = dispatchAvailability(target);
          const reason = unavailable ?? (["assigned","rework"].includes(task.state) ? null : task.waitReason ?? task.state);
          item.runnable = !reason;
          item.blockedBy = reason ? [{ role: target.name, roleId: target.id, reason, ...(deliveryLabels[reason] && { detail: deliveryLabels[reason] }), ...(reason === "bridge-tools-missing" && bridgeToolsBlocker(target)) }] : [];
          item.deliveredAt = task.deliveredAt ?? null;
        }
        if (command === "dispatchPlan") {
          result.runnable = result.tasks.every((item) => item.runnable);
          result.blockedBy = result.tasks.flatMap((item) => item.blockedBy.map((blocker)=>({...blocker,taskId:item.taskId,ticket:item.key})));
        }
      }
      return result;
    });
    if (command === "rebindCommittedWork") return { ...receipt, state: "applied", operationId,
      summary: receipt.summary ?? { from: receipt.rebind?.from, to: receipt.rebind?.to, confirmedPaths: receipt.rebind?.overlap } };
    if (role?.kind === "controller" && ["dispatch", "dispatchPlan", "check"].includes(command))
      return { ...receipt, turnRule: CONTROLLER_TURN_RULE };
    if (role?.kind === "controller" && ["rework", "unblock", "redeliver", "insertSchedule", "answer",
      "supersede", "abandonTask", "releaseSchedule"].includes(command))
      return { ...controllerBoundary, ...receipt };
    return receipt;
  }
  hash(s, task) {
    if (task.verification) assertFingerprintMode(task);
    return this.candidateFingerprint(s, task, fingerprintEol);
  }
  candidateFingerprint(s, task, eol) {
    return candidateFingerprint(find(s.projects, task.projectId).root, task, eol);
  }
  trialFingerprintScope(s, task, git) {
    const fail = (path, message) => {
      throw Object.assign(Error(message), { verificationCode: "contract-invalid", violations: [{ path, message }] });
    };
    const baseline = task.baseline;
    const oldEol = baseline?.fingerprintEol ?? "raw";
    if (!baseline || oldEol !== "raw" && oldEol !== "normalize" || baseline.fingerprintEol === fingerprintEol)
      fail("baseline.fingerprintEol", "试用票没有可续接的指纹口径差异");
    if (!task.verification || !task.candidate || releasedTaskScope(task))
      fail("candidate", "试用票缺少已冻结的候选或写入责任");
    const root = find(s.projects, task.projectId).root;
    const drift = baselineDrift(root, task, git, [...task.writes, ...readsFor(task)]);
    if (drift && (drift.blockingCondition || !drift.historyAdvance ||
        recordedBaselineChanges(root, task, s.plans.find(plan => plan.id === task.planId), git, drift).length)) {
      const path = git.branch !== baseline.branch ? "baseline.branch" : git.head !== baseline.head ? "baseline.head" : "baseline.index";
      fail(path, drift.blockingCondition ?? "Git HEAD 已离开冻结基线，须先处理提交漂移");
    }
    const pruned = committedOutsideBaseline(root, task, drift, git);
    try { assertOutsideScope(root, task, this.foreignWrites(s, task), git, pruned); }
    catch (error) { fail("baseline.other", error.message); }
    if (this.candidateFingerprint(s, task, oldEol) !== task.candidate)
      fail("candidate", "写集或候选输入已变化，原口径下无法证明试用候选与当前内容一致");
    if (s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job)))
      fail("checkJobs", "原票还有活动检查，须先完成或对账");
    for (const peer of s.tasks) {
      if (peer.id === task.id || peer.projectId !== task.projectId || !activeScope(peer)) continue;
      const conflict = this.scopeConflict(s, task, peer);
      if (conflict || peer.assignee === task.developerId)
        fail("schedule", conflict?.message ?? `开发成员仍负责 ${peer.ticketKey ?? peer.id}，请在该责任结束后续接`);
    }
    const batch = task.batchId && find(s.validationBatches, task.batchId);
    if (batch?.taskIds.some(id => find(s.tasks, id).state === "accepted"))
      fail("batch", "批次已有用户已验收票，须保留原批次并通过后继票处理");
    const redChecks = task.verification.checks.filter(check => check.stage === "red");
    if (!redChecks.length) fail("verification.checks", "试用票没有冻结的红检查");
    const convert = previous => {
      let snapshot;
      try { snapshot = convertImplementationBaseline(root, task, previous, oldEol); }
      catch (error) { fail("baseline.sources", "无法读取原取红实现快照：" + error.message); }
      if (!snapshot) fail("baseline.sources", "工作树和 Git 快照均无法证明原取红实现指纹，须先找回原快照");
      return snapshot;
    };
    const snapshot = convert(baseline);
    const redSnapshot = task.redBaseline && { ...task.redBaseline, ...convert(task.redBaseline) };
    return { oldEol, root, snapshot, redSnapshot, batch, redChecks, drift };
  }
  realignTrialFingerprint(s, task, args, role) {
    const git = this.ownershipGit(s, task);
    const { oldEol, root, snapshot, redSnapshot, batch, redChecks, drift } = this.trialFingerprintScope(s, task, git);
    const reason = text(args.reason, "续接口径原因");
    if (args.expectedHead !== undefined) assertCommitReference(args.expectedHead, git.head, "expectedHead");
    const current = this.ownershipGit(s, task);
    verify(current.head === git.head && current.branch === git.branch && current.index === git.index &&
      JSON.stringify(current.dirty) === JSON.stringify(git.dirty) && this.candidateFingerprint(s, task, oldEol) === task.candidate,
      "contract-invalid", "续接核对期间 Git 或原候选已变化，请重新运行 diagnoseTask");
    const prunedOutside = this.pruneOutside(s, task, current);
    if (drift) verify(this.advanceScope(s, task, { ...current, drift }), "contract-invalid", "票外文件仍有工作区版本，须先确认归属");
    const other = convertOutsideBaseline(root, task, current);
    const at = Date.now();
    const checks = task.verification.checks;
    const invalidatedChecks = [...new Set([...checks.map(check => check.id), ...(batch ? [batch.check.id] : [])])];
    for (const job of s.checkJobs)
      if (jobIncludes(job, task.id) && job.state === "passed") job.invalidated = true;
    if (batch) {
      batch.state = "waiting";
      for (const id of batch.taskIds) {
        const peer = find(s.tasks, id);
        if (id !== task.id && ["ready", "trial"].includes(peer.state) && peer.baseline?.fingerprintEol === fingerprintEol)
          Object.assign(peer, { state: "waiting_batch", trialInstructions: null, controllerEvidence: null });
      }
      delete task.batchReceiptId;
    }
    Object.assign(task.baseline, snapshot, { fingerprintEol, other });
    if (redSnapshot) task.redBaseline = redSnapshot;
    (task.fingerprintEolHistory ??= []).push({ from: oldEol, to: fingerprintEol, at });
    task.revision++;
    task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
    const nextAction = { command: "check", args: { taskId: task.id, checkId: redChecks[0].id } };
    Object.assign(task, { state: "waiting_verification", assignee: task.developerId, candidate: null, controllerEvidence: null,
      trialInstructions: null, deliveredAt: null, reviewDeliveredAt: null, reportedAt: null,
      fingerprintRecovery: true, waitReason: "口径已续接，等待责任开发重取红绿证据并交付", reworkReason: reason });
    this.recordContract(s, task, false, null, at);
    this.retire(s, task.id);
    this.notice(s, task.developerId, dispatchNotice(task), `口径已切换，请按新口径重跑 ${redChecks[0].id}：先核对并恢复原取红实现快照，保留测试；执行 check ${JSON.stringify(nextAction.args)}。取红后恢复候选实现，重跑候选检查，再 report 重新交付。`, task.id);
    const receipt = { state: "stored", cipherRealigned: true, taskId: task.id, previousFingerprintEol: oldEol,
      newFingerprintEol: fingerprintEol, invalidatedChecks, nextAction,
      ...(args.pruneOutside === true && { prunedOutside,
        ...(!prunedOutside.length && { pruneOutsideReason: "没有可证明已收口、可从票外基线移除的文件" }) }) };
    this.store.event("fingerprint.realign", { ...receipt, by: role.id, at, reason });
    return receipt;
  }
  questionScope(s, task, question) {
    return question.scope ?? s.roles.find(role => role.id === question.from)?.kind ??
      (question.from === task.developerId ? "developer" : null);
  }
  blockingQuestions(s, task, scope) {
    const ownerId = scope === "developer" ? task.developerId : task.assignee;
    return task.questions.filter(question => !question.answer && question.blocking === true &&
      question.from === ownerId && this.questionScope(s, task, question) === scope);
  }
  assertQuestionsAnswered(s, task, scope) {
    const pending = this.blockingQuestions(s, task, scope);
    if (pending.length) {
      const message = "当前责任有待答复的阻塞问题：" + pending.map(q => q.text).join("、");
      throw Object.assign(Error(message), { verificationCode: "contract-invalid",
        violations: pending.map(q => ({ path: `questions.${q.id}`, message: q.text, ownerRole: "controller",
          remedy: { command: "answer", args: { taskId: task.id, questionId: q.id },
            requiredParameters: ["text"] } })) });
    }
  }
  resumeSilentTask(s, task, role, reason) {
    need(isController(role, task), "仅本项目主控可 resumeTask");
    need(activeTaskIntervention(task)?.mode !== "stop", "停写请求正在收口，请先用 diagnoseTask 核对");
    need(!s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job)), "原票仍有未完成检查，请等检查收口");
    const stage = task.pausedFrom ?? task.state;
    if (stage !== "waiting_verification" || !recoveringFingerprint(task)) {
      if (["reviewing", "waiting_review", "waiting_verification", "ready", "trial"].includes(stage))
        verify(task.candidate, "evidence-missing", "原阶段须有同候选的交付报告才可恢复");
      const scope = task.baseline && this.verifyScope(s, task, undefined, true);
      if (task.candidate && task.verification)
        this.assertDeliveryProof(s, task, ["ready", "trial"].includes(stage), scope?.drift?.historicalCommit);
    }
    if (["assigned", "paused", "rework"].includes(stage))
      this.assertQuestionsAnswered(s, task, "developer");
    if (task.pausedFrom === "reviewing") task.pausedFrom = "waiting_review";
    const result = resumeTask(s, task, role, reason);
    for (const notice of s.notices)
      if (notice.taskId === task.id && /^(dispatch|review|check|owner-silent|delivery-blocked):/.test(notice.key))
        notice.readAt ??= Date.now();
    if (task.state === "waiting_verification") {
      const member = recoveringFingerprint(task) ? task.developerId : role.id;
      this.notice(s, member, `verification-resume:${task.id}:${task.scheduleVersion}`,
        "原票待按冻结检查续接：" + task.title, task.id);
    }
    return result;
  }
  sourceInput(root, task, eol = fingerprintEol) {
    return fingerprint(root, task.writes, task.verification.testWrites, undefined, { eol });
  }
  taskTimes(s, task, now = Date.now()) {
    const elapsed = since => since == null ? null : Math.max(0, now - since);
    let lastCheck = 0, checkQueueMs = 0;
    for (const job of s.checkJobs) {
      if (!jobIncludes(job, task.id)) continue;
      lastCheck = Math.max(lastCheck, job.finishedAt ?? job.startedAt ?? job.createdAt ?? 0);
      checkQueueMs += checkQueueDuration(job, now);
    }
    return { elapsedSinceDeliveryMs: elapsed(task.firstDeliveredAt ?? task.deliveredAt),
      elapsedSinceLastCheckMs: lastCheck ? elapsed(lastCheck) : null,
      blockedOnContractMs: (task.contractBlockedMs ?? 0) + (elapsed(task.contractBlockedSince) ?? 0),
      waitTimings: waitTimings(task, checkQueueMs, now) };
  }
  recordContract(s, task, blocked, drift, now = Date.now()) {
    if (blocked) task.contractBlockedSince ??= now;
    else if (task.contractBlockedSince !== undefined) {
      task.contractBlockedMs = (task.contractBlockedMs ?? 0) + Math.max(0, now - task.contractBlockedSince);
      delete task.contractBlockedSince;
    }
    if (!drift?.from || !drift.to || drift.from === drift.to) return;
    const lead = controller(s, task.projectId);
    if (!lead) return;
    const key = `git-drift:${task.id}:${drift.from}:${drift.to}`;
    if (s.notices.some(notice => notice.roleId === lead.id && notice.key === key)) return;
    let commits;
    if ([drift.from, drift.to].every(head => /^[a-f0-9]{40,64}$/.test(head))) {
      try {
        const root = find(s.projects, task.projectId).root;
        commits = readGit(root, ["log", "--format=%H", "--max-count=100", `${drift.from}..${drift.to}`, "--"]).trim().split(/\r?\n/).filter(Boolean);
        if (!commits.length) return;
      } catch {}
    }
    const details = { from: drift.from, to: drift.to, committedBetween: drift.committedBetween,
      conflicts: drift.conflicts, ...(commits && { commits }), origin: "unattributed" };
    const notice = this.notice(s, lead.id, key, `${task.ticketKey ?? task.id} · Git 提交漂移（提交者未知）：${JSON.stringify(details)}`, task.id);
    notice.drift = details;
    this.store.event("git.drift", { taskId: task.id, ...details });
  }
  foreignWrites(s, task) {
    return this.foreignWriteOwners(s, task).flatMap(({ writes }) => writes);
  }
  foreignWriteOwners(s, task) {
    return s.tasks.filter((peer) => !releasedTaskScope(peer) && peer.id !== task.id && peer.projectId === task.projectId && peer.admittedAt &&
      (peer.admittedAt >= (task.admittedAt ?? Date.now()) || occupied(peer) || task.concurrentPeers?.includes(peer.id)))
      .map(peer => {
        const origin = `票 ${peer.ticketKey ?? peer.id}`;
        assertPaths(peer.writes, `${origin}.writes`);
        const historicalWrites = (peer.scheduleHistory ?? []).flatMap((record, index) => {
          const writes = record?.previous?.writes ?? [];
          assertPaths(writes, `${origin}.scheduleHistory[${index}].previous.writes`);
          return writes;
        });
        return { taskId: peer.id, ticketKey: peer.ticketKey, writes: [...peer.writes, ...historicalWrites] };
      });
  }
  outsideOwnership(s, task, file, git) {
    if (!git.dirty.includes(file) || overlaps([file], git.protectedPaths)) return null;
    const peers = s.tasks.filter(peer => peer.projectId === task.projectId && peer.id !== task.id &&
      !releasedTaskScope(peer) && coversPath(peer.writes, file));
    const candidates = peers.filter(peer => (activeScope(peer) || ["queued", "trial", "ready"].includes(peer.state)) &&
      (peer.state !== "queued" || coversPath(peer.ownedDirty ?? [], file) ||
        coversPath(peer.retainedWrites ?? [], file)));
    const root = find(s.projects, task.projectId).root;
    try {
      return { file, sha256: fileSha256(root, file), unowned: !peers.some(peer => activeScope(peer) ||
          ["trial", "ready", "waiting_batch"].includes(peer.state)) && !candidates.length,
        candidates: candidates.map(peer => ({ taskId: peer.id, ticketKey: peer.ticketKey, state: peer.state })) };
    } catch { return null; }
  }
  canConfirmForeignDirty(s, task) {
    return Boolean(task.baseline && !releasedTaskScope(task) &&
      ["queued", "paused", "assigned", "rework"].includes(task.state) &&
      !s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job)));
  }
  confirmForeignDirty(s, task, args, role) {
    need(this.canConfirmForeignDirty(s, task), "确认票外归属须在待准入、暂停或开发阶段，且无在途检查。用 diagnoseTask 核对当前可执行动作");
    const reason = text(args.reason, "确认票外归属依据");
    const git = this.ownershipGit(s, task);
    assertCommitReference(args.expectedHead, git.head, "expectedHead");
    verify(git.branch === task.baseline.branch && git.branch !== "HEAD" && git.indexClean, "contract-invalid",
      "确认票外归属须在原分支且暂存区干净");
    verify(args.confirmForeignDirty && typeof args.confirmForeignDirty === "object" && !Array.isArray(args.confirmForeignDirty),
      "contract-invalid", "请逐文件填写可能的责任票和当前 SHA-256");
    const declared = Object.entries(args.confirmForeignDirty);
    need(declared.length && declared.length <= 20, "每次可确认 1 至 20 个票外文件");
    const root = find(s.projects, task.projectId).root;
    const outside = new Map(task.baseline.other);
    const confirmed = [];
    const raw = new Map(Object.entries(task.baseline.confirmedForeignDirty ?? {}));
    for (const [path, claim] of declared) {
      const [file] = scopePaths([path]);
      const ownership = this.outsideOwnership(s, task, file, git);
      verify(ownership && ownership.sha256 === claim?.sha256 &&
        (claim.taskId === null ? ownership.unowned : ownership.candidates.some(peer => peer.taskId === claim.taskId)),
        "contract-invalid", "文件已变化、触及冻结输入或责任票不匹配：" + file);
      outside.set(file, fingerprint(root, [file], [], undefined, { eol: task.baseline.fingerprintEol ?? "raw" }));
      raw.set(file, fingerprint(root, [file], [], undefined, { eol: "raw" }));
      verify(ownership.sha256 === fileSha256(root, file), "contract-invalid", "核对期间文件已变化：" + file);
      confirmed.push({ file, taskId: claim.taskId, sha256: ownership.sha256, ...(claim.taskId === null && { attributed: "unowned" }) });
    }
    task.baseline.other = [...outside];
    task.baseline.confirmedForeignDirty = Object.fromEntries(raw);
    delete task.preflightFailure;
    this.store.event("baseline-foreign-ownership-confirmed", { taskId: task.id, head: git.head, by: role.id, reason, confirmed });
    return { state: "stored", taskId: task.id, confirmed };
  }
  pruneOutside(s, task, git) {
    const root = find(s.projects, task.projectId).root;
    const drift = baselineDrift(root, task, git, [...task.writes, ...readsFor(task)]);
    verify(!drift?.gitBlocker, "contract-invalid", drift?.gitBlocker);
    const pruned = committedOutsideBaseline(root, task, drift, git);
    assertOutsideScope(root, task, this.foreignWrites(s, task), git, pruned);
    const removed = new Set(pruned.map(([file]) => file));
    task.baseline.other = task.baseline.other.filter(([file]) => !removed.has(file));
    this.auditOutsidePrune(task, drift, pruned);
    return [...removed];
  }
  auditOutsidePrune(task, drift, entries) {
    if (entries.length) this.store.event("baseline-other-pruned", {
      taskId: task.id, from: drift?.from ?? task.baseline.sourcesHead ?? task.baseline.head,
      to: drift?.to ?? task.baseline.head, removed: entries,
      remainingOutsidePaths: task.baseline.other.length, preservedSources: task.baseline.sources,
    });
  }
  advanceScope(s, task, git, audit = {}) {
    const drift = git.drift;
    if (!drift) return;
    this.recordContract(s, task, false, drift);
    if (drift.from === drift.to) return;
    const old = task.baseline;
    const root = find(s.projects, task.projectId).root;
    const pruned = committedOutsideBaseline(root, task, drift, git);
    const removed = new Set(pruned.map(([file]) => file));
    const committed = new Set(drift.committedBetween.map(file => file.toLowerCase()));
    // Retain the comparison point while a previously dirty path has another local version.
    if (old.other.some(([file]) => committed.has(file.toLowerCase()) && !removed.has(file))) return false;
    task.baseline = { ...old, head: git.head, index: git.index,
      sourcesHead: old.sourcesHead ?? old.head, deliveryBase: old.deliveryBase ?? old.head,
      evidenceBase: this.evidenceBase(task), other: old.other.filter(([file]) => !removed.has(file)) };
    (task.scheduleHistory ??= []).push({ previous: { writes: [...task.writes], baseline: old },
      historyAdvance: { from: drift.from, to: drift.to, ...(drift.candidateEquivalent && { candidateEquivalent: true, conflicts: drift.conflicts }) },
      at: Date.now(), ...audit });
    this.auditOutsidePrune(task, drift, pruned);
    return true;
  }
  blockedReportAction(task, blocker) {
    return { command: "report", args: { taskId: task.id, outcome: "blocked", summary: "契约校验阻塞，保留当前文件",
      blocker, dimensions: Object.fromEntries(["requirements", "implementation", "system"]
        .map(axis => [axis, { state: "unverified", evidence: "未完成验证：" + blocker }])) } };
  }
  registerPreparationBudgets(s, task, args, role) {
    const approval = task.checkRevisionApproval;
    const job = s.checkJobs.find(item => item.id === approval.preparationJobId);
    const proposal = verify(preparationRevision(s, task, job), "contract-invalid",
      "预算修订依据已失效。执行 diagnoseTask 核对原检查");
    verify(args.browserE2E === undefined && args.resources === undefined, "contract-invalid",
      "预算授权仅调整 timeoutMs。用 reviseSchedule {allowCheckRevision:true} 单独授权其他检查修订");
    this.verifyScope(s, task, role);
    const before = task.verification;
    const proposed = new Map(list(args.checks, "开发检查").map(check => {
      verify(check && typeof check === "object" && (check.preSteps === undefined || (
        Array.isArray(check.preSteps) && check.preSteps.every(step => step && typeof step === "object")
      )), "contract-invalid", "预算修订配方无效。按授权回执提交完整的 registerChecks 参数");
      return [check.id, check];
    }));
    const permitted = new Map(proposal.registration.args.checks.map(check => [check.id, check]));
    const validBudget = (value, previous) => Number.isSafeInteger(value) && value >= previous && value <= 3600000;
    const changed = [];
    const checks = before.checks.map(check => {
      if (leadCheck(check)) return check;
      const revision = proposed.get(check.id);
      const allowed = permitted.get(check.id);
      const budgetOnly = revision && sameCheckRecipe(checkWithoutBudgets(check), checkWithoutBudgets(revision)) &&
        validBudget(revision.timeoutMs, check.timeoutMs) && (check.preSteps ?? []).every((step, index) =>
          validBudget(revision.preSteps[index].timeoutMs, step.timeoutMs));
      verify(budgetOnly, "contract-invalid", `预算授权只允许提高冻结配方超时：${check.id}。按 reviseSchedule 授权回执中的 registerChecks 调用`);
      if (revision.timeoutMs !== check.timeoutMs || check.preSteps?.some((step, index) => step.timeoutMs !== revision.preSteps[index].timeoutMs)) {
        verify(allowed.timeoutMs !== check.timeoutMs || check.preSteps?.some((step, index) => step.timeoutMs !== allowed.preSteps[index].timeoutMs),
          "contract-invalid", `检查 ${check.id} 未获本次预算调整授权。按授权回执提交`);
        changed.push(check.id);
      }
      return { ...check, timeoutMs: revision.timeoutMs, ...(check.preSteps && { preSteps: check.preSteps.map((step, index) =>
        ({ ...step, timeoutMs: revision.preSteps[index].timeoutMs })) }) };
    });
    verify(proposed.size === permitted.size && args.checks.length === permitted.size && changed.includes(job.check.id),
      "contract-invalid", "须提交全套冻结开发检查并提高超时检查的预算。按授权回执执行 registerChecks");
    const retained = new Set(task.budgetReceiptIds ?? []);
    for (const record of s.checkJobs)
      if (record.taskId === task.id && record.state === "passed" && !record.invalidated &&
          before.checks.some(check => changed.includes(check.id) && check.id === record.check.id && sameCheckRecipe(check, record.check)))
        retained.add(record.id);
    task.budgetReceiptIds = [...retained];
    task.verification = { ...before, checks };
    task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
    delete task.checkRevisionApproval;
    const audit = { previous: { verification: before }, approval, budgetChangedChecks: changed,
      reason: text(args.reason, "预算修订依据"), by: role.id, at: Date.now() };
    (task.scheduleHistory ??= []).push(audit);
    this.store.event("checks.budget-revised", { taskId: task.id, ...audit });
    return { state: "stored", taskId: task.id, budgetChangedChecks: changed,
      nextAction: { command: "reviseSchedule", args: { taskId: task.id, reason: "预算已修订，沿原票恢复检查" } } };
  }
  deliveredScheduleError(task, message) {
    const nextAction = { command: "rework", args: { taskId: task.id, adjustScope: true, reason: "重新核对调度与冻结证据" } };
    throw Object.assign(Error(`${message}。先执行 rework ${JSON.stringify(nextAction.args)}，再用 reviseSchedule 调整范围。修改 AC 时，用 abandonTask 或 supersede 处理原票，并用 dispatchPlan 登记后继票。`),
      { verificationCode: "contract-invalid", nextAction });
  }
  refreshTicketSource(s, task, args, role) {
    verify(!releasedTaskScope(task) && ticketSourceReviewStates.includes(task.state),
      "contract-invalid", recoveryHint(s, task));
    if (!Object.keys(args).every(key => ["taskId", "reason", "refreshSourceDigest", "expectedSourceDigest", "writes"].includes(key)) ||
        args.writes !== undefined && JSON.stringify(args.writes) !== JSON.stringify(task.writes))
      this.deliveredScheduleError(task, "票面摘要对账只接受原写集及诊断参数");
    const reason = text(args.reason, "票面对账依据");
    const root = find(s.projects, task.projectId).root;
    const live = ticketSourceObservation(root, task, this.ownershipGit(s, task));
    verify(live?.digest && !live.staged && args.expectedSourceDigest === live.digest, "contract-invalid",
      `票面已变化或无法核对。执行 diagnoseTask ${JSON.stringify({taskId:task.id})} 获取当前摘要及命令`);
    const audit = { file: live.source.file, frozenDigest: live.source.digest, previousDigest: live.expected,
      digest: live.digest, by: role.id, reason, at: Date.now() };
    if (live.digest !== live.expected) {
      task.ticketSourceReview = audit;
      this.store.event("ticket.source-reviewed", { taskId: task.id, ...audit });
    }
    return { state: "applied", taskId: task.id, taskState: task.state, frozenContractPreserved: true,
      ticketSourceReview: task.ticketSourceReview ?? audit };
  }
  reviseDeliveredSchedule(s, task, args, role) {
    if (releasedTaskScope(task) || !Object.keys(args).every(key => ["taskId", "reason", "reads", "after"].includes(key)) ||
        args.reads === undefined && args.after === undefined)
      this.deliveredScheduleError(task, `当前状态 ${task.state} 只允许票面对账和保持原证据的 reads 或 after 调整`);
    const reason = text(args.reason, "调整原因");
    const reads = args.reads === undefined ? task.reads : scopePaths(args.reads);
    const next = args.after === undefined ? { dependencies: task.dependencies, dependencyStages: task.dependencyStages } :
      resolveAfter(s.tasks, task, args.after);
    if (args.after !== undefined) {
      validateDependencyEdit(s, task, next);
      for (const id of next.dependencies) {
        const peer = find(s.tasks, id);
        if (next.dependencyStages[id] === "accepted" ? peer.state !== "accepted" :
          !terminalDependency.includes(peer.state) || peer.verification &&
            !dependencyReceiptValid(task.dependencyReceipts?.[id], peer, s.checkJobs, job => this.intactOutput(job)) && peer.state !== "accepted")
          this.deliveredScheduleError(task, "新增或调整的前置票需要先满足对应门槛");
      }
    }
    const proposed = { ...task, reads, ...next };
    if (task.verification) {
      const paths = (ticket, check) => JSON.stringify(scopePaths(this.checkPaths(ticket, check)));
      if (task.verification.checks.some(check => paths(task, check) !== paths(proposed, check)))
        this.deliveredScheduleError(task, "reads 会改变已验证的检查输入");
      const scope = this.verifyScope(s, proposed);
      try {
        this.assertDeliveryProof(s, proposed, true, scope.drift?.historicalCommit);
        if (task.batchId) this.verifyBatchReceipt(s, proposed, scope.drift?.historicalCommit);
      } catch (error) {
        this.deliveredScheduleError(task, error.message);
      }
    }
    const previous = { reads: task.reads, dependencies: task.dependencies, stages: task.dependencyStages };
    retainDependencyReceipts(task, next);
    Object.assign(task, { reads, ...next, scheduleVersion: (task.scheduleVersion ?? 0) + 1 });
    (task.scheduleHistory ??= []).push({ previous, reason, by: role.id, at: Date.now() });
    return { state: "applied", taskId: task.id, taskState: task.state, scheduleVersion: task.scheduleVersion };
  }
  verifyScope(s, task, actor, adopt = false) {
    const root = find(s.projects, task.projectId).root;
    const git = this.ownershipGit(s, task);
    try {
      const scope = assertScope(root, task, this.foreignWrites(s, task), git);
      if (scope.drift && recordedBaselineChanges(root, task, s.plans.find(item => item.id === task.planId), git, scope.drift).length)
        throw Object.assign(Error("Git 前移含原基线未入库的规划记录，须核对记录来源"), {
          verificationCode: "contract-invalid", drift: scope.drift,
        });
      if (adopt && !scope.drift?.historicalCommit) this.advanceScope(s, task, scope);
      return scope;
    } catch(error) {
      if (error.drift) {
        const diagnosis=this.diagnoseTask(s,task,git);
        const drift = diagnosis.from ? diagnosis : baselineDrift(root, task, git, [...task.writes, ...readsFor(task)]);
        error.drift = drift;
        const own = drift?.conflicts.filter(file => coversPath(task.writes, file)) ?? [];
        if (actor?.kind === "developer" && own.length) {
          const blocker = `baseline-drift-blocked：你或他人在票在途时提交了 ${own.length} 个写集文件；提交者未知。`;
          const describe = { command: "describeDrift", args: { taskId: task.id } };
          const report = this.blockedReportAction(task, blocker);
          error.message = blocker + " 冻结 HEAD 与当前 HEAD 不同，禁止自行 commit 或回退 Git；保留当前文件，运行 describeDrift，使用 report outcome=blocked 交主控重绑。";
          error.nextAction = report;
          error.violations = [{ path: "baseline.head", message: error.message, expected: drift.from, actual: drift.to,
            conflicts: own, remedy: { describe, report } }];
          throw error;
        }
        const rerun=task.verification.checks.filter(check=>check.stage!=='red').map(check=>check.id);
        error.message+='；保留当前文件，先按诊断确认提交；不可证明内容等价时 rework adjustScope=true → rebindCommittedWork，随后重跑：'+rerun.join('、')+
          '；nextAction='+JSON.stringify(diagnosis.nextAction)+'；afterStop='+JSON.stringify(diagnosis.afterStop??null);
        if (diagnosis.nextAction && !["inspect", "guide"].includes(diagnosis.nextAction.command))
          error.nextAction = diagnosis.nextAction;
        error.violations=[{path:'baseline',message:'冻结 Git 基线漂移',expected:{head:task.baseline?.head},remedy:{nextAction:diagnosis.nextAction,afterStop:diagnosis.afterStop,rerunCheckIds:rerun}}];
      }
      throw error;
    }
  }
  confirmCommit(s, task, args, role, operationId) {
    if (args.partition !== undefined) {
      const peer = find(s.tasks, args.partition?.peerTaskId);
      const reason = text(args.reason, "确认部分提交依据");
      const { root, git, partition } = this.commitPartition(s, task, peer, true);
      assertCommitReference(args.expectedBase, peer.baseline.head, "expectedBase");
      assertCommitReference(args.expectedHead, git.head, "expectedHead");
      verify(partition.proof === args.partition.proof && JSON.stringify(scopePaths(args.paths)) === JSON.stringify(partition.paths),
        "contract-invalid", "提交或余留改动与提交前核对的分区证据不同");
      const drift = baselineDrift(root, peer, git, [...peer.writes, ...readsFor(peer)]);
      verify(drift && !drift.gitBlocker && !recordedBaselineChanges(root, peer,
        s.plans.find(plan => plan.id === peer.planId), git, drift).length, "contract-invalid", "部分提交包含未确认的基线漂移");
      const audit = { by: role.id, reason, operationId, from: drift.from, to: drift.to, ...partition, peerTaskId: peer.id };
      verify(this.advanceScope(s, peer, { ...git, drift }, { partitionedCommit: audit }),
        "contract-invalid", "对方票仍含未对账的票外版本");
      peer.baseline.deliveryBase = git.head;
      this.verifyScope(s, peer);
      this.store.event("commit.partition-confirmed", { taskId: task.id, ...audit });
      return { state: "applied", taskId: task.id, ...audit };
    }
    const reason = text(args.reason, "确认提交依据");
    const { root, git, drift, paths, preserved, baseline } = this.confirmCommitEvidence(s, task, args);
    const notes = planningSourceNotes(root, task, s.plans.find(item => item.id === task.planId));
    if (notes.length) this.store.event("source.changed-after-dispatch", {
      taskId: task.id, files: notes.map(({ file, kind, toDigest }) => ({ file, kind, toDigest })),
    });
    const previous = { writes: [...task.writes], baseline: structuredClone(task.baseline) };
    const old = task.baseline;
    const current=this.ownershipGit(s,task);
    verify(current.head===git.head&&current.branch===git.branch&&current.index===git.index&&JSON.stringify(current.dirty)===JSON.stringify(git.dirty)&&
      this.hash(s,task)===task.candidate,'contract-invalid','核对期间 Git 或候选输入变化，确认已停止；请重新 diagnoseTask');
    task.baseline=baseline;
    this.auditOutsidePrune(task, drift, committedOutsideBaseline(root, { ...task, baseline: old }, drift, git));
    const audit={from:drift.from,to:drift.to,paths,reason,by:role.id,at:Date.now(),preservedChecks:preserved,origin:'controller-confirmed'};
    task.confirmedCommit=audit;(task.scheduleHistory??=[]).push({previous,...audit,confirmedCommit:true});
    return {state:'applied',taskId:task.id,operationId,...audit,scannedFiles:git.ownershipMetrics?.scannedFiles??0};
  }
  commitPartition(s, task, peer, committed = false) {
    verify(task.state === "accepted" && task.verification && task.candidate &&
      peer.id !== task.id && peer.projectId === task.projectId && peer.state === "paused" &&
      !releasedTaskScope(peer) && peer.verification && peer.baseline && protectsAdmittedWrites(peer) &&
      !task.batchId && !peer.batchId, "contract-invalid",
      "部分提交需要已验收的原候选，以及同项目已停写并持有冻结基线的实施票");
    assertFingerprintMode(task);
    assertFingerprintMode(peer);
    assertStoppedTask(s, peer);
    const root = find(s.projects, task.projectId).root;
    const scopes = { ...peer, writes: [...peer.writes, ...task.writes] };
    const git = this.ownershipGit(s, scopes);
    const base = peer.baseline.head;
    verify(/^[0-9a-f]{40,64}$/.test(base) && git.branch === peer.baseline.branch && git.branch !== "HEAD",
      "contract-invalid", "部分提交须留在两票共同的冻结分支");
    verify(committed ? git.indexClean && readGit(root, ["rev-list", "--parents", "-n", "1", git.head]).trim() === git.head + " " + base :
      git.head === base, "contract-invalid", "部分提交须以对方冻结 HEAD 为唯一父提交");
    const { peerWorkspace, ...partition } = proveCommitPartition(root, task, peer, git, { base, committed });
    verify(partition.paths.every(file => !overlaps([file], readsFor(peer)) || partition.shared.includes(file)) &&
      !s.tasks.some(other => other.id !== task.id && other.id !== peer.id && other.projectId === task.projectId &&
        (activeScope(other) || ["trial", "ready"].includes(other.state) && !releasedTaskScope(other)) &&
        overlaps(partition.paths, [...other.writes, ...readsFor(other)])),
    "contract-invalid", "部分提交还触及其他冻结输入或第三张在途票");
    if (peer.candidate)
      verify(peerWorkspace === peer.candidate, "contract-invalid", "对方候选已经改变，须重新交付");
    const current = this.ownershipGit(s, scopes);
    verify(current.head === git.head && current.branch === git.branch && current.index === git.index &&
      JSON.stringify(current.dirty) === JSON.stringify(git.dirty) && this.hash(s, peer) === peerWorkspace,
    "contract-invalid", "核对期间 Git 状态或对方工作内容已变化");
    return { root, git, partition };
  }
  ownershipGit(s, task) {
    return gitState(find(s.projects, task.projectId).root, task, executionPolicy(this.execution, task.projectId).ownershipIgnores);
  }
  verifyOwnedDirty(s, task, hashes) {
    const root = find(s.projects, task.projectId).root;
    const git = includeIgnoredScopeWrites(root, task, this.ownershipGit(s, task));
    for (const [file, sha256] of Object.entries(hashes)) {
      verify(git.dirty.includes(file) && coversPath(task.writes, file) && fileSha256(root, file) === sha256,
        "contract-invalid", "写集文件状态或 SHA-256 已变，须重新提报：" + file);
    }
  }
  silentScheduleOwner(s, task, command) {
    if (task.state !== "assigned") return null;
    const status = ownerStatus(s, task);
    if (!status.silent || command === "releaseSchedule" && task.ownerState !== "silent") return null;
    return { recoveredBy: command, previousOwnerState: status.ownerState };
  }
  releaseSchedule(s, role, args) {
    const task = find(s.tasks, args.taskId);
    need(role?.kind === "controller" && role.projectId === task.projectId, "仅本项目主控可释放原票范围");
    need(activeTaskIntervention(task)?.mode !== "stop", "停写请求正在收口，请先用 diagnoseTask 核对");
    const recovered = this.silentScheduleOwner(s, task, "releaseSchedule");
    if (!recovered) assertStoppedTask(s, task);
    const git = this.scopeReleaseGit(s, task);
    const audit = { reason: text(args.reason, "释放原因"), by: role.id, at: Date.now(), head: git.head, ...recovered };
    if (recovered) task.state = "paused";
    const result = releaseStoppedScope(s, task, git, audit);
    this.recordContract(s, task, false);
    Object.assign(result,releaseHandoff(s,task,git));
    this.retire(s, task.id);
    return { ...result, ...recovered };
  }
  taskIntervention(s, task, role, command, args) {
    const previous = activeTaskIntervention(task);
    const member = s.roles.find(item => item.id === task.assignee && !item.archivedAt);
    const reason = text(args.reason, "实施干预依据");
    let request = previous;
    if (command === "interveneTask") {
      need(isController(role, task), "仅本项目主控可干预实施");
      need(member?.kind === "developer" && providerOf(member) === "dsh" && member.sessionId &&
        ["assigned", "rework"].includes(task.state) && !releasedTaskScope(task), "仅可干预已绑定 DSH 会话的在飞开发票");
      need(["guide", "stop"].includes(args.mode), "mode 为 guide 或 stop");
      need(previous?.mode !== "stop", "已有停写请求，请先用 diagnoseTask 核对原请求");
      request = { id: id(), mode: args.mode, state: "requested", reason, by: role.id, at: Date.now(),
        memberId: member.id, sessionId: member.sessionId, revision: task.revision, scheduleVersion: task.scheduleVersion ?? 0 };
      task.intervention = request;
      if (request.mode === "stop") for (const job of s.checkJobs) {
        if (job.state !== "queued" || !jobIncludes(job, task.id)) continue;
        Object.assign(job, { state: "interrupted", finishedAt: request.at, error: "原票已请求停止，检查尚未启动" });
        if (job.batchId) find(s.validationBatches, job.batchId).state = "interrupted";
      }
    } else {
      need(request && request.id === args.requestId, "当前实施干预已变化，请用 diagnoseTask 核对");
      if (command === "ackTaskIntervention") {
        need(role && role.id === member?.id && role.sessionId === request.sessionId, "仅原绑定的责任成员可确认干预");
        need(request.state === "requested", "已登记停写，正在等待检查收口");
        request.state = request.mode === "guide" ? "acknowledged" : "draining";
        request.confirmedAt = Date.now();
      } else {
        need(isController(role, task), "仅本项目主控可对账实施干预");
        if (args.decision === "confirm-stopped") {
          need(request.mode === "stop" && (request.state === "requested" || !interventionHostJobsSettled(s, request)),
            "原会话已确认停写，请对账剩余的 LingFlow 检查");
          if (member?.sessionId === request.sessionId && connected(member))
            need(member.state === "idle" && member.pending === 0 && !turnBlocksDelivery(member.observation),
              "原会话尚有回合或排队输入，不能确认停写");
          request.evidence = text(args.evidence, "已核实原会话及本票写入进程停止的证据。若宿主仍有作业，须写明如何核实这些作业与本票无关");
          request.state = "draining";
          request.confirmedAt = Date.now();
        } else {
          need(request.state === "requested" && ["withdraw", "retry"].includes(args.decision),
            "仅可撤回或重投尚未确认的干预。已确认停写的票须完成检查收口");
          if (args.decision === "withdraw") request.state = "withdrawn";
          else {
            need(member?.sessionId === request.sessionId, "原绑定会话已变化，请先核实原会话是否停写");
            const { admittedAt, delivery, ...current } = request;
            request = { ...current, id: id(), at: Date.now() };
            task.intervention = request;
          }
        }
      }
      request.resolution = { by: role.id, reason, at: Date.now(), ...(args.decision && { decision: args.decision }) };
    }
    this.store.event("task.intervention", { taskId: task.id, ...request, ...(previous && previous.id !== request.id && { previousId: previous.id }) });
    return { state: request.state, taskId: task.id, intervention: request };
  }
  finishTaskStop(s, task, now) {
    const request = activeTaskIntervention(task);
    if (request?.state !== "draining" || !interventionHostJobsSettled(s, request) ||
        s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job))) return;
    request.state = "stopped";
    request.stoppedAt = now;
    task.state = "paused";
    task.waitReason = interventionPauseReason;
    this.retire(s, task.id);
    this.store.event("task.intervention", { taskId: task.id, ...request });
    this.notice(s, controller(s, task.projectId).id, "schedule:" + request.id, "停写已收口：" + task.title, task.id);
  }
  interventionDelivery(task, member, now) {
    const request = activeTaskIntervention(task);
    if (request?.state !== "requested" || request.admittedAt || request.sessionId !== member?.sessionId ||
        providerOf(member) !== "dsh" || !member.enabled || !connected(member, now) ||
        bridgeToolsBlocker(member) || member.pendingToolHealthCheck || member.inputDrop || member.observation?.compacting) return null;
    const queuedInputFingerprint = member.state === "idle" ? queueFingerprintForDelivery(member) : null;
    if (!(member.state === "running" || member.state === "idle" && !turnBlocksDelivery(member.observation) &&
        (member.pending === 0 || queuedInputFingerprint))) return null;
    return { id: request.id, sessionId: request.sessionId, taskIntervention: true, text: interventionPrompt(task, request),
      ...(queuedInputFingerprint && { queuedInputFingerprint }) };
  }
  confirmCommitEvidence(s, task, args, observed) {
    verify(!releasedTaskScope(task), "contract-invalid", releasedConfirmationMessage);
    verify(task.candidate && ["waiting_verification", "waiting_review", "reviewing", "waiting_batch", "ready", "trial"].includes(task.state),
      "contract-invalid", "confirmCommit 仅确认已交付候选的等价提交；没有候选时请 diagnoseTask 后沿原 rebindCommittedWork 路径重跑。");
    const root = find(s.projects, task.projectId).root;
    const git = observed?.git ?? this.ownershipGit(s, task);
    const drift = observed?.drift ?? baselineDrift(root, task, git, [...task.writes, ...readsFor(task)], { compareCandidate: task.candidateScope === 2 });
    verify(drift, "contract-invalid", "没有需要确认的提交漂移");
    assertCommitReference(args.expectedBase, drift.from, "expectedBase");
    assertCommitReference(args.expectedHead, drift.to, "expectedHead");
    const plan = s.plans.find(item => item.id === task.planId);
    const records = observed?.records ?? recordedBaselineChanges(root, task, plan, git, drift);
    const paths = this.committedRebindScope(s, task, root, git, drift, records);
    verify(!records.length, "contract-invalid", "本次提交还含入库的冻结规划记录，请按 diagnoseTask 核对记录归属");
    verify(JSON.stringify(scopePaths(args.paths)) === JSON.stringify(scopePaths(paths)),
      "contract-invalid", "paths 必须精确对应诊断的提交重叠路径");
    verify(this.hash(s, task) === task.candidate && (task.candidateScope !== 2 || candidateTreeFingerprint(root, task, git.head) === task.candidate),
      "contract-invalid", "提交内容与已交付候选指纹不等价，不能保留原检查；请沿原票重新交付并重跑绿/完整检查。");
    const preserved = this.assertDeliveryProof(s, task).map(proof => proof.jobId);
    const old = task.baseline;
    const baseline = { ...scopeBaseline(root, task, this.foreignWrites(s, task), git), sources: old.sources, sourceFiles: old.sourceFiles,
      sourcesHead: old.sourcesHead ?? old.head, tests: old.tests, deliveryBase: old.deliveryBase ?? old.head, evidenceBase: this.evidenceBase(task) };
    return { root, git, drift, paths, preserved, baseline };
  }

  scopeReleaseGit(s, task) {
    if (!originalTaskWrites(task).length) return { dirty: [] };
    const git = this.ownershipGit(s, { ...task, writes: originalTaskWrites(task) });
    return includeIgnoredScopeWrites(find(s.projects, task.projectId).root, task, git);
  }
  committedRebindScope(s, task, root, git, drift, records = []) {
    assertFrozenTicket(root, task, git);
    const reject = (message) => verify(false, "contract-invalid", message + "；请用 diagnoseTask 核对原票");
    if (!task.verification || !task.baseline ||
        !["assigned", "rework", "paused", "changes_requested", "ready", "trial", "waiting_review", "waiting_verification", "waiting_batch", "reviewing"].includes(task.state))
      reject("仅支持未验收且仍有原责任的实施票");
    if (!drift || drift.from === drift.to || (!drift.conflicts.length && !records.length)) reject("没有写集内提交或冻结时未提交的规划记录，请用普通基线对账");
    if (drift.gitBlocker) reject(drift.gitBlocker);
    if (git.branch === "HEAD") reject("游离 HEAD 无法确认原分支");
    const observedOnly = drift.conflicts.filter((file) => !coversPath(task.writes, file));
    if (observedOnly.length) reject("提交触及只读输入：" + summarizePaths(observedOnly));
    if (drift.conflicts.length && !protectsAdmittedWrites(task))
      reject("无法证明原始写集及承接归属与准入时一致");
    const dirty = git.dirty.filter((file) => coversPath(task.writes, file) || overlaps([file], readsFor(task)));
    if (dirty.length) reject("冻结路径工作树仍有残留：" + summarizePaths(dirty));
    const unproven = records.filter((note) => !note.proven);
    if (unproven.length) reject("无法证明已入库规划记录保留冻结正文或仅追加受认可记录：" + summarizePaths(unproven.map((note) => note.file)));
    if (records.length && git.dirty.length) reject("工作树仍有未提交文件，请保留改动并核对归属：" + summarizePaths(git.dirty));
    if (s.checkJobs.some((job) => jobIncludes(job, task.id) && activeCheck(job))) reject("仍有未完成检查，请等待或对账原作业");
    const conflict = s.tasks.filter((peer) => peer.id !== task.id && activeScope(peer))
      .map((peer) => this.scopeConflict(s, task, peer)).find(Boolean);
    if (conflict) reject(conflict.message);
    assertOutsideScope(root, task, this.foreignWrites(s, task), git, committedOutsideBaseline(root, task, drift, git));
    return drift.conflicts;
  }
  runRecovery(state, role, action, preview = false) {
    const engine = new Workflow({
      read: () => state,
      operation: (_scope, _id, _input, run) => run(state),
      event: preview ? () => {} : (kind, details) => this.store.event(kind, details),
    }, { readOnly: true, execution: this.execution });
    return engine.callValidated(role.sessionId, action.command, action.args, "recovery-step", providerOf(role));
  }
  tryRecovery(state, role, candidate) {
    const summarize = message => ({ candidate, executable: false, remainingBlockers: [message] });
    if (!candidate) return summarize("当前没有可自动执行的恢复步骤");
    if (!role?.enabled || !role.sessionId) return summarize("须由本项目已开启并绑定的主控执行");
    try {
      this.runRecovery(structuredClone(state), role, candidate, true);
      return { candidate, executable: true, remainingBlockers: [] };
    } catch (error) {
      return summarize(error.message);
    }
  }
  recoveryPlan(s, task, diagnosis, role, reason) {
    if (pausedByIntervention(task) || diagnosis.classification === "task-stop-requested")
      return { candidate: null, executable: false, remainingBlockers: [diagnosis.reason] };
    const make = (command, args = {}) => ({ command, args: { taskId: task.id, reason: reason ?? "按原票诊断恢复", ...args } });
    const suggestion = diagnosis.nextAction;
    if (suggestion?.args?.refreshSourceDigest === true || suggestion?.args?.realignRedBaseline === true || diagnosis.unownedWrites || diagnosis.suggestedTests ||
        suggestion?.args?.confirmForeignDirty !== undefined)
      return { ...this.tryRecovery(s, role, suggestion), requiresConfirmation: true };
    if (diagnosis.violations?.some(violation => violation.path === "sources.tickets"))
      return { candidate: suggestion, executable: false, remainingBlockers: [diagnosis.reason] };
    let candidate;
    const explicit = ["confirmCommit", "rebindCommittedWork"].includes(suggestion?.command);
    if (["reviseSchedule", "rework", "resumeTask", "redeliver"].includes(suggestion?.command) || explicit)
      candidate = { ...suggestion, args: { ...suggestion.args, ...(reason && { reason }) } };
    if (!candidate && suggestion?.returnToOwner?.command === "rework")
      candidate = make("rework", { ...suggestion.returnToOwner.args, ...(reason && { reason }) });
    if (suggestion?.command === "yieldForSchedule")
      candidate = make("rework", { adjustScope: true });
    if (["assigned", "rework"].includes(task.state) && !task.deliveredAt &&
        s.wakes.some(wake => wake.roleId === task.assignee && wake.state === "pending" && wake.diagnostic?.reason === "retry-limit" &&
          s.notices.some(notice => wake.noticeIds.includes(notice.id) && notice.key === dispatchNotice(task))))
      candidate = make("redeliver");
    if (!candidate && ["assigned", "rework"].includes(task.state) && task.deliveryIssue)
      candidate = make("resumeTask");
    if (!candidate && ["reviewing", "waiting_review", "waiting_verification"].includes(task.state) &&
        ["review-missing", "evidence-missing"].includes(diagnosis.blocker ?? diagnosis.classification) && !diagnosis.checkId)
      candidate = make("resumeTask");
    if (!candidate && task.state === "paused" && !["contract-invalid", "baseline-drift-blocked"].includes(diagnosis.classification))
      candidate = make("resumeTask");
    if (!candidate) return { candidate: null, executable: false, remainingBlockers: [diagnosis.reason] };
    return { ...this.tryRecovery(s, role, candidate), ...(explicit && { requiresConfirmation: true }) };
  }
  diagnoseTask(s, task, knownGit) {
    const action = (command, fields = {}) => ({ command, args: { taskId: task.id, ...fields } });
    const interventionPause = pausedByIntervention(task);
    const stopChoices = interventionPause ? { intervention: task.intervention, stopRemedies: [
      { ...action("releaseSchedule"), requiredParameters: ["reason"], effect: "取消剩余责任，保留文件和历史" },
      { ...action("reviseSchedule"), requiredParameters: ["reason"], effect: "核对后在冻结契约内调整调度" },
      { ...action("supersede"), requiredParameters: ["supersededBy", "reason"], effect: "由已批准的后继票承接变更后的契约" },
      { ...action("resumeTask"), requiredParameters: ["reason"], effect: "明确恢复原票的冻结责任" },
    ] } : {};
    let sourceNotes = [], notices = [], historyAdvance, outsidePrune, ownershipIgnoreDetails, scannedGit;
    const result = (classification, reason, nextAction, extra = {}) => {
      if(nextAction&&!nextAction.ownerRole&&['evidence-missing','environment-failed','checks-missing'].includes(classification)) {
        nextAction={...nextAction,ownerRole:'developer',ownerId:task.developerId,args:{...nextAction.args,ticketKey:task.ticketKey},
          message:developerEvidenceMessage};
      }
      return {taskId: task.id, state: task.state, classification, reason, nextAction, ...(outsidePrune && { outsidePrune }),
        ...(ownershipIgnoreDetails && { ownershipIgnoreDetails }), ...(sourceNotes.length && { sourceNotes, ...specVersionSummary(sourceNotes) }),
        ...(notices.length && { notices }), ...(historyAdvance && { ...historyAdvance, historyAdvance }), ...stopChoices, ...extra};
    };
    const scopeRemedies = () => [
      { ...action("supersede"), requiredParameters: ["supersededBy", "reason"],
        effect: "由已核对的后继票承接，保留原票冻结契约和依赖门槛" },
      ...(task.state === "paused" ? [{ ...action("releaseSchedule"), requiredParameters: ["reason"],
        effect: "释放原票写集并保留证据和工作文件，等待另行确认剩余范围" }] : []),
    ];
    const blockedTrial = (classification, reason, extra = {}) => {
      const pending = s.checkJobs.find(job => jobIncludes(job, task.id) && activeCheck(job));
      if (pending) return result(classification, reason, action("checkStatus"), extra);
      if (task.assignee != null) return result(classification, reason, action("inspect"), extra);
      if (classification === "baseline-drift-blocked") {
        const remedies = scopeRemedies();
        return result(classification, reason, null, { ...extra, actionRequired: remedies[0], scopeRemedies: remedies,
          resolution: "核对后继票的当前基线与依赖，再由主控确认是否替代原票。冻结契约和历史证据保留。" });
      }
      return result(classification, reason, action("abandonTask", { reason: "主控已核对试用票及剩余责任，确认终止并保留历史" }), {
        ...extra, resolution: "仅在确认结束原票责任时执行终止；冻结证据和工作文件会保留。"
      });
    };
    if(releasedTaskScope(task)) {
      const handoff=releaseHandoff(s,task,this.scopeReleaseGit(s,task));
      if(handoff.handoff)return result('controller-takeover-risk',takeoverMessage,handoff.nextAction,{message:takeoverMessage,handoff:handoff.handoff});
    }
    if (task.state === "superseded") return result("superseded", "原票已被替代，全部调度范围已释放；历史证据保留，不代表已验收。",
      { command: "inspect", args: { taskId: task.supersededBy } }, { supersededBy: task.supersededBy });
    if(task.state==='abandoned') return result('abandoned','原票已终止，范围已释放，历史保留；不代表已验收。',null,{abandonment:task.abandonment});
    if (task.releasedScope) return result("scope-released", "原票范围已释放且不再准入，剩余工作由后继票承担；冻结证据保留。", action("inspect"), {
      resolution: "沿原票核对冻结证据，再按当前基线和本轮批准范围拟定后继票。用 previewPlan 核对每个前置是否仍必要、满足后才能放行；确认后用 dispatchPlan 登记。",
    });
    const intervention = activeTaskIntervention(task);
    if (intervention) {
      const jobs = s.checkJobs.filter(job => jobIncludes(job, task.id) && activeCheck(job));
      const uncertain = jobs.find(job => job.state === "uncertain");
      const resolution = decision => action("resolveTaskIntervention", { requestId: intervention.id, decision });
      const member = s.roles.find(item => item.id === intervention.memberId);
      const hostJobsSettled = interventionHostJobsSettled(s, intervention);
      const awaitingStop = intervention.mode === "stop" && (intervention.state === "requested" || !hostJobsSettled);
      const fallback = awaitingStop && (member?.sessionId !== intervention.sessionId || !connected(member) ||
        member.state === "idle" && member.pending === 0 && !turnBlocksDelivery(member.observation));
      return result(intervention.mode === "stop" ? "task-stop-requested" : "task-guidance-requested",
        intervention.state === "draining" ? "已登记停写回执，等待宿主作业和 LingFlow 检查收口后自动进入 paused。" :
          intervention.admittedAt ? "宿主已接收指令，等待原责任成员提交处理回执。" :
            "指令待投递，成员离线时保留请求。",
        uncertain ? { command: "checkStatus", args: { jobId: uncertain.id } } : jobs.length ? action("checkStatus") : action("inspect"),
        { intervention, hostJobsSettled, ...pendingInputStatus(member), activeChecks: jobs.map(job => ({ id: job.id, state: job.state })),
          ...(uncertain && { actionRequired: { command: "reconcileCheck", args: { jobId: uncertain.id }, requiredParameters: ["evidence"] } }),
          ...(fallback && !uncertain && { actionRequired: { ...resolution("confirm-stopped"), requiredParameters: ["reason", "evidence"] } }),
          ...(intervention.state === "requested" && { remedies: ["retry", "withdraw"].map(decision =>
            ({ ...resolution(decision), requiredParameters: ["reason"] })) }),
        });
    }
    const retiredDependency = task.state === "queued" && task.dependencies.find(id => {
      const predecessor = find(s.tasks, id);
      return predecessor.intervention?.state === "stopped" && releasedTaskScope(predecessor);
    });
    if (retiredDependency) return result("dependency-released", "前置已退出调度。由主控核对该前置是否仍需要，并确认新的依赖条件。",
      { command: "inspect", args: { taskId: retiredDependency } }, {
        actionRequired: { ...action("reviseSchedule"), requiredParameters: ["after", "reason"], ownerRole: "controller" },
      });
    const deliveryIssue = task.deliveryIssue && ["assigned", "rework", "paused"].includes(task.state) && task.deliveryIssue;
    const sessionIssue = () => result("session-recovery-needed", deliveryIssue.detail,
      action("resumeTask", { reason: "宿主会话已恢复，沿原票重新准入与投递" }), { deliveryIssue });
    if (deliveryIssue && !task.baseline) return sessionIssue();
    const scopeConflictResult = () => {
      const peer = s.tasks.find(item => item.id === task.scopeConflict.taskId);
      const conflict = peer && activeScope(peer) && this.scopeConflict(s, task, peer);
      if (!conflict) return result("waiting-admission", "等待调度器重新核对冲突", action("inspect"));
      const needsReads = conflict.kind === "read-scope-unknown" && task.readScopeKnown === false;
      return result("scope-conflict", conflict.message, needsReads ? null : conflict.nextAction, {
        scopeConflict: conflict,
        ...(needsReads && {
          actionRequired: { ...action("reviseSchedule", { reason: "补齐实际读集" }), requiredParameters: ["reads"] },
        }),
      });
    };
    if (task.state === "queued" && task.scopeConflict && !task.baseline) return scopeConflictResult();
    if (!task.verification) {
      if (task.readOnly === true) return result("read-only", "只读票不适用原生实施门槛", null);
      const reason = "旧实施票缺少冻结契约，保留历史；剩余工作使用 dispatchPlan 建立后继票";
      return task.state === "trial" ? blockedTrial("unrecoverable", reason) : result("contract-invalid", reason, { command: "guide", args: {} });
    }
    if (task.state === "accepted") return result("accepted", "保留原验收结论；当前工作区不代表历史候选", null);
    const root = find(s.projects, task.projectId).root;
    try {
      sourceNotes = planningSourceNotes(root, task, s.plans.find((item) => item.id === task.planId));
      if (!task.baseline) {
        const unownedAdmission = task.preflightFailure?.unownedWrites ||
          task.preflightFailure?.reason?.startsWith("写入范围内存在未分配的已有改动");
        const preflightGit = task.sources?.tickets || unownedAdmission ? this.ownershipGit(s, task) : undefined;
        assertFrozenTicket(root, task, preflightGit);
        if (unownedAdmission) {
          const error = unownedWriteError(task, preflightGit.dirty.filter(file => coversPath(task.writes, file)));
          if (error) throw error;
        }
        return task.state === "trial" ? blockedTrial("unrecoverable", "试用票缺少冻结基线") :
          result(task.preflightFailure?.classification ?? "waiting-admission", task.waitReason ?? "等待建立冻结基线", action("inspect"));
      }
      notices = this.specNotices(s, task, sourceNotes);
      const git = knownGit ?? this.ownershipGit(s, task);
      scannedGit = git;
      assertFrozenTicket(root, task, git);
      ownershipIgnoreDetails = git.ownershipIgnoreDetails;
      if (task.state === "paused" && !task.candidate) {
        const job = s.checkJobs.findLast(item => preparationRevision(s, task, item));
        if (job) {
          const nextAction = preparationRevision(s, task, job);
          return result("preparation-timeout", nextAction.message, nextAction, {
            checkId: job.check.id, hint: nextAction.message, ...preparationTiming(job.check,job.receipt),
            evidence: { command: "checkStatus", args: { jobId: job.id } },
          });
        }
      }
      const drift = baselineDrift(root, task, git, [...task.writes, ...readsFor(task)], { compareCandidate: true });
      const historicalCommit = drift?.historicalCommit;
      const pruned = committedOutsideBaseline(root, task, drift, git);
      if (pruned.length) {
        outsidePrune = { files: pruned.map(([file]) => file),
          message: "这些票外文件已核实与当前提交一致，本次核对已排除 baseline.other 的旧指纹。",
          ...(["queued", "paused", "trial"].includes(task.state) && {
            remedy: action("reviseSchedule", { pruneOutside: true, reason: "清理已提交的票外指纹", expectedHead: git.head }) }) };
      }
      if (pruned.length && ["paused", "trial"].includes(task.state) && this.inspectionContext)
        this.inspectionContext.outsidePruneHead = git.head;
      try { assertFingerprintMode(task); }
      catch (error) {
        if (task.state === "trial") {
          try { this.trialFingerprintScope(s, task, git); }
          catch (blocked) {
            const path = blocked.violations?.[0]?.path;
            const lacksProof = ["baseline.sources", "verification.checks", "candidate", "batch"].includes(path) ||
              path === "baseline.head" && drift?.conflicts.length && !drift.gitBlocker;
            return blockedTrial(lacksProof ? "unrecoverable" : "contract-invalid", blocked.message,
              { ...drift, violations: [...error.violations, ...(blocked.violations ?? [{ path: "baseline", message: blocked.message }])] });
          }
          return result("contract-invalid", "试用票待口径续接；续接后由原开发重取证据，重新交付后再试用。",
            action("reviseSchedule", { refreshBaseline: true, expectedHead: git.head, reason: "核对原候选后续接指纹口径" }),
            { violations: error.violations });
        }
        return result("contract-invalid", error.message, error.nextAction, { ...drift, violations: error.violations });
      }
      const records = drift ? recordedBaselineChanges(root, task, s.plans.find((item) => item.id === task.planId), git, drift) : [];
      if (task.candidate && drift?.conflicts.length && !drift.gitBlocker && !drift.contentDrift && !records.length) {
        const confirmation = action("confirmCommit", { expectedBase: drift.from, expectedHead: drift.to,
          paths: drift.conflicts, reason: "核对候选内容与提交完全等价" });
        try {
          this.confirmCommitEvidence(s, task, confirmation.args, { git, drift, records });
          return result("baseline-drift-content-equivalent", "提交与已交付候选等价，主控确认后可保留原检查和交付。提交者身份未知。",
            confirmation, { ...drift, shortStatus: git.shortStatus.slice(0, 20), statusCount: git.shortStatus.length,
              origin: "unattributed", preservableChecks: true });
        } catch (error) {
          if (error.verificationCode === "ownership-timeout") throw error;
        }
      }
      const redBasis = task.redBaseline ?? task.baseline;
      const failedRed = task.verification.checks.filter(check => check.stage === "red").map(check =>
        s.checkJobs.findLast(job => job.taskId === task.id && job.revision === task.revision &&
          !job.invalidated && sameCheckRecipe(job.check, check)))
        .find(job => job?.state === "failed" && job.receipt?.exitCode === 0 && !job.receipt.environmentFailure &&
          (!job.redImplementationBaseline || job.redImplementationBaseline === redBasis.sources));
      const redScopeUnverified = task.redBaselinePending || !implementationScopeMatches(task, redBasis);
      const legacyHandoff = !task.candidate && !task.redBaseline && task.baseline.admissionOwnedDirty?.some(file =>
        !coversPath(task.verification.testWrites, file)) &&
        (task.developerChecksPending || task.verification.checks.some(check => check.stage === "red" && !this.deliveryCheck(s, task, check)));
      if (failedRed || redScopeUnverified || legacyHandoff) {
        const repair = this.redBaselineRecovery(s, task, root, git);
        if (repair) {
          const pending = s.checkJobs.find(job => jobIncludes(job, task.id) && activeCheck(job));
          const reason = failedRed ? "红检查退出码 0，用例通过。请核对取红提交是否仍是未实现版本，并单独续接取红快照。" :
            redScopeUnverified ? "取红基线与当前写集不一致，可从已核对的历史提交续接取红快照。" :
              "准入时写集已有在途实现。请核对未实现版本所在提交后，单独续接取红快照。";
          return result("red-baseline-unverified", reason, pending ? action("checkStatus") : repair,
            { ...(pending && { afterChecks: repair }), ...(failedRed && { checkId: failedRed.check.id }) });
        }
        const fallback = this.redBaselineHeadFallback(task, root, git);
        if (failedRed) {
          const reason = "红检查退出码 0，未取得目标断言失败。请核对原日志，确认用例执行了目标断言，以及取红实现是否已经包含待验证行为。";
          return result("red-exit-zero", reason, { command: "checkEvidence", args: { jobId: failedRed.id } },
            { checkId: failedRed.check.id, ...(fallback && { actionRequired: fallback }) });
        }
        if (fallback) {
          const pending = s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job));
          const message = "自动定位取红快照失败。当前 HEAD 可作为候选，请先核对该提交的写集确实尚未实现本票行为。";
          return result("red-baseline-unverified", message, pending ? action("checkStatus") : fallback,
            { message, ...(pending ? { afterChecks: fallback } : { actionRequired: fallback }) });
        }
      }
      if (drift?.contentDrift && drift.from === drift.to && !drift.gitBlocker)
        return result("contract-invalid", "候选输入已变化，须按原票重新交付",
          action("rework", { reason: "已核对候选输入变化，按原票重新交付" }), drift);
      if (drift && !drift.blockingCondition && !records.length) {
        historyAdvance = drift;
        if ((task.preflightFailure || pruned.length) && task.state === "queued" && drift.from !== drift.to) {
          assertOutsideScope(root, task, this.foreignWrites(s, task), git, pruned);
          return result("history-advance", "Git 前移未触及冻结范围，原票可重新准入",
            action("reviseSchedule", { reason: "已提交的票外改动完成对账", refreshBaseline: true, expectedHead: drift.to }));
        }
      } else if (drift) {
        const status = git.shortStatus.slice(0, 20);
        const gitContext = { shortStatus: status, statusCount: git.shortStatus.length };
        const explicit = drift.conflicts.length || records.length;
        let blockingCondition = drift.blockingCondition;
        const blockingConditions = [];
        if (drift.gitBlocker) blockingConditions.push({ condition: "git-baseline-unsafe", reason: drift.gitBlocker, remedy: action("inspect"), effect: "核对冻结分支和基线；程序不改变 Git 历史" });
        if (drift.conflicts.length) blockingConditions.push({ condition: "committed-scope-overlap", paths: drift.conflicts.slice(0, 8), pathCount: drift.conflicts.length });
        if (records.length) blockingConditions.push({ condition: "recorded-baseline", paths: records.map((item) => item.file),
          remedies: sourceNotes.filter((note) => records.some((item) => item.file === note.file)).map((note) => note.nextAction),
          effect: "核对已入库文件保留冻结正文或仅追加受认可记录，逐文件确认提交指纹" });
        if (explicit) {
          try {
            const overlap = this.committedRebindScope(s, task, root, git, drift, records);
            const rerunRed = drift.conflicts.length ? task.verification.checks.filter(check => check.stage === "red" && !this.validCheck(s, task, check)).map(check => check.id) : [];
            const resume = action("rebindCommittedWork", { reason: "主控核对提交差异与原票写集归属后沿原票重绑", expectedBase: drift.from, expectedHead: drift.to, confirmPaths: overlap,
              ...(records.length && { confirmRecordedBaseline: Object.fromEntries(records.map(({ file, toDigest }) => [file, toDigest])) }) });
            for (const item of blockingConditions) item.remedy = resume;
            const stopped = task.state === "paused";
            const next = stopped ? resume : ["assigned", "rework"].includes(task.state)
              ? action("yieldForSchedule", { reason: "写集已提交，停写后交主控核对归属" })
              : action("rework", { reason: "归档旧交付证据，暂停并核对提交归属", adjustScope: true });
            return result(records.length && !drift.conflicts.length ? "baseline-drift-record-rebindable" : "baseline-drift-owned-rebindable",
              rerunRed.length ? "主控显式确认后可沿原票重绑；无有效历史红，须在原实现基线上重取真实红，再跑新 HEAD 的绿与完整检查" :
                "主控显式确认后可沿原票重绑，须用新 HEAD 的绿与完整检查",
              next,
              { ...drift, ...gitContext, blockingConditions, ...(rerunRed.length && { rerunRed }), ...(records.length && { recordedBaseline: records }),
                recovery: { candidate: resume, executable: false, requiredParameters: ["reason"], remainingBlockers: stopped ? [] : ["先交回并暂停原票"],
                  effect: "保留原票及历史；更新基线，要求新的绿及完整检查" },
                ...(stopped ? {} : { afterStop: resume }) });
          } catch (error) {
            blockingCondition = [drift.blockingCondition, error.message].filter(Boolean).join("；");
            if (!drift.gitBlocker) {
              const dirtyPaths = git.dirty.slice(0, 8);
              blockingConditions.push({ condition: "owned-rebind-precondition", reason: error.message,
                ...(dirtyPaths.length && { paths: dirtyPaths, pathCount: git.dirty.length }), remedy: action("inspect"),
                effect: "保留当前文件；核对原票和 Git 状态，剩余业务改动另行确认处理" });
            }
          }
        }
        if (!blockingCondition) {
          try { assertOutsideScope(root, task, this.foreignWrites(s, task), git, pruned); }
          catch (error) { blockingCondition = error.message; }
        }
        const unconfirmed = git.dirty.filter((file) => coversPath(task.writes, file) && !task.ownedDirty.includes(file));
        if (!blockingCondition && unconfirmed.length) blockingCondition = "须先核实已有改动归属并填写 ownedDirty：" + unconfirmed.join("、");
        if (blockingCondition && task.state === "trial")
          return blockedTrial(drift.contentDrift && !drift.gitBlocker ? "unrecoverable" : "baseline-drift-blocked",
            blockingCondition, { ...drift, ...gitContext, blockingCondition, blockingConditions });
        const refresh = action("reviseSchedule", { reason: "核对后重绑 Git 基线", refreshBaseline: true, expectedHead: drift.to });
        const remedies = blockingCondition && task.state === "paused" &&
          !s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job)) ? scopeRemedies() : [];
        const nextAction = blockingCondition ? null : ["queued", "paused"].includes(task.state) ? refresh :
          ["assigned", "rework"].includes(task.state) ? action("yieldForSchedule", { reason: "Git 基线漂移，停写后交回" }) :
          action("rework", { reason: "Git 基线漂移，保留旧证据后续接", adjustScope: true });
        return result(blockingCondition ? "baseline-drift-blocked" : "baseline-drift-rebindable",
          blockingCondition ?? "HEAD 已前移，提交差异未触及冻结读写或检查输入", nextAction,
          { ...drift, ...gitContext, blockingCondition, ...(records.length && { recordedBaseline: records }),
            recovery: { candidate: blockingCondition ? null : refresh, executable: !blockingCondition && nextAction === refresh,
              requiredParameters: [], remainingBlockers: blockingCondition ? [blockingCondition] : nextAction !== refresh ? ["先交回并暂停原票"] : [],
              effect: "仅在满足安全前移条件时保留原票并重绑" },
            ...(blockingConditions.length && { blockingConditions }),
            ...(remedies.length && { scopeRemedies: remedies }),
            ...(blockingCondition && { resolution: "保留当前文件和原票证据。只有取得新的范围授权、核对规划与派发参数后，才能用 previewPlan 和 dispatchPlan 建立后继票；当前诊断不会生成重建命令。" }),
            ...(nextAction && nextAction !== refresh && { afterStop: refresh }) });
      }
      assertOutsideScope(root, task, this.foreignWrites(s, task), git, pruned);
      if (interventionPause) return result("task-stopped", interventionPauseReason, action("inspect"));
      const suggested = task.state === "paused" && writeExpansionRemedy(root, task);
      if (suggested) return result("write-scope-review", task.waitReason, suggested.nextAction,
        { suggestedTests: suggested.suggestedTests, actionRequired: { ...suggested.nextAction, requiredParameters: ["reason"] } });
      if (task.state === "queued" && task.scopeConflict) return scopeConflictResult();
      if (deliveryIssue) return sessionIssue();
      if (redScopeUnverified) {
        const pending = s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job));
        return result("red-baseline-unverified", "无法证明原取红快照覆盖当前写集。核对未实现版本的历史提交后，单独续接取红快照。",
          action(pending ? "checkStatus" : "describeDrift"),
          { actionRequired: { ...action("reviseSchedule", { realignRedBaseline: true, expectedHead: git.head }),
            requiredParameters: ["redBaselineHead", "reason"], ownerRole: "controller" } });
      }
      if (task.developerChecksPending) return result("checks-not-registered",
        "责任开发应在保持原取红实现的情况下用 registerChecks 冻结检查；原票的验收、资源与读写边界已冻结",
        { ...action("inspect", { section: "full" }), ownerRole: "developer", ownerId: task.developerId },
        { developerChecksPending: true });
      if (task.candidate && !historicalCommit && this.hash(s, task) !== task.candidate) return result("contract-invalid",
        "候选输入已变化，须按原票重新交付", action("rework", { reason: "已核对候选输入变化，按原票重新交付" }));
      const checkBlocker = (check) => {
        const input = this.checkInput(root, task, check);
        const job = s.checkJobs.findLast((item) => item.taskId === task.id && item.check.id === check.id &&
          sameCheckRecipe(item.check, check) && this.checkContentMatches(item, input));
        const nextAction = job?.classification === "preparation-timeout" ? preparationActionView(s, job, task) :
          job?.redFailureReason && job.nextAction ? job.nextAction : evidenceNextAction(task, check, controller(s, task.projectId)?.id);
        return result(job?.classification ?? "evidence-missing", `检查 ${check.id}：${job?.error ?? "缺少有效回执"}`,
          nextAction, { message:nextAction.message,blocker: "checks-missing", checkId: check.id,
              ...(job&&{evidence:{command:activeCheck(job)?'checkStatus':'checkEvidence',args:activeCheck(job)?{taskId:task.id}:{jobId:job.id}}}),
          ...(job?.environmentFailure && { environmentFailure: true, environmentFailureReason: job.environmentFailureReason,
            hint: nextAction.message??job.hint, membersCanRetry: job.membersCanRetry }),
          ...(job?.classification==='preparation-timeout' && preparationTiming(job.check,job.receipt)) });
      };
      if (task.state === "changes_requested") {
        const review = task.reviews.at(-1);
        return result(review?.classification ?? "evidence-missing", review?.findings ?? "审查未通过", action("inspect"));
      }
      const developerChecks = task.verification.checks.filter(item => !leadCheck(item));
      if (recoveringFingerprint(task)) {
        const order = { red: 0, green: 1 };
        developerChecks.sort((a, b) => (order[a.stage] ?? 2) - (order[b.stage] ?? 2));
      }
      if (!historicalCommit) {
        for (const check of developerChecks) {
          if (!this.deliveryCheck(s, task, check)) return checkBlocker(check);
        }
      }
      if (!task.candidate) return result("evidence-missing", "尚未提交同候选的交付报告", action("inspect"));
      this.assertDeliveryProof(s, task, false, historicalCommit);
      if (["reviewing", "waiting_review"].includes(task.state))
        return result("evidence-missing", task.waitReason ?? "缺少当前候选的独立审查通过回执", action("inspect"), { blocker: "review-missing" });
      if (task.state === "waiting_verification") {
        const pending = task.verification.checks.find((item) => leadCheck(item) && !this.validCheck(s, task, item));
        if (pending) return checkBlocker(pending);
      }
      if (task.batchId && task.state === "waiting_batch") {
        const batch = find(s.validationBatches, task.batchId);
        const job = s.checkJobs.findLast((item) => item.batchId === batch.id);
        return result(job?.classification ?? "evidence-missing", `累计验证：${job?.error ?? batch.state}`,
          job ? { command: "checkEvidence", args: { jobId: job.id } } : action("inspect"));
      }
      if (["ready", "trial"].includes(task.state)) {
        this.assertDeliveryProof(s, task, true, historicalCommit);
        if (task.batchId) this.verifyBatchReceipt(s, task, historicalCommit);
        return result(task.state === "trial" ? "awaiting-user" : "ready",
          task.state === "trial" ? "待用户试用验收" : "当前候选证据满足程序门槛，待主控汇总", null,
          task.state === "trial" ? { actionRequired: { command: "accept", args: { taskId: task.id }, requiredParameters: ["evidence"] } } :
            { actionRequired: { command: "summarize", args: { taskId: task.id }, requiredParameters: ["instructions", "decision"] } });
      }
      return result("evidence-missing", task.waitReason ?? "当前流程尚未达到交付门槛", action("inspect"));
    } catch (error) {
      if (error.outsideFile && scannedGit) {
        const outsideOwnership = this.outsideOwnership(s, task, error.outsideFile, scannedGit);
        if (outsideOwnership) {
          const { file, sha256, candidates, unowned } = outsideOwnership;
          const pending = s.checkJobs.some(job => jobIncludes(job, task.id) && activeCheck(job));
          const canConfirmNow = (unowned || candidates.length > 0) && this.canConfirmForeignDirty(s, task) &&
            scannedGit.indexClean && scannedGit.branch === task.baseline.branch && scannedGit.branch !== "HEAD";
          const confirmation = { ...action(unowned ? "confirmForeignDirty" : "reviseSchedule", { expectedHead: scannedGit.head,
            reason: unowned ? "已核对该票外改动没有活动责任票，确认保留其当前字节" : "核对票外文件的责任票及当前字节",
            ...((unowned || candidates.length === 1) && { confirmForeignDirty: { [file]: { taskId: candidates[0]?.taskId ?? null, sha256 } } }) }),
            ownerRole: "controller" };
          const nextAction = pending ? action("checkStatus") : canConfirmNow && candidates.length <= 1 ? confirmation : action("inspect");
          const remedy = pending ? "先等原票检查结束或对账，再重新诊断获取最新文件摘要。" :
            canConfirmNow && unowned ? "核对该文件的来源。需入库时由授权人提交；需保留现有字节时，用 confirmForeignDirty 确认当前 SHA-256。" :
            canConfirmNow ? "核实责任票后可立即对账当前字节。对方再次修改文件后须重新确认。" :
              "请核对责任票、原分支和暂存区。当前阶段无法确认该文件归属。";
          return result("contract-invalid", `发现未归属的改动：${file}。${remedy}`, nextAction, {
            outsideOwnership: { ...outsideOwnership, canConfirmNow },
            ...(canConfirmNow && candidates.length > 1 && { actionRequired: { ...confirmation, requiredParameters: ["confirmForeignDirty"] } }),
          });
        }
      }
      if (error.nextAction) return result(error.verificationCode, error.message, error.nextAction,
        { ...(error.violations && { violations: error.violations }), ...(error.unownedWrites && {
          unownedWrites: error.unownedWrites, actionRequired: { ...error.nextAction, requiredParameters: ["reason"] },
        }) });
      if (task.state === "trial" && error.verificationCode === "contract-invalid")
        return blockedTrial("contract-invalid", error.message);
      return result(error.verificationCode ?? "evidence-missing", error.message, action("inspect"));
    }
  }
  reviewTestChanges(task, review, options) {
    return testReviewEvidence(task, review, options);
  }
  deliveryEvidence(s, task, args) {
    verify(task.verification && task.candidate, "evidence-missing", "没有已受理的冻结候选，请先用 diagnoseTask 核对原票");
    verify(args.candidate === undefined || args.candidate === task.candidate, "contract-invalid", "请求的候选与当前原票不一致");
    verify(task.state !== "accepted", "evidence-missing", "已验收票的历史证据请用 inspect 和 checkEvidence 查看；当前工作区不是历史快照");
    const root = find(s.projects, task.projectId).root;
    const git = this.verifyScope(s, task);
    const historicalCommit = git.drift?.historicalCommit;
    verify(historicalCommit || this.hash(s, task) === task.candidate, "contract-invalid", "候选输入已变化，不能复用旧证据；请沿原票重新交付");
    const report = task.reports.findLast((item) => item.revision === task.revision && item.candidate === task.candidate);
    const review = task.reviews.findLast((item) => item.candidate === task.candidate &&
      (item.revision === undefined ? report && item.at >= report.at : item.revision === task.revision));
    const batchJob = task.batchReceiptId && s.checkJobs.find((job) => job.id === task.batchReceiptId);
    let batchValid = false;
    if (batchJob) {
      try { this.verifyBatchReceipt(s, task, historicalCommit); batchValid = true; } catch { /* Leave stale batch evidence marked invalid. */ }
    }
    const result = { taskId: task.id, candidate: task.candidate, head: git.head, reportId: report?.id,
      ...(historicalCommit && { deliveryCommit: historicalCommit }),
      planning: task.sources, sourceNotes: planningSourceNotes(root, task, s.plans.find((item) => item.id === task.planId)),
      files: report?.manifest?.files ?? [], testChanges: report?.manifest?.testChanges ?? [],
      acceptance: task.verification.acceptance,
      independentReview: { required: task.risk === "high", ...(review && { verdict: review.verdict, reportId: review.id }) },
      ...(task.batchId && { batch: { batchId: task.batchId, valid: batchValid,
        ...(batchValid && { evidence: { command: "checkEvidence", args: { jobId: batchJob.id } } }) } }),
      checks: task.verification.checks.map((check) => {
        const job = !historicalCommit && this.deliveryCheck(s, task, check);
        const reusable = Boolean(job && (leadCheck(check) || report?.checks.some((proof) => proof.jobId === job.id)));
        const historical = historicalCommit && this.historicalCheck(s, task, check);
        return { id: check.id, stage: check.stage, argv: check.argv, covers: check.covers, inputs: check.inputs,
          expectedExit: check.expectedExit, expectedOutput: check.expectedOutput, failureOutput: check.failureOutput,
          reusable, owner: leadCheck(check) ? "controller" : "developer",
          ...(job && job.taskId !== task.id && { redNotApplicable: true, upstreamTaskId: job.taskId }),
          ...(historical && { historicalEvidence: { command: "checkEvidence", args: { jobId: historical.id } } }),
          ...(reusable && { exitCode: job.receipt?.exitCode, evidenceHead: JSON.parse(job.input)[0], evidence: { command: "checkEvidence", args: { jobId: job.id } } }) };
      }),
    };
    if (args.file !== undefined) {
      const [file] = scopePaths([args.file]);
      verify(result.files.some((entry) => entry.file === file), "contract-invalid", "只可查看候选交付清单中的相对路径");
      result.change = candidateDiff(root, git, file,
        report?.manifest?.deliveryBase ?? (historicalCommit ? report?.manifest?.head : undefined), historicalCommit);
      if (!historicalCommit) verify(this.hash(s, task) === task.candidate && gitState(root).head === git.head,
          "contract-invalid", "读取差异期间候选或 Git HEAD 已变化");
    }
    return result;
  }
  checkReference(check, job, task) {
    return { checkId: check.id, stage: check.stage, covers: check.covers, jobId: job.id, output: job.output,
      ...(task && job.taskId !== task.id && { redNotApplicable: true, upstreamTaskId: job.taskId }) };
  }
  evidenceBase(task) {
    // An approved clean forward rebind updates the Git gate, not the identity of unchanged evidence.
    return task.baseline.evidenceBase ?? [task.baseline.head, task.baseline.index];
  }
  checkInput(root, task, check) {
    assertFingerprintMode(task);
    return JSON.stringify([...this.evidenceBase(task),
      fingerprint(root, this.checkPaths(task, check), [], undefined, { rawPaths: task.verification.testWrites })]);
  }
  checkPaths(task, check) {
    return [...new Set([...task.writes, ...task.reads, ...check.inputs])];
  }
  checkResponsibility(task, check, role) {
    need(leadCheck(check)
      ? role.kind === "controller" && task.state === "waiting_verification" && !recoveringFingerprint(task)
      : role.id === task.developerId && (["assigned", "rework"].includes(task.state) || recoveringFingerprint(task)),
    "该检查不属于当前角色或阶段");
    if(leadCheck(check)) {
      const issue=probeSeparationIssues(task.verification.checks).find(issue=>issue.checkId===check.id);
      verify(!issue,'contract-invalid',issue?.message);
      verify(check.timeoutMs<=60000,'contract-invalid','主控冻结探针最多 60000ms，不得扩充为开发 full/regression');
    }
  }
  redCommitSnapshot(root, task, git, args) {
    assertCommitReference(args.expectedHead, git.head, "expectedHead");
    const head = args.redBaselineHead;
    verify(typeof head === "string" && /^[a-f0-9]{40,64}$/.test(head),
      "contract-invalid", "redBaselineHead 须是已核对的完整提交哈希");
    assertFingerprintMode(task);
    verify(git.branch === task.baseline.branch && git.branch !== "HEAD" && git.indexClean,
      "contract-invalid", "确认取红提交须在原分支且暂存区干净");
    try { readGit(root, ["merge-base", "--is-ancestor", head, git.head]); }
    catch (error) {
      if (error.verificationCode === "ownership-timeout") throw error;
      verify(false, "contract-invalid", "redBaselineHead 须为当前 HEAD 或其祖先");
    }
    const proof = implementationSnapshotAtCommit(root, task, head);
    verify(proof, "contract-invalid", "无法从 redBaselineHead 读取当前写集的实现");
    return { head, writes: [...task.writes], ...proof };
  }
  inheritedRedBaseline(s, task, root, git) {
    const predecessors = s.tasks.filter(peer => peer.projectId === task.projectId &&
      (peer.supersededBy === task.id || peer.id === task.upstreamRedTaskId) &&
      peer.verification && peer.baseline?.fingerprintEol === fingerprintEol);
    for (const peer of predecessors) {
      const prior = { ...peer, writes: originalTaskWrites(peer) };
      const projected = projectImplementationBaseline(root, prior, task.writes, prior.redBaseline ?? prior.baseline);
      if (!projected || !implementationScopeMatches(task, projected)) continue;
      try {
        const snapshot = this.redCommitSnapshot(root, task, git, { expectedHead: git.head, redBaselineHead: projected.head });
        if (snapshot.sources === projected.sources) return snapshot;
      } catch (error) {
        if (error.verificationCode !== "contract-invalid") throw error;
      }
    }
  }
  redBaselineRecovery(s, task, root, git) {
    if (!task.baseline || releasedTaskScope(task) || task.state === "accepted" ||
        git.branch !== task.baseline.branch || git.branch === "HEAD" || !git.indexClean) return null;
    const expected = task.redBaseline ?? task.baseline;
    const needsProjection = task.redBaselinePending || !implementationScopeMatches(task, expected);
    const projection = this.inheritedRedBaseline(s, task, root, git) ??
      (needsProjection ? projectImplementationBaseline(root, task, task.writes, expected) : null);
    if (needsProjection && !projection) return null;
    const head = projection?.head ?? expected.sourcesHead ?? expected.head;
    if (!/^[a-f0-9]{40,64}$/.test(head ?? "")) return null;
    const args = { taskId: task.id, realignRedBaseline: true, expectedHead: git.head, redBaselineHead: head,
      reason: "核对取红提交仍是行为未实现版本，仅续接取红基线" };
    let proposed;
    try { proposed = this.redCommitSnapshot(root, task, git, args); }
    catch (error) {
      if (error.verificationCode !== "contract-invalid") throw error;
      return null;
    }
    if (projection && proposed.sources !== projection.sources || !needsProjection && proposed.sources === expected.sources) return null;
    return { command: "reviseSchedule", args, ownerRole: "controller" };
  }
  redBaselineHeadFallback(task, root, git) {
    const args = { taskId: task.id, realignRedBaseline: true, expectedHead: git.head, redBaselineHead: git.head,
      reason: "已核对当前 HEAD 尚未实现本票行为，按该 Git 提交续接取红" };
    try { this.redCommitSnapshot(root, task, git, args); }
    catch (error) {
      if (error.verificationCode !== "contract-invalid") throw error;
      return null;
    }
    return { command: "reviseSchedule", args, ownerRole: "controller", requiredParameters: ["reason"] };
  }
  realignRedBaseline(s, task, args, role) {
    need(Object.keys(args).every(key => ["taskId", "realignRedBaseline", "expectedHead", "redBaselineHead", "reason"].includes(key)),
      "取红快照续接须单独执行");
    const blockers = [];
    if (!task.baseline || !task.verification || releasedTaskScope(task) || task.state === "accepted" ||
        !(task.developerChecksPending || task.verification.checks.some(check => check.stage === "red")))
      blockers.push({ code: "red-baseline-state", detail: `原票 state=${task.state}，须持有未释放的冻结红检查契约` });
    const jobs = s.checkJobs.filter(job => jobIncludes(job, task.id) && activeCheck(job));
    if (jobs.length) blockers.push({ code: "active-checks", detail: "取红快照续接须等在途检查完成或对账", jobIds: jobs.map(job => job.id) });
    if (blockers.length) throw Object.assign(Error(blockers.map(item => item.detail).join("；")), {
      verificationCode: "contract-invalid", blockers,
      ...(jobs.length && { nextAction: { command: "checkStatus", args: { taskId: task.id } } }),
    });
    const root = find(s.projects, task.projectId).root;
    const git = this.ownershipGit(s, task);
    assertFrozenTicket(root, task, git);
    const snapshot = this.redCommitSnapshot(root, task, git, args);
    const previous = task.redBaseline ?? task.baseline;
    const reason = text(args.reason, "取红续接依据");
    task.redBaseline = snapshot;
    delete task.redBaselinePending;
    const rerunRed = task.verification.checks.filter(check => check.stage === "red" && !this.deliveryCheck(s, task, check)).map(check => check.id);
    const audit = { taskId: task.id, redBaselineHead: snapshot.head, previousSources: previous.sources,
      newSources: snapshot.sources, rerunRed, reason, by: role.id };
    this.store.event("baseline.red-realigned", audit);
    return { state: "applied", redBaselineRealigned: true, ...audit,
      ...(rerunRed.length && { instruction: "先保留当前实现和测试，按 redBaselineHead 核对原实现快照。仅在该实现快照上运行待补红检查。" }) };
  }
  checkPrerequisites(s, task, check, root) {
    assertFingerprintMode(task);
    const context = `[${task.ticketKey ?? task.id} / ${check.id} / scheduleVersion=${task.scheduleVersion ?? 0}]`;
    const expected = task.redBaseline ?? task.baseline;
    verify(!task.redBaselinePending && implementationScopeMatches(task, expected), "contract-invalid",
      `${context} 取红基线覆盖范围与当前写集不一致，请用 diagnoseTask 获取原票恢复路径`);
    if (check.stage === "red") {
      const actual = implementationFingerprint(root, task);
      if (expected.sources !== actual.sources) {
        const changedFiles = expected.sourceFiles ? [...new Set([...Object.keys(expected.sourceFiles), ...Object.keys(actual.sourceFiles)])]
          .filter(file => expected.sourceFiles[file] !== actual.sourceFiles[file]) : null;
        const restore = (changedFiles ?? []).filter(file => /^[a-f0-9]{64}$/.test(expected.sourceFiles[file] ?? ""))
          .map(file => ["git", "-c", "core.autocrlf=false", "show", (expected.sourcesHead ?? expected.head) + ":" + file]);
        const expectedAbsent = (changedFiles ?? []).filter(file => expected.sourceFiles[file] === null);
        const refresh = this.redBaselineRecovery(s, task, root, this.ownershipGit(s, task));
        const message = `${context} 红阶段必须在实现文件未变化时运行；期望 sources=${expected.sources}；实际 sources=${actual.sources}；差异文件：${changedFiles?.join("、") || "旧基线缺少逐文件指纹，无法定位"}。` +
          `先保留当前候选，核对 ${expected.sourcesHead ?? expected.head} 的取红实现；取红时需缺席的路径：${expectedAbsent.join("、") || "无"}。` +
          (refresh ? `核对取红提交后，由主控执行 reviseSchedule ${JSON.stringify(refresh.args)}。` :
            "请恢复经过核验的取红快照，或用 diagnoseTask 核对承接路径。");
        throw Object.assign(Error(message), { verificationCode: "contract-invalid", ...(refresh && { nextAction: refresh }),
          violations: [{ path: "baseline.sources", message, expected: expected.sources, actual: actual.sources, changedFiles,
            remedy: { inspectBytes: restore, expectedAbsent, ...(refresh ? { nextAction: refresh } : {}) } }] });
      }
    }
    if (["green", "full"].includes(check.stage))
      need(task.verification.checks.filter((entry) => entry.stage === "red").every((entry) => this.deliveryCheck(s, task, entry)), context + " 先完成可核对的预期失败检查");
    if (["full", "regression"].includes(check.stage))
      need(task.verification.checks.filter((entry) => entry.stage === "green").every((entry) => this.validCheck(s, task, entry)), context + " 先完成对应的局部绿阶段");
    if (leadCheck(check)) this.assertDeliveryProof(s, task);
  }
  redProof(root, task, check) {
    return fingerprint(root, [...task.verification.testWrites, ...check.inputs.filter((file) => !overlaps([file], task.writes))],
      [], undefined, { rawPaths: task.verification.testWrites });
  }
  intactOutput(job) {
    try {
      return job.output && createHash("sha256").update(readFileSync(job.output)).digest("hex") === job.receipt?.outputHash;
    } catch {
      return false;
    }
  }
  checkContentMatches(job, input) {
    if (job.input === input) return true;
    try {
      const old = JSON.parse(job.input), current = JSON.parse(input);
      return Array.isArray(old) && old.length === 3 && old.every(value => typeof value === "string") &&
        old[2] === current[2];
    } catch { return false; }
  }
  invalidateCheckReceipts(s, task, checkIds) {
    if (!checkIds.length) return;
    for (const job of s.checkJobs)
      if (job.taskId === task.id && job.state === "passed" && checkIds.includes(job.check.id)) job.invalidated = true;
  }
  checkArtifactsAvailable(s, root, job) {
    const preparation = job.receipt?.preparation;
    if (artifactsIntact(root, preparation)) return true;
    if (preparation?.artifactsVerified !== true) return false;
    // A later verified build can account for changed shared products. Keep
    // rejecting changes with no recorded producer, including manual edits.
    return preparation.artifacts.every(artifact => artifactsIntact(root, { artifacts: [artifact] }) ||
      s.checkJobs.some(later => later.id !== job.id && later.root === job.root && later.finishedAt > job.finishedAt &&
        later.state === "passed" && later.receipt?.preparation?.artifactsVerified === true &&
        later.check.preSteps?.some(step => coversPath(step.outputs, artifact.file)) &&
        later.receipt.preparation.artifacts.some(output => output.file === artifact.file && artifactsIntact(root, { artifacts: [output] }))));
  }
  validCheck(s, task, check, jobId) {
    assertFingerprintMode(task);
    if (task.redBaselinePending || !implementationScopeMatches(task, task.redBaseline ?? task.baseline)) return;
    const root = find(s.projects, task.projectId).root;
    const red = check.stage === "red";
    const input = red ? this.redProof(root, task, check) : this.checkInput(root, task, check);
    return s.checkJobs.findLast((job) => job.taskId === task.id && (!jobId || job.id === jobId) &&
      job.check.id === check.id && (sameCheckRecipe(job.check, check) ||
        task.budgetReceiptIds?.includes(job.id) && sameCheckRecipe(checkWithoutBudgets(job.check), checkWithoutBudgets(check))) &&
      job.fingerprintEol === fingerprintEol && !job.invalidated &&
      job.state === "passed" && !job.receipt?.environmentFailure &&
      (red || this.checkArtifactsAvailable(s, root, job)) &&
      (red ? (job.redProofVersion === 2
        ? job.redProof === redEvidence(root, task, check, job.redImplementationBaseline, 2).redProof &&
          job.redTestProof === fingerprint(root, task.verification.testWrites, [], undefined, { eol: "raw" })
        : job.redProof === input) : this.checkContentMatches(job, input)) &&
      (!red || this.intactOutput(job) && redReceiptValid(check, job.receipt, readFileSync(job.output, "utf8"))) &&
      this.intactOutput(job));
  }
  upstreamRed(s, task, check, jobId) {
    if (check.stage !== "red" || !task.baseline || task.redBaselinePending ||
        !(task.redInheritedWrites ?? task.baseline.admissionOwnedDirty ?? task.ownedDirty ?? []).some(file =>
          coversPath(task.writes, file) && !coversPath(task.verification.testWrites, file))) return;
    const pair = task.verification.checks.find(green => green.stage === "green" && check.id === green.id + "-red" &&
      (check.derivedFrom === green.id || task.redContractVersion !== 2 && check.derivedFrom === undefined) &&
      JSON.stringify(green.argv) === JSON.stringify(check.argv));
    if (!pair) return;
    const upstreamIds = task.upstreamRedTaskId ? [task.upstreamRedTaskId] :
      [...(task.dependencies ?? []), ...s.tasks.filter(item => item.supersededBy === task.id).map(item => item.id)];
    if (!upstreamIds.length) return;
    const recipe = ({ id, derivedFrom, ...fields }) => fields;
    const root = find(s.projects, task.projectId).root;
    const testProof = fingerprint(root, task.verification.testWrites, [], undefined, { eol: "raw" });
    for (const upstreamId of upstreamIds) {
      const upstream = s.tasks.find(item => item.id === upstreamId && item.projectId === task.projectId && item.verification && item.baseline);
      if (!upstream || upstream.baseline.fingerprintEol !== fingerprintEol ||
          JSON.stringify(scopePaths(upstream.verification.testWrites)) !== JSON.stringify(scopePaths(task.verification.testWrites)) ||
          !(upstream.releasedScope?.writes ?? upstream.writes).length ||
          JSON.stringify(scopePaths(upstream.releasedScope?.writes ?? upstream.writes)) !== JSON.stringify(scopePaths(task.writes)) ||
          !check.covers.every(id => upstream.verification.acceptance.find(ac => ac.id === id)?.text ===
            task.verification.acceptance.find(ac => ac.id === id)?.text)) continue;
      const upstreamCheck = upstream.verification.checks.find(entry => entry.stage === "red" && sameCheckRecipe(recipe(entry), recipe(check)));
      if (!upstreamCheck) continue;
      const original = upstream.releasedScope?.writes ? { ...upstream, writes: upstream.releasedScope.writes } : upstream;
      const job = this.validCheck(s, original, upstreamCheck, jobId);
      if (job?.redTestProof === testProof && job.receipt.failureOutputSeen === true) return job;
    }
  }
  deliveryCheck(s, task, check, jobId) {
    return this.validCheck(s, task, check, jobId) ?? this.upstreamRed(s, task, check, jobId);
  }
  historicalCheck(s, task, check) {
    const proof = task.deliveryVerification?.checks.find(item => item.checkId === check.id);
    if (!proof) return;
    const job = s.checkJobs.find(item => item.id === proof.jobId);
    if (job && (job.taskId === task.id && sameCheckRecipe(job.check, check) ||
        check.stage === "red" && proof.upstreamTaskId === job.taskId && job.receipt?.failureOutputSeen === true) &&
        job.fingerprintEol === fingerprintEol &&
        job.state === "passed" && !job.invalidated && !job.receipt?.environmentFailure &&
        job.receipt?.outputHash === proof.outputHash && this.intactOutput(job)) return job;
  }
  recordDeliveryVerification(s, task, batchJob) {
    if (!task.deliveredManifest) return;
    try {
      const checks = this.assertDeliveryProof(s, task, true).map(({ checkId, jobId, upstreamTaskId }) => ({
        checkId, jobId, outputHash: find(s.checkJobs, jobId).receipt.outputHash,
        ...(upstreamTaskId && { upstreamTaskId }),
      }));
      task.deliveryVerification = { reportId: task.deliveredManifest.reportId, checks,
        ...(batchJob && { batch: { jobId: batchJob.id, outputHash: batchJob.receipt.outputHash } }) };
    } catch (error) {
      if (!["evidence-missing", "contract-invalid"].includes(error.verificationCode)) throw error;
    }
  }
  assertDeliveryProof(s, task, final = false, historicalCommit) {
    verify(historicalCommit || this.hash(s, task) === task.candidate, "contract-invalid", "候选输入已变化，需重新交付");
    const report = task.reports.findLast((item) => item.revision === task.revision && item.candidate === task.candidate);
    const checks = [];
    for (const check of task.verification.checks) {
      if (leadCheck(check) && !final) continue;
      const job = historicalCommit ? this.historicalCheck(s, task, check) : leadCheck(check) ? this.validCheck(s, task, check) :
        report?.checks?.map(proof => proof?.jobId && this.deliveryCheck(s, task, check, proof.jobId)).find(Boolean);
      verify(job, "evidence-missing", "交付证据缺失、失效或已变化：" + check.id);
      checks.push(this.checkReference(check, job, task));
    }
    return checks;
  }
  activeChecks() {
    return this.store.read().checkJobs.filter(activeCheck);
  }
  claimCheck(jobId) {
    return this.store.change((s) => {
      const job = find(s.checkJobs, jobId);
      if (job.state !== "queued") return null;
      const resources = job.check.resources ?? [];
      const artifacts = job.check.requiredArtifacts ?? [];
      if (s.checkJobs.some(other => other.id !== job.id && ["launching", "uncertain"].includes(other.state) &&
          ((other.check.resources ?? []).some(resource => resources.includes(resource)) ||
          other.root === job.root && overlaps(artifacts, other.check.requiredArtifacts ?? [])))) return null;
      if (resources.length && s.tasks.some(task => occupied(task) && !jobIncludes(job, task.id) &&
          task.resources.some(resource => resources.includes(resource)))) return null;
      if (job.batchId) {
        try {
          const batch = find(s.validationBatches, job.batchId);
          verify(job.fingerprintEol === fingerprintEol, "contract-invalid", "累计检查的指纹口径已变化，须重新提交");
          verify(this.batchInput(s, batch) === job.input, "contract-invalid", "累计检查输入已变化");
          if (job.check.ownershipPolicy) assertCheckOwnership(find(s.projects, job.projectId).root, job.check);
        } catch (error) {
          this.closeBatch(s, job, { state: "stale", error: error.message, classification: error.verificationCode ?? "evidence-missing" });
          return null;
        }
        job.state = "launching";
        job.startedAt = Date.now();
        return job;
      }
      if (s.checkJobs.some((peer) => peer.taskId === job.taskId && peer.id !== job.id && ["launching", "uncertain"].includes(peer.state)))
        return null;
      const task = find(s.tasks, job.taskId);
      const project = find(s.projects, job.projectId);
      try {
        verify(task.revision === job.revision && (job.scheduleVersion === undefined || job.scheduleVersion === (task.scheduleVersion ?? 0)),
          "contract-invalid", "检查责任在启动前已变化");
        const scope = this.verifyScope(s, task, s.roles.find(role => role.id === job.requester), true);
        const input = this.checkInput(project.root, task, job.check);
        if (leadCheck(job.check) || task.verification.browserE2E) assertCheckOwnership(project.root, job.check, task.verification.browserE2E);
        if (job.preparing) {
          this.checkResponsibility(task, job.check, activeRole(s, job.requester));
          if (job.check.stage !== "red") this.checkPrerequisites(s, task, job.check, project.root);
          const cached = this.validCheck(s, task, job.check);
          if (cached) {
            if (leadCheck(job.check)) this.completeIndependentChecks(s, task);
            this.recordContract(s, task, false);
            Object.assign(job, { state: "reused", reusedJobId: cached.id, finishedAt: Date.now(), ownership: scope.ownershipMetrics });
            delete job.preparing;
            this.notice(s, job.requester, `check:${job.id}:reused`, `复用有效检查记录 ${cached.id}：${task.title}`, task.id);
            return null;
          }
          if (job.check.stage === "red") this.checkPrerequisites(s, task, job.check, project.root);
          Object.assign(job, { input, ownership: scope.ownershipMetrics });
          const notes = planningSourceNotes(project.root, task, s.plans.find((item) => item.id === task.planId));
          if (notes.length) job.sourceNotes = notes;
          if (job.check.stage === "red") Object.assign(job, redEvidence(project.root, task, job.check, task.redBaseline?.sources));
          delete job.preparing;
        } else verify(input === job.input, "contract-invalid", "检查输入在启动前已变化");
      } catch (error) {
        if (error.verificationCode === "contract-invalid") this.recordContract(s, task, true, error.drift);
        this.closeCheck(s, job, { state: "stale", error: error.message, classification: error.verificationCode ?? "evidence-missing",
          ...(error.nextAction && { nextAction: error.nextAction }),
          ...(error.violations && { violations: error.violations }) });
        return null;
      }
      this.recordContract(s, task, false);
      job.state = "launching";
      job.startedAt = Date.now();
      return job;
    });
  }
  completeIndependentChecks(s, task) {
    if (task.state !== "waiting_verification" || recoveringFingerprint(task)) return;
    if (!task.verification.checks.filter(leadCheck).every(check => this.validCheck(s, task, check))) return;
    task.state = task.batchId ? "waiting_batch" : "ready";
    task.waitReason = null;
    if (task.state === "ready") this.recordDeliveryVerification(s, task);
  }
  closeCheck(s, job, result) {
    this.classifyCheck(job, result);
    const task = find(s.tasks, job.taskId);
    if (result.redFailureReason === "exit-zero") {
      const root = find(s.projects, task.projectId).root;
      // The receipt is already complete. Resolve the current Git snapshot when
      // available, and leave a diagnostic entry point if Git can't be read.
      const lookup = { command: "diagnoseTask", args: { taskId: task.id }, ownerRole: "controller" };
      let repair;
      try { repair = this.redBaselineRecovery(s, task, root, this.ownershipGit(s, task)); } catch {}
      const pending = s.checkJobs.some(item => item.id !== job.id && jobIncludes(item, task.id) && activeCheck(item));
      result.nextAction = repair && !pending ? repair : lookup;
      result.error += repair
        ? ` 核对取红提交后执行 ${result.nextAction.command} ${JSON.stringify(result.nextAction.args)}。`
        : " 当前没有可证实的替代提交。核对用例是否实际执行并能区分未实现行为，再由主控选择取红提交。";
      result.reason = result.error;
    }
    if(result.environmentFailureReason==='preparation-timeout'&&['failed','uncertain'].includes(result.state)) {
      Object.assign(result,preparationRecovery(s,task,{...job,state:result.state},result.receipt??{}));
      if(result.receipt)Object.assign(result.receipt,{classification:result.classification,hint:result.hint,membersCanRetry:false,nextAction:result.nextAction,
        ...preparationTiming(job.check,result.receipt)});
    }
    Object.assign(job, result, { finishedAt: Date.now() });
    const independent = leadCheck(job.check);
    if(!independent&&job.state==='passed'&&this.validCheck(s,task,job.check)) {
      task.reworkEvidence=(task.reworkEvidence??[]).filter(checkId=>checkId!==job.check.id);
      task.reworkEvidenceDetails=(task.reworkEvidenceDetails??[]).filter(item=>item.checkId!==job.check.id);
    }
    if (independent && job.state === "passed") this.completeIndependentChecks(s, task);
    const receiver = independent ? controller(s, task.projectId)?.id : task.developerId;
    if (receiver) this.notice(s, receiver, `check:${job.id}:${job.state}`, `检查 ${job.check.id} ${job.state}：${task.title}`, task.id);
    if (!independent && job.state === "uncertain")
      this.notice(s, controller(s, task.projectId).id, "check-reconcile:" + job.id, "后台检查待对账：" + task.title, task.id);
  }
  finishCheck(jobId, receipt, output) {
    return this.store.change((s) => {
      const job = find(s.checkJobs, jobId);
      if (!["launching", "uncertain"].includes(job.state) || (job.state === "uncertain" && receipt.uncertain)) return;
      let recordedOutput = "";
      try { if (output) recordedOutput = readFileSync(output, "utf8"); } catch {}
      receipt = { ...receipt, ...detectEnvironmentFailure(receipt, recordedOutput, receipt.startedAt ?? job.startedAt, job.check) };
      receipt = {...receipt,...checkEvidenceFacts(job.check,receipt,recordedOutput)};
      if (receipt.environmentFailure) Object.assign(receipt, { failureOutputSeen: false, classification: "environment-failed", ...environmentRetry(job) });
      if (receipt.timedOut) receipt = { ...receipt, uncertain: true };
      if (job.check.stage === "red") receipt = { ...receipt,
        redProofScope: job.redProofScope ?? job.files.filter(file => !job.check.inputs.includes(file)),
        excludedTestWrites: job.excludedTestWrites ?? [],
      };
      if (job.state === "uncertain" && receipt.uncertain) return;
      if (job.batchId) {
        const result = { state: receipt.uncertain ? "uncertain" : "failed", output, receipt };
        if (!receipt.uncertain) {
          try {
            verify(job.fingerprintEol === fingerprintEol && !receipt.stale && this.batchInput(s, find(s.validationBatches, job.batchId)) === job.input,
              "contract-invalid", "累计检查输入已变化");
            if (this.passed(job, receipt, output)) result.state = "passed";
          } catch (error) {
            result.state = "stale";
            result.error = error.message;
            result.classification = error.verificationCode;
          }
        }
        this.closeBatch(s, job, result);
        this.schedule(s);
        return;
      }
      const task = find(s.tasks, job.taskId);
      const result = { state: "failed", output, receipt };
      if (receipt.uncertain) {
        result.state = "uncertain";
      } else {
        try {
          this.verifyScope(s, task, undefined, true);
          verify(!receipt.stale && task.revision === job.revision && this.checkInput(job.root, task, job.check) === job.input,
            "contract-invalid", "检查期间输入已变化");
          if (leadCheck(job.check)) this.assertDeliveryProof(s, task);
          if (this.passed(job, receipt, output))
            result.state = "passed";
        } catch (error) {
          result.state = "stale";
          result.error = error.message;
          result.classification = error.verificationCode;
          if (error.verificationCode === "contract-invalid") this.recordContract(s, task, true, error.drift);
        }
      }
      this.closeCheck(s, job, result);
      this.schedule(s);
    });
  }
  passed(job, receipt, output) {
    return receipt.id === job.id && !receipt.environmentFailure && !receipt.signal && !receipt.timedOut && !receipt.launchError &&
      (receipt.evidenceKind!=='test'||receipt.testCaseSeen===true) &&
      receipt.exitCode === job.check.expectedExit && receipt.expectedOutputSeen && this.intactOutput({ output, receipt }) &&
      (job.check.stage !== "red" || redReceiptValid(job.check, receipt, readFileSync(output, "utf8")));
  }
  classifyCheck(job, result) {
    const receipt = result.receipt;
    let output = "";
    try { if (result.output) output = readFileSync(result.output, "utf8"); } catch {}
    const environment = detectEnvironmentFailure(receipt, output, receipt?.startedAt ?? job.startedAt, job.check);
    Object.assign(result, environment, ...(receipt ? [checkEvidenceFacts(job.check,{...receipt,...environment},output)] : []));
    if (result.state === "passed") {
      if (job.check.stage === 'red') { result.redEvidenceValid = true; if (receipt) receipt.redEvidenceValid = true; }
      return;
    }
    if (["failed", "uncertain"].includes(result.state) && result.environmentFailure) {
      Object.assign(result, { classification: "environment-failed", error: environment.reason, ...environmentRetry(job) });
      return;
    }
    if (job.check.stage === "red" && result.state === "failed" && this.intactOutput(result) &&
        !redReceiptValid(job.check, receipt, output)) {
      const evidence = { command: "checkEvidence", args: { jobId: job.id } };
      const { marker, markerSeen, assertionVerified } = redFailureObservation(job.check, output);
      let redFailureReason, error, nextAction = evidence;
      if (receipt.exitCode === 0) {
        redFailureReason = "exit-zero";
        error = "红检查退出码 0，用例通过。请先核对取红实现是否已经包含待验证行为。";
      } else if (receipt.truncated || !assertionVerified ||
          !Number.isInteger(receipt.exitCode) || receipt.exitCode < 1) {
        redFailureReason = "assertion-unverified";
        error = "红检查未取得可核验的断言失败。请查看原日志，检查用例选择、语法、依赖和日志完整性。";
      } else if (receipt.exitCode !== job.check.expectedExit) {
        redFailureReason = "exit-mismatch";
        error = `红检查实际退出码 ${receipt.exitCode}，冻结预期为 ${job.check.expectedExit}。请在原日志中核对退出原因。`;
      } else if (!markerSeen) {
        redFailureReason = "marker-mismatch";
        error = marker ? "红检查观察到断言失败，但未命中冻结失败标记。请核对原日志；确认是目标断言后，由主控授权修订原票检查。" :
          "红检查观察到断言失败，但检查未声明失败标记。请核对原日志后，由主控授权登记真实断言的标记。";
      } else {
        redFailureReason = "receipt-invalid";
        error = "红检查回执未能证明命中的标记来自真实断言失败。请核对原日志和回执。";
      }
      Object.assign(result, { classification: "evidence-missing", redFailureReason, error, reason: error, nextAction });
      return;
    }
    if(result.state==='failed'&&receipt?.evidenceKind==='test'&&!receipt.testCaseSeen) {
      Object.assign(result,{classification:'evidence-missing',reason:receipt.evidenceReason,error:receipt.evidenceReason,
        membersCanRetry:!job.batchId,nextAction:{command:'check',args:{taskId:job.taskId,checkId:job.check.id}}});
      return;
    }
    if (result.state === "failed" && receipt?.id === job.id && !receipt.launchError && !receipt.signal &&
      !receipt.timedOut && !receipt.truncated && Number.isInteger(receipt.exitCode) && this.intactOutput(result)) {
      result.error ??= `检查 ${job.check.id} 实测退出码 ${receipt.exitCode}，预期 ${job.check.expectedExit}` +
        (receipt.expectedOutputSeen ? "" : "；缺少预期输出标记");
      if (job.check.stage !== "red" && receipt.exitCode !== job.check.expectedExit &&
        (job.check.failureOutput && receipt.failureOutputSeen || result.evidenceKind === 'probe' && receipt.exitCode !== 0 && result.errorStackSeen || result.evidenceKind === 'compile' && receipt.exitCode !== 0 && result.compileErrorSeen)) {
        result.classification ??= "quality-failed";
        result.error += job.check.failureOutput && receipt.failureOutputSeen ? `；命中冻结的断言失败标记：${job.check.failureOutput}` :
          result.evidenceKind === 'compile' ? '；已观察到编译错误' : '；已观察到进程错误栈';
      }
    }
    result.classification ??= "evidence-missing";
    result.error ??= receipt?.launchError || (result.state === "uncertain" ? "作业结果待对账" : "缺少完整可核验的检查回执");
  }
  batchFiles(s, batch) {
    return [...new Set([...batch.check.inputs, ...batch.taskIds.flatMap((id) => {
      const task = find(s.tasks, id);
      return [...task.writes, ...readsFor(task)];
    })])];
  }
  batchInput(s, batch, delivered = false) {
    const root = find(s.projects, batch.projectId).root;
    const versions = batch.taskIds.map((id) => {
      const task = find(s.tasks, id);
      verify((delivered ? terminalDependency.includes(task.state) : task.state === "waiting_batch") && this.hash(s, task) === task.candidate,
        "contract-invalid", "批次成员候选已变化");
      this.verifyScope(s, task);
      this.assertDeliveryProof(s, task, true);
      return [task.id, task.revision, task.candidate, ...this.evidenceBase(task)];
    });
    return JSON.stringify([versions, fingerprint(root, this.batchFiles(s, batch), [], undefined, {
      rawPaths: batch.taskIds.flatMap(taskId => find(s.tasks, taskId).verification.testWrites),
    })]);
  }
  verifyBatchReceipt(s, task, historicalCommit) {
    const batch = find(s.validationBatches, task.batchId);
    const job = find(s.checkJobs, task.batchReceiptId);
    verify(job.state === "passed" && this.intactOutput(job), "evidence-missing", "累计检查证据已失效");
    if (historicalCommit) {
      const proof = task.deliveryVerification?.batch;
      verify(proof?.jobId === job.id && proof.outputHash === job.receipt.outputHash && !job.invalidated,
        "evidence-missing", "原交付的累计检查证据已失效");
      return;
    }
    verify(job.input === this.batchInput(s, batch, true), "contract-invalid", "累计检查输入已变化");
  }
  closeBatch(s, job, result) {
    this.classifyCheck(job, result);
    Object.assign(job, result, { finishedAt: Date.now() });
    const batch = find(s.validationBatches, job.batchId);
    batch.state = job.state;
    if (job.state === "passed") {
      for (const taskId of batch.taskIds) {
        const task = find(s.tasks, taskId);
        task.state = "ready";
        task.waitReason = null;
        task.batchReceiptId = job.id;
        this.recordDeliveryVerification(s, task, job);
      }
    }
    const receiver = controller(s, batch.projectId)?.id;
    if (receiver) this.notice(s, receiver, `batch:${job.id}:${job.state}`, `累计验证 ${batch.check.id} ${job.state}`, batch.taskIds[0]);
  }
  scheduleBatches(s) {
    for (const batch of s.validationBatches.filter((entry) => entry.state === "waiting")) {
      const tasks = batch.taskIds.map((id) => find(s.tasks, id));
      if (!tasks.every((task) => task.state === "waiting_batch")) continue;
      const files = this.batchFiles(s, batch);
      const resourceConflict = (resources) => batch.check.resources.some((resource) => resources.includes(resource));
      const inUse = s.tasks.some((task) => occupied(task) && (
        resourceConflict(task.resources) || (task.projectId === batch.projectId && overlaps(files, task.writes))
      )) || s.checkJobs.some((job) => job.batchId && activeCheck(job) && resourceConflict(job.check.resources));
      if (inUse) continue;
      let input;
      try {
        input = this.batchInput(s, batch);
      } catch (error) {
        batch.state = "stale";
        batch.error = error.message;
        const receiver = controller(s, batch.projectId)?.id;
        if (receiver) this.notice(s, receiver, "batch-stale:" + id(), "累计检查需对账：" + error.message, tasks[0].id);
        continue;
      }
      const job = { id: id(), projectId: batch.projectId, taskId: tasks[0].id, taskIds: batch.taskIds,
        batchId: batch.id, root: find(s.projects, batch.projectId).root, check: batch.check, files,
        fingerprintEol, rawPaths: tasks.flatMap(task => task.verification.testWrites),
        input, state: "queued", createdAt: Date.now() };
      batch.state = "queued";
      s.checkJobs.push(job);
    }
  }
  view(s, role) {
    return {
      roleDuplicateDiagnostics: (s.roleDuplicateDiagnostics ?? []).filter(item => !role || s.roles.find(member => member.id === item.roleId)?.projectId === role.projectId),
      projects: s.projects.filter((p) => !role || p.id === role.projectId),
      roles: s.roles
        .filter(
          (r) => !r.archivedAt && (!role || r.projectId === role.projectId),
        )
        .map((member) => ({ id: member.id, name: member.name, kind: member.kind,
          label: roleLabel(member),
          enabled: member.enabled,
          connected: connected(member),
          state: member.state,
          ...pendingInputStatus(member),
          ...(member.lastInputDrop && { lastInputDrop: member.lastInputDrop }),
          seenContextRevision: member.seenContextRevision ?? null,
          wakeHealth:wakeHealth(s,member.id),
          deliveryDiagnostic: member.enabled ? this.deliveryDiagnostic(s, member) : null,
        })),
      requirements: s.requirements.filter(
        (r) => !role || r.projectId === role.projectId,
      ),
      tasks: s.tasks
        .filter((t) => !role || t.projectId === role.projectId)
        .map((task) => ({
          id: task.id, ticketKey: task.ticketKey, planId: task.planId, dependencies: task.dependencies,
          title: task.title, state: task.state, assignee: task.assignee, risk: task.risk,
          ...ownerStatus(s,task),
          ...supersessionHint(s,task),
          supersededBy: task.supersededBy, scopeReleased: releasedTaskScope(task),
          waitReason: task.waitReason, deliveredAt: task.deliveredAt ?? null,
          ...this.taskDelivery(s, task),
          scopeConflict: task.scopeConflict,
          verificationMode: verificationMode(task),
        })),
    };
  }
  taskDelivery(s, task) {
    const roleIds=[task.developerId,task.assignee,...s.roles.filter(role=>role.projectId===task.projectId&&role.kind==='controller'&&!role.archivedAt).map(role=>role.id)];
    return {...this.taskDeliveryStatus(s,task),wakeHealth:wakeHealth(s,roleIds)};
  }
  taskDeliveryStatus(s, task) {
    const owner=ownerStatus(s,task);
    if (releasedTaskScope(task)) return { deliveryState: ['superseded','abandoned'].includes(task.state) ? task.state : "scope-released" };
    if (!task.developerId) return {};
    const blocker = task.state === "accepted" ? null : bridgeToolsBlocker(s.roles.find(item => item.id === (task.assignee ?? task.developerId)));
    if (blocker) return { deliveryState: "blocked", blockedBy: [blocker], deliveryIssue: blocker };
    if (task.deliveredAt) return { deliveryState: "delivered", ...owner, ...(task.deliveryIssue && { deliveryIssue: task.deliveryIssue }) };
    if (task.resumePending) return { deliveryState: "pending", ...(task.deliveryIssue && { deliveryIssue: task.deliveryIssue }) };
    const role = s.roles.find((item) => item.id === (task.assignee ?? task.developerId));
    const diagnostic = role && this.deliveryDiagnostic(s, role, task.admittedAt);
    return { deliveryState: task.state === "queued" ? "waiting-admission" : diagnostic?.reason === "retry-limit" ? "undeliverable" : task.assignee ? "pending" : "waiting-admission",
      ...(diagnostic && { deliveryIssue: diagnostic }) };
  }
  recovery(s, role) {
    const primary = role.kind === "controller" && controller(s, role.projectId)?.id === role.id;
    const work = role.kind === "supervisor" ? [] : s.tasks.filter((task) =>
      task.projectId === role.projectId && task.state !== "accepted" && !releasedTaskScope(task) &&
      (primary || task.assignee === role.id));
    const tasks = work.sort((a, b) => Number(a.state === "queued") - Number(b.state === "queued")).slice(0, 12).map((task) => ({
      id: task.id, ticketKey: task.ticketKey, title: task.title.slice(0, 140), state: task.state,
      revision: task.revision, candidate: task.candidate, progress: task.progress?.slice(0, 240),
      waitReason: task.waitReason?.slice(0, 240), openQuestions: task.questions.filter((item) => !item.answer).map((item) => item.id),
      checks: s.checkJobs.filter((job) => jobIncludes(job, task.id) &&
        (job.batchId || job.revision === task.revision)).slice(-8)
        .map((job) => ({ id: job.id, checkId: job.check.id, state: job.state })),
    }));
    return { tasks, remaining: work.length - tasks.length };
  }
  scopeConflict(s, task, peer) {
    const peerRole = s.roles.find((role) => role.id === (peer.assignee ?? peer.developerId))?.kind ?? "unknown";
    const remedyFor = kind => scopeConflictRemedy(s, task, peer, kind,
      after => validateDependencyEdit(s, task, resolveAfter(s.tasks, task, after)));
    return scopeConflict(task, peer, peerRole, remedyFor);
  }
  schedule(s, now = Date.now()) {
    for (const task of s.tasks) this.finishTaskStop(s, task, now);
    this.scheduleBatches(s);
    for (const task of s.tasks) {
      if (task.state !== "queued") recordAdmissionWait(task, null, now);
      if (task.state === "queued") {
        const conflicts = s.tasks.filter((peer) => peer.id !== task.id && activeScope(peer));
        const previousFailures = task.dependencyWaitFailures ?? {};
        const failures = {}, fingerprintBlocked = new Set();
        const blockers = task.dependencies.filter((dep) => {
          const predecessor = find(s.tasks, dep);
          if (predecessor.state === "trial" && predecessor.verification && predecessor.baseline?.fingerprintEol !== fingerprintEol) {
            fingerprintBlocked.add(dep);
            return true;
          }
          if (task.dependencyStages?.[dep] === "accepted") return predecessor.state !== "accepted";
          if (verificationMode(predecessor) === "missing-contract") return true;
          if (!terminalDependency.includes(predecessor.state)) return true;
          const historical=task.dependencyReceipts?.[dep]??recoverAdmittedDependency(task,predecessor,s.checkJobs,job=>this.intactOutput(job));
          if(historical)(task.dependencyReceipts??={})[dep]=historical;
          if(dependencyReceiptValid(historical,predecessor,s.checkJobs,job=>this.intactOutput(job))) return false;
          try {
            const scope = predecessor.verification && (predecessor.state !== "accepted" || predecessor.candidateScope === 2)
              ? this.verifyScope(s, predecessor) : undefined;
            const historicalCommit = scope?.drift?.historicalCommit;
            if (predecessor.batchId) this.verifyBatchReceipt(s, predecessor, historicalCommit);
            const proofs=predecessor.verification
              ? this.assertDeliveryProof(s,predecessor,true,historicalCommit).map(proof=>find(s.checkJobs,proof.jobId)) : [];
            if(predecessor.batchReceiptId)proofs.push(find(s.checkJobs,predecessor.batchReceiptId));
            (task.dependencyReceipts??={})[dep]=dependencyReceipt(predecessor,proofs,now);
            return false;
          } catch (error) {
            const failure = failures[dep] = {
              since: previousFailures[dep] && previousFailures[dep].code !== "contract-invalid" ? previousFailures[dep].since : now,
              reason: error.message,
              code: error.verificationCode ?? "evidence-missing",
            };
            if (failure.code === "contract-invalid") failure.since = now;
            else if (now - failure.since >= SILENCE_THRESHOLD_MS) {
              const lead = controller(s, task.projectId);
              const reason = "核对前置回执异常：" + (predecessor.ticketKey ?? dep);
              const detach = { command: "reviseSchedule", args: { taskId: task.id, reason,
                after: task.dependencies.filter(id => id !== dep).map(taskId => ({ taskId, stage: task.dependencyStages?.[taskId] ?? "verified" })) } };
              const restore = { command: ["assigned", "rework", "paused"].includes(predecessor.state) ? "resumeTask" : "rework",
                args: { taskId: dep, reason } };
              if (lead) this.notice(s, lead.id, `patrol-alert:dependency:${task.id}:${dep}:${failure.since}`,
                `${task.ticketKey ?? task.id} 等待前置 ${predecessor.ticketKey ?? dep} 超过 10 分钟：${error.message}\n` +
                `确认不再需要该前置后：${detach.command} ${JSON.stringify(detach.args)}\n` +
                `仍需前置、先对账后：${restore.command} ${JSON.stringify(restore.args)}`, task.id);
            }
            return true;
          }
        });
        for (const [dep, previous] of Object.entries(previousFailures)) {
          if (failures[dep]?.since === previous.since) continue;
          const key = `patrol-alert:dependency:${task.id}:${dep}:${previous.since}`;
          for (const notice of s.notices) if (notice.key === key && !notice.readAt) notice.readAt = now;
        }
        if (Object.keys(failures).length) task.dependencyWaitFailures = failures;
        else delete task.dependencyWaitFailures;
        const blocked = blockers[0];
        const conflict = !blocked && conflicts.map((peer) => this.scopeConflict(s, task, peer)).find(Boolean);
        const memberBusy = !blocked && conflicts.some((t) => t.assignee === task.developerId && !["paused", "queued"].includes(t.state));
        task.scopeConflict = conflict || null;
        let waitKind = blocked ? "dependency" : memberBusy ? "member" : conflict ? "resource" : null;
        const blockedTicket = blocked && (find(s.tasks, blocked).ticketKey ?? blocked);
        let reason = blocked
          ? fingerprintBlocked.has(blocked) ? `前置 ${blockedTicket} 待口径续接`
          : "等待前置：" + blockedTicket + " · " + (task.dependencyStages?.[blocked] === "accepted" ? "用户验收" : "有效验证") +
            (failures[blocked] ? " · " + failures[blocked].reason : "")
          : memberBusy
            ? "开发者已有责任"
            : conflict
              ? conflict.message
              : null;
        const target = s.roles.find((role) => role.id === task.developerId);
        const unavailable = target && dispatchAvailability(target);
        if (!reason && target?.resumeTaskAfter) {
          reason = "等待成员恢复后的新心跳，再重新准入";
          waitKind = "member";
        }
        if (!reason && ["offline", "unbound", "disabled", "jobs-unknown"].includes(unavailable)) {
          reason = deliveryLabels[unavailable];
          waitKind = "member";
        }
        if (!reason && s.checkJobs.some(job =>
          job.batchId && activeCheck(job) && ((job.projectId === task.projectId && overlaps(task.writes, job.files)) ||
            task.resources.some(resource => job.check.resources.includes(resource))) ||
          !job.batchId && ["launching", "uncertain"].includes(job.state) &&
            task.resources.some(resource => job.check.resources?.includes(resource)))) {
          reason = "等待检查作业释放输入或共享资源";
          waitKind = "resource";
        }
        const oldFailure = task.preflightFailure;
        if (!reason && task.verification && oldFailure?.version === (task.scheduleVersion ?? 0) &&
            now - (oldFailure.checkedAt ?? 0) < 30000)
          reason = oldFailure.reason;
        if (!reason && task.verification) {
          try {
            const project = find(s.projects, task.projectId);
            if (task.baseline) this.verifyScope(s, task, undefined, true);
            else {
              task.concurrentPeers = s.tasks.filter((peer) => peer.id !== task.id && peer.projectId === task.projectId && occupied(peer)).map((peer) => peer.id);
              const git = this.ownershipGit(s, task);
              assertFrozenTicket(project.root, task, git);
              task.baseline = scopeBaseline(project.root, task, this.foreignWrites(s, task), git);
              const inheritedImplementation = task.baseline.admissionOwnedDirty.filter(file =>
                !coversPath(task.verification.testWrites, file));
              if (inheritedImplementation.length) task.redInheritedWrites = inheritedImplementation;
              if (inheritedImplementation.length && (task.developerChecksPending ||
                  task.verification.checks.some(check => check.stage === "red"))) {
                const inherited = this.inheritedRedBaseline(s, task, project.root, git);
                const headFallback = task.upstreamRedTaskId || s.tasks.some(peer => peer.supersededBy === task.id) ||
                  task.verification.checks.some(check => check.derivedFrom);
                const proof = inherited ?? (headFallback && implementationSnapshotAtCommit(project.root, task, git.head));
                if (proof && proof.sources !== task.baseline.sources) {
                  task.redBaseline = { head: git.head, writes: [...task.writes], ...proof };
                  this.store.event("baseline.red-inherited", { taskId: task.id, head: task.redBaseline.head, sources: proof.sources });
                }
              }
            }
          } catch (error) {
            reason = error.message;
            task.preflightFailure = { version: task.scheduleVersion ?? 0, checkedAt: now, reason,
              classification: error.verificationCode ?? "evidence-missing", ...(error.unownedWrites && { unownedWrites: error.unownedWrites }) };
            const lead = controller(s, task.projectId);
            if (lead) {
              const noticeKey = `preflight:${task.id}:${task.scheduleVersion ?? 0}`;
              const notice = s.notices.find((item) => item.roleId === lead.id && item.key === noticeKey);
              const summary = `准入受阻：${task.title} · ${reason}`;
              if (notice) notice.summary = summary;
              else this.notice(s, lead.id, noticeKey, summary, task.id);
            }
          }
        }
        if (blocked) task.waitedForDependency = true;
        recordAdmissionWait(task, waitKind, now);
        const wasWaitingForDependency = task.waitedForDependency || task.waitReason?.startsWith("等待前置：");
        task.waitReason = reason;
        if (!reason) {
          if (task.preflightFailure) {
            const lead = controller(s, task.projectId);
            if (lead) this.notice(s, lead.id, `preflight-ready:${task.id}:${task.scheduleVersion ?? 0}`,
              "准入阻塞已解除，原票已自动分派：" + task.title, task.id);
          }
          delete task.preflightFailure;
          delete task.waitedForDependency;
          task.state = task.resumeState ?? (task.revision > 1 ? "rework" : "assigned");
          delete task.resumeState; delete task.resumePending; delete task.deliveryIssue;
          task.assignee = task.developerId;
          task.admittedAt ??= Date.now();
          task.retainedWrites = [];
          this.notice(
            s,
            task.assignee,
            dispatchNotice(task),
            "开发任务：" + task.title + (task.redBaseline?.head && task.redBaseline.sources !== task.baseline?.sources
              ? `。已选定取红提交 ${task.redBaseline.head}。需要登记检查或重新取红时，先保存在途实现和测试，再使用该提交的实现快照。` : "") +
              (task.developerChecksPending ? "。先用 registerChecks 冻结检查再取红。" : "") +
              (task.baseline?.excludedPeerDirty?.length ? "。基线中已排除他人写集：" + summarizePaths(task.baseline.excludedPeerDirty) : ""),
            task.id,
          );
          const lead = wasWaitingForDependency && controller(s, task.projectId);
          if (lead) this.notice(s, lead.id, "dependency-ready:" + task.id + ":" + task.revision + ":" + (task.scheduleVersion ?? 0), "前置已满足，原票已自动分派：" + task.title, task.id);
        }
      }
      if (task.state === "waiting_review") {
        const reviewer = s.roles.find(
          (r) =>
            r.projectId === task.projectId &&
            r.kind === "reviewer" &&
            r.id !== task.developerId &&
            r.enabled &&
            !r.archivedAt &&
            dispatchAvailability(r, now, true) === null &&
            !s.tasks.some(
              (t) => t.assignee === r.id && t.state === "reviewing",
            ),
        );
        task.waitReason = reviewer ? null : "等待已开启且空闲的独立审查者";
        if (!reviewer && !s.roles.some((r) => r.kind === "reviewer" && r.projectId === task.projectId && r.enabled && !r.archivedAt))
          this.notice(s, controller(s, task.projectId).id, `review-blocked:${task.id}:${task.revision}`, "高风险票缺少已开启的独立审查者：" + task.title, task.id);
        if (reviewer) {
          task.state = "reviewing";
          task.assignee = reviewer.id;
          this.notice(
            s,
            reviewer.id,
            reviewNotice(task),
            "独立审查：" + task.title,
            task.id,
          );
          const resume = s.notices.findLast(notice => notice.roleId === reviewer.id && !notice.readAt && notice.key.startsWith('resume:'));
          if (resume?.silent && !resume.silentCoalescedAt) {
            delete resume.silent;
            Object.assign(resume, { actionable: true, summary: resumeText });
          }
        }
      }
    }
    this.scheduleBatches(s);
  }
  catalog() {
    const s = this.store.read();
    return s.projects.map((p) => ({
      ...p,
      roles: s.roles
        .filter((r) => !r.archivedAt && providerOf(r) === "dsh" && r.projectId === p.id)
        .map(({ id, name, kind, customLabel, sessionId }) => ({
          id,
          name,
          kind,
          label: roleLabel({ kind, customLabel }),
          bound: !!sessionId,
        })),
    }));
  }
  request({ roleId, sessionId, cwd }) {
    return this.store.change((s) => {
      const role = activeRole(s, roleId),
        project = find(s.projects, role.projectId);
      need(providerOf(role) === "dsh", "会话类型不匹配");
      text(sessionId, "会话编号");
      need(
        role.kind === "supervisor" || realpathSync(cwd).toLowerCase() === project.root.toLowerCase(),
        "会话目录与项目不一致",
      );
      need(
        !s.roles.some((r) => providerOf(r) === "dsh" && r.sessionId === sessionId && r.id !== roleId),
        "该会话已绑定其他角色",
      );
      need(
        !role.sessionId || role.sessionId === sessionId,
        "角色已绑定其他会话",
      );
      if (role.sessionId === sessionId) return { bound: true, confirmed: true, roleId, effective: Boolean(role.enabled), reason: role.enabled ? "confirmed-and-enabled" : "disabled", deliveryBlocker: dispatchAvailability(role) };
      const previous = s.requests.find(
        (r) => r.roleId === roleId && r.sessionId === sessionId && !r.confirmed,
      );
      if (previous) return { ...previous, effective: false, reason: "awaiting-confirmation" };
      const request = { id: id(), roleId, sessionId, cwd, confirmed: false };
      s.requests.push(request);
      return { ...request, effective: false, reason: "awaiting-confirmation" };
    });
  }
  codexRole(roleId) {
    const s = this.store.read();
    const role = activeRole(s, roleId);
    need(providerOf(role) === "codex", "会话类型不匹配");
    return { role, project: find(s.projects, role.projectId) };
  }
  bindCodex(roleId, sessionId, cwd) {
    return this.store.change((s) => {
      const role = activeRole(s, roleId);
      const project = find(s.projects, role.projectId);
      need(providerOf(role) === "codex", "会话类型不匹配");
      need(typeof sessionId === "string" && /^[\w-]{8,160}$/.test(sessionId) && sessionId !== "ui", "会话编号无效");
      need(realpathSync(cwd).toLowerCase() === project.root.toLowerCase(), "会话目录与项目不一致");
      need(!role.sessionId || role.sessionId === sessionId, "角色已绑定其他会话");
      need(!s.roles.some((r) => r.id !== role.id && providerOf(r) === "codex" && r.sessionId === sessionId), "该会话已绑定其他角色");
      role.sessionId = sessionId;
      return role;
    });
  }
  claimCodexWake(wakeId, sessionId) {
    return this.store.change((s) => {
      const wake = s.wakes.find((item) => item.id === wakeId && item.sessionId === sessionId);
      const role = wake && s.roles.find((item) => item.id === wake.roleId);
      if (!role?.enabled || role.resumeWake || providerOf(role) !== "codex" || wake.state !== "pending" ||
          wake.codexAttempt || !s.notices.some((n) => n.roleId === role.id && !n.readAt)) return false;
      wake.codexAttempt = Date.now();
      return true;
    });
  }
  clearCodexWakeRejection(wakeId, sessionId) {
    return this.store.change((s) => {
      const wake = s.wakes.find((item) => item.id === wakeId && item.sessionId === sessionId);
      if (wake?.state === "pending" && s.roles.some((r) => r.id === wake.roleId && providerOf(r) === "codex"))
        delete wake.codexAttempt;
    });
  }
  patrol(s, now, liveIds = new Set(), provider = "dsh") {
    for(const task of s.tasks) {
      const status=updateOwnerSilence(s,task,now);
      if(task.ownerState==="silent"&&!task.ownerSilentNotified) {
        task.ownerSilentNotified=now;
        task.deliveryIssue={reason:"member-silent",at:now,detail:"成员空闲超过 10 分钟，原责任未收口；主控可 resumeTask 恢复"};
        const lead=controller(s,task.projectId);
        if(lead)this.notice(s,lead.id,`owner-silent:${task.id}:${task.scheduleVersion??0}`,task.deliveryIssue.detail,task.id);
      }
    }
    for (const role of s.roles) {
      if (role.archivedAt) continue;
      const project = find(s.projects, role.projectId);
      inspectRole({
        s, role, project, lead: controller(s, project.id), now,
        live: providerOf(role) === provider && liveIds.has(role.sessionId),
        notify: (...args) => this.notice(s, ...args),
      });
    }
  }
  patrolTick(now = Date.now()) {
    const state = this.store.read();
    if (state.roles.some((role) => role.enabled && now - role.connectedAt >= 15000))
      this.store.change((s) => this.patrol(s, now));
  }
  bridgeBindings() {
    const roles = this.store.read().roles.filter(role => !role.archivedAt && providerOf(role) === "dsh" && role.sessionId);
    return {
      sessions: [...new Set(roles.map(role => role.sessionId))],
      controllerSessions: [...new Set(roles.filter(role => role.enabled && isDshController(role)).map(role => role.sessionId))],
    };
  }
  heartbeat(sessions, now = Date.now(), provider = "dsh") {
    need(Array.isArray(sessions) && sessions.length <= 100, "sessions 无效");
    return this.store.change((s) => {
      for (const session of sessions) {
        const role = s.roles.find((r) => !r.archivedAt && r.enabled && providerOf(r) === provider && r.sessionId === session.id) ??
          s.roles.find((r) => !r.archivedAt && providerOf(r) === provider && r.sessionId === session.id);
        if (!role) continue;
        recordBridgeTools(role, session, (kind, data) => {
          this.store.event(kind,data);
          s.toolsRepairHistory=(s.toolsRepairHistory??[]).filter(item=>item.at>=now-7*86400000);
          s.toolsRepairHistory.push({...data,roleId:role.id});
        });
        const health = session.toolHealthCheck;
        role.toolHealthSupported = session.toolHealthSupported === true;
        if (!role.toolHealthSupported) delete role.pendingToolHealthCheck;
        if (role.pendingToolHealthCheck && health?.id === role.pendingToolHealthCheck.id && typeof health.ok === "boolean") {
          this.store.event("wake.tools-health-checked", { roleId: role.id, id: health.id, ok: health.ok });
          role.consecutiveWakeLosses = 0;
          delete role.pendingToolHealthCheck;
        }
        const idleSince = role.state === "idle" && now - role.connectedAt < 15000 && role.queueIdle && role.queueIdle.fingerprint === session.pendingInputFingerprint
          ? role.queueIdle.since : now;
        recordOwnerHeartbeat(role,session,now);
        role.bridgePresent = true;
        role.connectedAt = now;
        role.state = session.state;
        role.pending = session.pending;
        role.jobs = session.jobs;
        if (provider === "dsh" && session.pending > 0 && Array.isArray(session.pendingInputKinds) &&
            session.pendingInputKinds.length <= 3 && session.pendingInputKinds.every(kind => ["lingflow", "host", "unknown"].includes(kind))) {
          role.pendingInputKinds = [...new Set(session.pendingInputKinds)];
        } else delete role.pendingInputKinds;
        if (role.pendingInputKinds?.length && !role.pendingInputKinds.includes("unknown") &&
            validQueueFingerprint(session.pendingInputFingerprint)) role.pendingInputFingerprint = session.pendingInputFingerprint;
        else delete role.pendingInputFingerprint;
        if (role.state === "idle" && role.jobs === 0 && role.pendingInputFingerprint)
          role.queueIdle = { since: idleSince, lastAt: now, fingerprint: role.pendingInputFingerprint };
        else delete role.queueIdle;
        const queuedIds = session.pendingInputIds;
        role.canDropPendingInput = provider === "dsh" && session.canDropPendingInput === true && Boolean(role.pendingInputFingerprint) &&
          Array.isArray(queuedIds) && queuedIds.length === role.pending && new Set(queuedIds).size === queuedIds.length &&
          queuedIds.every(item => typeof item === "string" && item.length > 0 && item.length <= 200);
        if (role.canDropPendingInput) role.pendingInputIds = queuedIds;
        else delete role.pendingInputIds;
        if (role.inputDrop && role.inputDrop.sessionId !== role.sessionId) {
          this.store.event("input.drop-obsolete", { roleId: role.id, ...role.inputDrop });
          delete role.inputDrop;
        }
        if (role.queuedInputApproval && (role.queuedInputApproval.sessionId !== role.sessionId ||
            role.queuedInputApproval.fingerprint !== role.pendingInputFingerprint)) delete role.queuedInputApproval;
        if (session.pending === 0) delete role.queueDrainWakeId;
        if (role.resumeTaskAfter && now >= role.resumeTaskAfter && session.state === "idle" && session.pending === 0 && session.jobs === 0) delete role.resumeTaskAfter;
        recordObservation(role, session, now);
        const intervention = s.tasks.find(task => task.assignee === role.id && activeTaskIntervention(task))?.intervention;
        const interventionDelivery = intervention && Array.isArray(session.deliveryResults) &&
          session.deliveryResults.find(entry => entry?.wakeId === intervention.id);
        if (interventionDelivery && intervention) {
          const { state, reason, attempt } = interventionDelivery;
          intervention.delivery = { state, reason, attempt };
        }
        const wake = s.wakes.find(
          (w) => w.roleId === role.id && activeWake(w),
        );
        role.deliveryIssue = wake?.state !== "pending" ? null : Array.isArray(session.deliveryIssueWakeIds)
          ? (session.deliveryIssueWakeIds.includes(wake.id) ? "投递结果待对账；可重新开启角色续接，或在原会话读取 inbox。" : null)
          : (session.deliveryIssue ?? null);
        if (wake?.state === "pending" && Array.isArray(session.deliveryResults)) {
          const data = session.deliveryResults.slice(-30).find((item) => item?.wakeId === wake.id);
          this.trackWakeAttempts(s, wake, data);
          const deliveryStates = { uncertain: "uncertain", exhausted: "retry-limit", retry: "host-rejected" };
          const reason = data?.state === "waiting" && Object.hasOwn(deliveryLabels, data.reason) ? data.reason :
            data?.generation === wakeGeneration(wake) && Object.hasOwn(deliveryStates, data.state) ? deliveryStates[data.state] : null;
          if (reason) {
            wake.diagnostic = { reason, at: Number.isSafeInteger(data.at) ? data.at : wake.at,
              attempt: Number.isSafeInteger(data.attempt) && data.attempt >= 0 ? data.attempt : 0 };
            if (!wake.silent && ["uncertain", "retry-limit"].includes(reason)) {
              const task = s.tasks.find((item) => item.assignee === role.id && ["assigned", "rework", "reviewing"].includes(item.state));
              const lead = controller(s, role.projectId);
              if (lead && lead.id !== role.id) this.notice(s, lead.id, `delivery-blocked:${wake.id}:${wakeGeneration(wake)}:${reason}`,
                `${role.name}：${deliveryLabels[reason]}`, task?.id);
            }
          } else if (wake.diagnostic?.reason !== "retry-limit" && wake.diagnostic?.reason !== "uncertain") delete wake.diagnostic;
        }
        if (
          wake?.state === "enqueued" &&
          role.state === "idle" &&
          role.pending === 0 &&
          role.jobs === 0 && !role.pendingInputFingerprint && !turnBlocksDelivery(role.observation) &&
          handoffAge(wake, now) >= lossDeadline(wake)
        ) {
          role.deliveryIssue =
            "短卡已送达但收件箱仍未读取。可点击「续接原会话」，或在原会话读取 inbox。";
        }
      }
      const liveIds = new Set(sessions.map((session) => session.id));
      for (const role of s.roles) if (providerOf(role) === provider && role.sessionId && !liveIds.has(role.sessionId)) role.bridgePresent = false;
      this.schedule(s, now);
      this.normalizeNotices(s);
      for (const role of s.roles) if (providerOf(role) === provider) consolidateActiveWakes(s, role, now);
      recoverLostWakes(s,now,(kind,data)=>this.store.event(kind,data),(role,wake,ageMs)=>{
        const lead=controller(s,role.projectId);
        if (lead && wake.state === "failed") {
          this.notice(s, lead.id, `wake-abandoned:${wake.id}`,
            `${role.name} 的唤醒连续 ${wake.deliveryLosses} 次未读取。可执行 rearmWake ${JSON.stringify({roleId:role.id,reason:"恢复原会话未读责任"})}，或从原会话读取 inbox。`);
        } else if (lead) {
          const notice = this.notice(s, lead.id, `wake-stuck:${wake.id}:${wake.deliveryRetry}`,
            `${role.name} 的唤醒超过 ${Math.floor(ageMs / 1000)} 秒未读取，已自动安排恢复`);
          notice.wakeLossAt = wake.lostAt;
        }
      }, (role, unread) => {
        const suppressed = new Set(selectWakeNotices(s, role, unread).suppressedNotices
          .filter(notice => notice.reason === "no-member-responsibility").map(notice => notice.id));
        return unread.filter(notice => !suppressed.has(notice.id));
      }, role => providerOf(role) === provider && liveIds.has(role.sessionId) && role.jobs === 0 &&
        !wakeRecipientBusy(role, now) &&
        !role.pendingToolHealthCheck && dispatchAvailability(role, now, true) === null,
      (role, unread) => selectWakeNotices(s, role, unread, { ignoreFailed: true }).notices);
      this.patrol(s, now, liveIds, provider);
      const deliveries = [];
      const blockedReasons=new Map();
      for (const role of s.roles) {
        if(providerOf(role)!==provider)continue;
        if (role.inputDrop && role.enabled && liveIds.has(role.sessionId)) {
          deliveries.push({ id: role.inputDrop.id, sessionId: role.sessionId, dropPendingInput: true,
            queuedInputFingerprint: role.inputDrop.fingerprint });
          blockedReasons.set(role.id, "queued-input");
          continue;
        }
        const intervened = s.tasks.find(task => task.assignee === role.id && activeTaskIntervention(task));
        if (intervened) {
          const delivery = liveIds.has(role.sessionId) && this.interventionDelivery(intervened, role, now);
          if (delivery) deliveries.push(delivery);
          if (delivery || intervened.intervention.mode === "stop") {
            blockedReasons.set(role.id, "task-intervention");
            continue;
          }
        }
        const protectedController = isDshController(role);
        const controllerTurn = protectedController ? role.observation?.turn : null;
        const queueFingerprint = queueFingerprintForDelivery(role);
        const blocked=role.pendingToolHealthCheck?'bridge-health-check':bridgeToolsBlocker(role)?'bridge-tools-missing':!role.enabled?'role-disabled':
          !liveIds.has(role.sessionId)||now-role.connectedAt>=15000?'role-offline':
          turnBlocksDelivery(role.observation)?(protectedController?'controller-turn':'role-running'):role.state!=='idle'?'role-running':
          role.pending!==0&&!queueFingerprint?'queued-input':!Number.isSafeInteger(role.jobs)||role.jobs<0?'jobs-unknown':role.jobs>0?'background-jobs':null;
        if (blocked) {
          blockedReasons.set(role.id, blocked);
          if (role.enabled && liveIds.has(role.sessionId) && wakeRecipientBusy(role, now)) {
            const unread = s.notices.filter(notice => notice.roleId === role.id && !notice.readAt);
            const selection = selectWakeNotices(s, role, unread);
            if (selection.actionable) {
              const queued = selection.notices.filter(notice => !notice.silent);
              const relevant = item => item.roleId === role.id && item.sessionId === role.sessionId && !item.silent && !item.queueDrainOnly;
              const wake = s.wakes.find(item => relevant(item) && activeWake(item)) ??
                s.wakes.findLast(item => relevant(item) && item.state === "consumed");
              if (wake && mergeWakeNotices(wake, queued, now, { defer: true }).length && wake.state === "consumed")
                wake.deferredAt = now;
            }
          }
          continue;
        }
        if (role.resumeWake) {
          // Replace transport only after an idle heartbeat confirms the inbox
          // is empty or the relay can safely wake its pending inputs.
          // The persisted task and unread business events keep their identities.
          for (const old of s.wakes)
            if (old.roleId === role.id && old.state === "enqueued") {
              consumeWake(old,now,'session-resumed');
            }
          delete role.resumeWake;
          delete role.deliveryIssue;
        }
        const unread = s.notices.filter(
          (n) => n.roleId === role.id && !n.readAt,
        );
        const selection = selectWakeNotices(s, role, unread);
        const silent = !selection.actionable;
        if (silent && queueFingerprint) {
          let drain = s.wakes.find(wake => wake.id === role.queueDrainWakeId);
          if (!drain || drain.queuedInputFingerprint !== queueFingerprint) {
            for (const old of s.wakes) if (old.roleId === role.id && activeWake(old))
              consumeWake(old, now, "queue-drain-replaces-inactive-responsibility");
            const text = ["LingFlow · 恢复原会话的排队输入", role.kind === "controller" && CONTROLLER_WAKE_BOUNDARY,
              "先处理已排队的输入。用 lingflow_team 的 inbox 核对当前责任，无事即结束本轮。"].filter(Boolean).join("\n\n");
            const contextIncluded = provider !== "dsh" && !hasCurrentContext(role);
            drain = { id: id(), roleId: role.id, sessionId: role.sessionId, state: "pending", noticeIds: [], at: now,
              queueDrainOnly: true, queuedInputFingerprint: queueFingerprint,
              contextIncluded, contextRevision: contextRevision(role),
              text: contextIncluded ? wakeText(find(s.projects, role.projectId), role, false, text) : text };
            role.queueDrainWakeId = drain.id;
            s.wakes.push(drain);
          }
          if (drain.state === "pending") deliveries.push({ ...drain });
          continue;
        }
        if (!unread.length) continue;
        let wake = s.wakes.find((w) => w.roleId === role.id && activeWake(w) && !w.queueDrainOnly);
        const eligible = selection.notices.filter(notice => silent ? notice.silent && !notice.silentCoalescedAt : !notice.silent);
        if (silent && wake && !wake.silent) {
          if (wake.state !== 'pending') continue;
          consumeWake(wake, now, 'non-actionable-only');
          wake = undefined;
        }
        if (!eligible.length) {
          for (const old of s.wakes) if (old.roleId === role.id && old.state === "pending") {
            consumeWake(old,now,'non-actionable-only');
          }
          continue;
        }
        const previousQuietWake = silent && !wake && s.wakes.findLast(item => item.silent && item.projectId === role.projectId);
        if (previousQuietWake && eligible.some(notice => notice.at <= previousQuietWake.at + wakeCoalesceMs(this.execution))) {
          for (const notice of unread) if (isSilentNotice(role, notice) && notice.at <= previousQuietWake.at + wakeCoalesceMs(this.execution)) notice.silentCoalescedAt ??= now;
          continue;
        }
        const accumulatedDuringTurn = controllerTurn?.endedAt && eligible.some(notice => notice.at <= controllerTurn.endedAt);
        if (!accumulatedDuringTurn && wakeDelay(eligible, role, now, this.execution) > 0) {
          blockedReasons.set(role.id, 'coalescing-window');
          continue;
        }
        if (!silent && wake?.silent) {
          consumeWake(wake, now, 'responsibility-ready');
          wake = undefined;
        }
        if (!silent && !wake) {
          wake = s.wakes.findLast(item => item.roleId === role.id && item.sessionId === role.sessionId &&
            item.state === "consumed" && item.deferredAt && eligible.some(notice => item.noticeIds.includes(notice.id)));
          if (wake) {
            delete wake.deferredAt;
            delete wake.consumedAt;
            delete wake.supersededAt;
            delete wake.closeReason;
            delete wake.lostAt;
            wake.deliveryLosses = 0;
            delete wake.autoRearmedAt;
            requeueWake(wake, now, "deferred-notices");
          }
        }
        for (const drain of s.wakes) if (drain.roleId === role.id && drain.queueDrainOnly && activeWake(drain)) {
          consumeWake(drain, now, "business-wake-replaces-drain");
          if (role.queueDrainWakeId === drain.id) delete role.queueDrainWakeId;
        }
        if (!wake) {
          wake = {
            id: id(),
            roleId: role.id,
            sessionId: role.sessionId,
            state: "pending",
            noticeIds: eligible.map((n) => n.id),
            at: now,
            actionable: !silent,
            ...(silent && { projectId: role.projectId, silent: true }),
          };
          s.wakes.push(wake);
        }
        normalizeWake(wake,now);
        const recoverQueued = queueFingerprint && wake.state === "enqueued" && !wake.queuedInputFingerprint && !wake.queueRecoveryFingerprint;
        mergeWakeNotices(wake,eligible,now);
        if (recoverQueued && wake.state === "enqueued") {
          requeueWake(wake, now, "idle-queued-input");
          wake.queueRecoveryFingerprint = queueFingerprint;
        }
        if (wake.state === "pending") {
          if (wake.text && wake.payloadGeneration === wakeGeneration(wake) && (wake.queuedInputFingerprint ?? null) !== queueFingerprint)
            requeueWake(wake, now, "queued-input-changed");
          if (protectedController) {
            const turnId = controllerTurn?.id ?? null;
            if (wake.text && wake.payloadGeneration === wakeGeneration(wake) && wake.controllerTurnId !== turnId)
              requeueWake(wake, now, "turn-boundary-changed");
            wake.controllerTurnId = turnId;
          }
          if (queueFingerprint) wake.queuedInputFingerprint = queueFingerprint;
          else delete wake.queuedInputFingerprint;
          if (wake.text && wake.payloadGeneration === wakeGeneration(wake)) {
            deliveries.push({ ...wake });
            continue;
          }
          if (silent) {
            wake.contextIncluded = false;
            wake.text = ['LingFlow · 静默续接', role.kind === "controller" && CONTROLLER_WAKE_BOUNDARY,
              provider === "dsh" ? "角色已开启 · 本轮无责任，无需核对收件箱。" :
                wakeSummary(eligible, s.tasks, s.checkJobs, s.roles) + '\n\n无需回报「没有任务」。'].filter(Boolean).join("\n\n");
            wake.payloadGeneration = wakeGeneration(wake);
            Object.assign(wake, promptMetrics(wake.text, false, role.toolsVersion));
            deliveries.push({ ...wake });
            continue;
          }
          wake.contextRevision = contextRevision(role);
          wake.contextIncluded = provider !== "dsh" && !hasCurrentContext(role);
          const project = find(s.projects, role.projectId);
          if (provider === "dsh") {
            wake.text = dshWakeText(project, role, dshWakeSummary(eligible, s.tasks, s.checkJobs, s.roles, s.messages));
          } else {
            const taskIds=[...new Set(eligible.map(notice=>notice.taskId).filter(Boolean))].sort();
            const reportIds=taskIds.filter(taskId=>eligible.some(notice=>notice.taskId===taskId&&/^report(?:-blocked)?:/.test(notice.key)));
            const summary = [`actionable: true | notices: ${eligible.length} | actionableCount: ${eligible.filter(notice=>notice.actionable).length}`,
              ...reportIds.map(taskId=>{const task=find(s.tasks,taskId);return `${task.ticketKey??task.id.slice(0,8)} · taskId=${task.id} · candidate=${task.candidate?.slice(0,12)??'待生成'}`;}),
              "动态详情",wakeSummary(eligible,s.tasks,s.checkJobs,s.roles),"任务索引",...taskIds.filter(taskId=>!reportIds.includes(taskId)).map(taskId=>{
                const task=find(s.tasks,taskId);return `${task.ticketKey??task.id} · ${task.title}`;
              })].join("\n");
            wake.text = wakeText(project, role,
              role.kind === "controller" && controller(s, role.projectId)?.id === role.id, summary, s);
          }
          wake.payloadGeneration=wakeGeneration(wake);
          Object.assign(wake,promptMetrics(wake.text,wake.contextIncluded,role.toolsVersion));
          deliveries.push({ ...wake });
        }
      }
      for(const role of s.roles.filter(role=>providerOf(role)===provider&&!role.archivedAt)) {
        const selection=selectWakeNotices(s,role,s.notices.filter(notice=>notice.roleId===role.id&&!notice.readAt));
        auditWakeCoverage(s,role,selection,blockedReasons.get(role.id),now,(kind,data)=>this.store.event(kind,data));
      }
      return { deliveries, toolHealthChecks: s.roles.filter(role => role.enabled && providerOf(role) === provider &&
        liveIds.has(role.sessionId) && role.pendingToolHealthCheck).map(role => ({ sessionId: role.sessionId, ...role.pendingToolHealthCheck })) };
    });
  }
  validWake(wakeId, sessionId, generation) {
    const s = this.store.read(),
      wake = s.wakes.find((w) => w.id === wakeId);
    if (!wake) {
      const task = s.tasks.find(item => item.intervention?.id === wakeId);
      if (task) {
        const member = s.roles.find(item => item.id === task.assignee);
        return { valid: Boolean(member?.sessionId === sessionId && (generation ?? 0) === 0 &&
          this.interventionDelivery(task, member, Date.now())) };
      }
      const role = s.roles.find(item => item.inputDrop?.id === wakeId);
      return { valid: Boolean(role?.enabled && role.sessionId === sessionId && role.inputDrop.sessionId === sessionId &&
          connected(role) && role.state === "idle" && role.jobs === 0) };
    }
    const role = find(s.roles, wake.roleId);
    const unread = s.notices.filter(n => n.roleId === role.id && !n.readAt);
    const selection = selectWakeNotices(s, role, unread.filter(n => (wake.payloadNoticeIds ?? wake.noticeIds).includes(n.id)));
    return {
      valid:
        wake.sessionId === sessionId && role.sessionId === sessionId &&
        role.enabled && connected(role) && !role.resumeWake && !role.inputDrop && !bridgeToolsBlocker(role) &&
        !turnBlocksDelivery(role.observation) &&
        !s.tasks.some(task => task.assignee === role.id && activeTaskIntervention(task)?.mode === "stop") &&
        (!isDshController(role) || role.state === "idle" && role.pending === 0 && role.jobs === 0 &&
          !role.pendingToolHealthCheck && !wake.queuedInputFingerprint &&
          wake.controllerTurnId === (role.observation?.turn?.id ?? null)) &&
        (!wake.queuedInputFingerprint || role.state === "idle" && role.jobs === 0 && !role.pendingToolHealthCheck &&
          queueFingerprintForDelivery(role) === wake.queuedInputFingerprint) &&
        wake.state === "pending" &&
        (generation ?? 0) === wakeGeneration(wake) &&
        (wake.queueDrainOnly === true && role.queueDrainWakeId === wake.id && !selectWakeNotices(s, role, unread).actionable ||
          selection.actionable || wake.silent === true && selection.notices.some(notice => notice.silent && !notice.silentCoalescedAt) &&
          !selectWakeNotices(s, role, unread).actionable),
    };
  }
  acknowledge(wakeId, sessionId, provider = "dsh", delivery) {
    return this.store.change((s) => {
      const task = s.tasks.find(item => item.intervention?.id === wakeId);
      if (task) {
        const request = activeTaskIntervention(task);
        const member = s.roles.find(item => item.id === task.assignee);
        if (request?.state !== "requested" || request.sessionId !== sessionId || member?.sessionId !== sessionId ||
            provider !== "dsh" || (delivery?.generation ?? 0) !== 0) return { state: "obsolete" };
        if (!request.admittedAt) {
          request.admittedAt = Date.now();
          this.store.event("task.intervention-delivered", { taskId: task.id, requestId: request.id, sessionId });
        }
        return { state: "stored" };
      }
      const dropRole = s.roles.find(role => role.inputDrop?.id === wakeId);
      if (dropRole) {
        const drop = dropRole.inputDrop;
        const receipt = delivery?.inputDrop;
        need(provider === "dsh" && drop.sessionId === sessionId && dropRole.sessionId === sessionId &&
          ["dropped", "queue-changed", "partial"].includes(receipt?.state) &&
          Array.isArray(receipt.ids) && receipt.ids.length <= drop.count && new Set(receipt.ids).size === receipt.ids.length &&
          receipt.ids.every(item => drop.requestedIds.includes(item)) &&
          (receipt.state !== "dropped" || receipt.ids.length === drop.count), "取消排队输入的回执不匹配");
        dropRole.lastInputDrop = { ...drop, state: receipt.state, ids: receipt.ids, completedAt: Date.now() };
        delete dropRole.inputDrop;
        this.store.event("input.drop-completed", { roleId: dropRole.id, ...dropRole.lastInputDrop });
        return { state: receipt.state };
      }
      const wake = s.wakes.find((w) => w.id === wakeId);
      if (!wake || !activeWake(wake)) return { state: "obsolete" };
      need(providerOf(find(s.roles, wake.roleId)) === provider, "会话类型不匹配");
      need(wake.sessionId === sessionId, "回执会话不匹配");
      if((delivery?.generation??0)!==wakeGeneration(wake))return {state:'obsolete',reason:'stale-generation'};
      need(!bridgeToolsBlocker(find(s.roles, wake.roleId)), "bridge-tools-missing：成员工具未恢复，不能确认送达");
      const payload = wake.payloadNoticeIds ?? wake.noticeIds;
      if (wake.state === "pending") {
        this.trackWakeAttempts(s, wake, delivery);
        const recipient = find(s.roles, wake.roleId);
        if (wake.contextIncluded && wake.contextRevision === contextRevision(recipient)) markContextSeen(recipient);
        wake.state = "enqueued";
        wake.admittedAt = Date.now();
        wake.handedOffAt=wake.admittedAt;
        countDeliveryAttempts(wake,delivery?.attempt??1);
        delete wake.lostAt;
        recordPromptAdmission(s,wake,wake.admittedAt);
        delete wake.diagnostic;
        this.logWakeDelivery(s, wake, "delivered", Number.isSafeInteger(delivery?.attempt) && delivery.attempt >= 1 ? delivery.attempt : 1, wake.admittedAt);
        if (wake.queueDrainOnly) consumeWake(wake, Date.now(), "queued-input-woken");
        if (wake.silent) {
          for (const notice of s.notices) if (payload.includes(notice.id)) notice.silentCoalescedAt = wake.admittedAt;
          consumeWake(wake, wake.admittedAt, 'silent-resume-delivered');
        }
      }
      for (const notice of s.notices.filter((n) =>
        payload.includes(n.id),
      ))
        this.recordDelivery(s, notice, wake.roleId, Date.now());
      return { state: "stored" };
    });
  }
}

export const GUIDE = `LingFlow 仅快速模式。主控沟通、派单、处理例外和汇总。high 自动派独立审查，low/medium 实施票需要主控独立验证。开发、审查分别核对需求、实现和直接系统影响。业务验收来自用户；主控可以记录用户对当前候选的实际试用结论。写命令必须带稳定 operationId。关闭角色只停止新投递。
${CONTROLLER_TURN_RULE}
三条硬规则：red 与 regression 回执不能作为 AC 验收证据。after 只填确需等待的 verified 或 accepted 门槛；只依赖当前已入库代码时记录提交 SHA、声明实际 reads。端口、数据库等互斥用 resources。
派单与插票
- spec 记录用户确认的行为、边界与可观察验收。tickets 写 AC、真实读写、风险理由、共享资源和必要前置。planned-attempts 只记本轮需要主控决定的跨票顺序、共享边界或停手条件；无此事项填「本轮无额外跨票协调。」即可。程序按票上的依赖、读写、资源和成员责任实时准入。
- 开发接票后决定票内实现路线，在 testWrites 内设计夹具、断言和边界反例。常规票直接推进；复杂票有技术取舍时用 progress 在原票简记复用点、验证入口和停手条件。边界变化先沿原票交主控裁决。
- 对票面用 schema {command:"dispatchPlan",requirementId,spec,ticketsDir,attempts}；同目录有旧票时改传 tickets:[本轮票面路径]。优先推荐当前可接票的开发，developerIds 显式指定优先。state=valid 已完成预检，可直接提交 args。shared-resource-missing 或 dependency-shared-resource 是提示：核对共用端口／资源名，真实前置继续用 after，互斥用 resources。程序不改依赖或资源。
- 须预先锁定的检查可继续用 lingflow-checks。从代码中才能确定开发检查时，在 lingflow-contract 选择 developerChecks:true，派发先冻结全部 AC、testWrites、关键读写和资源；免审票仍由主控在 lingflow-checks 冻结独立探针。开发须在首次取红前用 registerChecks 冻结检查配方。requiresInput 向成员核实事实。
- 未冻结的草稿可直接修改。已经派发后，新需求只写差异 spec 和新票，在 planned-attempts 末尾追加以「## 本轮插入」开头的小节。新票 X 无真实前置时显式 after:[]。要让仍在 queued 的 B 等 X，用 insertSchedule 整体替换 B 的 after，保留仍必要的旧前置。保留冻结规格和票面。与在飞票的实际冲突由 LingFlow 按读写和资源判定。必须调整在途票时，先由责任成员停写并 yieldForSchedule，再沿原票处理；验收行为变化用后继票承接。
参数表（args 是 JSON 对象字符串，也可直接传 JSON 对象；身份来自真实会话，不得自行填写）：
${writeSignatures}
summarize 完整形状示例（用原票实际候选、全部AC与真实核对证据替换示例值）：${JSON.stringify(summarizeExample)}
list {}：角色和任务短卡，已批准需求。assigned 表示已分配；deliveryState=delivered 和 deliveredAt 表示宿主已接收或成员已读取原通知。是否已启动看成员实时 state。
唤醒健康：list/snapshot 的角色卡和任务卡含 wakeHealth={stuck,oldestStuckAgeMs,lastDeliveredAt}。enqueued 表示宿主接收，原会话读取 inbox 或确认工作后收口。忙碌期间合并新通知，保留已发内容与回执身份，等空闲再发更新。未读按 120、240、480 秒核对。第三次未读时记录 wake.abandoned，并请求 DSH 复核工具注册。投递诊断可在收件箱查阅。工具可用且心跳确认空闲时允许自动续接一次，也可由主控执行 rearmWake {roleId,reason} 或从面板恢复。未覆盖的通知会记录 wake.suppressed，含 blockingWakeId 和原因。
inbox {}：返回本角色全部未读通知，不限于某条 wake.noticeIds；返回后写 readAt，并关闭本角色仍开放的唤醒。开发或审查成员读取本人的当前责任票，或成功执行该票的检查、进度、报告等操作时，会单独确认这条责任通知，停止为它重投；答复和消息仍可在 inbox 读取。notice.actionable 始终为布尔值；纯状态通知仍不单独唤醒主控。
redeliver {taskId,reason?}：主控可重投已送达但成员静默的 assigned/rework 原票，沿 resumeTask 正常准入；真正运行、有排队输入或后台作业时仍拒绝。也可重试宿主明确拒绝且耗尽重试的待投递。其他情况报 no-pending-delivery 并给出后续动作。
context {}：当前项目目录、角色、职责和已保存的身份提示词。每次开启角色或资料更新后，inbox 也会提供一次。
inspect {taskId,section?,offset?,limit?}：默认只回状态、验收条款、检查摘要和最近报告。完整票面显式 section:"full"；baseline.other、全量 checkJobs、reports、reviews、scheduleHistory、acceptance 显式按 section 分页，offset 非负、limit 为 1–200。默认上限190KB；返回 truncated、scanned、totalBytes 与 omitted 查询入口，完整证据保留本地。
deliveryEvidence {taskId,candidate?,file?}：查候选可复用检查、命令、覆盖、断言标记及日志入口。file 打开交付清单中单个文件的实际差异。存在 deliveryCommit 时，差异和 historicalEvidence 对应已验证的原交付提交。索引不替代独立审查或主控短探针。
diagnoseTask {taskId,supersedeConflict?}：核对当前门槛，返回分类、原因及后续命令。写集冲突可按依赖顺序执行，共享资源冲突等待对端释放。仅当主控已确认两个写集冲突无法调和且有有效承接票时，在承接票诊断中传 supersedeConflict:原票ID，核对承接命令和在途文件数量。inspect / diagnoseTask 提供 elapsedSinceDeliveryMs、elapsedSinceLastCheckMs（无检查时为 null）、blockedOnContractMs（从首次观察到阻塞累计）。检查准入或诊断发现新提交时，按原票及 from/to 记一条主控信息通知，随下次行动唤醒合发，不推断提交者。
describeDrift {taskId}：只读核对 from/to、committedBetween（提交差异路径）和 conflicts。成员不要在冻结票在途时自行 commit；看到 baseline-drift-blocked 时保留当前文件，用 report {taskId,outcome:"blocked",summary,blocker,dimensions} 交主控处理。
同文件部分提交仅支持已验收票与同项目已停写票之间互不重叠的普通文本 hunk。按用户 Git 授权选择已验收票的 hunk 暂存，主控执行 describeDrift {taskId,partitionPeerTaskId} 核对暂存区能否完整重建验收候选。核对通过后正常提交暂存区，再用 confirmCommit {taskId,expectedBase,expectedHead,paths,partition:{peerTaskId,proof},reason} 记账，保留对方的未暂存改动及冻结证据。proof、paths、expectedBase 从预检回执复制，expectedHead 为实际提交。
proposeOwnedDirty {taskId,files:[{file,sha256}],reason?}：责任开发提报写集内现存未跟踪或修改文件的原始字节 SHA-256，不自动取得归属。主控在原票可调整状态下用 reviseSchedule {taskId,reason,confirmOwnedDirty:{"路径":"sha256"}} 精确确认，或 rejectOwnedDirty:true 拒绝。文件变化须重新提报。
governance {projectId?,limit?:50}：只读扫描本项目最近最多50个提交；未 summarize 的原票写集被提交时返回 commit、ticketKey、files、at，以及 released-work-committed / in-flight-work-committed。这是范围和生命周期风险审计，不根据 Git 作者名认定提交者身份。
rework {taskId,reason,evidence?:[checkId]}：将证据待办清单回投原票 developerId。evidence 只允许冻结的非 independent/controller 检查；成员 inbox 逐项列出检查与上次分类、原因。指定检查必须在本次返工取得新有效回执才清空；其它仍有效的检查不强制重跑。diagnoseTask.nextAction 的 ownerRole/ownerId 指定实际责任人；ownerRole=developer 时主控使用 returnToOwner 回投，不能自行运行 check 或 shell。
reconcileCheck {jobId,evidence}：用户工作台或本项目主控可对账 state=uncertain 的作业。evidence 必须写明已确认旧作业退出、资源可安全复用的实际依据；标记 interrupted，保留旧回执，不当作 passed。主控回执带 reconciledBy=controller 和 reconciledById。之后责任开发成员可 yieldForSchedule，再沿正常范围释放或返工路径处理；无需主控接手开发。
resumeTask {taskId,reason}：主控恢复会话异常的 assigned/rework/paused 原票。先在宿主恢复会话；成员仍运行、有排队输入、未知或未完作业时拒绝。保留原基线、报告、候选和检查历史，等待新空闲心跳后正常准入及重新投递。不能用该命令绕过归属或验收；原 operationId 重试只取同一回执。
scopePreview {taskId?,writes,reads?,readOnly?,contextReads?,resources?}：主控在派发或调整前查看与活动票的冲突。reads 要包含实际检查输入；列出对方原票、冲突方向及路径或资源。
inspectPlan {planId,document?,taskId?}：指定票面相对路径可查看派发正文 text、当前摘要及差异。需要保留 BOM 时用 restoreText。diff 相对派发正文，ticketSource.status 相对当前门禁期望。已派票按冻结 AC 和检查执行。误改时从派发正文恢复，再执行 diagnoseTask；保留当前文档时，按诊断使用 reviseSchedule 的 refreshSourceDigest，以当前摘要做字节对账。需要修改 AC 或检查契约时派发后继票。
spec 与 planned attempts 可在执行期间更新。主控在 spec 顶部维护 Version: vN，在「## 变更记录」填写日期、版本、说明、影响 AC、影响在飞票。report 和 diagnoseTask 回传版本与摘要差异。命中冻结 AC 或票号时，主控选择沿用原契约、追加票或作废重派。禁止直接编辑在飞票面。停写后用 reviseSchedule 修改调度字段，变更 AC 则使用独立的新票面。
schema {command:"previewPlan|dispatchPlan|supersede|releaseSchedule|insertSchedule|registerChecks"}：查看契约。schema {command:"dispatchPlan",requirementId,spec,ticketsDir 或 tickets,attempts,developerIds?} 只读生成经预检的 args、分配和检查摘要；可原样 dispatchPlan。票面 developerChecks:true 的票在返回检查摘要标记 developerChecksPending。
cacheDiagnostics {roleId,last24h?}：只读查看本项目成员最近24小时已确认送达次数、平均 promptBytes、contextFullCount、工具修复次数和 toolsVersion；不是供应商实际缓存命中率。
buildCache {projectId}：只读查看最近 4 条前置构建缓存（cacheKey、builtAt、产物 bytes、lastHitAt）及 hits、misses、savedMs。缓存只跳过前置步骤，检查仍执行，旧证据仍校验产物指纹；checkStatus / checkEvidence 的 receipt.preparation 记录 cached 与 savedMs。
静默 resume（silent:true、actionable:false）按项目合并，不属于待办。无需查看 inbox 或回报「没有任务」；如无异常直接结束本轮。真实派审、开放责任和问答单独投递。
abandonTask {taskId,reason}：主控可终止已证明停写的未投递 queued 票、无排队输入和后台作业的 paused 票，或无责任成员的 trial 票。票须无未完检查，终止会释放范围并保留全部证据及审计。
收口顺序：成员交付 → 主控独立探针或高风险独立审查 → summarize → 最后按用户已有 Git 授权提交。若必须先提交：已交付候选内容完全等价时，由主控 confirmCommit {taskId,expectedBase,expectedHead,paths,reason} 显式确认；保留候选、报告、检查、当前阶段及已满足的依赖。不能证明等价时沿 diagnoseTask 的 rework→rebindCommittedWork 路径，重跑原绿、完整及适用独立检查。上述命令都不替用户执行 Git 提交、回滚或历史改写。不能仅凭 Git 作者名判断是主控还是成员提交。
主控上下文含「当前状态」块，压缩后以该块为准，不要为确认 HEAD、在途票 taskId、检查通过数而重新逐票 inspect。
previewPlan：同一份参数预检，不派发、不冻结。返回 state、violations（path/expected/remedy）和范围派生；无论预检通过与否都不承诺在线。支持 sources.ticketsDir 或 sources.tickets 文件数组。sources 示例：{"spec":"spec.md","tickets":"tickets.md","attempts":"attempts.md"}；票面文件的 lingflow-contract JSON 围栏可冻结必改文件、必改测试与 AC；预检和派发共同核对，未采用围栏的旧规划兼容。
approve {text,source}：仅 DSH 主控。登记用户已授权执行的目标和可观察验收条件。source 为用户确认的对话摘录或引用。仅讨论和未确认草稿不登记；沿用已有需求 ID。
dispatch {requirementId,developerId,title,description,risk,readOnly:true,writes:[],reads,resources,dependencies:[任务ID]}：派给开发成员的纯只读调查。独立审查由高风险票交付后自动派发，沿用冻结候选及证据。
dispatchPlan {requirementId,sources:{spec,tickets,attempts},tickets:[{key,developerId,title,description,brief?,boundaries?,stopConditions?,risk,riskReason?,readOnly?,writes,reads,resources,ownedDirty?,after:[{ticket或taskId,stage:"verified|accepted"}],verification}],batches?}：仅 DSH 主控。来源为项目相对文件。一次登记可前向引用的计划图。实施票的 verification={acceptance:[{id,text}],testWrites:[测试文件],checks:[{id,stage:"red|green|full|regression|independent|controller",argv:[程序,参数...],inputs:[相对路径],covers:[AC编号],expectedExit?,expectedOutput?,timeoutMs?}]}。红绿同命令及输入，红阶段声明真实失败标记。evidenceKind 按 argv 推断：test 要求真实用例/断言；probe 红证据要求预期非零退出码、expectedOutput 和本进程 Error 错误栈（含 at）或 AssertionError，不强制 AssertionError 文案；compile 的 TS/SyntaxError 属于代码错误。failed-before-tests 的两秒规则仅用于 test；启动、缺依赖、信号和超时均不得作为红证据。full 的 covers 并集覆盖全部 AC。regression 是开发回归门，covers=[]，不能替代 AC 证据；主控探针最多 60000ms。免审实施票至少一项 independent。确有必要时冻结 controller 收口探针。检查输入也参加并发冲突判断。共享数据库、端口及环境写进 resources。
允许票根 browserE2E，预检报告归并；Hive 票面可派生具名用例。快速模式默认零条浏览器 E2E。仅浏览器能证明关键 AC 时，在 verification.browserE2E 填 [{file:"e2e/feature.spec.ts",title:"关键行为",reason:"为何无法以 API 或组件测试证明",covers:["AC1"]}]。检查由开发执行，每条至少绑定一个 full 检查，inputs 包含该文件且 covers 包含相应 AC。argv 示例：${JSON.stringify(browserCheckArgv({ file: "e2e/feature.spec.ts", title: "关键行为" }))}。证据型浏览器命令绑定一个文件和字面标题；整文件或整套用 regression。主控和累计检查不能代跑，审查核对断言和实测。
batches:[{key,tickets:[票编号],argv,inputs,resources,covers:[{ticket,acceptance:[AC编号]}],timeoutMs?,expectedOutput?}]：不同票确需同一次累计验证且候选能同时稳定时使用。成员票先过各自门槛，然后程序跑一次累计检查，通过才共同放行。retryBatch {batchId,reason} 对账后重跑。现场冲突可用 reviseBatch {batchId,reason,groups:[同样的批次定义]} 重新分组，保留全部原验收条款及历史。
unblock {taskId,reason}：主控按诊断沿原票预演并执行一项恢复。recovery.executable 表示在同状态副本上实际命令通过；确认提交归属的动作返回 confirmation-required，请核对后执行所列命令。
accept {taskId,evidence}：工作台或本项目主控在 trial 票上记录实际用户试用结论；候选、审查与检查仍须有效，回执保留 acceptedBy。
recordSourceAppend {taskId,file,summary}：记录冻结原文后可证明的行边界追加。已派票以冻结文档和 AC 为准，外部文档后续修改单独记审计。
Git 对账：同分支快进若未触及冻结读写与检查输入，或可证明提交字节与已交付候选等价，会记录安全前移。候选内容变化需按新候选重新验证。已入库且干净的票外脏文件从归属基线移除并保留审计。冻结路径被暂存、切换分支或提交影响冻结输入时仍须处理。expectedBase/expectedHead 接受至少 7 位十六进制 SHA 前缀。
rebindCommittedWork {taskId,expectedBase,expectedHead,confirmPaths,confirmRecordedBaseline?,reason}：仅主控。写集内提交默认阻断；用 diagnoseTask 核对，开发先停写交回。主控确认提交归属后可沿原票重绑。同分支快进、原写集可证明、冻结路径干净且无未完检查才允许。原票继续采用派发时的 AC 和检查。spec 与 planned attempts 的追加、改写和提交记录到来源审计，可随原票续接。诊断要求 confirmRecordedBaseline 时使用回执中的冻结来源路径及指纹。保留匹配的历史红证据，绿、完整检查及验收按新基线执行。不操作 Git 历史。
重绑回执给出 redBaselineRebound、redBaselineHead 和 redBaselineReason。新提交实现等价时续接红基线。需要重跑时，按回执恢复原取红实现，运行真实红，再恢复已核对实现跑绿和完整检查。主控可用 reviseSchedule {taskId,refreshBaseline:true,expectedHead,redBaselineHead,reason} 选定当前 HEAD 或其祖先作为取红依据。
仅取红基线错位时，主控用 reviseSchedule {taskId,realignRedBaseline:true,expectedHead,redBaselineHead,reason} 单独续接。在途检查须先完成或对账。候选、已通过检查和调度版本继续保留。红检查退出码 0 时，先按 diagnoseTask 核对未实现的取红提交及用例选择。
票外归属以当前文件 SHA-256 对账。diagnoseTask 给出候选责任票、当前状态能否确认和可用命令。开发中的票可在检查结束后由主控确认，文件字节变化后重新诊断和核对。
refreshBaseline 按冻结的 fingerprintEol 对照工作区和提交中的实现内容。normalize 接受仅 CRLF/LF 的差异，raw 要求原始字节一致。修复失效基线后按 nextAction 重跑红检查；再次核对相同实现会保留有效的红回执。
归属扫描默认忽略未跟踪的 .scratch/、logs/、**/dist.bak-*/；需要核对此类路径时，在票的 writes 或 sources 中显式声明。项目显式配置 ownershipIgnores 数组时整体替换默认规则，不追加；已跟踪文件不受此过滤影响。
interveneTask {taskId,mode:"guide"|"stop",reason}：主控向当前责任开发发按票纠偏或停写指令。成员运行中在下一执行步骤收到；stop 立即阻拦新检查和旧口径交付。成员核对当前请求后执行 ackTaskIntervention {taskId,requestId,reason}。停写回执登记后，现有检查可独立收口，全部结束后自动暂停原票。
resolveTaskIntervention {taskId,requestId,decision:"retry"|"withdraw"|"confirm-stopped",reason,evidence?}：主控重投或撤回未确认的请求，或凭实际证据确认失联成员的原会话及写入进程已停止。仍有检查时沿 diagnoseTask 对账。停写后可调整、释放原票或登记后继票。
yieldForSchedule {taskId,reason}：责任人停写并结束本票后台检查后交回调度。有 stop 请求时可先登记停写，检查随后独立收口。reviseSchedule {taskId,reason,writes?,reads?,resources?,ownedDirty?,after?:[{taskId,stage}],refreshBaseline?}：主控调整未开工或已交回的原票。调度变更留历史，发现实际写入和原票不一致时先停写。只有核实 Git 状态和已有改动归属后才 refreshBaseline。同分支安全前移且执行范围不变时，原检查仍按输入指纹和日志复核，不必仅因 HEAD 改变而重跑。
纯扩写集：正在执行或实时空闲的原责任成员可沿原票新增干净的已跟踪文件。只传 taskId、reason、writes 并保留全部旧路径；有在途检查、归属冲突或取红快照无法证明时先停写对账。实际失效的证据见 invalidatedChecks。缩窄范围或改变其他字段需按原流程停写。
confirmForeignDirty {taskId,expectedHead,reason,confirmForeignDirty:{路径:{taskId,sha256}}}：由主控核对票外文件的当前字节。有已知责任票时填其 ID；确无活动写入责任时可填 null。原分支、冻结输入、暂存区和 SHA-256 仍按实际快照核对。
票外指纹清理：主控可对持有冻结基线的排队、暂停、试用或执行中票单独执行 reviseSchedule {taskId,pruneOutside:true,reason}。若满足刷新条件，可与 refreshBaseline 一起执行。prunedOutside 列出已核实收口的文件，空列表附 pruneOutsideReason。审计事件为 baseline-other-pruned。
队列投递恢复：已开启的原绑定 DSH 会话持续空闲且无作业时，可识别的排队输入会随原票唤醒。想立即续接，执行 redeliver 返回的 unblock 参数。确认误投后，可执行 dropAction 指定的 dropPendingInput {roleId,expectedQueueFingerprint,reason}，在 list 查 lastInputDrop。
规划版本：新 dispatchPlan 须有 Version: N 和 ## 变更记录。报告可用 specVersion 引用派发或当前版本，原票验收仍取冻结 AC。
承接红证据：新票用 supersede 或 upstreamRedTaskId 关联前序票，并核对 ownedDirty。准入通知给出可核对的取红提交。派生红只有在检查配方、测试字节、验收及原日志都核实后才标记 redNotApplicable。需要重新取红时，先保留当前实现和测试，再使用取红提交的实现快照。
试用票口径续接：主控按 diagnoseTask 的 reviseSchedule {taskId,refreshBaseline:true,reason} 沿原票续接。程序核对原口径下的候选、Git、归属和原取红实现快照，保留旧回执并标记 invalidated。开发收到 check 命令后先恢复核实过的取红实现，再重跑红、绿及候选检查并重新交付。重新汇总后由用户试用。
insertSchedule {taskId,after:[{taskId或ticket,stage:"verified|accepted"}],reason}：仅本项目主控整体替换 queued 票前置。[] 表示无技术依赖，运行时仍核对实际冲突；不能跨项目、自指或成环。dispatchPlan 显式 after 优先于票面前置，省略时沿用票面派生。
supersede {taskId,supersededBy,reason}：仅本项目主控。旧票须为 paused、blocked、已证明停写的未投递 queued、或无责任成员的 trial，且无未完检查。改为 superseded 后释放全部读写与资源范围，保留冻结契约、历史证据、检查回执及替代审计；等待票的原依赖转向后继票且保留 verified/accepted 门槛。有原写集在途改动时返回 handoff 和带 ownedDirty 的 dispatchPlan nextAction；承接票仍须通过真实规划和归属门禁。用 inspect 继续读取旧票。不会修改项目文件、提交、回滚或改写 Git 历史。
releaseSchedule {taskId,reason}：主控释放已停写收尾票的调度范围，保留证据，原票不再准入。assigned 票须已记录静默且成员有新鲜 idle 心跳、无排队输入、后台作业或未完检查。reviseSchedule 调整静默票的 after/reads 时按实时状态核对，回执返回 recoveredBy 和 previousOwnerState。对暂停的实施票 reviseSchedule {taskId,writes:[],reason} 等价。有在途改动返回 handoff/ownedDirty，不修改文件；abandonTask 的停写门槛不变。
previewPlan 的 violations[].repair 给出可复制的 path/value；如果缺真实用例、AC 或路径而不能安全生成替代值，则标记 requiresInput，不把形状示例当成可执行检查。
后台检查以已授权原票冻结的 argv 为准。责任角色按 checkId 提交后由后台运行，已登记的累计检查达到条件时自动排队。检查在项目根目录运行；测试数据用 LINGFLOW_TEST_DATA_ROOT。
技术依赖用 after.stage=verified。只有用户明确要求逐票试用确认后才能继续时才选 accepted；后续票已登记时，主控核对原约定后可用 reviseSchedule 调整原票依赖。
registerChecks {taskId,checks,browserE2E?,resources?}：仅已准入的责任开发可为 developerChecksPending 原票登记检查。保持原实现，在批准的读写范围和资源内登记红绿、full 与适用回归。修订时先停写，由主控 reviseSchedule {taskId,allowCheckRevision:true,reason} 授权，再由责任开发传 replace:true、reason 和完整的开发检查配方。变更红配方须回到原取红状态。完成后按回执恢复，原验收与主控探针保留。
check {taskId,checkId,async?}：责任开发提交红、绿或完整检查；主控提交独立验收或冻结的短探针。async:true 先返回作业号，归属和检查在后台完成。checkStatus {jobId} 查看结果；reused 时沿 reusedJobId 读取有效作业。票内 E2E 由开发承担，累计验证由程序后台跑。checkStatus {taskId} 默认看本票紧凑作业摘要，receipt含exitCode/failureOutputSeen/testCountSeen/environmentFailure/elapsedMs；完整作业传 detail:"full"，可配 limit/offset；checkEvidence {jobId} 读取日志。结果不明用原 operationId 对账。
等待分段：inspect、diagnoseTask 和工作台票详情展示 waitTimings。dependencyMs、resourceMs、memberMs 只累计队列中程序实际观察到的主阻塞，资源段包括文件范围冲突。checkQueueMs 累计每个作业提交至启动或未启动即结束的时间，并行作业的等待可重叠。trackedSince 为 null 表示没有排队采样，不回填旧票历史。
红阶段只比较 writes 排除 testWrites 后的实现文件，按冻结的 fingerprintEol 逐字节一致：LINGFLOW_FINGERPRINT_EOL 默认 normalize（只把 CRLF 转 LF），raw 则比较原始字节。testWrites 可以先改来取红，但红到绿、候选和检查都按测试文件原始字节核对。无 .gitattributes 时工作树行尾受 core.autocrlf 影响，LingFlow 不读取它来决定口径。旧票或切换口径时先停写，由主控核对原实现和归属，再 reviseSchedule {refreshBaseline:true}；不自动重算。
冻结检查可声明 requiredArtifacts:["apps/web/dist"] 和 preSteps:[{argv:["npm","run","build"],outputs:["apps/web/dist"],timeoutMs:120000}]。明确构建配置与源码 inputs，outputs 不得覆盖 writes/inputs；主控探针不做构建。缺产物明确报 evidence-missing，前置失败不算红，构建与检查共享总时限，回执保留步骤日志及产物 hash。
preSteps 总预算预检：有 preSteps 且 timeoutMs<300000 时 warning 提醒“构建前置可能占满预算”。前置步骤超时，或总超时且 preparation.elapsedMs>=timeoutMs*0.8 时，分类为 preparation-timeout。checkStatus 显示实测耗时、冻结预算、差额和建议值。有等价检查历史可复用且原责任可续接时，diagnoseTask 优先给主控 reviseSchedule {allowCheckRevision:true,preparationJobId}，由原开发按回执执行 registerChecks。需要承接票时，提案须核对可用开发、原票交回和真实对账，并经 previewPlan。主控探针仍限60000ms。
report {taskId,summary,dimensions,outcome?,blocker?,request?,artifacts?,openItems?:[{text,blocking,trigger?,impact?,evidence?}]}：交付受阻时用 outcome=blocked，summary 写已完成工作与自测，blocker 写具体原因和被拒回执（如有），request 写需主控做的事。程序保存成员申报与当前诊断，但不受理候选、不放行下游；修复后沿原票另用新操作 ID 正式交付。成功交付可登记非阻塞待取舍项。实施票由程序收集检查回执和当前候选的写入清单。dimensions 的 requirements、implementation、system 各填 {state,evidence,checkIds:[检查编号]}。pass 必须引用同票有效且通过的非 red 检查，并解释它如何支持结论。问题或未验证用 issues/unverified。新只读票提供 dimensions（如某维度无法验证，注明 unverified 和原因）及 checks:[{command,exitCode:0,evidence}]，无需程序 checkIds。无冻结契约的旧票保留原报告，不补造三维或原生证据。
review {taskId,candidate,verdict:"pass|changes",findings,dimensions,testReview?,classification?,request?,artifacts?,openItems?:[{text,blocking,trigger?,impact?,evidence?}]}：仅被派审成员。通过时引用同候选程序证据。交付 manifest.testChanges 非空时，testReview 说明为何既有测试改动没有降低覆盖，或用 changes 报出反例。changes 可标 contract-invalid（契约需对账）、evidence-missing（证据待补）、quality-failed（有可复现的质量反例）；不确定时用 evidence-missing。report/review 均确认 state=stored。
message {roleId?,text,replyTo?}：主控用 roleId 向本项目成员发直达消息；用 replyTo 引用本人收到的消息或能核实发件角色的通知。监管发新消息给本项目通知负责人，主控沿原监管消息回复。inbox 回投新消息，messages {messageId?} 查询本人频道。stored 表示已入库；派工、恢复和阻塞答复分别用原任务命令。
question {taskId,text,blocking?}：默认普通提问；blocking:true 只拦提问者自己的开发交付或审查通过。answer {taskId,questionId,text,resume?}：主控或提问者答复；主控答复最后一条开发阻塞后，若暂停票通过预演且成员可恢复，默认重投原责任。
progress {taskId,text}：责任成员静默更新。
rework {taskId,reason,adjustScope?,evidence?}：主控安排原票返工。只暂停时保留同内容候选和报告；明确指定失效证据或候选变更时重新取证。符合纯扩写集条件时直接用 reviseSchedule。其他范围调整可传 adjustScope=true 先停在原票，再用 reviseSchedule 修订并重新准入。summarize {taskId,instructions,decision:{candidate,acceptance:[{id,evidence,checkIds}],limits,testReview?}}：实施票由主控逐条引用覆盖对应 AC 的有效检查。免审票改动既有测试时由主控填写 testReview。提供真实启动方式和试用步骤。
operation {id:原operationId}：查询原操作回执。无结果保留原 ID，不生成新派单。
派发、预检和 reviseSchedule 的可选 contextReads:["相对路径"] 只供背景阅读，不锁写者，也不作候选证据；只读票请明确 reads，确实不读工作区才填 []。两者都不声明时视为读集未知，与在飞写集串行；不会自动把证据读取降级。reads、writes 和实际检查 inputs 仍按冻结快照校验。检查或批次可声明 failureOutput（例如 "AssertionError"）；非红阶段仅在完整回执同时证明退出码异常和命中断言标记时归为 quality-failed，未证实归为 evidence-missing。旧实施票可保留报告与审查历史，缺契约时不能走原生汇总或验收；剩余工作用 dispatchPlan 建立后继票。
需求讨论、登记和派单在 DSH 主控会话。试用结论可由用户在工作台登记，也可由本项目主控根据明确用户反馈登记。`;

