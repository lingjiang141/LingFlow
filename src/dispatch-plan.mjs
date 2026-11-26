import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findRecord as find, requireText as text, requireValue as need } from "./command-arguments.mjs";
import { coversPath, overlaps, scopePaths } from "./files.mjs";
import { parseHiveTicket, splitHiveTickets, substituteTicket } from "./hive-plan.mjs";
import { invalidPlan, planSchema, unknownFields, violation } from "./plan-schema.mjs";
import { planningResourceWarnings, recommendDevelopers } from "./plan-scheduling.mjs";
import { assertTicketContract, readTicketChecks, readTicketContracts } from "./planning-contract.mjs";
import { cumulativeCheck, key, list, planSources, readGit, readVerification, verify } from "./quality.mjs";
import { freezeRiskItems } from "./review-contract.mjs";
import { hasSpecChangeLog, readSpecVersion } from "./spec-revision.mjs";
import { relatedTestWarnings } from "./test-scope-hints.mjs";

export const readsFor = (task) => [...task.reads, ...(task.verification?.checks.flatMap((check) => [...check.inputs, ...(check.requiredArtifacts ?? [])]) ?? [])];
export const verificationMode = (task) => task.verification ? "frozen" : task.readOnly ? "read-only" : "missing-contract";

export function dispatchReadOnlyTask(state, role, args) {
  const requirement = find(state.requirements, args.requirementId);
  need(role?.kind === "controller" && role.projectId === requirement.projectId, "请在本项目已开启的 DSH 主控会话派单");
  verify(args.readOnly === true, "contract-invalid", "新实施票请用 dispatchPlan 并提供 tickets[].verification；纯调查才用 dispatch，例如 {\"readOnly\":true,\"writes\":[]}");
  const task = createTask(state, role, requirement, args, randomUUID());
  task.dependencies = list(args.dependencies ?? [], "依赖");
  for (const dependency of task.dependencies)
    need(find(state.tasks, dependency).projectId === task.projectId, "依赖必须同项目");
  state.tasks.push(task);
  return { taskId: task.id, receipt: "accepted" };
}

export function dispatchPlan(state, role, args) {
  return freezePlan(state, role, args, "dispatch");
}

export function previewPlan(state, role, args, assignmentWarnings) {
  return freezePlan(state, role, args, "preview", { assignmentWarnings });
}

export function materializePlan(state, role, args, canAssignDeveloper) {
  return freezePlan(state, role, args, "materialize", { canAssignDeveloper });
}

export function prepareDependencyEdit(state, task, after) {
  const next = resolveAfter(state.tasks, task, after);
  validateDependencyEdit(state, task, next);
  return next;
}

function createTask(state, role, requirement, input, taskId, sources, ticketKey, warnings = [], prefix = "ticket") {
  need(role?.kind === "controller" && role.projectId === requirement.projectId, "请在本项目已开启的 DSH 主控会话派单");
  const worker = find(state.roles, input.developerId);
  need(!worker.archivedAt, "成员已归档");
  need(worker.projectId === requirement.projectId, "开发者无效");
  need(["low", "medium", "high"].includes(input.risk), "风险必须为 low/medium/high");
  const writes = scopePaths(input.writes), reads = scopePaths(input.reads ?? []);
  const contextReads = scopePaths(input.contextReads ?? []);
  const readOnly = input.readOnly === true;
  need(input.readOnly === undefined || typeof input.readOnly === "boolean", "readOnly 必须为布尔值");
  need(readOnly ? writes.length === 0 : writes.length > 0, "实施票须声明写入范围，只读票须设置 readOnly=true 且 writes=[]");
  need(worker.kind === "developer", "角色不具备该任务的实施权限；新票仅派给开发成员");
  const resources = list(input.resources ?? [], "共享资源").map((resource) => text(resource, "资源名称").toLowerCase());
  const project = find(state.projects, requirement.projectId);
  const developerChecksPending = input.developerChecks === true;
  need(input.developerChecks === undefined || typeof input.developerChecks === "boolean", "developerChecks 须为布尔值");
  need(!developerChecksPending || !readOnly && sources, "开发登记检查仅支持引用规划文件的实施票");
  const verification = readOnly ? null : readVerification(input.verification,
    { root: project.root, writes, risk: input.risk, warnings, prefix: prefix + ".verification", developerChecksPending });
  if (verification) need(sources, "实施票必须引用已批准的规划文件");
  const riskItems = sources && freezeRiskItems(input, verification, warnings, prefix);
  const ownedDirty = scopePaths(input.ownedDirty ?? []);
  need(ownedDirty.every((file) => coversPath(writes, file)), "已有改动授权必须在本票写入范围内");
  return {
    id: taskId, projectId: project.id, requirementId: requirement.id, ticketKey,
    sources, title: text(input.title, "任务标题"), description: text(input.description, "任务及验收条件"),
    dispatchedBy: role.id,
    ...Object.fromEntries(["brief", "boundaries", "stopConditions", "riskReason", "assignmentReason"].filter((field) =>
      input[field] !== undefined && (field !== "riskReason" || input[field] !== null))
      .map((field) => [field, text(input[field], field)])),
    developerId: worker.id, assignee: worker.id, risk: input.risk, readOnly, dimensionsRequired: true,
    ...(riskItems && { riskItems, riskContractVersion: 1 }),
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

export function retainDependencyReceipts(task, next) {
  if (!task.dependencyReceipts) return;
  for (const dependency of Object.keys(task.dependencyReceipts))
    if (!next.dependencies.includes(dependency) || (task.dependencyStages?.[dependency] ?? "verified") !== next.dependencyStages[dependency])
      delete task.dependencyReceipts[dependency];
}

function readPlanTickets(root, ticketDocuments, violations) {
  const contracts = new Map();
  const hiveTickets = new Map();
  const ticketChecks = new Map();
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
    try { parsed = splitHiveTickets(document).map((part) => parseHiveTicket(part, { exists: (file) => existsSync(resolve(root, file)) })); }
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
  return { contracts, hiveTickets, ticketChecks };
}

function freezePlan(state, role, args, mode, { canAssignDeveloper, assignmentWarnings } = {}) {
  const requirement = find(state.requirements, args.requirementId);
  need(role?.kind === "controller" && role.projectId === requirement.projectId, "请在本项目已开启的 DSH 主控会话派单");
  const project = find(state.projects, role.projectId);
  let documents;
  try { documents = planSources(project.root, args.sources, true); } catch (error) {
    throw invalidPlan([violation("sources", error.message, planSchema.sources, "指定存在的项目相对规划文件或 issues 目录")]);
  }
  const sources = Object.fromEntries(Object.entries(documents).map(([name, doc]) => [name, { file: doc.file, digest: doc.digest }]));
  const specVersion = readSpecVersion(documents.spec.text);
  const planId = randomUUID();
  const ticketDocuments = Object.entries(documents).filter(([name]) => name === "tickets" || name.startsWith("ticket:"));
  const violations = [], warnings = [], normalized = [];
  if (!specVersion || !hasSpecChangeLog(documents.spec.text)) {
    const missing = [!specVersion && "Version: N", !hasSpecChangeLog(documents.spec.text) && "## 变更记录"].filter(Boolean);
    violations.push(violation("sources.spec", `规格缺少 ${missing.join("、")}`, "Version: 1 和 ## 变更记录",
      "在 spec 顶部补版本及变更记录，再用相同参数执行 previewPlan，随后 dispatchPlan"));
  }
  unknownFields(args, ["requirementId","sources","tickets","batches","developerIds"], "plan", warnings);
  unknownFields(args.sources, ["spec","tickets","ticketsDir","attempts"], "sources", warnings);
  const { contracts, hiveTickets, ticketChecks } = readPlanTickets(project.root, ticketDocuments, violations);
  if (mode === "materialize") {
    const developers = state.roles.filter(member => member.projectId === project.id && member.kind === "developer" && !member.archivedAt);
    need(developers.length, "本项目没有可用开发成员");
    const keys = [...new Set([...hiveTickets.keys(), ...contracts.keys()])];
    const selected = recommendDevelopers(developers, state.tasks, keys, args.developerIds, canAssignDeveloper);
    const tickets = keys.map((ticket, index) => {
      const contract = contracts.get(ticket), hive = hiveTickets.get(ticket);
      if (!contract) violations.push(violation(`tickets[${ticket}].ticketContract`, "缺少 lingflow-contract", null, "在未冻结的新票补齐机读契约，旧票使用副本转录"));
      if (!ticketChecks.has(ticket) && !contract?.developerChecks) violations.push(violation(`tickets[${ticket}].verification.checks`, "缺少 lingflow-checks，不能推测实际检查或红标记", null,
        "声明真实 checks 和 browserE2E；仅有自然语言检查描述无法直接派发"));
      return { key: ticket, developerId: selected[index],
        ...(contract?.riskItems !== undefined && { riskItems: contract.riskItems }),
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
      need(!seenKeys.has(ticketKey) && !state.tasks.some((t)=>t.projectId===project.id&&t.ticketKey===ticketKey),"票编号已存在，请沿原票续接："+ticketKey);
      seenKeys.add(ticketKey);
      unknownFields(raw,["key","developerId","title","description","brief","boundaries","stopConditions","risk","riskItems","riskReason","writes","reads","contextReads","resources","ownedDirty","after","readOnly","verification","browserE2E","developerChecks","upstreamRedTaskId","assignmentReason"],prefix,warnings);
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
      const input=substituteTicket({ ...merged, riskItems: merged.riskItems === undefined ? contract?.riskItems : merged.riskItems },inferred,warnings,prefix);
      const refs=Object.fromEntries(Object.entries(sources).filter(([name])=>!name.startsWith("ticket:")));
      const ticketSource = hive?.name ?? ticketDocuments.find(([, document])=>document.file===contracts.get(ticketKey)?.source)?.[0];
      if(ticketSource) refs.tickets=sources[ticketSource];
      const task={...createTask(state, role, requirement, input, randomUUID(), refs, ticketKey, warnings, prefix),planId,
        ...(specVersion && { specVersion })};
      if (raw.upstreamRedTaskId !== undefined) {
        const upstream = state.tasks.find(item => item.id === raw.upstreamRedTaskId && item.projectId === project.id && item.verification);
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
        const counterpart = byKey.get(needed.ticket) ?? state.tasks.find((t)=>t.projectId===project.id&&t.ticketKey===needed.ticket);
        const provided = dependencies.find((dep)=>dep?.ticket===needed.ticket || (counterpart && dep?.taskId===counterpart.id));
        if (!provided) {
          warnings.push({path:at,message:"票面声明的前置未被采用",value:needed});
        } else if (provided.stage === "accepted" && needed.stage === "verified") {
          warnings.push({ path: at, message: `前置 ${needed.ticket} 被设为等待用户验收。技术前置请选择 verified；仅用户明确要求验收后再推进时保留 accepted。`, value: provided });
        }
      }
      input.after = dependencies;
      const resolved = dependencies.filter(dep => !dep?.ticket || byKey.has(dep.ticket) || !inputs.some(item => item?.key === dep.ticket));
      Object.assign(task, resolveAfter([...byKey.values(), ...state.tasks], task, resolved, warnings, at));
    } catch(error) { collect(at,error,[{ticket:"R35-01",stage:"verified"}],"引用同项目实际前置票"); }
  }
  if(violations.length) throw invalidPlan(violations, warnings);
  const byId = new Map([...byKey.values()].map((task) => [task.id, task]));
  let order;
  try { order = dependencyOrder([...byKey.values()]); }
  catch(error) { throw invalidPlan([violation("tickets.after",error.message,[{ticket:"R35-01",stage:"verified"}],"只保留实际依赖，取消互相等待的边")]); }
  warnings.push(...planningResourceWarnings(order, state.tasks.filter(task => task.projectId === project.id), documents));
  for (const task of order) for (const dependency of task.dependencies) {
    const peer = state.tasks.find(peer => peer.id === dependency);
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
    const batch = { id: randomUUID(), projectId: project.id, taskIds: members.map((task) => task.id), check, state: "waiting" };
    for (const member of members) member.batchId = batch.id;
    frozenBatches.push(batch);
  } catch(error) { collect("batches["+index+"]",error,{key:"batch",tickets:["A","B"],argv:["node","verify.cjs"],inputs:["verify.cjs"],covers:[{ticket:"A",acceptance:["AC-1"]},{ticket:"B",acceptance:["AC-1"]}]},"核对批次成员、实际输入和覆盖；不能批次互等或冲突"); } }
  if(violations.length) throw invalidPlan(violations, warnings);
  if (mode === "materialize") return { state: "valid", warnings, args, checks: order.map(task => ({
    ticket: task.ticketKey, checks: task.verification.checks, browserE2E: task.verification.browserE2E,
    ...(task.developerChecksPending && { developerChecksPending: true }),
  })) };
  if (mode === "preview") {
    if (assignmentWarnings) warnings.push(...assignmentWarnings(order));
    return { state: "valid", violations: [], warnings, sources, tickets: order.map((task) => ({
      key: task.ticketKey, developerId: task.developerId, writes: task.writes, reads: task.reads,
      after: normalized.find(input => input.key === task.ticketKey)?.after ?? [],
      verification: task.verification, verificationMode: verificationMode(task),
      ...(task.assignmentReason && { assignmentReason: task.assignmentReason }),
      ...(task.riskItems && { riskItems: task.riskItems }),
      ...(task.developerChecksPending && { developerChecksPending: true }),
    })) };
  }
  state.validationBatches.push(...frozenBatches);
  state.tasks.push(...order);
  state.plans.push({ id: planId, projectId: project.id, requirementId: requirement.id, documents, createdAt: Date.now(),
    ...(specVersion && { specVersion }) });
  return { receipt: "accepted", planId, warnings, tasks: order.map((task) => ({ key: task.ticketKey, taskId: task.id })) };
}
