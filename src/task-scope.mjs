import { overlaps } from "./files.mjs";
import { execFileSync } from "node:child_process";
import { gitCommandTimeout } from "./execution-policy.mjs";

const stoppedStates = new Set(["paused", "blocked"]);
const waitingStates = new Set(["queued", ...stoppedStates]);
const activeJobs = new Set(["queued", "launching", "uncertain"]);
const requireValue = (value, message) => {
  if (!value) throw Object.assign(Error(message), { verificationCode: "contract-invalid" });
};
export const releasedTaskScope = task => ['superseded','abandoned'].includes(task.state) || Boolean(task.releasedScope);
export const originalTaskWrites = task => task.releasedScope?.writes ?? task.writes;
export function neverDeliveredTask(state, task) {
  return task.state === 'queued' && !task.deliveredAt && !task.firstDeliveredAt && !task.candidate &&
    !task.reports?.length && !task.reviews?.length && !state.checkJobs.some(job=>job.taskId===task.id||job.taskIds?.includes(task.id)) &&
    !(task.scheduleHistory??[]).some(item=>item.previous?.deliveredAt) &&
    !state.notices.some(note=>note.taskId===task.id&&note.key.startsWith('dispatch:')&&note.readAt) &&
    !state.wakes.some(wake=>wake.state==='enqueued'&&state.notices.some(note=>note.taskId===task.id&&note.key.startsWith('dispatch:')&&wake.noticeIds.includes(note.id)));
}

export function undeliveredQueuedTask(state, task) {
  if(neverDeliveredTask(state,task))return true;
  if(task.state!=='queued'||task.deliveredAt)return false;
  const key=`dispatch:${task.id}:${task.revision}${task.scheduleVersion?':'+task.scheduleVersion:''}`;
  const notices=state.notices.filter(note=>note.taskId===task.id&&note.key===key);
  if(notices.some(note=>note.readAt)||state.wakes.some(wake=>wake.state==='enqueued'&&notices.some(note=>wake.noticeIds.includes(note.id))))return false;
  const member=state.roles.find(role=>role.id===task.developerId);
  return Boolean(member&&member.state==='idle'&&member.pending===0&&member.jobs===0&&member.bridgePresent!==false&&
    member.connectedAt&&Date.now()-member.connectedAt<15000);
}

export function supersessionHint(state, task) {
  return undeliveredQueuedTask(state,task) && state.tasks.some(peer=>peer.id!==task.id&&peer.projectId===task.projectId&&!releasedTaskScope(peer)&&
    task.writes.length&&task.writes.every(file=>peer.writes.includes(file))) ? {staleReason:'predecessor-never-delivered'} : {};
}

export function includeIgnoredScopeWrites(root, task, git) {
  const writes = originalTaskWrites(task);
  if (!writes.length) return git;
  // Ownership noise filters and .gitignore must not hide files in the scope
  // being relinquished. This command only reads the explicit declared paths.
  const ignored = execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...writes],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: gitCommandTimeout(), maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean);
  return { ...git, dirty: [...new Set([...git.dirty, ...ignored])] };
}

export function assertStoppedTask(state, task) {
  requireValue(!releasedTaskScope(task),'该票已释放，请登记承接票；不能再次释放旧范围或接管后继票的改动。');
  requireValue(stoppedStates.has(task.state)||undeliveredQueuedTask(state,task), `原票 state=${task.state}，已投递或无法证明当前责任未投递且成员已停写，必须先由责任成员用 yieldForSchedule 交回 paused；主控不能终止 active 工作。`);
  requireValue(!state.checkJobs.some(job => activeJobs.has(job.state) &&
    (job.taskId === task.id || job.taskIds?.includes(task.id))), "原票仍有未完成或待对账的检查，先用 checkStatus/checkEvidence 收口原作业。");
}

export function abandonStoppedTask(state, task, git, audit) {
  assertStoppedTask(state,task);
  const member=state.roles.find(role=>role.id===task.developerId);
  requireValue(undeliveredQueuedTask(state,task)||(task.state==='paused'&&member?.state!=='running'&&member?.pending===0&&member?.jobs===0),
    '仅当前责任未投递且已证明停写的 queued 票，或无排队输入和后台作业的 paused 票可 abandonTask；已投递责任请先 yieldForSchedule。');
  const previous=scopeSnapshot(task);
  task.abandonment={...audit};record(task,previous,{...audit,abandoned:true});
  task.state='abandoned';task.assignee=null;task.retainedWrites=[];task.scopeConflict=null;task.waitReason=null;
  return {state:'abandoned',taskId:task.id,reason:audit.reason};
}
export function assertStoppedScope(state, task, git) {
  assertStoppedTask(state, task);
  const dirty = git.dirty.filter(file => overlaps([file], originalTaskWrites(task)));
  requireValue(!dirty.length, `旧票写集必须干净，仍有未提交或未跟踪改动：${dirty.join("、")}；保留文件，先核对归属，本命令不会提交或回滚。`);
}

function scopeSnapshot(task) {
  return structuredClone({ state: task.state, assignee: task.assignee, writes: task.writes, reads: task.reads,
    resources: task.resources, retainedWrites: task.retainedWrites ?? [], dependencies: task.dependencies,
    dependencyStages: task.dependencyStages ?? {}, ownedDirty: task.ownedDirty ?? [] });
}
function record(task, previous, audit) {
  (task.scheduleHistory ??= []).push({ previous, ...audit });
  task.scheduleVersion = (task.scheduleVersion ?? 0) + 1;
}

export function releaseStoppedScope(state, task, git, audit) {
  assertStoppedTask(state, task);
  if (!task.releasedScope) {
    const previous = scopeSnapshot(task);
    task.releasedScope = { ...previous, ...audit };
    record(task, previous, { ...audit, scopeReleased: true });
  }
  task.writes = [];
  task.retainedWrites = [];
  task.ownedDirty = [];
  task.assignee = null;
  task.scopeConflict = null;
  task.waitReason = "范围已释放，原票保留历史且不再准入；剩余工作请登记后继票。";
  return { state: task.state, taskId: task.id, scopeReleased: true };
}

// Compute dependency changes before applying any of them. Replacement must not
// satisfy an acceptance gate or create a new scheduling cycle.
function replacementDependencies(state, task, successor) {
  const changes = [];
  for (const current of state.tasks) {
    if (current.id === task.id || current.projectId !== task.projectId ||
        (!waitingStates.has(current.state) && current.id !== successor.id)) continue;
    if (current.id !== successor.id && !current.dependencies.includes(task.id)) continue;
    const stages = new Map();
    const add = (id, stage = "verified") => stages.set(id, stages.get(id) === "accepted" || stage === "accepted" ? "accepted" : "verified");
    for (const id of current.dependencies) {
      if (id !== task.id) add(id, current.dependencyStages?.[id]);
      else if (current.id !== successor.id) add(successor.id, current.dependencyStages?.[id]);
    }
    if (current.id === successor.id) for (const id of task.dependencies) {
      if (id !== successor.id) add(id, task.dependencyStages?.[id]);
    }
    const dependencies = [...stages.keys()], dependencyStages = Object.fromEntries(stages);
    if (JSON.stringify([current.dependencies, current.dependencyStages ?? {}]) === JSON.stringify([dependencies, dependencyStages])) continue;
    requireValue(waitingStates.has(current.state), "后继票已执行，不能追加或变更其前置门槛；请先由责任成员停写交回。");
    requireValue(!state.checkJobs.some(job => activeJobs.has(job.state) && (job.taskId === current.id || job.taskIds?.includes(current.id))),
      "依赖待调整票仍有未完成检查，请先收口原作业再替代。");
    changes.push({ taskId: current.id, previous: scopeSnapshot(current), dependencies, dependencyStages });
  }
  const graph = new Map(state.tasks.filter(item => item.projectId === task.projectId && item.id !== task.id && !releasedTaskScope(item))
    .map(item => [item.id, changes.find(change => change.taskId === item.id)?.dependencies ?? item.dependencies]));
  const done = new Set(), visiting = new Set();
  function visit(id) {
    if (done.has(id) || !graph.has(id)) return;
    requireValue(!visiting.has(id), "替代会造成前置依赖循环；请先用 reviseSchedule 核对等待票的 after。");
    visiting.add(id);
    for (const dependency of graph.get(id)) visit(dependency);
    visiting.delete(id); done.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return changes;
}

export function supersedeStoppedTask(state, task, successor, git, audit) {
  assertStoppedTask(state, task);
  requireValue(task.id !== successor.id && task.projectId === successor.projectId, "后继票必须是同项目的另一张票。");
  requireValue(!releasedTaskScope(successor) && !["accepted", "ready", "trial"].includes(successor.state), "后继票已经收尾或被替代，不能承接原票。");
  const changes = replacementDependencies(state, task, successor);
  const previous = scopeSnapshot(task);
  task.supersededBy = successor.id;
  task.supersession = { ...audit, dependencyChanges: structuredClone(changes) };
  record(task, previous, { ...audit, supersededBy: successor.id });
  task.state = "superseded";
  task.assignee = null;
  task.retainedWrites = [];
  task.scopeConflict = null;
  task.waitReason = null;
  for (const change of changes) {
    const current = state.tasks.find(item => item.id === change.taskId);
    record(current, change.previous, { ...audit, dependencyReplacement: { from: task.id, to: successor.id } });
    current.dependencies = change.dependencies;
    current.dependencyStages = change.dependencyStages;
  }
  return { state: "superseded", taskId: task.id, supersededBy: successor.id, dependencyChanges: changes.map(change => change.taskId) };
}

export function scopeConflictRemedy(task, peer) {
  return stoppedStates.has(peer.state) && task.id && task.projectId === peer.projectId
    ? { command: "supersede", args: { taskId: peer.id, supersededBy: task.id, reason: "确认由后继票承接原票剩余工作，保留旧票全部证据" } }
    : { command: "inspect", args: { taskId: peer.id } };
}

export const taskScopeSchemas = {
  supersede: { required: ["taskId", "supersededBy", "reason"], role: "controller", allowedStates: [...stoppedStates],
    neverDeliveredException: 'queued 且没有投递、报告或检查历史，可由主控直接替代',
    effect: "释放原票全部调度范围，保留历史；有在途改动时返回 ownedDirty 承接提案；等待票的依赖转向后继票且保留原验收门槛", preconditions: ["原责任已停写", "无未完成检查", "同项目有效后继票", "依赖无环"], gitWrites: false },
  abandonTask: {required:['taskId','reason'],role:'controller',allowedStates:['queued (never delivered)','paused (owner stopped)'],gitWrites:false,
    effect:'终止剩余责任并释放范围，保留全部历史，不代表通过验收'},
  releaseSchedule: { required: ["taskId", "reason"], role: "controller", allowedStates: [...stoppedStates],
    effect: "收尾票退出调度，保留冻结证据；不标记已完成或已验收", alias: "reviseSchedule {taskId,writes:[],reason}（暂停的实施票）", gitWrites: false },
};
