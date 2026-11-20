export function roleDeliveryPresentation(role) {
  const diagnostic = role.deliveryDiagnostic;
  const abnormal = role.resumeStatus === "delivery-issue" || diagnostic?.reason === "delivery-loss-limit";
  const connection = role.connected ? (role.state === "idle" ? "空闲" : role.state === "running" ? "执行中" : role.state) : "离线";
  return {
    status: !role.sessionId ? "等待会话绑定" :
      `${role.enabled ? "已开启" : "新投递已暂停"} · ${abnormal ? "投递异常 · " : ""}${connection}\n待输入 ${role.pending ?? "—"}`,
    issue: diagnostic?.detail ?? role.deliveryIssue,
    rearm: diagnostic?.nextAction?.command === "rearmWake" ? diagnostic.nextAction : null,
  };
}
