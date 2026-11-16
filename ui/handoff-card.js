export function excerpt(value, limit) {
  const characters = Array.from(String(value ?? "").replace(/\s+/g, " ").trim());
  return characters.length > limit ? characters.slice(0, limit).join("") + "…" : characters.join("");
}

export function handoffRecord(notice, task) {
  if (!task) return undefined;
  const [kind, ref, phase] = notice.key.split(":");
  if (kind === "report") return task.reports?.find((item) => item.id === ref);
  if (kind === "report-blocked") return task.blockedReports?.find((item) => item.id === ref);
  if (kind === "review") return phase
    ? task.reports?.findLast((item) => item.revision === Number(phase))
    : task.reviews?.find((item) => item.id === ref);
}

function pathLine(label, paths = [], limit = 6) {
  return `${label}（${paths.length}）：${paths.slice(0, limit).map((file) => excerpt(file, 150)).join("、") || "无"}${paths.length > limit ? "；其余见原票" : ""}`;
}

export function handoffLines(notice, task, roles = []) {
  if (!task) return [];
  const [kind, ref, phase] = notice.key.split(":");
  if (!["dispatch", "report", "report-blocked", "review", "question", "answer"].includes(kind)) return [];
  const record = handoffRecord(notice, task);
  const roleId = kind === "question" ? task.questions?.find((q) => q.id === ref)?.from
    : kind === "answer" ? task.questions?.find((q) => q.id === ref)?.answeredBy
    : kind === "dispatch" ? task.dispatchedBy
    : record?.reviewerId ?? record?.developerId ?? (record && task.developerId);
  const sender = roles.find((r) => r.id === roleId)?.name ?? (
    kind === "dispatch" || kind === "answer" ? "主控" :
      kind === "review" && !phase ? "审查成员" : kind === "question" ? "责任成员" : "开发成员");
  const lines = [];
  if (kind === "review" && phase) lines.push("派审：LingFlow 自动分派 · 开发自测来自 " + excerpt(sender, 60));
  else lines.push("发送者：" + excerpt(sender, 60));
  if (kind === "dispatch") {
    lines.push("目标：" + excerpt(task.brief ?? task.description, 220));
    if (task.boundaries) lines.push("红线：" + excerpt(task.boundaries, 180));
    if (task.stopConditions) lines.push("停止条件：" + excerpt(task.stopConditions, 180));
    if (task.riskReason) lines.push("风险理由：" + excerpt(task.riskReason, 180));
    lines.push(pathLine("允许写入（项目相对路径）", task.writes));
    const checkInputs = (task.verification?.checks ?? []).flatMap((check) => check.inputs ?? []);
    lines.push(pathLine("关键读取和检查输入", [...new Set([...(task.reads ?? []), ...checkInputs])]));
    if (task.contextReads?.length) lines.push(pathLine("背景阅读（不作证据）", task.contextReads));
    lines.push(`风险 ${task.risk ?? "未标记"} · ${task.risk === "high" ? "自动独立审查" : task.verification ? "主控独立验收" : "只读交付"} · 前置 ${task.dependencies?.length ?? 0} 项 · 共享资源：${excerpt(task.resources?.join("、"), 120) || "无"}`);
    if (task.planId) {
      const files = ["spec", "tickets", "attempts"].filter((key) => task.sources?.[key]?.file)
        .map((key) => `${key}=${excerpt(task.sources[key].file, 150)}`);
      lines.push("冻结规划：" + files.join("；") + " · inspectPlan " + JSON.stringify({ planId: task.planId }));
    }
    if (task.verification) {
      lines.push("验收条款：" + (task.verification.acceptance ?? []).slice(0, 3).map(({ id, text }) => `${id} ${excerpt(text, 80)}`).join("；"));
      lines.push("冻结检查：" + (task.verification.checks ?? []).slice(0, 8).map(({ id, stage }) => `${id} (${stage})`).join("、") + "；完整 argv 与覆盖范围见原票 verification。");
      if (task.verification.browserE2E?.length)
        lines.push("票内浏览器用例：" + task.verification.browserE2E.slice(0, 2).map(({ file, title }) => excerpt(file + " · " + title, 160)).join("；"));
    }
  }
  if (kind === "review" && phase) {
    lines.push("审查范围：只读；核对当前候选、原始需求和冻结检查，不修改源码。");
    lines.push(pathLine("候选写集", task.writes));
  }
  if (record) {
    lines.push(`回执 ${record.id.slice(0, 8)} · 责任版本 ${record.revision ?? "未记录"} · 候选 ${record.candidate?.slice(0, 12) ?? "未受理"}`);
    if (record.artifacts?.length) lines.push(pathLine("成员提供的证据路径", record.artifacts));
    if (record.manifest?.files?.length) lines.push(pathLine("交付改动", record.manifest.files.map(({ file }) => file)));
    const checkIds = record.checks?.filter(({ jobId }) => jobId) ?? [];
    if (checkIds.length && record.candidate) lines.push("候选证据索引：deliveryEvidence " + JSON.stringify({ taskId: task.id, candidate: record.candidate }));
    if (checkIds.length) lines.push("检查证据：checkEvidence 按作业 ID 查看 · " + checkIds.slice(0, 6).map(({ checkId, jobId }) => `${checkId}=${jobId}`).join("、"));
    const sourceNotes = record.gate?.sourceNotes ?? record.manifest?.scopeNotes?.filter((note) => ["source-appended", "planning-source-changed"].includes(note.kind)) ?? [];
    for (const note of sourceNotes.slice(0, 3))
      lines.push(excerpt(note.kind + "： " + note.file + (note.startLine ? " 第 " + note.startLine + " 行 +" + note.appendedBytes + " 字节（原票要求仍冻结）" : " · 请核对冻结规划"), 240));
    if (record.gate) {
      lines.push("交付门槛（程序诊断）：" + excerpt(record.gate.classification + " · " + record.gate.reason, 240));
      if (record.gate.from && record.gate.to) lines.push(`基线变化：${record.gate.from.slice(0, 12)} → ${record.gate.to.slice(0, 12)}`);
      if (record.gate.conflicts?.length) lines.push(pathLine("冲突路径", record.gate.conflicts));
    }
    if (record.blocker) lines.push("为何未交付（成员说明）：" + excerpt(record.blocker, 400));
    const pendingQuestions = task.questions?.filter((q) => !q.answer).length ?? 0;
    const items = record.openItems ?? [];
    const failedWithoutItem = (kind === "report-blocked" || record.verdict === "changes") && !items.some((item) => item.blocking);
    const blockers = pendingQuestions + items.filter((item) => item.blocking).length + Number(failedWithoutItem);
    const open = pendingQuestions + items.length + Number(failedWithoutItem);
    if (open) {
      lines.push(`本责任 ${open} 项开放，${blockers} 项阻塞。` +
        (blockers ? "主控核对阻塞项。" : "") +
        (open > blockers ? "交付检查点向用户汇总非阻塞项并请其取舍。" : ""));
      for (const item of [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking)).slice(0, 2))
        lines.push((item.blocking ? "阻塞：" : "待取舍：") + excerpt(item.text, 160) +
          (item.trigger ? " · 触发：" + excerpt(item.trigger, 80) : "") + (item.impact ? " · 影响：" + excerpt(item.impact, 100) : "") +
          (item.evidence ? " · 证据：" + excerpt(item.evidence, 100) : ""));
    }
    if (record.request) lines.push("请求收信者：" + excerpt(record.request, 220));
  }
  lines.push("原票：inspect " + JSON.stringify({ taskId: task.id }));
  return lines;
}
