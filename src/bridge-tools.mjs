export function bridgeToolsBlocker(role) {
  return role?.toolsMissing?.length ? {
    code: "bridge-tools-missing", reason: "bridge-tools-missing", sessionId: role.sessionId,
    toolsMissing: role.toolsMissing,
    detail: "bridge-tools-missing：成员工具尚未恢复，等待 DSH 桥接重新注册后投递",
  } : null;
}

export function recordBridgeTools(role, session, event) {
  if(typeof session.toolsVersion==='string'&&session.toolsVersion.length<=100)role.toolsVersion=session.toolsVersion;
  role.toolsMissing = Array.isArray(session.toolsMissing)
    ? [...new Set(session.toolsMissing.filter(name => ["lingflow_connect", "lingflow_team"].includes(name)))] : [];
  const repair = session.toolsReinstall;
  if (repair && typeof repair.id === "string" && repair.id.length <= 100 && typeof repair.ok === "boolean" &&
      Number.isSafeInteger(repair.at) && repair.id !== role.lastToolsRepairId) {
    role.lastToolsRepairId = repair.id;
    event("tools-reinstall", { sessionId: session.id, ok: repair.ok, at: repair.at });
  }
}
