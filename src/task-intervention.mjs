import { releasedTaskScope } from "./task-scope.mjs";

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
  const args = JSON.stringify({ taskId: task.id, requestId: request.id, reason: "填写实际处理回执" });
  return [
    `LingFlow · ${request.mode === "stop" ? "停止原票" : "实施纠偏"} · ${task.ticketKey ?? task.id}`,
    `先用 inspect {taskId:"${task.id}"} 核对原票仍在 assigned 或 rework，revision=${request.revision}，scheduleVersion=${request.scheduleVersion}（缺省为 0），且 intervention 为 requested、ID 为 ${request.id}。条件变化时结束此指令。`,
    `主控指令：${request.reason}`,
    request.mode === "stop"
      ? "立即停止该票新增写入与检查，保留在途文件和日志。先核对自己启动的写入进程已停止，再提交停写回执。LingFlow 检查可随后独立收口。"
      : "按此指导继续当前票，保持冻结验收、检查和写集。发现需要改变契约时回报主控。",
    `执行 ackTaskIntervention ${args}。`,
  ].join("\n");
}
