import { releasedTaskScope } from "./task-scope.mjs";
import { excerpt } from "../ui/handoff-card.js";

export function activeTaskIntervention(task) {
  const request = task?.intervention;
  return request && ["requested", "draining"].includes(request.state) &&
    ["assigned", "rework"].includes(task.state) && !releasedTaskScope(task) &&
    request.memberId === task.assignee && request.revision === task.revision &&
    request.scheduleVersion === (task.scheduleVersion ?? 0) ? request : null;
}

export function interventionHostJobsSettled(state, request) {
  return Boolean(request.evidence || state.roles.some(member =>
    member.id === request.memberId && member.sessionId === request.sessionId && member.jobs === 0));
}

export function interventionPrompt(task, request) {
  return [
    `LingFlow · ${request.mode === "stop" ? "停止原票" : "实施纠偏"} · ${task.ticketKey ?? task.id.slice(0, 8)}《${excerpt(task.title, 44)}》`,
    `主控指令：${excerpt(request.reason, 180)}`,
    `先用 lingflow_team 的 inbox 核对原票上的当前干预（编号尾号 ${request.id.slice(-8)}）。确认请求仍待处理后按原票执行。`,
    request.mode === "stop"
      ? "立即停止该票新增写入与检查，保留在途文件和日志。先核对自己启动的写入进程已停止，再提交停写回执。LingFlow 检查可随后独立收口。"
      : "按此指导继续当前票，保持冻结验收、检查和写集。发现需要改变契约时回报主控。",
    "回执用 ackTaskIntervention，沿用原票和干预记录里的完整编号。",
  ].join("\n");
}
