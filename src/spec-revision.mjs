export function readSpecVersion(text) {
  const header = text?.replace(/^\uFEFF/, "").split(/^##\s/m, 1)[0];
  const version = /^[ \t]*Version:[ \t]*v?(\d+)[ \t]*\r?$/im.exec(header ?? "")?.[1];
  return version ? `v${version}` : null;
}

export const hasSpecChangeLog = text => /^##[ \t]+变更记录[ \t]*\r?$/m.test(text ?? "");

const splitCells = line => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim());
const ids = cell => cell.match(/[\w.-]+/g) ?? [];

function changeImpacts(text) {
  const section = (text ?? "").split(/^##[ \t]+变更记录[ \t]*\r?$/m)[1]?.split(/^#{1,2}\s/m)[0];
  const lines = section?.trim().split(/\r?\n/) ?? [];
  const header = splitCells(lines[0] ?? "");
  const [version, ac, tickets] = ["版本", "影响 AC", "影响在飞票"].map(name => header.indexOf(name));
  if (ac < 0 || tickets < 0 || !/^\s*\|?\s*:?-{3,}/.test(lines[1] ?? "")) return [];
  const rows = [];
  for (const line of lines.slice(2)) {
    if (!line.includes("|")) break;
    const cells = splitCells(line);
    if (cells.length === header.length) rows.push({
      version: cells[version] ?? "", acceptance: [...new Set(ids(cells[ac]))].sort(), tickets: [...new Set(ids(cells[tickets]))].sort(),
    });
  }
  return rows;
}

export function specImpact(frozen, current, task, ticketText) {
  const previous = new Set(changeImpacts(frozen).map(row => JSON.stringify(row)));
  const covers = new Set([
    ...(task.verification?.acceptance.map(ac => ac.id) ?? []),
    ...(task.verification?.checks.flatMap(check => check.covers) ?? []),
    ...[...(ticketText ?? "").matchAll(/^\s*(?:[-*]\s+)?covers\s*[:：][ \t]*(.+)$/gim)].flatMap(match => ids(match[1])),
  ]);
  const acceptance = new Set();
  let named = false;
  for (const row of changeImpacts(current)) {
    if (previous.has(JSON.stringify(row))) continue;
    named ||= row.tickets.includes(task.ticketKey);
    for (const id of row.acceptance) if (covers.has(id)) acceptance.add(id);
  }
  if (named || acceptance.size) return { acceptance: [...acceptance].sort(), named };
}

export function planningDecisionOptions(task) {
  if (!task.sources?.spec || !task.sources?.attempts) return [];
  const reason = "根据当前 spec 调整原票剩余工作";
  const stop = ["assigned", "rework"].includes(task.state)
    ? { command: "yieldForSchedule", args: { taskId: task.id, reason }, actor: "developer" }
    : { command: "rework", args: { taskId: task.id, reason, adjustScope: true }, actor: "controller" };
  const before = ["paused", "trial"].includes(task.state) || task.state === "queued" && !task.deliveredAt ? [] : [stop];
  const newKey = "RNEW-01";
  const dispatch = {
    command: "dispatchPlan",
    args: {
      requirementId: task.requirementId,
      sources: { spec: task.sources.spec.file, attempts: task.sources.attempts.file, tickets: [".scratch/lingflow/issues/RNEW-01.md"] },
      tickets: [{ key: newKey, developerId: task.developerId, risk: task.risk }],
    },
  };
  const prepare = "用可用的新票号替换 RNEW-01，在该路径新建有标题和验收条款的票面，填写 lingflow-contract 和 lingflow-checks。先用相同参数执行 previewPlan。";
  return [
    { choice: "keep-frozen", label: "保持冻结口径", action: { command: "inspect", args: { taskId: task.id, section: "acceptance" } },
      instruction: "按原票 AC 与检查继续收口。" },
    { choice: "add-ticket", label: "追加票", action: dispatch, instruction: prepare + "新票依赖原票时，在 tickets[0].after 加入 {taskId,stage:\"verified\"}。" },
    { choice: "replace-ticket", label: "作废重派", before,
      action: { command: "abandonTask", args: { taskId: task.id, reason } }, then: dispatch,
      instruction: prepare + "先确认旧票停写并收口后台检查。作废回执若有 handoff.ownedDirty，将它填入后继票的 tickets[0].ownedDirty。若要保留等待票的依赖，停写后先派后继票，再用 supersede {taskId,supersededBy,reason} 替代旧票。" },
  ];
}

export function specVersionSummary(notes) {
  const spec = notes.find(note => note.specVersion);
  if (!spec) return {};
  const { dispatched, current } = spec.specVersion;
  return {
    specVersion: spec.specVersion,
    acceptanceSummary: `按派发时 spec ${dispatched ?? `摘要 ${spec.fromDigest.slice(0, 12)}`} 验收，当前 spec ${current ?? (spec.toDigest ? `摘要 ${spec.toDigest.slice(0, 12)}` : "不可读取")}。`,
  };
}

export function planningDiff(frozen, current) {
  if (current === null) return { status: "unavailable" };
  if (frozen === current) return { status: "bytes-changed", removedLines: 0, addedLines: 0 };
  const before = frozen.split(/\r?\n/), after = current.split(/\r?\n/);
  let first = 0, endBefore = before.length, endAfter = after.length;
  while (first < endBefore && first < endAfter && before[first] === after[first]) first++;
  while (endBefore > first && endAfter > first && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const excerpt = (lines, end) => lines.slice(first, Math.min(first + 5, end)).map(line => line.slice(0, 250));
  return {
    status: first === endBefore && first === endAfter ? "bytes-changed" : "changed",
    startLine: first + 1, removedLines: endBefore - first, addedLines: endAfter - first,
    before: excerpt(before, endBefore), after: excerpt(after, endAfter),
  };
}
