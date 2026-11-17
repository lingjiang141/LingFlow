import { createHash, randomUUID } from "node:crypto";
import { inspectedEntities, selectWakeNotices, inspectionMetadata, inspectionCommands } from "./controller-notices.mjs";
import { operationIdIssue, commandSignature, writeSignatures, summarizeExample, testReviewEvidence } from "./compliance-errors.mjs";
import { checkStatusResponse } from "./check-status-response.mjs";
import { checkEvidenceFacts } from "./check-evidence.mjs";
import { redEvidenceRequirement } from './evidence-facts.mjs';
import { dependencyReceipt, dependencyReceiptValid, recoverAdmittedDependency } from "./dependency-receipts.mjs";
import { cacheDiagnostics, promptMetrics, recordPromptAdmission } from "./cache-diagnostics.mjs";
import { activeWake, normalizeWake, consumeWake, requeueWake, mergeWakeNotices, recoverLostWakes, auditWakeCoverage, wakeHealth, countDeliveryAttempts } from "./wake-state.mjs";
import { detectEnvironmentFailure, environmentRetry, taskEnvironmentFailure } from "./environment-failure.mjs";
import { commandCall, findRecord, commandExamples } from "./command-arguments.mjs";
import { bridgeToolsBlocker, recordBridgeTools } from "./bridge-tools.mjs";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { coversPath, fingerprint, overlaps, scopePaths } from "./files.mjs";
import { redEvidence, redReceiptValid } from "./red-evidence.mjs";
import { resumeTask } from "./recovery.mjs";
import { ownerStatus, recoveryHint, updateOwnerSilence, recordOwnerHeartbeat } from "./owner-status.mjs";
import { inspectResponse } from "./inspect-response.mjs";
import { wakeDelay } from "./wake-policy.mjs";
import { artifactsIntact } from "./check-preparation.mjs";
import { reconcileRoleDuplicates } from "./role-duplicates.mjs";
import { assertStoppedTask, includeIgnoredScopeWrites, originalTaskWrites, releasedTaskScope, releaseStoppedScope, supersedeStoppedTask, abandonStoppedTask, supersessionHint, scopeConflictRemedy, taskScopeSchemas } from "./task-scope.mjs";
import { commandTimeout, executionPolicy } from "./execution-policy.mjs";
import {
  CONTROLLER_POLICY,
  CONTROLLER_TURN_RULE,
  ROLE_IDENTITIES,
  ROLE_LABELS,
  contextRevision,
  hasCurrentContext,
  markContextSeen,
  roleContext,
  roleLabel,
  savedPrompt,
  wakeText,
} from "./role-context.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseHiveTicket, splitHiveTickets, substituteTicket } from "./hive-plan.mjs";
import { invalidPlan, planSchema, unknownFields, violation } from "./plan-schema.mjs";
import { wakeSummary } from "./wake-card.mjs";
import { formatQualitySummary } from "../ui/quality-summary.js";
import { assertCheckOwnership, browserCheckArgv } from "./verification-policy.mjs";
import { inspectRole, recordObservation } from "./patrol.mjs";
import { assertTicketContract, readTicketContracts } from "./planning-contract.mjs";
import {
  assertScope,
  assertOutsideScope,
  baselineDrift,
  cumulativeCheck,
  evidenceJobs,
  gitState,
  candidateDiff,
  changedFromBaseline,
  committedFiles,
  summarizePaths,
  key,
  list,
  planSources,
  readVerification,
  scopeBaseline,
  scopeNotes,
  planningSourceNotes,
  recordedBaselineChanges,
  committedDirtyBaselinePaths,
  threeDimensions,
  verificationCodes,
  verify,
} from "./quality.mjs";

const id = () => randomUUID();
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
function exactConfirmations(input, expected) {
  const actual = input ?? {};
  return actual && typeof actual === "object" && !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([file, digest]) => Object.hasOwn(actual, file) && actual[file] === digest);
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
const terminalDependency = ["ready", "trial", "accepted"];
const dispatchNotice = (task) => `dispatch:${task.id}:${task.revision}${task.scheduleVersion ? ":" + task.scheduleVersion : ""}`;
const jobIncludes = (job, taskId) => job.taskId === taskId || job.taskIds?.includes(taskId);
const readsFor = (task) => [...task.reads, ...(task.verification?.checks.flatMap((check) => [...check.inputs, ...(check.requiredArtifacts ?? [])]) ?? [])];
const occupied = (task) => !releasedTaskScope(task) && ["assigned", "rework", "paused", "blocked", "reviewing", "waiting_review", "waiting_verification"].includes(task.state);
const leadCheck = (check) => ["independent", "controller"].includes(check.stage);
const connected = (role, now = Date.now()) => Boolean(role.sessionId && role.connectedAt &&
  now - role.connectedAt < 15000 && role.state !== "offline" && role.bridgePresent !== false);
function dispatchAvailability(role, now = Date.now()) {
  if (bridgeToolsBlocker(role)) return "bridge-tools-missing";
  if (!role.sessionId) return "unbound";
  if (!role.enabled) return "disabled";
  if (!connected(role, now)) return "offline";
  if (role.state !== "idle" || role.pending !== 0 || role.jobs > 0) return "busy";
  if (role.resumeWake) return "resuming";
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
  "inbox-not-empty": "原会话仍有待处理输入",
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

function scopeConflict(task, peer, peerRole) {
  if (releasedTaskScope(peer)) return;
  const writes = peer.state === "queued" ? peer.retainedWrites : peer.writes;
  const reads = peer.state === "queued" ? [] : readsFor(peer);
  const remedy = scopeConflictRemedy(task, peer);
  const details = { taskId: peer.id, ...(peer.ticketKey && { ticketKey: peer.ticketKey }), peerRole, peerState: peer.state, remedy };
  const peerLabel = `${peer.ticketKey ? peer.ticketKey + " / " : ""}${peer.id}（${peerRole}，state=${peer.state}）`;
  const nextAction = remedy;
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
      if (total) return { ...details, kind, paths: pairs[0], pairs, total, nextAction,
        message: `写入、读取或共享资源冲突：${kind} · ${peerLabel} · ${pairs.map((pair) => pair.join(" ↔ ")).join("、")}（共 ${total} 对）；下一步：${remedy.command} ${JSON.stringify(remedy.args)}。也可在责任人停写后用 reviseSchedule 修正实际范围。替代须确认承接关系、旧写集干净且无未完检查；仅释放收尾票可用 releaseSchedule。`,
      };
    }
    if ((task.readScopeKnown === false && writes?.length) ||
        (peer.state !== "queued" && peer.readScopeKnown === false && task.writes.length)) {
      const currentUnknown = task.readScopeKnown === false;
      const refine = { command: "scopePreview", args: { writes: [], readOnly: true, reads: ["替换为实际读取的相对路径"] } };
      return { ...details, kind: "read-scope-unknown", paths: (currentUnknown ? writes : task.writes).slice(0, 8),
        nextAction: currentUnknown ? refine : nextAction,
        message: `read-scope-unknown：${currentUnknown ? "本票未声明 reads，遇到写入中的对端" : "对端未声明 reads"} ${peerLabel}。${currentUnknown ? `先替换示例路径：scopePreview ${JSON.stringify(refine.args)}；确实不读工作区才填 reads:[]。已排队票用 reviseSchedule 补同一份 reads。` : `下一步：${remedy.command} ${JSON.stringify(remedy.args)}；主控核对承接关系，或用 reviseSchedule 补对端实际 reads。`}`,
      };
    }
  }
  const resource = occupied(peer) && task.resources.find((item) => peer.resources.includes(item));
  if (resource) return { ...details, kind: "resource", resource, nextAction,
    message: `写入、读取或共享资源冲突：resource · ${peerLabel} · ${resource}；下一步：${remedy.command} ${JSON.stringify(remedy.args)}，核对原票和共享资源。` };
}

function activeScope(task) {
  if (releasedTaskScope(task)) return false;
  return occupied(task) || task.state === "waiting_batch" ||
    (task.state === "queued" && task.retainedWrites?.length);
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
  const verification = readOnly ? null : readVerification(input.verification, { root: project.root, writes, risk: input.risk, warnings, prefix: prefix + ".verification" });
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
    resources: [...new Set(resources)], ownedDirty, verification,
    dependencies: [], dependencyStages: {}, state: "queued", revision: 1,
    acceptedAt: Date.now(), deliveredAt: null, reportedAt: null,
    reports: [], reviews: [], questions: [],
  };
}

function freezePlan(s, role, args, preview = false) {
  const requirement = find(s.requirements, args.requirementId);
  need(role?.kind === "controller" && role.projectId === requirement.projectId, "请在本项目已开启的 DSH 主控会话派单");
  const project = find(s.projects, role.projectId);
  let documents;
  try { documents = planSources(project.root, args.sources, true); } catch (error) {
    throw invalidPlan([violation("sources", error.message, planSchema.sources, "指定存在的项目相对规划文件或 issues 目录")]);
  }
  const sources = Object.fromEntries(Object.entries(documents).map(([name, doc]) => [name, { file: doc.file, digest: doc.digest }]));
  const planId = id();
  const ticketDocuments = Object.entries(documents).filter(([name]) => name === "tickets" || name.startsWith("ticket:"));
  const contracts = new Map(), hiveTickets = new Map();
  const violations = [], warnings = [], normalized = [];
  unknownFields(args, ["requirementId","sources","tickets","batches"], "plan", warnings);
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
    if (!parsed.length && name.startsWith("ticket:") && !declared.size)
      violations.push(violation("sources."+name, "找不到票面 H1："+document.file, "# 票 R35-01：标题", "选择原始票面文件，或使用含 lingflow-contract 的原生票面"));
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
      unknownFields(raw,["key","developerId","title","description","brief","boundaries","stopConditions","risk","riskReason","writes","reads","contextReads","resources","ownedDirty","after","readOnly","verification","browserE2E"],prefix,warnings);
      const hive=hiveTickets.get(ticketKey);
      if (hiveTickets.size && !hive && !raw.readOnly) need(contracts.has(ticketKey),"未找到匹配的 Hive H1："+ticketKey);
      const merged = {...raw};
      if (raw.browserE2E !== undefined) {
        need(raw.verification?.browserE2E === undefined || JSON.stringify(raw.verification.browserE2E)===JSON.stringify(raw.browserE2E),"票根和 verification.browserE2E 不一致，请只保留一份");
        merged.verification={...raw.verification,browserE2E:raw.browserE2E};
        warnings.push({path:prefix+".browserE2E",message:"已归并到 verification.browserE2E"});
      }
      const input=substituteTicket(merged,hive,warnings,prefix);
      const refs=Object.fromEntries(Object.entries(sources).filter(([name])=>!name.startsWith("ticket:")));
      const ticketSource = hive?.name ?? ticketDocuments.find(([, document])=>document.file===contracts.get(ticketKey)?.source)?.[0];
      if(ticketSource) refs.tickets=sources[ticketSource];
      const task={...newTask(s,role,requirement,input,id(),refs,ticketKey,warnings,prefix),planId};
      const contract=contracts.get(ticketKey);
      need(task.readOnly || !contracts.size || contract,"缺少 "+ticketKey+" 的 lingflow-contract");
      assertTicketContract(task,contract);
      if(contract) task.ticketContract=contract;
      byKey.set(ticketKey,task);
      normalized.push(input);
    } catch(error) { collect(prefix,error,planSchema.tickets[0],"补齐这张票的派发字段；保留原票正文"); }
  }
  for(const input of normalized) {
    const task=byKey.get(input.key);
    const at="tickets["+input.key+"].after";
    try {
      const dependencies = [...list(input.after ?? [], "前置依赖")];
      for (const needed of hiveTickets.get(input.key)?.after ?? []) {
        const counterpart = byKey.get(needed.ticket) ?? s.tasks.find((t)=>t.projectId===project.id&&t.ticketKey===needed.ticket);
        const provided = dependencies.find((dep)=>dep?.ticket===needed.ticket || (counterpart && dep?.taskId===counterpart.id));
        if (!provided) {
          dependencies.push(needed);
          warnings.push({path:at,message:"已保留原票明确的前置依赖",value:needed});
        } else if (provided.stage === "accepted" && needed.stage === "verified") {
          warnings.push({ path: at, message: `前置 ${needed.ticket} 被设为等待用户验收。技术前置请选择 verified；仅用户明确要求验收后再推进时保留 accepted。`, value: provided });
        }
      }
      input.after = dependencies;
      for (const dep of dependencies) {
        unknownFields(dep, ["ticket","taskId","stage"], at,warnings);
        const stage = dep?.stage ?? "verified";
        need(["verified", "accepted"].includes(stage), "前置门槛必须为 verified 或 accepted");
        need(!!dep?.ticket !== !!dep?.taskId, "前置依赖须指定 ticket 或 taskId");
        if (dep.ticket && inputs.some((item)=>item?.key===dep.ticket) && !byKey.has(dep.ticket)) continue;
        const predecessor = dep.ticket ? need(byKey.get(dep.ticket) ?? s.tasks.find((t)=>t.projectId===project.id&&t.ticketKey===dep.ticket), "前置票不存在："+dep.ticket) : find(s.tasks, dep.taskId);
        need(predecessor.projectId === project.id, "依赖必须同项目");
        need(!Object.hasOwn(task.dependencyStages, predecessor.id), "前置依赖重复");
        task.dependencies.push(predecessor.id);
        task.dependencyStages[predecessor.id] = stage;
      }
    } catch(error) { collect(at,error,[{ticket:"R35-01",stage:"verified"}],"引用同项目实际前置票"); }
  }
  if(violations.length) throw invalidPlan(violations, warnings);
  const visiting = new Set(), complete = new Set(), order = [];
  const byId = new Map([...byKey.values()].map((task) => [task.id, task]));
  function visit(task) {
    need(!visiting.has(task.id), "规划依赖存在循环：" + task.ticketKey);
    if (complete.has(task.id)) return;
    visiting.add(task.id);
    for (const dependency of task.dependencies) {
      const predecessor = byId.get(dependency);
      if (predecessor) visit(predecessor);
    }
    visiting.delete(task.id);
    complete.add(task.id);
    order.push(task);
  }
  try { for (const task of byKey.values()) visit(task); }
  catch(error) { throw invalidPlan([violation("tickets.after",error.message,[{ticket:"R35-01",stage:"verified"}],"只保留实际依赖，取消互相等待的边")]); }
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
  if (preview) return { state: "valid", violations: [], warnings, sources, tickets: order.map((task) => ({ key: task.ticketKey, writes: task.writes, reads: task.reads, after: normalized.find((input)=>input.key===task.ticketKey)?.after ?? [], verification: task.verification, verificationMode: verificationMode(task) })) };
  s.validationBatches.push(...frozenBatches);
  s.tasks.push(...order);
  s.plans.push({ id: planId, projectId: project.id, requirementId: requirement.id, documents, createdAt: Date.now() });
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
      this.normalizeNotices(s);
      for(const wake of s.wakes)normalizeWake(wake,Date.now());
      for (const role of s.roles) {
        role.enabled = false;
        role.connectedAt = 0;
        delete role.observation;
        delete role.patrolStatus;
      }
    });
  }
  normalizeNotices(s) {
    for(const notice of s.notices)if(typeof notice.actionable!=='boolean') {
      const role=s.roles.find(role=>role.id===notice.roleId);
      notice.actionable=role?Boolean(selectWakeNotices(s,role,[notice]).notices[0]?.actionable):false;
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
  notice(s, roleId, key, summary, taskId = null) {
    if (!s.notices.some((n) => n.roleId === roleId && n.key === key)) {
      const notice = {
        id: id(),
        roleId,
        key,
        summary,
        taskId,
        readAt: null,
        at: Date.now(),
      };
      const role=s.roles.find(role=>role.id===roleId);
      notice.actionable=role ? Boolean(selectWakeNotices(s,role,[notice]).notices[0]?.actionable) : false;
      s.notices.push(notice);
      return notice;
    }
    return s.notices.find(notice=>notice.roleId===roleId&&notice.key===key);
  }
  retire(s, taskId) {
    for (const n of s.notices)
      if (n.taskId === taskId && !n.readAt) n.readAt = Date.now();
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
      notice.key === `review:${task.id}:${task.revision}`
    )
      task.reviewDeliveredAt ??= at;
  }
  logWakeDelivery(s, wake, result, attempt, at = Date.now()) {
    const taskIds = s.notices.filter((notice) => wake.noticeIds.includes(notice.id) && notice.taskId).map((notice) => notice.taskId);
    for (const taskId of new Set(taskIds.length ? taskIds : [null]))
      this.store.event("deliver", { wakeId: wake.id, taskId, roleId: wake.roleId, attempt, result, at });
  }
  trackWakeAttempts(s, wake, data) {
    if (data?.generation !== (wake.deliveryRetry ?? 0) || !Array.isArray(data.outcomes)) return;
    for (const outcome of data.outcomes.slice(0, 4)) {
      if (!Number.isSafeInteger(outcome?.attempt) || outcome.attempt <= (wake.loggedAttempt ?? 0) || outcome.attempt > 4 ||
          !["rejected", "uncertain"].includes(outcome.result)) continue;
      this.logWakeDelivery(s, wake, outcome.result, outcome.attempt, Number.isSafeInteger(outcome.at) ? outcome.at : undefined);
      countDeliveryAttempts(wake,outcome.attempt);
      wake.loggedAttempt = outcome.attempt;
    }
  }
  deliveryDiagnostic(s, role, since) {
    const wake = s.wakes.find((item) => item.roleId === role.id && item.state === "pending");
    const availability = dispatchAvailability(role);
    const reason = ["bridge-tools-missing", "offline", "unbound", "disabled", "jobs-unknown"].includes(availability) ? availability :
      wake?.diagnostic?.reason ?? (role.deliveryIssue?.startsWith("投递结果待对账") ? "uncertain" :
        Date.now() - (wake?.at ?? since ?? Date.now()) >= 10000 ? (availability === "busy" ? "busy" : "stalled") : null);
    return reason ? { reason, at: wake?.diagnostic?.at ?? wake?.at ?? since ?? role.connectedAt ?? Date.now(),
      attempt: wake?.diagnostic?.attempt ?? 0, detail: deliveryLabels[reason], ...(wake && { wakeId: wake.id }) } : null;
  }
  resumeStatus(s, role) {
    if (!role.enabled) return null;
    const notice = s.notices.findLast((item) => item.roleId === role.id && item.key.startsWith("resume:"));
    if (!notice) return null;
    if (notice.readAt) return "read";
    if (role.deliveryIssue) return "delivery-issue";
    if (role.resumeWake) return dispatchAvailability(role, Date.now()) === "offline" ? "offline" : "waiting-idle";
    return s.wakes.some((wake) => wake.roleId === role.id && wake.state === "enqueued" && wake.noticeIds.includes(notice.id))
      ? "delivered" : "pending";
  }
  snapshot() {
    const s = this.store.read();
    const { plans, projects, controllerReads, promptAdmissions, toolsRepairHistory, roleIdentityConflicts, ...workbench } = s;
    return {
      ...workbench,
      tasks: s.tasks.map(task => ({ ...task, ...this.taskDelivery(s, task) })),
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
    const result = commandCall(command, args, parameters => this.callValidated(sessionId, command, parameters, operationId, provider, partialReason, source),
      sessionId === "ui" && command === "scopePreview" ? ["projectId"] : []);
    if (this.inspectionContext && result && typeof result === "object") {
      Object.defineProperty(result, inspectionMetadata, { value: this.inspectionContext });
      if (!this.readOnly) this.recordInspection(sessionId, inspectedEntities(command, args, result), observedAt, provider);
    }
    return result;
  }
  recordInspection(sessionId, observed, at, provider = "dsh") {
    if (!observed || sessionId === "ui") return;
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
    if (partialReason) {
      const evidence = { available: false, reason: partialReason, at: Date.now() };
      if (command === "previewPlan") {
        need(role?.kind === "controller" && find(state.requirements, args.requirementId).projectId === role.projectId, "仅本项目主控可预检计划");
        return { state: "unavailable", evidence };
      }
      if (command === "checkEvidence") {
        const job = find(state.checkJobs, args.jobId);
        need(!role || job.projectId === role.projectId, "不可跨项目读取");
        return { ...job, log: null, evidence };
      }
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      return { taskId: task.id, state: task.state, candidate: task.candidate, deliveredAt: task.deliveredAt ?? null, ...this.taskDelivery(state, task),
        classification: "evidence-missing", reason: "本地 Git 或文件证据暂不可用", evidence,
        nextAction: { command: "inspect", args: { taskId: task.id } } };
    }
    if (command === "operation") return this.store.receipt(scope, args.id);
    if (command === "guide") return { guide: GUIDE, examples: commandExamples };
    if (command === "context") {
      need(role, "请从角色会话读取上下文");
      return roleContext(
        find(state.projects, role.projectId),
        role,
        controller(state, role.projectId)?.id === role.id,
      );
    }
    if (command === "checkStatus") {
      if (args.jobId !== undefined) {
        const job = find(state.checkJobs, args.jobId);
        need(!role || job.projectId === role.projectId, "不可跨项目读取");
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
        return need(document, "没有该规划文档；多票计划用文档相对路径或索引键");
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
      need(["controller", "supervisor", "planner"].includes(role?.kind), "该角色没有独立频道");
      const channel = state.messages.filter((item) => item.projectId === role.projectId &&
        (item.from === role.id || item.to === role.id));
      if (args.messageId !== undefined) return find(channel, args.messageId);
      return channel.slice(-50);
    }
    if (command === "list") return this.view(state, role);
    if (command === 'cacheDiagnostics') {
      const member=find(state.roles,args.roleId);
      need(!role||member.projectId===role.projectId,'不可跨项目读取');
      return cacheDiagnostics(state,member.id);
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
      if (name === "resumeTask") return { ...signature, required: ["taskId", "reason"], states: ["assigned", "rework", "paused"],
        preconditions: ["本项目主控", "成员不在运行，无排队输入或后台检查", "新心跳恢复后正常准入"], preserves: ["baseline", "candidate", "reports", "checkJobs", "reworkReason"] };
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
      return { ...this.diagnoseTask(state, task), ...this.taskDelivery(state, task) };
    }
    if (command === "inspect") {
      const task = find(state.tasks, args.taskId);
      need(!role || task.projectId === role.projectId, "不可跨项目读取");
      if(args.section==='events') return this.store.taskEvents(task.id,args);
      const events=this.store.taskEvents(task.id);
      return inspectResponse({
        ...task,
        ...supersessionHint(state,task),events:events.items,eventCount:events.total,
        ...ownerStatus(state, task),
        ...this.taskDelivery(state, task),
        ...taskEnvironmentFailure(state.checkJobs.filter(job => jobIncludes(job, task.id) && (job.batchId || job.revision === task.revision))),
        ...(!task.candidate && { evidence: { available: false, reason: "no-candidate", at: Date.now() } }),
        verificationMode: verificationMode(task),
        requirement: find(state.requirements, task.requirementId),
        checkJobs: state.checkJobs.filter((job) => jobIncludes(job, task.id)),
        batch: state.validationBatches.find((batch) => batch.id === task.batchId),
      }, args);
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
        const resuming = notices.some((n) => n.key.startsWith("resume:"));
        delete current.resumeWake;
        for (const n of notices) {
          n.readAt = Date.now();
          this.recordDelivery(s, n, role.id, n.readAt);
        }
        for (const wake of s.wakes)
          if (wake.roleId === role.id && wake.state !== "consumed")
            consumeWake(wake,Date.now());
        const messageIds = new Set(notices.filter((n) => n.key.startsWith("message:")).map((n) => n.key.slice(8)));
        return {
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
          need(sender && (planner ? sender.kind === "planner" : ["controller", "supervisor"].includes(sender.kind)), "该角色不能向此频道发送消息");
          if (sender.kind === "controller" && args.roleId && s.roles.find(role => role.id === args.roleId)?.kind !== "supervisor")
            verify(false, "contract-invalid", "主控不能直接 message 成员；恢复原票用 resumeTask，回答阻塞用 answer，新增责任用 dispatchPlan。roleId 必须是本项目监管者。");
          const previous = args.replyTo === undefined ? null : s.messages.find(message => message.id === args.replyTo);
          if (args.replyTo !== undefined) verify(previous, "contract-invalid", "replyTo 不是该频道收到的消息 id（通知 id 不能代替消息 id）；用 messages 查询原消息并复制 id。");
          if (previous) verify(previous.to === sender.id, "contract-invalid", "replyTo 不是当前角色收到的消息；回复必须引用频道内对方原消息，用 messages 查询。");
          if (sender.kind === "controller") verify(previous, "contract-invalid", "主控回复须引用原监管消息 replyTo；用 messages 查询并复制原消息 id。");
          const target = previous ? activeRole(s, previous.from) : controller(s, sender.projectId);
          need(target && target.projectId === sender.projectId &&
            target.kind === (sender.kind === "controller" ? "supervisor" : "controller") &&
            (args.roleId === undefined || args.roleId === target.id), "频道成员无效");
          const message = { id: id(), projectId: sender.projectId, from: sender.id, to: target.id,
            text: text(args.text, "消息"), replyTo: args.replyTo ?? null, at: Date.now() };
          if (planner) message.sources = planSources(find(s.projects, sender.projectId).root, args.sources);
          s.messages.push(message);
          this.notice(s, target.id, "message:" + message.id, (planner ? "规划已交付：" : sender.kind === "controller" ? "主控已回复监管消息：" : "监管者转达用户消息：") + message.id);
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
                t.questions.some((q) => q.from === target.id && !q.answer),
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
            this.notice(
              s,
              target.id,
              "resume:" + operationId,
              "角色已开启或请求续接。读取收件箱内原责任和恢复索引，核对实际工作区、候选与检查回执后续接。",
            );
          } else if (!target.enabled) {
            delete target.resumeWake;
            delete target.patrolStatus;
            for (const notice of s.notices)
              if (notice.roleId === target.id && !notice.readAt && notice.key.startsWith("patrol-resume:"))
                notice.readAt = Date.now();
          }
          result = { enabled: target.enabled, resumeStatus: this.resumeStatus(s, target) };
          break;
        }
        case "dispatchPlan":
          result = freezePlan(s, currentRole, args);
          break;
        case "redeliver": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.kind === "controller" && currentRole.projectId === task.projectId, "仅本项目主控可重试投递");
          if (task.deliveredAt && ["assigned","rework"].includes(task.state)) {
            result = this.resumeSilentTask(s, task, currentRole, args.reason ?? "member-silent：主控重投已送达但静默的原票");
            break;
          }
          need(task.assignee && ["assigned", "rework"].includes(task.state) && !task.deliveredAt, `no-pending-delivery：当前 state=${task.state}，无可重投的开发责任；inspect 核对原票；${recoveryHint(s, task)}`);
          const wake = s.wakes.find((item) => item.roleId === task.assignee && item.state === "pending");
          need(wake, "原票等待可用会话，请打开原绑定会话等待心跳");
          need(wake.diagnostic?.reason === "retry-limit", "仅宿主明确拒绝且达到重试上限时可重试；结果待对账时从原会话读取 inbox");
          requeueWake(wake,Date.now(),'controller-retry');
          result = { state: "pending", taskId: task.id, wakeId: wake.id };
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
        case "resumeTask": {
          const task = find(s.tasks, args.taskId);
          result = this.resumeSilentTask(s, task, currentRole, text(args.reason, "恢复原因"));
          break;
        }
        case "supersede": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.kind === "controller" && currentRole.projectId === task.projectId, "仅本项目主控可替代原票");
          assertStoppedTask(s, task);
          const successor = find(s.tasks, args.supersededBy);
          const audit = { reason: text(args.reason, "替代原因"), by: currentRole.id, at: Date.now() };
          const git = this.scopeReleaseGit(s, task);
          result = supersedeStoppedTask(s, task, successor, git, audit);
          this.retire(s, task.id);
          this.notice(s, task.developerId, "superseded:" + task.id, "原票已被替代，停止原票工作并保留证据：" + task.title, task.id);
          break;
        }
        case 'abandonTask': {
          const task=find(s.tasks,args.taskId);
          need(currentRole?.kind==='controller'&&currentRole.projectId===task.projectId,'仅本项目主控可终止原票');
          const audit={reason:text(args.reason,'终止原因'),by:currentRole.id,at:Date.now()};
          result=abandonStoppedTask(s,task,this.scopeReleaseGit(s,task),audit);
          this.retire(s,task.id);this.store.event('abandon-task',{taskId:task.id,...audit});
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
        case "yieldForSchedule": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.id === task.assignee && ["assigned", "rework"].includes(task.state), "只有已停写的责任成员可以交回调度");
          need(!s.checkJobs.some((job) => jobIncludes(job, task.id) && activeCheck(job)), "先等待或对账后台检查，再交回调度");
          task.state = "paused";
          task.waitReason = text(args.reason, "现场冲突或调度原因");
          this.notice(s, controller(s, task.projectId).id, "schedule:" + id(), "待调整调度：" + task.title, task.id);
          result = { state: "paused", taskId: task.id };
          break;
        }
        case "rebindCommittedWork": {
          const task = find(s.tasks, args.taskId);
          lead(task.projectId);
          need(currentRole?.kind === "controller", "仅本项目主控可确认提交归属");
          need(task.state === "paused" && !task.candidate, '重绑顺序：1. diagnoseTask {taskId} 获取 nextAction；2. 已交付票由主控 rework {taskId,adjustScope:true,reason} 暂停，活动票由开发停写后 yieldForSchedule {taskId,reason}；3. 再 diagnoseTask，复制 nextAction.args 调 rebindCommittedWork。');
          const reason = text(args.reason, "主控确认提交归属的理由");
          need(reason !== "填写核对提交差异和归属的实际依据", "请填写主控核对提交差异和归属的实际依据");
          const root = find(s.projects, task.projectId).root;
          const git = this.ownershipGit(s, task);
          const drift = baselineDrift(root, task, git, [...task.writes, ...readsFor(task)]);
          const plan = s.plans.find((item) => item.id === task.planId);
          const sourceNotes = planningSourceNotes(root, task, plan);
          const records = recordedBaselineChanges(root, task, plan, git, drift);
          const overlap = this.committedRebindScope(s, task, root, git, drift, sourceNotes, records);
          const expectedRecords = Object.fromEntries(records.map(({ file, toDigest }) => [file, toDigest]));
          verify(exactConfirmations(args.confirmRecordedBaseline, expectedRecords), "contract-invalid",
            '请按 diagnoseTask 确认已入库规划记录；confirmRecordedBaseline 必须是对象 {"规划相对路径":"<sha256>"}，不是布尔值；从 diagnoseTask.nextAction.args 复制实际路径与指纹，未要求确认时省略该字段。');
          const expectedSources = Object.fromEntries(sourceNotes.map(({ file, toDigest }) => [file, toDigest]));
          verify(exactConfirmations(args.confirmSourceAppends, expectedSources),
            "contract-invalid", "追加记录未经确认或已变化；请用 diagnoseTask 查看来源路径、行号和 confirmSourceAppends");
          verify(args.expectedHead === drift.to && args.expectedBase === drift.from &&
            JSON.stringify(scopePaths(args.confirmPaths)) === JSON.stringify(scopePaths(overlap)),
            "contract-invalid", "基线或重叠文件与确认不一致；请重新用 diagnoseTask 核对");
          const previous = { baseline: structuredClone(task.baseline) };
          const deliveryBase = task.baseline.deliveryBase ?? task.baseline.head;
          const baseline = { ...scopeBaseline(root, task, this.foreignWrites(s, task), git), deliveryBase };
          const current = this.ownershipGit(s, task);
          verify(current.head === git.head && current.branch === git.branch && current.index === git.index &&
            JSON.stringify(current.dirty) === JSON.stringify(git.dirty), "contract-invalid", "核对期间 Git 状态已变化，请重新运行 diagnoseTask");
          verify(JSON.stringify(planningSourceNotes(root, task, plan)) === JSON.stringify(sourceNotes),
            "contract-invalid", "核对期间规划来源已变化，请重新运行 diagnoseTask");
          task.baseline = baseline;
          task.retainedWrites = [];
          task.state = "queued";
          task.waitReason = null;
          task.deliveredAt = null;
          task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
          const rebind = { from: drift.from, to: drift.to, overlap, reason, at: Date.now(), by: currentRole.id, ...(sourceNotes.length && { acceptedSourceAppends: sourceNotes }), ...(records.length && { recordedBaseline: records }) };
          (task.scheduleHistory ??= []).push({ previous, reason, by: currentRole.id, at: rebind.at, rebind });
          this.retire(s, task.id);
          result = { state: "applied", taskId: task.id, rebind, operationId,
            scannedFiles: git.ownershipMetrics?.scannedFiles ?? 0, ownership: git.ownershipMetrics,
            summary: { from: rebind.from, to: rebind.to, confirmedPaths: overlap, scheduleVersion: task.scheduleVersion } };
          break;
        }
        case "reviseSchedule": {
          const task = find(s.tasks, args.taskId);
          need(currentRole?.kind === "controller" && currentRole.projectId === task.projectId, "仅本项目 DSH 主控可调整调度");
          if (["assigned","rework"].includes(task.state)) need(false,recoveryHint(s,task));
          if (!task.readOnly && Array.isArray(args.writes) && args.writes.length === 0) {
            need(Object.keys(args).every(key => ["taskId", "reason", "writes"].includes(key)), "释放范围请单独传 taskId、writes:[]、reason；其他调度调整另行核对。");
            result = this.releaseSchedule(s, currentRole, args);
            break;
          }
          need(!releasedTaskScope(task), "原票已释放或被替代，不再准入；剩余工作请登记后继票。");
          need(["queued", "paused"].includes(task.state), recoveryHint(s, task));
          const root = find(s.projects, task.projectId).root;
          const reason = text(args.reason, "调整原因");
          const nextReads = args.reads === undefined ? task.reads : scopePaths(args.reads);
          const nextContextReads = args.contextReads === undefined ? task.contextReads ?? [] : scopePaths(args.contextReads);
          const nextWrites = args.writes === undefined ? task.writes : scopePaths(args.writes);
          const nextOwnedDirty = args.ownedDirty === undefined ? task.ownedDirty ?? [] : scopePaths(args.ownedDirty);
          need(task.readOnly ? !nextWrites.length : nextWrites.length, "调整后仍须保留正确的写入范围");
          need(nextOwnedDirty.every((file) => coversPath(nextWrites, file)), "已有改动授权必须在调整后的写入范围内");
          const nextResources = args.resources === undefined ? task.resources : [...new Set(list(args.resources, "共享资源").map((r) => text(r, "资源").toLowerCase()))];
          const previous = { reads: task.reads, contextReads: task.contextReads ?? [], writes: task.writes, resources: task.resources, dependencies: task.dependencies, stages: task.dependencyStages, ownedDirty: task.ownedDirty };
          const nextDependencies = args.after === undefined ? task.dependencies : [];
          const nextStages = args.after === undefined ? task.dependencyStages : {};
          const reaches = (predecessor, visited = new Set()) => {
            if (predecessor.id === task.id) return true;
            if (visited.has(predecessor.id)) return false;
            visited.add(predecessor.id);
            return predecessor.dependencies.some((dep) => reaches(find(s.tasks, dep), visited));
          };
          for (const dep of list(args.after ?? [], "前置依赖")) {
            const predecessor = find(s.tasks, dep.taskId);
            need(predecessor.projectId === task.projectId && !reaches(predecessor), "调整后的依赖跨项目或存在循环");
            const stage = dep.stage ?? "verified";
            need(["verified", "accepted"].includes(stage) && !Object.hasOwn(nextStages, predecessor.id), "前置门槛无效或重复");
            nextDependencies.push(predecessor.id);
            nextStages[predecessor.id] = stage;
          }
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
          let rebind;
          if (args.refreshBaseline === true) verify(task.verification && task.baseline, "contract-invalid", "尚无可重绑的冻结基线；请用 diagnoseTask 核对原票");
          if (task.verification) {
            need(task.verification.testWrites.every((file) => nextWrites.some((write) => file === write || file.startsWith(write + "/"))), "调整不能移除冻结的测试文件");
            if (task.baseline) {
              const previousBaseline = structuredClone(task.baseline);
              const git = this.ownershipGit(s, { ...task, reads: nextReads, contextReads: nextContextReads, writes: nextWrites });
              const touched = git.dirty.filter((file) => coversPath(task.writes, file));
              need(touched.every((file) => nextWrites.some((write) => file === write || file.startsWith(write + "/"))), "调整会释放仍有修改的文件，请先处理写入归属");
              const expanded = git.dirty.filter((file) => coversPath(nextWrites, file) && !coversPath(task.writes, file));
              need(expanded.every((file) => nextOwnedDirty.includes(file)), "新增写入包含已有改动，需先核实用户授权与归属");
              task.baseline.other = task.baseline.other.filter(([file]) => !expanded.includes(file));
              task.retainedWrites = [...new Set([...touched, ...expanded])];
              if (task.baseline.sources === this.sourceInput(root, task))
                task.baseline.sources = this.sourceInput(root, { ...task, writes: nextWrites });
              if (args.refreshBaseline === true) {
                const drift = baselineDrift(root, task, git, [...task.writes, ...nextWrites, ...readsFor(task), ...nextReads]);
                verify(args.expectedHead === undefined || args.expectedHead === git.head, "contract-invalid", "当前 HEAD 已再次变化，请重新运行 diagnoseTask");
                verify(!drift?.blockingCondition, "contract-invalid", `${drift?.blockingCondition}；请主控先核对 Git 或用 dispatchPlan 建立后继票，保留原票证据`);
                const unmanaged = committedDirtyBaselinePaths(task, drift);
                verify(!unmanaged.length, "contract-invalid", "提交包含原基线已有的未归属改动：" + summarizePaths(unmanaged) + "；保留这些文件并由主控核对，不能直接重绑");
                const records = recordedBaselineChanges(root, task, s.plans.find((item) => item.id === task.planId), git, drift);
                verify(!records.length, "contract-invalid", "前移包含冻结时未提交的规划记录：" + summarizePaths(records.map((note) => note.file)) + "；请用 diagnoseTask 核对显式接纳条件");
                assertOutsideScope(root, { ...task, writes: nextWrites }, this.foreignWrites(s, task), git);
                need(touched.every((file) => nextOwnedDirty.includes(file)), "重新绑定基线前须逐项确认现有改动归属");
                previous.baseline = previousBaseline;
                const { sources, deliveryBase, cleanWrites } = task.baseline;
                const sameScope = JSON.stringify([task.writes, task.reads, task.dependencies, task.dependencyStages, task.resources]) ===
                  JSON.stringify([nextWrites, nextReads, nextDependencies, nextStages, nextResources]);
                const evidenceBase = sameScope ? this.evidenceBase(task) : null;
                task.baseline = {
                  ...scopeBaseline(root, { ...task, writes: nextWrites, ownedDirty: nextOwnedDirty }, this.foreignWrites(s, task), git),
                  sources,
                  cleanWrites: JSON.stringify(task.writes) === JSON.stringify(nextWrites) ? cleanWrites : undefined,
                  ...(deliveryBase && { deliveryBase }),
                  ...(evidenceBase && { evidenceBase }),
                };
                if (drift) rebind = { from: drift.from, to: drift.to, committedBetween: drift.committedBetween };
              }
            }
          }
          if (task.baseline && JSON.stringify(task.writes) !== JSON.stringify(nextWrites)) delete task.baseline.cleanWrites;
          Object.assign(task, {
            reads: nextReads, contextReads: nextContextReads, writes: nextWrites, resources: nextResources, ownedDirty: nextOwnedDirty,
            ...(task.readOnly && (args.reads !== undefined || nextContextReads.length > 0) && { readScopeKnown: true }),
            dependencies: nextDependencies, dependencyStages: nextStages,
            state: "queued", waitReason: null, deliveredAt: null,
            scheduleVersion: (task.scheduleVersion ?? 0) + 1,
          });
          (task.scheduleHistory ??= []).push({ previous, reason, by: currentRole.id, at: Date.now(), ...(rebind && { rebind }) });
          this.retire(s, task.id);
          result = { state: "stored", taskId: task.id, scheduleVersion: task.scheduleVersion, ...(rebind && { rebind }) };
          break;
        }
        case "check": {
          const task = find(s.tasks, args.taskId);
          need(task.verification && currentRole?.projectId === task.projectId, "只有本项目责任成员可以提交冻结检查");
          const check = find(task.verification.checks, args.checkId);
          this.checkResponsibility(task, check, currentRole);
          need(args.async === undefined || typeof args.async === "boolean", "async 须为布尔值");
          const project = find(s.projects, task.projectId);
          const running = s.checkJobs.find((job) => job.taskId === task.id && job.check.id === check.id && activeCheck(job));
          const job = { id: id(), taskId: task.id, projectId: task.projectId, root: project.root,
            check, files: this.checkPaths(task, check), revision: task.revision, scheduleVersion: task.scheduleVersion ?? 0, requester: currentRole.id,
            state: "queued", createdAt: Date.now(), ...(source && { source }) };
          if (args.async) {
            if (running) { result = { jobId: running.id, state: running.state }; break; }
            job.preparing = true;
            s.checkJobs.push(job);
            result = { jobId: job.id, state: job.state };
            break;
          }
          // Keep pre-policy frozen responsibilities resumable under their original terms.
          if (task.verification.browserE2E) assertCheckOwnership(project.root, check, task.verification.browserE2E);
          const scope = this.verifyScope(s, task);
          const input = this.checkInput(project.root, task, check);
          const notes = planningSourceNotes(project.root, task, s.plans.find((item) => item.id === task.planId));
          const advisory = { ownership: scope.ownershipMetrics, ...(notes.length && { sourceNotes: notes }) };
          if (running) { result = { jobId: running.id, state: running.state, ...advisory }; break; }
          const cached = this.validCheck(s, task, check);
          if (cached) { result = { jobId: cached.id, state: "passed", ...advisory }; break; }
          this.checkPrerequisites(s, task, check, project.root);
          Object.assign(job, { input, ownership: scope.ownershipMetrics });
          if (check.stage === "red") Object.assign(job, redEvidence(project.root, task, check));
          s.checkJobs.push(job);
          result = { jobId: job.id, state: job.state, ...advisory,
            ...(job.redProofVersion && { redProofScope: job.redProofScope, excludedTestWrites: job.excludedTestWrites }) };
          break;
        }
        case "reconcileCheck": {
          ui();
          const job = find(s.checkJobs, args.jobId);
          need(job.state === "uncertain", "只有待对账的检查可人工收口");
          job.reconciliation = text(args.evidence, "已确认旧进程退出及资源安全的依据");
          job.state = "interrupted";
          job.finishedAt = Date.now();
          if (job.batchId) find(s.validationBatches, job.batchId).state = "interrupted";
          result = { state: job.state };
          break;
        }
        case "report": {
          const task = find(s.tasks, args.taskId);
          need(
            currentRole?.id === task.developerId &&
              ["assigned", "rework"].includes(task.state),
            "仅责任开发者可以交付活动任务",
          );
          need(args.outcome === undefined || ["success", "blocked"].includes(args.outcome), "report outcome 为 success 或 blocked");
          const handoff = handoffFields(args);
          if (args.outcome === "blocked") {
            const diagnostic = this.diagnoseTask(s, task);
            const report = {
              id: id(), revision: task.revision, developerId: currentRole.id, outcome: "blocked",
              summary: text(args.summary, "实现与自测结果"), blocker: text(args.blocker, "未交付原因"),
              ...handoff, dimensions: threeDimensions(args.dimensions), at: Date.now(),
              ...(task.verification && { gate: { classification: diagnostic.classification, reason: diagnostic.reason, nextAction: diagnostic.nextAction,
                ...Object.fromEntries(["checkId", "from", "to", "committedBetween", "conflicts", "blockingCondition", "blockingConditions", "sourceNotes", "afterStop", "recovery", "shortStatus", "recordedBaseline"].filter((key) => diagnostic[key] !== undefined).map((key) => [key, diagnostic[key]])) } }),
            };
            (task.blockedReports ??= []).push(report);
            this.notice(s, controller(s, task.projectId).id, "report-blocked:" + report.id, "开发报告 · 交付受阻：" + task.title, task.id);
            result = { state: "stored", outcome: "blocked", reportId: report.id, taskId: task.id, qualitySummary: formatQualitySummary(report) };
            break;
          }
          need(!handoff.openItems?.some((item) => item.blocking), "有阻塞项请用 report outcome=blocked，不能作为成功交付");
          need(
            task.questions.every((q) => q.answer),
            "尚有未答复阻塞，不能交付",
          );
          let checks = args.checks, findings, manifest;
          if (task.verification) {
            const git = this.verifyScope(s, task);
            checks = task.verification.checks.filter((check) => !leadCheck(check)).map((check) => {
              const job = verify(this.validCheck(s, task, check), "evidence-missing", "缺少通过且仍有效的程序检查：" + check.id);
              return this.checkReference(check, job);
            });
            findings = threeDimensions(args.dimensions, checks);
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
              files: changed.map((file) => ({ file, fingerprint: fingerprint(root, [file]) })),
              testChanges: changed.filter((file) =>
                originallyTracked.has(file.toLowerCase()) && coversPath(task.verification.testWrites, file)),
            };
          } else {
            need(Array.isArray(checks) && checks.length && checks.every((c) =>
              typeof c.command === "string" && c.command.trim() && c.exitCode === 0 &&
              typeof c.evidence === "string" && c.evidence.trim()), "请提供通过的必要检查 command/exitCode/evidence");
            if (task.dimensionsRequired || args.dimensions !== undefined) findings = threeDimensions(args.dimensions);
          }
          const candidate = this.hash(s, task);
          const report = {
            id: id(),
            revision: task.revision,
            candidate,
            summary: text(args.summary, "交付说明"),
            developerId: currentRole.id, ...handoff,
            checks,
            verificationMode: verificationMode(task),
            ...(manifest && { manifest }),
            ...(findings && { dimensions: findings }),
            at: Date.now(),
          };
          task.reports.push(report);
          task.candidate = candidate;
          task.reportedAt = report.at;
          task.state = task.risk === "high" ? "waiting_review" : task.verification ? "waiting_verification" : "ready";
          task.assignee = null;
          this.retire(s, task.id);
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
          need(args.verdict !== "pass" || !handoff.openItems?.some((item) => item.blocking), "审查通过不能含阻塞项，请用 verdict=changes");
          let dimensions, testReview, classification;
          if (task.verification) {
            if (args.verdict === "pass") {
              this.verifyScope(s, task);
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
          need(
            [
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
          if (task.batchId) {
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
          task.revision++;
          need(args.adjustScope === undefined || typeof args.adjustScope === "boolean", "adjustScope 必须为布尔值");
          task.state = args.adjustScope ? "paused" : "queued";
          task.waitReason = args.adjustScope ? "等待主控在原票调整范围" : null;
          task.assignee = task.developerId;
          task.candidate = null;
          task.controllerEvidence = null;
          task.deliveredAt = null;
          task.reviewDeliveredAt = null;
          task.reportedAt = null;
          task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
          task.reworkReason = text(args.reason, "返工原因");
          this.retire(s, task.id);
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
          if (task.verification) {
            this.verifyScope(s, task);
            const checks = this.assertDeliveryProof(s, task, true);
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
              limits: text(decision.limits, "主控核对后的剩余限制"), by: currentRole.id, at: Date.now() };
            if (task.risk !== "high") {
              if (testReview) task.controllerEvidence.testReview = testReview;
            }
          }
          if (task.batchId) this.verifyBatchReceipt(s, task);
          verify(
            this.hash(s, task) === task.candidate,
            "contract-invalid",
            "候选输入已变化，需重新交付",
          );
          task.trialInstructions = text(args.instructions, "试用步骤");
          task.state = "trial";
          const notes = task.verification ? planningSourceNotes(find(s.projects, task.projectId).root, task, s.plans.find((item) => item.id === task.planId)) : [];
          result = { state: "awaiting_user", verificationMode: verificationMode(task), ...(notes.length && { sourceNotes: notes }) };
          break;
        }
        case "accept": {
          ui();
          const task = find(s.tasks, args.taskId);
          requireContract(task);
          need(task.state === "trial", "请先由主控汇总试用步骤");
          if (task.verification) {
            this.verifyScope(s, task);
            this.assertDeliveryProof(s, task, true);
          }
          if (task.batchId) this.verifyBatchReceipt(s, task);
          verify(
            this.hash(s, task) === task.candidate,
            "contract-invalid",
            "试用候选已变化，不能验收旧候选",
          );
          task.acceptance = text(args.evidence, "试用验收记录");
          task.state = "accepted";
          result = { state: "accepted" };
          break;
        }
        case "question": {
          const task = find(s.tasks, args.taskId);
          need(
            currentRole &&
              [task.developerId, task.assignee].includes(currentRole.id),
            "仅责任成员可提问",
          );
          const question = {
            id: id(),
            from: currentRole.id,
            text: text(args.text, "问题"),
            answer: null,
          };
          task.questions.push(question);
          this.notice(
            s,
            controller(s, task.projectId).id,
            "question:" + question.id,
            "任务阻塞：" + question.text,
            task.id,
          );
          result = { state: "stored", questionId: question.id };
          break;
        }
        case "answer": {
          const task = find(s.tasks, args.taskId);
          lead(task.projectId);
          const q = find(task.questions, args.questionId);
          need(!q.answer, "问题已经答复");
          q.answer = text(args.text, "答复");
          q.answeredBy = currentRole.id;
          this.notice(
            s,
            q.from,
            "answer:" + q.id,
            "主控答复：" + q.answer,
            task.id,
          );
          result = { state: "stored" };
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
      if (command !== "check" || !args.async) this.schedule(s);
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
    return role?.kind === "controller" && ["dispatch", "dispatchPlan", "check"].includes(command)
      ? { ...receipt, turnRule: CONTROLLER_TURN_RULE }
      : receipt;
  }
  hash(s, task) {
    return fingerprint(find(s.projects, task.projectId).root, [
      ...task.writes,
      ...task.reads,
      ...(task.verification?.checks.flatMap((check) => check.inputs) ?? []),
    ]);
  }
  resumeSilentTask(s, task, role, reason) {
    const result=resumeTask(s,task,role,reason);
    this.retire(s,task.id);
    for(const wake of s.wakes) if(wake.roleId===task.developerId&&wake.state!=="consumed") {
      wake.state="consumed";wake.supersededAt=Date.now();
    }
    return result;
  }
  sourceInput(root, task) {
    return fingerprint(root, task.writes, task.verification.testWrites);
  }
  foreignWrites(s, task) {
    return this.foreignWriteOwners(s, task).flatMap(({ writes }) => writes);
  }
  foreignWriteOwners(s, task) {
    return s.tasks.filter((peer) => !releasedTaskScope(peer) && peer.id !== task.id && peer.projectId === task.projectId && peer.admittedAt &&
      (peer.admittedAt >= (task.admittedAt ?? Date.now()) || occupied(peer) || task.concurrentPeers?.includes(peer.id)))
      .map((peer) => ({ taskId: peer.id, ticketKey: peer.ticketKey, writes: [...peer.writes, ...(peer.scheduleHistory ?? []).flatMap((record) => record.previous.writes)] }));
  }
  verifyScope(s, task) {
    try { return assertScope(find(s.projects, task.projectId).root, task, this.foreignWrites(s, task), this.ownershipGit(s, task)); }
    catch(error) {
      if(error.message.includes('Git HEAD、分支或暂存区已变化')) {
        const diagnosis=this.diagnoseTask(s,task);
        const rerun=task.verification.checks.filter(check=>check.stage!=='red').map(check=>check.id);
        error.message+='；保留当前文件，先按诊断确认提交；不可证明内容等价时 rework adjustScope=true → rebindCommittedWork，随后重跑：'+rerun.join('、')+
          '；nextAction='+JSON.stringify(diagnosis.nextAction)+'；afterStop='+JSON.stringify(diagnosis.afterStop??null);
        error.violations=[{path:'baseline',message:'冻结 Git 基线漂移',expected:{head:task.baseline?.head},remedy:{nextAction:diagnosis.nextAction,afterStop:diagnosis.afterStop,rerunCheckIds:rerun}}];
      }
      throw error;
    }
  }
  confirmCommit(s, task, args, role, operationId) {
    verify(task.candidate&&['waiting_verification','waiting_review','reviewing','waiting_batch','ready','trial'].includes(task.state),
      'contract-invalid','confirmCommit 仅确认已交付候选的等价提交；没有候选时请 diagnoseTask 后沿原 rebindCommittedWork 路径重跑。');
    const reason=text(args.reason,'确认提交依据'),root=find(s.projects,task.projectId).root;
    const git=this.ownershipGit(s,task),drift=baselineDrift(root,task,git,[...task.writes,...readsFor(task)]);
    verify(drift&&args.expectedBase===drift.from&&args.expectedHead===drift.to,'contract-invalid','确认的基线或 HEAD 已变化，请重新 diagnoseTask');
    const plan=s.plans.find(item=>item.id===task.planId),notes=planningSourceNotes(root,task,plan),records=recordedBaselineChanges(root,task,plan,git,drift);
    const paths=this.committedRebindScope(s,task,root,git,drift,notes,records);
    verify(!notes.length&&!records.length,'contract-invalid','规划来源有追加或基线记录待确认，请沿原 diagnoseTask/rebindCommittedWork 显式核对，不自动接纳。');
    verify(JSON.stringify(scopePaths(args.paths))===JSON.stringify(scopePaths(paths)),'contract-invalid','paths 必须精确对应诊断的提交重叠路径');
    verify(this.hash(s,task)===task.candidate,'contract-invalid','提交内容与已交付候选指纹不等价，不能保留原检查；请沿原票重新交付并重跑绿/完整检查。');
    const preserved=this.assertDeliveryProof(s,task).map(proof=>proof.jobId),previous={baseline:structuredClone(task.baseline)};
    const evidenceBase=this.evidenceBase(task),old=task.baseline;
    const baseline={...scopeBaseline(root,task,this.foreignWrites(s,task),git),sources:old.sources,tests:old.tests,
      deliveryBase:old.deliveryBase??old.head,evidenceBase};
    const current=this.ownershipGit(s,task);
    verify(current.head===git.head&&current.branch===git.branch&&current.index===git.index&&JSON.stringify(current.dirty)===JSON.stringify(git.dirty)&&
      this.hash(s,task)===task.candidate,'contract-invalid','核对期间 Git 或候选输入变化，确认已停止；请重新 diagnoseTask');
    task.baseline=baseline;
    const audit={from:drift.from,to:drift.to,paths,reason,by:role.id,at:Date.now(),preservedChecks:preserved,origin:'controller-confirmed'};
    task.confirmedCommit=audit;(task.scheduleHistory??=[]).push({previous,...audit,confirmedCommit:true});
    return {state:'applied',taskId:task.id,operationId,...audit,scannedFiles:git.ownershipMetrics?.scannedFiles??0};
  }
  ownershipGit(s, task) {
    return gitState(find(s.projects, task.projectId).root, task, executionPolicy(this.execution, task.projectId).ownershipIgnores);
  }
  releaseSchedule(s, role, args) {
    const task = find(s.tasks, args.taskId);
    need(role?.kind === "controller" && role.projectId === task.projectId, "仅本项目主控可释放原票范围");
    assertStoppedTask(s, task);
    const audit = { reason: text(args.reason, "释放原因"), by: role.id, at: Date.now() };
    const git = this.scopeReleaseGit(s, task);
    const result = releaseStoppedScope(s, task, git, audit);
    this.retire(s, task.id);
    return result;
  }
  scopeReleaseGit(s, task) {
    if (!originalTaskWrites(task).length) return { dirty: [] };
    const git = this.ownershipGit(s, { ...task, writes: originalTaskWrites(task) });
    return includeIgnoredScopeWrites(find(s.projects, task.projectId).root, task, git);
  }
  committedRebindScope(s, task, root, git, drift, sourceNotes, records = []) {
    const reject = (message) => verify(false, "contract-invalid", message + "；请用 diagnoseTask 核对原票");
    if (!task.verification || !task.baseline ||
        !["assigned", "rework", "paused", "changes_requested", "ready", "trial", "waiting_review", "waiting_verification", "waiting_batch", "reviewing"].includes(task.state))
      reject("仅支持未验收且仍有原责任的实施票");
    if (!drift || drift.from === drift.to || (!drift.conflicts.length && !records.length)) reject("没有写集内提交或冻结时未提交的规划记录，请用普通基线对账");
    if (drift.gitBlocker) reject(drift.gitBlocker);
    if (git.branch === "HEAD") reject("游离 HEAD 无法确认原分支");
    const unmanaged = committedDirtyBaselinePaths(task, drift);
    if (unmanaged.length) reject("提交包含原基线已有的未归属改动：" + summarizePaths(unmanaged));
    const observedOnly = drift.conflicts.filter((file) => !coversPath(task.writes, file));
    if (observedOnly.length) reject("提交触及只读输入：" + summarizePaths(observedOnly));
    if (drift.conflicts.length && JSON.stringify(task.baseline.cleanWrites) !== JSON.stringify(task.writes))
      reject("无法证明原始写集在基线建立时干净且范围未变");
    const dirty = git.dirty.filter((file) => coversPath(task.writes, file) || overlaps([file], readsFor(task)));
    if (dirty.length) reject("冻结路径工作树仍有残留：" + summarizePaths(dirty));
    const changedSources = sourceNotes.filter((note) => note.kind !== "source-appended");
    if (changedSources.length) reject("规划来源已变化（非纯追加）：" + summarizePaths(changedSources.map((note) => note.file)));
    const unproven = records.filter((note) => !note.proven);
    if (unproven.length) reject("无法证明已入库规划记录只追加记录正文：" + summarizePaths(unproven.map((note) => note.file)));
    if (records.length && git.dirty.length) reject("工作树仍有未提交文件，请保留改动并核对归属：" + summarizePaths(git.dirty));
    if (s.checkJobs.some((job) => jobIncludes(job, task.id) && activeCheck(job))) reject("仍有未完成检查，请等待或对账原作业");
    const conflict = s.tasks.filter((peer) => peer.id !== task.id && activeScope(peer))
      .map((peer) => this.scopeConflict(s, task, peer)).find(Boolean);
    if (conflict) reject(conflict.message);
    assertOutsideScope(root, task, this.foreignWrites(s, task), git);
    for (const check of task.verification.checks.filter((item) => item.stage === "red"))
      if (drift.conflicts.length && !this.validCheck(s, task, check)) reject("历史红证据缺失或输入变化：" + check.id);
    return drift.conflicts;
  }
  diagnoseTask(s, task) {
    const action = (command, fields = {}) => ({ command, args: { taskId: task.id, ...fields } });
    let sourceNotes = [];
    const result = (classification, reason, nextAction, extra = {}) => ({
      taskId: task.id, state: task.state, classification, reason, nextAction, ...(sourceNotes.length && { sourceNotes }), ...extra,
    });
    if (task.state === "superseded") return result("superseded", "原票已被替代，全部调度范围已释放；历史证据保留，不代表已验收。",
      { command: "inspect", args: { taskId: task.supersededBy } }, { supersededBy: task.supersededBy });
    if(task.state==='abandoned') return result('abandoned','原票已终止，范围已释放，历史保留；不代表已验收。',null,{abandonment:task.abandonment});
    if (task.releasedScope) return result("scope-released", "原票范围已释放且不再准入，剩余工作由后继票承担；冻结证据保留。", action("inspect"));
    if (task.deliveryIssue && ["assigned", "rework", "paused"].includes(task.state))
      return result("session-recovery-needed", task.deliveryIssue.detail, action("resumeTask", { reason: "宿主会话已恢复，沿原票重新准入与投递" }), { deliveryIssue: task.deliveryIssue });
    if (task.state === "queued" && task.scopeConflict) {
      const conflict = task.scopeConflict;
      const nextAction = conflict.kind === "read-scope-unknown" && task.readScopeKnown === false
        ? action("reviseSchedule", { reason: "补齐实际读集", reads: ["替换为实际读取的相对路径"] }) : conflict.nextAction ?? action("inspect");
      return result("scope-conflict", conflict.message ?? task.waitReason, nextAction, { scopeConflict: conflict });
    }
    if (!task.verification) return task.readOnly === true
      ? result("read-only", "只读票不适用原生实施门槛", null)
      : result("contract-invalid", "旧实施票缺少冻结契约，保留历史；剩余工作使用 dispatchPlan 建立后继票", { command: "guide", args: {} });
    if (task.state === "accepted") return result("accepted", "保留原验收结论；当前工作区不代表历史候选", null);
    if (!task.baseline) return result(task.preflightFailure?.classification ?? "waiting-admission",
      task.waitReason ?? "等待建立冻结基线", action("inspect"));
    const root = find(s.projects, task.projectId).root;
    try {
      sourceNotes = planningSourceNotes(root, task, s.plans.find((item) => item.id === task.planId));
      const git = this.ownershipGit(s, task);
      const drift = baselineDrift(root, task, git, [...task.writes, ...readsFor(task)]);
      if (drift) {
        const records = recordedBaselineChanges(root, task, s.plans.find((item) => item.id === task.planId), git, drift);
        const status = git.shortStatus.slice(0, 20);
        const gitContext = { shortStatus: status, statusCount: git.shortStatus.length };
        const explicit = drift.conflicts.length || records.length;
        let blockingCondition = drift.blockingCondition;
        const blockingConditions = [];
        const unmanaged = committedDirtyBaselinePaths(task, drift);
        if (unmanaged.length) {
          blockingCondition ??= "提交包含原基线已有的未归属改动：" + summarizePaths(unmanaged);
          blockingConditions.push({ condition: "unowned-dirty-baseline", paths: unmanaged.slice(0, 8), pathCount: unmanaged.length, remedy: action("inspect"), effect: "查看原基线并人工核实归属；保留现有文件及提交" });
        }
        if (drift.gitBlocker) blockingConditions.push({ condition: "git-baseline-unsafe", reason: drift.gitBlocker, remedy: action("inspect"), effect: "核对冻结分支和基线；程序不改变 Git 历史" });
        if (drift.conflicts.length) blockingConditions.push({ condition: "committed-scope-overlap", paths: drift.conflicts.slice(0, 8), pathCount: drift.conflicts.length });
        const changedSources = sourceNotes.filter((note) => note.kind !== "source-appended");
        if (records.length) blockingConditions.push({ condition: "recorded-baseline", paths: records.map((item) => item.file),
          remedies: sourceNotes.filter((note) => records.some((item) => item.file === note.file)).map((note) => note.nextAction), effect: "对照冻结正文，证明仅追加记录后逐文件确认指纹" });
        if (explicit && changedSources.length) blockingConditions.push({ condition: "requirement-sources-changed", paths: changedSources.map((note) => note.file), remedies: changedSources.map((note) => note.nextAction) });
        if (explicit) {
          try {
            const overlap = this.committedRebindScope(s, task, root, git, drift, sourceNotes, records);
            if(task.candidate&&!sourceNotes.length&&!records.length&&this.hash(s,task)===task.candidate) {
              this.assertDeliveryProof(s,task);
              return result('baseline-drift-content-equivalent','提交内容与已交付候选等价，可由主控显式确认并保留检查；提交者身份没有可核对记录，不作推断。',
                action('confirmCommit',{expectedBase:drift.from,expectedHead:drift.to,paths:overlap,reason:'核对候选内容与提交完全等价'}),
                {...drift,...gitContext,origin:'unattributed',preservableChecks:true});
            }
            const resume = action("rebindCommittedWork", { reason: "主控核对提交差异与原票写集归属后沿原票重绑", expectedBase: drift.from, expectedHead: drift.to, confirmPaths: overlap,
              ...(sourceNotes.length && { confirmSourceAppends: Object.fromEntries(sourceNotes.map(({ file, toDigest }) => [file, toDigest])) }),
              ...(records.length && { confirmRecordedBaseline: Object.fromEntries(records.map(({ file, toDigest }) => [file, toDigest])) }) });
            for (const item of blockingConditions) item.remedy = resume;
            const stopped = task.state === "paused";
            const next = stopped ? resume : ["assigned", "rework"].includes(task.state)
              ? action("yieldForSchedule", { reason: "写集已提交，停写后交主控核对归属" })
              : action("rework", { reason: "归档旧交付证据，暂停并核对提交归属", adjustScope: true });
            return result(records.length && !drift.conflicts.length ? "baseline-drift-record-rebindable" : "baseline-drift-owned-rebindable", "主控显式确认后可沿原票重绑，须用新 HEAD 的绿与完整检查",
              next,
              { ...drift, ...gitContext, blockingConditions, ...(records.length && { recordedBaseline: records }),
                recovery: { candidate: resume, executable: false, requiredParameters: ["reason"], remainingBlockers: stopped ? [] : ["先交回并暂停原票"],
                  effect: "保留原票及历史；更新基线，要求新的绿及完整检查" },
                ...(stopped ? {} : { afterStop: resume }) });
          } catch (error) {
            blockingCondition = [drift.blockingCondition, error.message].filter(Boolean).join("；");
            if (!changedSources.length && !drift.gitBlocker && !unmanaged.length) {
              const dirtyPaths = git.dirty.slice(0, 8);
              blockingConditions.push({ condition: "owned-rebind-precondition", reason: error.message,
                ...(dirtyPaths.length && { paths: dirtyPaths, pathCount: git.dirty.length }), remedy: action("inspect"),
                effect: "保留当前文件；核对原票和 Git 状态，剩余业务改动另行确认处理" });
            }
          }
        }
        if (!blockingCondition) {
          try { assertOutsideScope(root, task, this.foreignWrites(s, task), git); }
          catch (error) { blockingCondition = error.message; }
        }
        const unconfirmed = git.dirty.filter((file) => coversPath(task.writes, file) && !task.ownedDirty.includes(file));
        if (!blockingCondition && unconfirmed.length) blockingCondition = "须先核实已有改动归属并填写 ownedDirty：" + unconfirmed.join("、");
        const refresh = action("reviseSchedule", { reason: "核对后重绑 Git 基线", refreshBaseline: true, expectedHead: drift.to });
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
            ...(blockingCondition && { resolution: "保留当前文件和原票证据。只有取得新的范围授权、核对规划与派发参数后，才能用 previewPlan 和 dispatchPlan 建立后继票；当前诊断不会生成重建命令。" }),
            ...(nextAction && nextAction !== refresh && { afterStop: refresh }) });
      }
      assertOutsideScope(root, task, this.foreignWrites(s, task), git);
      if (task.candidate) verify(this.hash(s, task) === task.candidate, "contract-invalid", "候选输入已变化，须按原票重新交付");
      const checkBlocker = (check) => {
        const input = this.checkInput(root, task, check);
        const job = s.checkJobs.findLast((item) => item.taskId === task.id && item.check.id === check.id &&
          item.revision === task.revision && item.input === input);
        return result(job?.classification ?? "evidence-missing", `检查 ${check.id}：${job?.error ?? "缺少有效回执"}`,
          job?.classification === "environment-failed" ? job.nextAction : job ? { command: activeCheck(job) ? "checkStatus" : "checkEvidence", args: activeCheck(job) ? { taskId: task.id } : { jobId: job.id } }
            : action("check", { checkId: check.id }), { blocker: "checks-missing", checkId: check.id,
              ...(job?.environmentFailure && { environmentFailure: true, environmentFailureReason: job.environmentFailureReason,
                hint: job.hint, membersCanRetry: job.membersCanRetry }) });
      };
      if (task.state === "changes_requested") {
        const review = task.reviews.at(-1);
        return result(review?.classification ?? "evidence-missing", review?.findings ?? "审查未通过", action("inspect"));
      }
      for (const check of task.verification.checks.filter((item) => !leadCheck(item))) {
        if (!this.validCheck(s, task, check)) return checkBlocker(check);
      }
      if (!task.candidate) return result("evidence-missing", "尚未提交同候选的交付报告", action("inspect"));
      this.assertDeliveryProof(s, task);
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
        this.assertDeliveryProof(s, task, true);
        if (task.batchId) this.verifyBatchReceipt(s, task);
        return result(task.state === "trial" ? "awaiting-user" : "ready", task.state === "trial" ? "待用户试用验收" : "当前候选证据满足程序门槛，待主控汇总", action("inspect"));
      }
      return result("evidence-missing", task.waitReason ?? "当前流程尚未达到交付门槛", action("inspect"));
    } catch (error) {
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
    verify(this.hash(s, task) === task.candidate, "contract-invalid", "候选输入已变化，不能复用旧证据；请沿原票重新交付");
    const report = task.reports.findLast((item) => item.revision === task.revision && item.candidate === task.candidate);
    const review = task.reviews.findLast((item) => item.candidate === task.candidate &&
      (item.revision === undefined ? report && item.at >= report.at : item.revision === task.revision));
    const batchJob = task.batchReceiptId && s.checkJobs.find((job) => job.id === task.batchReceiptId);
    let batchValid = false;
    if (batchJob) {
      try { this.verifyBatchReceipt(s, task); batchValid = true; } catch { /* Leave stale batch evidence marked invalid. */ }
    }
    const result = { taskId: task.id, candidate: task.candidate, head: git.head, reportId: report?.id,
      planning: task.sources, sourceNotes: planningSourceNotes(root, task, s.plans.find((item) => item.id === task.planId)),
      files: report?.manifest?.files ?? [], testChanges: report?.manifest?.testChanges ?? [],
      acceptance: task.verification.acceptance,
      independentReview: { required: task.risk === "high", ...(review && { verdict: review.verdict, reportId: review.id }) },
      ...(task.batchId && { batch: { batchId: task.batchId, valid: batchValid,
        ...(batchValid && { evidence: { command: "checkEvidence", args: { jobId: batchJob.id } } }) } }),
      checks: task.verification.checks.map((check) => {
        const job = this.validCheck(s, task, check);
        const reusable = Boolean(job && (leadCheck(check) || report?.checks.some((proof) => proof.jobId === job.id)));
        return { id: check.id, stage: check.stage, argv: check.argv, covers: check.covers, inputs: check.inputs,
          expectedExit: check.expectedExit, expectedOutput: check.expectedOutput, failureOutput: check.failureOutput,
          reusable, owner: leadCheck(check) ? "controller" : "developer",
          ...(reusable && { exitCode: job.receipt?.exitCode, evidenceHead: JSON.parse(job.input)[0], evidence: { command: "checkEvidence", args: { jobId: job.id } } }) };
      }),
    };
    if (args.file !== undefined) {
      const [file] = scopePaths([args.file]);
      verify(result.files.some((entry) => entry.file === file), "contract-invalid", "只可查看候选交付清单中的相对路径");
      result.change = candidateDiff(root, git, file, report?.manifest?.deliveryBase);
      verify(this.hash(s, task) === task.candidate && gitState(root).head === git.head,
        "contract-invalid", "读取差异期间候选或 Git HEAD 已变化");
    }
    return result;
  }
  checkReference(check, job) {
    return { checkId: check.id, stage: check.stage, covers: check.covers, jobId: job.id, output: job.output };
  }
  evidenceBase(task) {
    // An approved clean forward rebind updates the Git gate, not the identity of unchanged evidence.
    return task.baseline.evidenceBase ?? [task.baseline.head, task.baseline.index];
  }
  checkInput(root, task, check) {
    return JSON.stringify([...this.evidenceBase(task),
      fingerprint(root, this.checkPaths(task, check))]);
  }
  checkPaths(task, check) {
    return [...new Set([...task.writes, ...task.reads, ...check.inputs])];
  }
  checkResponsibility(task, check, role) {
    need(leadCheck(check)
      ? role.kind === "controller" && task.state === "waiting_verification"
      : role.id === task.developerId && ["assigned", "rework"].includes(task.state),
    "该检查不属于当前角色或阶段");
  }
  checkPrerequisites(s, task, check, root) {
    if (check.stage === "red")
      need(task.baseline.sources === this.sourceInput(root, task), "红阶段必须在实现文件未变化时运行");
    if (["green", "full"].includes(check.stage))
      need(task.verification.checks.filter((entry) => entry.stage === "red").every((entry) => this.validCheck(s, task, entry)), "先完成可核对的预期失败检查");
    if (["full", "regression"].includes(check.stage))
      need(task.verification.checks.filter((entry) => entry.stage === "green").every((entry) => this.validCheck(s, task, entry)), "先完成对应的局部绿阶段");
    if (leadCheck(check)) this.assertDeliveryProof(s, task);
  }
  redProof(root, task, check) {
    return fingerprint(root, [...task.verification.testWrites, ...check.inputs.filter((file) => !overlaps([file], task.writes))]);
  }
  intactOutput(job) {
    try {
      return job.output && createHash("sha256").update(readFileSync(job.output)).digest("hex") === job.receipt?.outputHash;
    } catch {
      return false;
    }
  }
  validCheck(s, task, check) {
    const root = find(s.projects, task.projectId).root;
    const red = check.stage === "red";
    const input = red ? this.redProof(root, task, check) : this.checkInput(root, task, check);
    return s.checkJobs.findLast((job) => job.taskId === task.id && job.check.id === check.id &&
      job.state === "passed" && !job.receipt?.environmentFailure && (red || artifactsIntact(root, job.receipt?.preparation)) && (red ? (job.redProofVersion === 2
        ? job.redProof === redEvidence(root, task, check, job.redImplementationBaseline, 2).redProof &&
          job.redTestProof === fingerprint(root, task.verification.testWrites)
        : job.redProof === input) : job.input === input) &&
      (!red || this.intactOutput(job) && redReceiptValid(check, job.receipt, readFileSync(job.output, "utf8"))) &&
      (!leadCheck(check) || job.revision === task.revision) && this.intactOutput(job));
  }
  assertDeliveryProof(s, task, final = false) {
    verify(this.hash(s, task) === task.candidate, "contract-invalid", "候选输入已变化，需重新交付");
    const report = task.reports.findLast((item) => item.revision === task.revision && item.candidate === task.candidate);
    const checks = [];
    for (const check of task.verification.checks) {
      if (leadCheck(check) && !final) continue;
      const job = this.validCheck(s, task, check);
      verify(job && (leadCheck(check) || report?.checks.some((proof) => proof.jobId === job.id)),
        "evidence-missing", "交付证据缺失、失效或已变化：" + check.id);
      checks.push(this.checkReference(check, job));
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
      if (job.batchId) {
        try {
          const batch = find(s.validationBatches, job.batchId);
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
        const scope = this.verifyScope(s, task);
        const input = this.checkInput(project.root, task, job.check);
        if (task.verification.browserE2E) assertCheckOwnership(project.root, job.check, task.verification.browserE2E);
        if (job.preparing) {
          this.checkResponsibility(task, job.check, activeRole(s, job.requester));
          const cached = this.validCheck(s, task, job.check);
          if (cached) {
            Object.assign(job, { state: "reused", reusedJobId: cached.id, finishedAt: Date.now(), ownership: scope.ownershipMetrics });
            delete job.preparing;
            this.notice(s, job.requester, `check:${job.id}:reused`, `复用有效检查记录 ${cached.id}：${task.title}`, task.id);
            return null;
          }
          this.checkPrerequisites(s, task, job.check, project.root);
          Object.assign(job, { input, ownership: scope.ownershipMetrics });
          const notes = planningSourceNotes(project.root, task, s.plans.find((item) => item.id === task.planId));
          if (notes.length) job.sourceNotes = notes;
          if (job.check.stage === "red") Object.assign(job, redEvidence(project.root, task, job.check));
          delete job.preparing;
        } else verify(input === job.input, "contract-invalid", "检查输入在启动前已变化");
      } catch (error) {
        this.closeCheck(s, job, { state: "stale", error: error.message, classification: error.verificationCode ?? "evidence-missing" });
        return null;
      }
      job.state = "launching";
      job.startedAt = Date.now();
      return job;
    });
  }
  closeCheck(s, job, result) {
    this.classifyCheck(job, result);
    Object.assign(job, result, { finishedAt: Date.now() });
    const task = find(s.tasks, job.taskId);
    const independent = leadCheck(job.check);
    if (independent && job.state === "passed" && task.state === "waiting_verification" &&
      task.verification.checks.filter(leadCheck).every((check) => this.validCheck(s, task, check))) {
      task.state = task.batchId ? "waiting_batch" : "ready";
      task.waitReason = null;
    }
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
            verify(!receipt.stale && this.batchInput(s, find(s.validationBatches, job.batchId)) === job.input,
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
          this.verifyScope(s, task);
          verify(!receipt.stale && task.revision === job.revision && this.checkInput(job.root, task, job.check) === job.input,
            "contract-invalid", "检查期间输入已变化");
          if (leadCheck(job.check)) this.assertDeliveryProof(s, task);
          if (this.passed(job, receipt, output))
            result.state = "passed";
        } catch (error) {
          result.state = "stale";
          result.error = error.message;
          result.classification = error.verificationCode;
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
    if (result.state === "failed" && result.environmentFailure) {
      Object.assign(result, { classification: "environment-failed", error: environment.reason, ...environmentRetry(job) });
      return;
    }
    if(result.state==='failed'&&receipt?.evidenceKind==='test'&&!receipt.testCaseSeen) {
      Object.assign(result,{classification:'evidence-missing',reason:receipt.evidenceReason,error:receipt.evidenceReason,
        membersCanRetry:!job.batchId,nextAction:{command:'check',args:{taskId:job.taskId,checkId:job.check.id}}});
      return;
    }
    if (job.check.stage === "red" && result.state === "failed" && this.intactOutput(result) &&
        !redReceiptValid(job.check, receipt, readFileSync(result.output, "utf8")))
      result.error ??= '红证据无效：' + redEvidenceRequirement(result.evidenceKind) + '；failureOutputSeen 必须为 true。保持实现基线，重跑同一 red 检查。';
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
    return JSON.stringify([versions, fingerprint(root, this.batchFiles(s, batch))]);
  }
  verifyBatchReceipt(s, task) {
    const batch = find(s.validationBatches, task.batchId);
    const job = find(s.checkJobs, task.batchReceiptId);
    verify(job.state === "passed" && this.intactOutput(job), "evidence-missing", "累计检查证据已失效");
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
    return scopeConflict(task, peer, peerRole);
  }
  schedule(s, now = Date.now()) {
    this.scheduleBatches(s);
    for (const task of s.tasks) {
      if (task.state === "queued") {
        const conflicts = s.tasks.filter((peer) => peer.id !== task.id && activeScope(peer));
        const blocked = task.dependencies.find((dep) => {
          const predecessor = find(s.tasks, dep);
          if (task.dependencyStages?.[dep] === "accepted") return predecessor.state !== "accepted";
          if (verificationMode(predecessor) === "missing-contract") return true;
          if (!terminalDependency.includes(predecessor.state)) return true;
          const historical=task.dependencyReceipts?.[dep]??recoverAdmittedDependency(task,predecessor,s.checkJobs,job=>this.intactOutput(job));
          if(historical)(task.dependencyReceipts??={})[dep]=historical;
          if(dependencyReceiptValid(historical,predecessor,s.checkJobs,job=>this.intactOutput(job))) return false;
          try {
            if (predecessor.batchId) this.verifyBatchReceipt(s, predecessor);
            if (predecessor.verification) {
              if (predecessor.state !== "accepted") this.verifyScope(s, predecessor);
              this.assertDeliveryProof(s, predecessor, true);
            }
            const proofs=predecessor.verification?this.assertDeliveryProof(s,predecessor,true).map(proof=>find(s.checkJobs,proof.jobId)):[];
            if(predecessor.batchReceiptId)proofs.push(find(s.checkJobs,predecessor.batchReceiptId));
            (task.dependencyReceipts??={})[dep]=dependencyReceipt(predecessor,proofs,now);
            return false;
          } catch {
            return true;
          }
        });
        const conflict = !blocked && conflicts.map((peer) => this.scopeConflict(s, task, peer)).find(Boolean);
        task.scopeConflict = conflict || null;
        let reason = blocked
          ? "等待前置：" + (find(s.tasks, blocked).ticketKey ?? blocked) + " · " + (task.dependencyStages?.[blocked] === "accepted" ? "用户验收" : "有效验证")
          : conflicts.some((t) => t.assignee === task.developerId && !["paused", "queued"].includes(t.state))
            ? "开发者已有责任"
            : conflict
              ? conflict.message
              : null;
        const target = s.roles.find((role) => role.id === task.developerId);
        const unavailable = target && dispatchAvailability(target);
        if (!reason && target?.resumeTaskAfter) reason = "等待成员恢复后的新心跳，再重新准入";
        if (!reason && ["offline", "unbound", "disabled", "jobs-unknown"].includes(unavailable))
          reason = deliveryLabels[unavailable];
        if (!reason && s.checkJobs.some((job) => job.batchId && activeCheck(job) &&
          ((job.projectId === task.projectId && overlaps(task.writes, job.files)) ||
            task.resources.some((resource) => job.check.resources.includes(resource)))))
          reason = "等待累计检查释放输入或共享资源";
        const oldFailure = task.preflightFailure;
        if (!reason && task.verification && oldFailure?.version === (task.scheduleVersion ?? 0) &&
            now - (oldFailure.checkedAt ?? 0) < 30000)
          reason = oldFailure.reason;
        if (!reason && task.verification) {
          try {
            const project = find(s.projects, task.projectId);
            if (task.baseline) this.verifyScope(s, task);
            else {
              task.concurrentPeers = s.tasks.filter((peer) => peer.id !== task.id && peer.projectId === task.projectId && occupied(peer)).map((peer) => peer.id);
              task.baseline = scopeBaseline(project.root, task, this.foreignWrites(s, task), this.ownershipGit(s, task));
            }
          } catch (error) {
            reason = error.message;
            task.preflightFailure = { version: task.scheduleVersion ?? 0, checkedAt: now, reason, classification: error.verificationCode ?? "evidence-missing" };
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
            "开发任务：" + task.title,
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
            dispatchAvailability(r) === null &&
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
            `review:${task.id}:${task.revision}`,
            "独立审查：" + task.title,
            task.id,
          );
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
    return { sessions: [...new Set(this.store.read().roles.filter(role => !role.archivedAt && providerOf(role) === "dsh" && role.sessionId).map(role => role.sessionId))] };
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
        recordOwnerHeartbeat(role,session,now);
        role.bridgePresent = true;
        role.connectedAt = now;
        role.state = session.state;
        role.pending = session.pending;
        role.jobs = session.jobs;
        if (role.resumeTaskAfter && now >= role.resumeTaskAfter && session.state === "idle" && session.pending === 0 && session.jobs === 0) delete role.resumeTaskAfter;
        recordObservation(role, session, now);
        const wake = s.wakes.find(
          (w) => w.roleId === role.id && w.state !== "consumed",
        );
        role.deliveryIssue = wake?.state !== "pending" ? null : Array.isArray(session.deliveryIssueWakeIds)
          ? (session.deliveryIssueWakeIds.includes(wake.id) ? "投递结果待对账；可重新开启角色续接，或在原会话读取 inbox。" : null)
          : (session.deliveryIssue ?? null);
        if (wake?.state === "pending" && Array.isArray(session.deliveryResults)) {
          const data = session.deliveryResults.slice(-30).find((item) => item?.wakeId === wake.id);
          this.trackWakeAttempts(s, wake, data);
          const deliveryStates = { uncertain: "uncertain", exhausted: "retry-limit", retry: "host-rejected" };
          const reason = data?.state === "waiting" && Object.hasOwn(deliveryLabels, data.reason) ? data.reason :
            data?.generation === (wake.deliveryRetry ?? 0) && Object.hasOwn(deliveryStates, data.state) ? deliveryStates[data.state] : null;
          if (reason) {
            wake.diagnostic = { reason, at: Number.isSafeInteger(data.at) ? data.at : wake.at,
              attempt: Number.isSafeInteger(data.attempt) && data.attempt >= 0 && data.attempt <= 4 ? data.attempt : 0 };
            if (["uncertain", "retry-limit"].includes(reason)) {
              const task = s.tasks.find((item) => item.assignee === role.id && ["assigned", "rework", "reviewing"].includes(item.state));
              const lead = controller(s, role.projectId);
              if (lead && lead.id !== role.id) this.notice(s, lead.id, `delivery-blocked:${wake.id}:${wake.deliveryRetry ?? 0}:${reason}`,
                `${role.name}：${deliveryLabels[reason]}`, task?.id);
            }
          } else if (wake.diagnostic?.reason !== "retry-limit" && wake.diagnostic?.reason !== "uncertain") delete wake.diagnostic;
        }
        if (
          wake?.state === "enqueued" &&
          role.state === "idle" &&
          role.pending === 0 &&
          Date.now() - (wake.admittedAt ?? wake.at) > 45000
        ) {
          role.deliveryIssue =
            "短卡已送达但收件箱仍未读取。可点击「续接原会话」，或在原会话读取 inbox。";
        }
      }
      const liveIds = new Set(sessions.map((session) => session.id));
      for (const role of s.roles) if (providerOf(role) === provider && role.sessionId && !liveIds.has(role.sessionId)) role.bridgePresent = false;
      this.schedule(s, now);
      this.normalizeNotices(s);
      recoverLostWakes(s,now,(kind,data)=>this.store.event(kind,data),(role,wake,ageMs)=>{
        const lead=controller(s,role.projectId);
        if(lead) {
          const notice=this.notice(s,lead.id,`wake-stuck:${wake.id}:${wake.deliveryRetry}`,
            `${role.name} 的唤醒超过 ${Math.floor(ageMs/1000)} 秒未读取，已自动安排恢复`,null);
          notice.wakeLossAt=wake.lostAt;
        }
      });
      this.patrol(s, now, liveIds, provider);
      const deliveries = [];
      const blockedReasons=new Map();
      for (const role of s.roles) {
        if(providerOf(role)!==provider)continue;
        const blocked=bridgeToolsBlocker(role)?'bridge-tools-missing':!role.enabled?'role-disabled':
          !liveIds.has(role.sessionId)||now-role.connectedAt>=15000?'role-offline':role.state!=='idle'?'role-running':
          role.pending!==0?'queued-input':!Number.isSafeInteger(role.jobs)||role.jobs<0?'jobs-unknown':role.jobs>0?'background-jobs':null;
        if(blocked){blockedReasons.set(role.id,blocked);continue;}
        if (role.resumeWake) {
          // Replace the transport wake once, only after a fresh idle, empty inbox.
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
        if (!unread.length) continue;
        const selection = selectWakeNotices(s, role, unread);
        if (!selection.actionable) {
          for (const old of s.wakes) if (old.roleId === role.id && old.state === "pending") {
            consumeWake(old,now,'non-actionable-only');
          }
          continue;
        }
        const eligible = selection.notices;
        if (wakeDelay(eligible, role, now, this.execution) > 0) {blockedReasons.set(role.id,'coalescing-window');continue;}
        let wake = s.wakes.find(
          (w) => w.roleId === role.id && activeWake(w),
        );
        if (!wake) {
          wake = {
            id: id(),
            roleId: role.id,
            sessionId: role.sessionId,
            state: "pending",
            noticeIds: eligible.map((n) => n.id),
            at: now,
          };
          s.wakes.push(wake);
        }
        normalizeWake(wake,now);
        mergeWakeNotices(wake,eligible,now);
        if (wake.state === "pending") {
          wake.contextRevision = contextRevision(role);
          wake.contextIncluded = !hasCurrentContext(role);
          const taskIds=[...new Set(eligible.map(notice=>notice.taskId).filter(Boolean))].sort();
          const reportIds=taskIds.filter(taskId=>eligible.some(notice=>notice.taskId===taskId&&/^report(?:-blocked)?:/.test(notice.key)));
          wake.text = wakeText(
            find(s.projects, role.projectId),
            role,
            role.kind === "controller" && controller(s, role.projectId)?.id === role.id,
            [`actionable: true | notices: ${eligible.length} | actionableCount: ${eligible.filter(notice=>notice.actionable).length}`,
              ...reportIds.map(taskId=>{const task=find(s.tasks,taskId);return `${task.ticketKey??task.id.slice(0,8)} · taskId=${task.id} · candidate=${task.candidate?.slice(0,12)??'待生成'}`;}),
              "动态详情",wakeSummary(eligible,s.tasks,s.checkJobs,s.roles),"任务索引",...taskIds.filter(taskId=>!reportIds.includes(taskId)).map(taskId=>{
                const task=find(s.tasks,taskId);return `${task.ticketKey??task.id} · ${task.title}`;
              })].join("\n"),
          );
          wake.payloadGeneration=wake.deliveryRetry;
          Object.assign(wake,promptMetrics(wake.text,wake.contextIncluded,role.toolsVersion));
          deliveries.push({ ...wake });
        }
      }
      for(const role of s.roles.filter(role=>providerOf(role)===provider&&!role.archivedAt)) {
        const selection=selectWakeNotices(s,role,s.notices.filter(notice=>notice.roleId===role.id&&!notice.readAt));
        auditWakeCoverage(s,role,selection,blockedReasons.get(role.id),now,(kind,data)=>this.store.event(kind,data));
      }
      return { deliveries };
    });
  }
  validWake(wakeId, sessionId, generation) {
    const s = this.store.read(),
      wake = s.wakes.find((w) => w.id === wakeId);
    if (!wake) return { valid: false };
    const role = find(s.roles, wake.roleId);
    return {
      valid:
        wake.sessionId === sessionId &&
        role.enabled && connected(role) && !role.resumeWake && !bridgeToolsBlocker(role) &&
        wake.state === "pending" &&
        (generation===undefined?(wake.deliveryRetry??0)===0:generation===(wake.deliveryRetry??0)) &&
        selectWakeNotices(s, role, s.notices.filter(n => n.roleId === role.id && !n.readAt && wake.noticeIds.includes(n.id))).actionable,
    };
  }
  acknowledge(wakeId, sessionId, provider = "dsh", delivery) {
    return this.store.change((s) => {
      const wake = s.wakes.find((w) => w.id === wakeId);
      if (!wake || !activeWake(wake)) return { state: "obsolete" };
      need(providerOf(find(s.roles, wake.roleId)) === provider, "会话类型不匹配");
      need(wake.sessionId === sessionId, "回执会话不匹配");
      if((delivery?.generation??0)!==(wake.deliveryRetry??0))return {state:'obsolete',reason:'stale-generation'};
      need(!bridgeToolsBlocker(find(s.roles, wake.roleId)), "bridge-tools-missing：成员工具未恢复，不能确认送达");
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
        this.logWakeDelivery(s, wake, "delivered", Number.isSafeInteger(delivery?.attempt) && delivery.attempt >= 1 && delivery.attempt <= 4 ? delivery.attempt : 1, wake.admittedAt);
      }
      for (const notice of s.notices.filter((n) =>
        wake.noticeIds.includes(n.id),
      ))
        this.recordDelivery(s, notice, wake.roleId, Date.now());
      return { state: "stored" };
    });
  }
}

export const GUIDE = `LingFlow 仅快速模式。主控沟通、派单、处理例外和汇总。high 自动派独立审查，low/medium 实施票需要主控独立验证。开发、审查分别核对需求、实现和直接系统影响。业务验收由用户完成。写命令必须带稳定 operationId。关闭角色只停止新投递。
${CONTROLLER_TURN_RULE}
参数表（args 是 JSON 对象字符串，也可直接传 JSON 对象；身份来自真实会话，不得自行填写）：
${writeSignatures}
summarize 完整形状示例（用原票实际候选、全部AC与真实核对证据替换示例值）：${JSON.stringify(summarizeExample)}
list {}：角色和任务短卡，已批准需求。assigned 表示已分配；deliveryState=delivered 和 deliveredAt 表示宿主已接收或成员已读取原通知。是否已启动看成员实时 state。
唤醒健康：list/snapshot 的角色卡和任务卡含 wakeHealth={stuck,oldestStuckAgeMs,lastDeliveredAt}。enqueued 只代表宿主已接收，inbox 读取才收口并写 consumedAt。超过120秒未读会记录 wake.delivery_lost 并按新批次重投；运行、排队输入、后台作业和工具缺失继续阻止注入。未覆盖的通知会记录 wake.suppressed，含 blockingWakeId 和原因。
inbox {}：返回本角色全部未读通知，不限于某条 wake.noticeIds；返回后写 readAt，并关闭本角色仍开放的唤醒。notice.actionable 始终为布尔值；纯状态通知仍不单独唤醒主控。
redeliver {taskId,reason?}：主控可重投已送达但成员静默的 assigned/rework 原票，沿 resumeTask 正常准入；真正运行、有排队输入或后台作业时仍拒绝。也可重试宿主明确拒绝且耗尽重试的待投递。其他情况报 no-pending-delivery 并给出后续动作。
context {}：当前项目目录、角色、职责和已保存的身份提示词。每次开启角色或资料更新后，inbox 也会提供一次。
inspect {taskId,section?,offset?,limit?}：默认只回状态、验收条款、检查摘要和最近报告。完整票面显式 section:"full"；baseline.other、全量 checkJobs、reports、reviews、scheduleHistory、acceptance 显式按 section 分页，offset 非负、limit 为 1–200。默认上限190KB；返回 truncated、scanned、totalBytes 与 omitted 查询入口，完整证据保留本地。
deliveryEvidence {taskId,candidate?,file?}：查当前候选可复用检查、命令、覆盖、断言标记及日志入口。file 打开交付清单中单个文件的实际差异；缺项交原责任人。索引不替代独立审查或主控短探针。
diagnoseTask {taskId}：只读核对当前门槛。例：{"taskId":"原票ID"}。返回分类、具体原因及后续命令；HEAD 漂移时列出提交差异和阻塞路径。按原回合规则定向调用。
resumeTask {taskId,reason}：主控恢复会话异常的 assigned/rework/paused 原票。先在宿主恢复会话；成员仍运行、有排队输入、未知或未完作业时拒绝。保留原基线、报告、候选和检查历史，等待新空闲心跳后正常准入及重新投递。不能用该命令绕过归属或验收；原 operationId 重试只取同一回执。
scopePreview {taskId?,writes,reads?,readOnly?,contextReads?,resources?}：主控在派发或调整前查看与活动票的冲突。reads 要包含实际检查输入；列出对方原票、冲突方向及路径或资源。
inspectPlan {planId,document?}：读取原计划索引，指定 spec、tickets 或 attempts 查看冻结正文。
schema {command:"previewPlan|dispatchPlan|supersede|releaseSchedule"}：查看契约字段和合法形状。
cacheDiagnostics {roleId,last24h?}：只读查看本项目成员最近24小时已确认送达次数、平均 promptBytes、contextFullCount、工具修复次数和 toolsVersion；不是供应商实际缓存命中率。
abandonTask {taskId,reason}：仅主控可终止从未投递的 queued 票，或已停写且无排队输入/后台作业的 paused 票。保留审计和全部证据，释放范围，不修改 Git；不把终止当成通过验收。supersede 同样允许已证明从未投递的 queued 票直接由后继承接。
收口顺序：成员交付 → 主控独立探针或高风险独立审查 → summarize → 最后按用户已有 Git 授权提交。若必须先提交：已交付候选内容完全等价时，由主控 confirmCommit {taskId,expectedBase,expectedHead,paths,reason} 显式确认；保留候选、报告、检查、当前阶段及已满足的依赖。不能证明等价时沿 diagnoseTask 的 rework→rebindCommittedWork 路径，重跑原绿、完整及适用独立检查。上述命令都不替用户执行 Git 提交、回滚或历史改写。不能仅凭 Git 作者名判断是主控还是成员提交。
previewPlan：同一份参数预检，不派发、不冻结。返回 state、violations（path/expected/remedy）和范围派生；无论预检通过与否都不承诺在线。支持 sources.ticketsDir 或 sources.tickets 文件数组。sources 示例：{"spec":"spec.md","tickets":"tickets.md","attempts":"attempts.md"}；票面文件的 lingflow-contract JSON 围栏可冻结必改文件、必改测试与 AC；预检和派发共同核对，未采用围栏的旧规划兼容。
approve {text,source}：仅 DSH 主控。登记用户已授权执行的目标和可观察验收条件。source 为用户确认的对话摘录或引用。仅讨论和未确认草稿不登记；沿用已有需求 ID。
dispatch {requirementId,developerId,title,description,risk,readOnly:true,writes:[],reads,resources,dependencies:[任务ID]}：派给开发成员的纯只读调查。独立审查由高风险票交付后自动派发，沿用冻结候选及证据。
dispatchPlan {requirementId,sources:{spec,tickets,attempts},tickets:[{key,developerId,title,description,brief?,boundaries?,stopConditions?,risk,riskReason?,readOnly?,writes,reads,resources,ownedDirty?,after:[{ticket或taskId,stage:"verified|accepted"}],verification}],batches?}：仅 DSH 主控。来源为项目相对文件。一次登记可前向引用的计划图。实施票的 verification={acceptance:[{id,text}],testWrites:[测试文件],checks:[{id,stage:"red|green|full|regression|independent|controller",argv:[程序,参数...],inputs:[相对路径],covers:[AC编号],expectedExit?,expectedOutput?,timeoutMs?}]}。红绿同命令及输入，红阶段声明真实失败标记。evidenceKind 按 argv 推断：test 要求真实用例/断言；probe 红证据要求预期非零退出码、expectedOutput 和本进程 Error 错误栈（含 at）或 AssertionError，不强制 AssertionError 文案；compile 的 TS/SyntaxError 属于代码错误。failed-before-tests 的两秒规则仅用于 test；启动、缺依赖、信号和超时均不得作为红证据。full 的 covers 并集覆盖全部 AC。regression 是开发回归门，covers=[]，不能替代 AC 证据；主控探针最多 60000ms。免审实施票至少一项 independent。确有必要时冻结 controller 收口探针。检查输入也参加并发冲突判断。共享数据库、端口及环境写进 resources。
允许票根 browserE2E，预检报告归并；Hive 票面可派生具名用例。快速模式默认零条浏览器 E2E。仅浏览器能证明关键 AC 时，在 verification.browserE2E 填 [{file:"e2e/feature.spec.ts",title:"关键行为",reason:"为何无法以 API 或组件测试证明",covers:["AC1"]}]。检查由开发执行，每条至少绑定一个 full 检查，inputs 包含该文件且 covers 包含相应 AC。argv 示例：${JSON.stringify(browserCheckArgv({ file: "e2e/feature.spec.ts", title: "关键行为" }))}。证据型浏览器命令绑定一个文件和字面标题；整文件或整套用 regression。主控和累计检查不能代跑，审查核对断言和实测。
batches:[{key,tickets:[票编号],argv,inputs,resources,covers:[{ticket,acceptance:[AC编号]}],timeoutMs?,expectedOutput?}]：不同票确需同一次累计验证且候选能同时稳定时使用。成员票先过各自门槛，然后程序跑一次累计检查，通过才共同放行。retryBatch {batchId,reason} 对账后重跑。现场冲突可用 reviseBatch {batchId,reason,groups:[同样的批次定义]} 重新分组，保留全部原验收条款及历史。
rebindCommittedWork {taskId,expectedBase,expectedHead,confirmPaths,confirmSourceAppends?,confirmRecordedBaseline?,reason}：仅主控。写集内提交默认阻断；用 diagnoseTask 核对，开发先停写交回。主控确认提交归属后可沿原票重绑。同分支快进、原写集可证明、冻结路径干净且无未完检查才允许。规划原文必须未变；若诊断证明仅在行边界追加 Markdown，可用诊断给出的 confirmSourceAppends 逐文件确认当前指纹。冻结时未提交、后来入库的记录型 Markdown 还须显式传 confirmRecordedBaseline；诊断会提供路径与指纹。确认只记审计，不改冻结规划或 AC。保留匹配的历史红证据，绿、完整检查及验收按新基线执行。不操作 Git 历史。
yieldForSchedule {taskId,reason}：责任人停写并结束本票后台检查后交回调度。reviseSchedule {taskId,reason,writes?,reads?,resources?,ownedDirty?,after?:[{taskId,stage}],refreshBaseline?}：主控调整未开工或已交回的原票。调度变更留历史，发现实际写入和原票不一致时先停写。只有核实 Git 状态和已有改动归属后才 refreshBaseline。同分支安全前移且执行范围不变时，原检查仍按输入指纹和日志复核，不必仅因 HEAD 改变而重跑。
supersede {taskId,supersededBy,reason}：仅本项目主控。旧票须为 paused/blocked、写集无已暂存/未暂存/未跟踪改动且无未完检查；active 票先由责任成员停写交回。改为 superseded 后释放全部读写与资源范围，保留冻结契约、历史证据、检查回执及替代审计；等待票的原依赖转向后继票且保留 verified/accepted 门槛，不把旧票当已验收。用 inspect 继续读取旧票。不会修改项目文件、提交、回滚或改写 Git 历史。
releaseSchedule {taskId,reason}：主控释放 paused/blocked 收尾票的全部调度范围，保留旧范围快照和冻结证据；原票不再准入。对暂停的实施票 reviseSchedule {taskId,writes:[],reason} 等价。仍须旧写集干净且无未完检查。需要正式承接关系时用 supersede；不能用空写集绕过活动票的停写要求。
后台检查以已授权原票冻结的 argv 为准。责任角色按 checkId 提交后由后台运行，已登记的累计检查达到条件时自动排队。检查在项目根目录运行；测试数据用 LINGFLOW_TEST_DATA_ROOT。
技术依赖用 after.stage=verified。只有用户明确要求逐票试用确认后才能继续时才选 accepted；后续票已登记时，主控核对原约定后可用 reviseSchedule 调整原票依赖。
check {taskId,checkId,async?}：责任开发提交红、绿或完整检查；主控提交独立验收或冻结的短探针。async:true 先返回作业号，归属和检查在后台完成。checkStatus {jobId} 查看结果；reused 时沿 reusedJobId 读取有效作业。票内 E2E 由开发承担，累计验证由程序后台跑。checkStatus {taskId} 默认看本票紧凑作业摘要，receipt含exitCode/failureOutputSeen/testCountSeen/environmentFailure/elapsedMs；完整作业传 detail:"full"，可配 limit/offset；checkEvidence {jobId} 读取日志。结果不明用原 operationId 对账。
冻结检查可声明 requiredArtifacts:["apps/web/dist"] 和 preSteps:[{argv:["npm","run","build"],outputs:["apps/web/dist"],timeoutMs:120000}]。明确构建配置与源码 inputs，outputs 不得覆盖 writes/inputs；主控探针不做构建。缺产物明确报 evidence-missing，前置失败不算红，构建与检查共享总时限，回执保留步骤日志及产物 hash。
report {taskId,summary,dimensions,outcome?,blocker?,request?,artifacts?,openItems?:[{text,blocking,trigger?,impact?,evidence?}]}：交付受阻时用 outcome=blocked，summary 写已完成工作与自测，blocker 写具体原因和被拒回执（如有），request 写需主控做的事。程序保存成员申报与当前诊断，但不受理候选、不放行下游；修复后沿原票另用新操作 ID 正式交付。成功交付可登记非阻塞待取舍项。实施票由程序收集检查回执和当前候选的写入清单。dimensions 的 requirements、implementation、system 各填 {state,evidence,checkIds:[检查编号]}。pass 必须引用同票有效且通过的非 red 检查，并解释它如何支持结论。问题或未验证用 issues/unverified。新只读票提供 dimensions（如某维度无法验证，注明 unverified 和原因）及 checks:[{command,exitCode:0,evidence}]，无需程序 checkIds。无冻结契约的旧票保留原报告，不补造三维或原生证据。
review {taskId,candidate,verdict:"pass|changes",findings,dimensions,testReview?,classification?,request?,artifacts?,openItems?:[{text,blocking,trigger?,impact?,evidence?}]}：仅被派审成员。通过时引用同候选程序证据。交付 manifest.testChanges 非空时，testReview 说明为何既有测试改动没有降低覆盖，或用 changes 报出反例。changes 可标 contract-invalid（契约需对账）、evidence-missing（证据待补）、quality-failed（有可复现的质量反例）；不确定时用 evidence-missing。report/review 均确认 state=stored。
message {roleId?,text,replyTo?}：监管发新消息给本项目通知负责人；主控必须用 replyTo 引用收到的监管消息；追问沿原消息。inbox 回投新消息，messages {messageId?} 查询本人频道或指定原消息。stored 仅表示已入库。
question {taskId,text}：责任成员沿原票报告阻塞；answer {taskId,questionId,text}：主控答复。
progress {taskId,text}：责任成员静默更新。
rework {taskId,reason,adjustScope?}：主控安排原票新版本。需要扩大或修订范围时传 adjustScope=true 先停在原票，再用 reviseSchedule 修订并重新准入。summarize {taskId,instructions,decision:{candidate,acceptance:[{id,evidence,checkIds}],limits,testReview?}}：实施票由主控逐条引用覆盖对应 AC 的有效检查。免审票改动既有测试时由主控填写 testReview。提供真实启动方式和试用步骤。
operation {id:原operationId}：查询原操作回执。无结果保留原 ID，不生成新派单。
派发、预检和 reviseSchedule 的可选 contextReads:["相对路径"] 只供背景阅读，不锁写者，也不作候选证据；只读票请明确 reads，确实不读工作区才填 []。两者都不声明时视为读集未知，与在飞写集串行；不会自动把证据读取降级。reads、writes 和实际检查 inputs 仍按冻结快照校验。检查或批次可声明 failureOutput（例如 "AssertionError"）；非红阶段仅在完整回执同时证明退出码异常和命中断言标记时归为 quality-failed，未证实归为 evidence-missing。旧实施票可保留报告与审查历史，缺契约时不能走原生汇总或验收；剩余工作用 dispatchPlan 建立后继票。
需求讨论、登记和派单在 DSH 主控会话。用户试用验收仍在 LingFlow 工作台。`;

