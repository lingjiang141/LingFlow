export const qualityDimensions = Object.freeze({
  requirements: "需求正确性",
  implementation: "实现一致性",
  system: "系统影响",
});

const qualityStates = Object.freeze({ pass: "通过", issues: "有问题", unverified: "未验证" });

export function qualityStateLabel(state) {
  return Object.hasOwn(qualityStates, state) ? qualityStates[state] : "未记录";
}

export function formatQualitySummary(record) {
  if (!record) return "";
  const results = Object.entries(qualityDimensions).map(([key, label]) =>
    `${label} ${qualityStateLabel(record.dimensions?.[key]?.state)}`);
  return "[LingFlow三维结果] 成员申报。" + results.join("，");
}

export function noticeQualitySummary(notice, task) {
  if (!task) return null;
  const [kind, ref, revision] = notice.key.split(":");
  const report = kind === "report-blocked"
    ? task.blockedReports?.find((item) => item.id === ref)
    : kind === "report"
    ? task.reports?.find((item) => item.id === ref)
    : kind === "review" && revision && ref === task.id
      ? task.reports?.findLast((item) => item.revision === Number(revision))
      : undefined;
  const review = kind === "review" && !revision
    ? task.reviews?.find((item) => item.id === ref)
    : undefined;
  const line = formatQualitySummary(report ?? review);
  return line ? { line, fromReviewAssignment: Boolean(report && kind === "review") } : null;
}
