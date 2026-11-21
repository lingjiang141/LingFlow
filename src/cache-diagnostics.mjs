import { wakeGeneration } from "./wake-state.mjs";

export function promptMetrics(text, contextFull, toolsVersion = null) {
  const digest = text.lastIndexOf('\n\n当前状态\n当前状态（自动生成，勿手工核对以下事实）');
  const boundary = digest < 0 ? text.indexOf('当前事项\n') : digest + 2;
  const stable = boundary < 0 ? text : text.slice(0, boundary);
  return { promptBytes: Buffer.byteLength(text), stableBytes: Buffer.byteLength(stable), contextFull,
    toolsVersion };
}

export function recordPromptAdmission(state, wake, at) {
  state.promptAdmissions ??= [];
  const generation = wakeGeneration(wake);
  if (state.promptAdmissions.some(item => item.wakeId === wake.id&&(item.generation??0)===generation)) return;
  state.promptAdmissions = state.promptAdmissions.filter(item => item.at >= at - 7 * 86400000);
  state.promptAdmissions.push({ wakeId: wake.id, generation, roleId: wake.roleId, sessionId: wake.sessionId, at,
    ...promptMetrics(wake.text, Boolean(wake.contextIncluded), wake.toolsVersion) });
}

export function cacheDiagnostics(state, roleId, now = Date.now()) {
  const since = now - 86400000;
  const deliveries = (state.promptAdmissions ?? []).filter(item => item.roleId === roleId && item.at >= since);
  const repairs = (state.toolsRepairHistory ?? []).filter(item => item.roleId === roleId && item.at >= since);
  return { roleId, since, until: now, deliveries: deliveries.length,
    averagePromptBytes: deliveries.length ? Math.round(deliveries.reduce((sum,item)=>sum+item.promptBytes,0)/deliveries.length) : 0,
    contextFullCount: deliveries.filter(item=>item.contextFull).length,
    toolsReinstallCount: repairs.length, toolsReinstallSuccesses: repairs.filter(item=>item.ok).length,
    toolsVersion: state.roles.find(role=>role.id===roleId)?.toolsVersion ?? null, recent: deliveries.slice(-10),
    note: '仅统计部署后已确认送达的记录；字节数不代表模型提供商的缓存命中率。' };
}
