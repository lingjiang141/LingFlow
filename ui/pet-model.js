import { specBoard, specChoices } from "./spec-board.js";
import { excerpt } from "./handoff-card.js";

const closed = new Set(["ready", "trial", "accepted"]);
const waiting = new Set(["queued", "paused", "blocked"]);
const retiredStates = new Set(["superseded", "abandoned"]);
const labels = { queued: "等待准入", assigned: "开发中", rework: "返工中", paused: "待调整", blocked: "已阻塞",
  reviewing: "审查中", waiting_review: "等待审查", waiting_verification: "待独立验证", waiting_batch: "累计验证中",
  changes_requested: "待处理反馈", ready: "待汇总", trial: "待试用", accepted: "已验收", superseded: "已被替代", abandoned: "已放弃" };
export function petProgress(snapshot, selection = {}) {
  const projects = snapshot.projects.map(({ id, name }) => ({ id, name }));
  const chosenProject = projects.find(project => project.id === selection.projectId);
  const project = chosenProject ?? projects[0];
  const board = specBoard(snapshot.tasks ?? [], project?.id, !chosenProject ? "current" : selection.specKey, snapshot.plannedTickets ?? []);
  const groups = ["closed", "active", "waiting"].map(id => ({ id, tickets: [] }));
  let completed = 0, accepted = 0, total = 0;
  for (const task of board.selected?.tasks ?? (board.selectionKey === "all" ? board.tasks : [])) {
    const scopeReleased = Boolean(task.releasedScope || task.scopeReleased);
    const retiredState = retiredStates.has(task.state);
    const retired = retiredState || scopeReleased;
    const group = retired || closed.has(task.state) ? 0 : waiting.has(task.state) ? 2 : 1;
    if (!retired) { total++; if (closed.has(task.state)) completed++; if (task.state === "accepted") accepted++; }
    const role = snapshot.roles?.find(role => role.id === (task.assignee ?? task.developerId));
    groups[group].tickets.push({ id: task.id, key: task.ticketKey ?? task.id.slice(0, 8), title: task.title,
      summary: excerpt(task.brief || task.description || task.verification?.acceptance?.[0]?.text || "尚无票面概述", 180),
      state: task.state, label: scopeReleased && !retiredState ? "范围已释放" : labels[task.state] ?? task.state,
      assignee: role?.name ?? "未分配", waitReason: excerpt(task.waitReason ?? "", 180), retired });
  }
  for (const group of groups) {
    const priority = ticket => {
      if (ticket.state === "abandoned") return 3;
      if (ticket.retired) return 2;
      if (group.id === "active" && ticket.state === "assigned" || group.id === "closed" && ticket.state === "trial") return 0;
      return 1;
    };
    group.tickets.sort((a, b) => priority(a) - priority(b) || a.key.localeCompare(b.key, "zh-CN", { numeric: true }));
  }
  const plannedTickets = board.selected
    ? (board.selected.plannedTickets ?? [])
    : board.selectionKey === "all"
      ? (board.plannedTickets ?? [])
      : [];
  for (const item of plannedTickets) {
    groups[2].tickets.push({
      id: `planned:${item.requirementId}:${item.key}`,
      key: item.key,
      title: item.title ?? item.key,
      state: "planned",
      label: item.requirementClosed ? "该需求已收口 · 未派发" : "已规划 · 待派发",
      blurb: item.dependsOn?.length ? `前置：${item.dependsOn.join("、")}` : "",
      risk: item.risk ?? "medium",
      planned: true,
      requirementClosed: Boolean(item.requirementClosed),
      dependsOn: item.dependsOn ?? [],
    });
  }
  return { projects, project, specs: board.specs.map(({ key, file, digest }) => ({ key, file, digest })),
    cycles: board.cycles.map(({ key, file, versions, tasks, plannedTickets: cyclePlanned }) => ({ key, file, versionCount: versions.length, ticketCount: tasks.length, plannedCount: cyclePlanned?.length ?? 0 })),
    scopes: specChoices(board), selectionKey: board.selectionKey,
    spec: board.selected ? { key: board.selected.key, kind: board.selected.kind, file: board.selected.file, digest: board.selected.digest } :
      board.selectionKey === "all" ? { key: "all", kind: "all", file: "全部项目任务" } : null,
    total, completed, accepted, plannedCount: plannedTickets.length, plannedTickets, percent: total ? Math.round(completed / total * 100) : 0, groups };
}
