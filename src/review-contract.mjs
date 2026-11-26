import { invalidPlan, riskItemShape, violation } from "./plan-schema.mjs";
import { dimensions, evidenceJobs, threeDimensions, verify } from "./quality.mjs";

const validText = (value, max) => typeof value === "string" && value.trim() && value.length <= max;
const stableId = value => typeof value === "string" && /^[\w.-]{1,80}$/.test(value);
const uniqueIds = value => Array.isArray(value) && value.length && value.every(stableId) && new Set(value).size === value.length;

export function freezeRiskItems(input, verification, warnings, prefix) {
  const items = input.riskItems;
  const path = prefix + ".riskItems";
  if (items === undefined && input.risk === "high" && validText(input.riskReason, 8000)) {
    warnings.push({ path, message: "该票只有自由文本风险理由，缺少可核对的 AC/检查映射" });
    return [{ id: "RISK-1", reason: input.riskReason.trim(), impact: "(未填写，主控应补充)", coveredBy: [], verifiedBy: [] }];
  }
  if (items === undefined && input.risk !== "high") return;

  const sampleCheck = verification?.checks.find(check => check.stage === "full" && check.covers.length)
    ?? verification?.checks.find(check => check.covers.length);
  const example = [{ ...riskItemShape, ...(sampleCheck && { coveredBy: [sampleCheck.covers[0]], verifiedBy: [sampleCheck.id] }) }];
  const reject = (suffix, message) => {
    throw invalidPlan([violation(path + suffix, message, example, "填写本票的风险、影响及验收和检查映射",
      { path, value: example, requiresInput: false })], warnings);
  };
  if (!Array.isArray(items) || items.length > 40 || input.risk === "high" && !items.length)
    reject("", input.risk === "high" ? "高风险必须给出可核对的理由与覆盖检查" : "riskItems 须为最多 40 条的数组");
  const ids = new Set();
  return items.map((item, index) => {
    const at = `[${index}]`;
    if (!stableId(item?.id) || ids.has(item.id)) reject(at + ".id", "风险编号须为票内唯一的稳定编号");
    ids.add(item.id);
    for (const field of ["reason", "impact"])
      if (!validText(item[field], 2000)) reject(at + "." + field, "风险理由和影响须为 1–2000 字符的非空文本");
    if (!uniqueIds(item.coveredBy) || item.coveredBy.some(id => !verification?.acceptance.some(ac => ac.id === id)))
      reject(at + ".coveredBy", "须引用本票已登记的验收条款");
    if (!uniqueIds(item.verifiedBy)) reject(at + ".verifiedBy", "须引用本票已登记的覆盖检查");
    for (const id of item.verifiedBy) {
      const check = verification?.checks.find(check => check.id === id);
      if (!check) reject(at + ".verifiedBy", `本票没有检查 ${id}`);
      if (!check.covers.some(ac => item.coveredBy.includes(ac)))
        reject(at + ".verifiedBy", `检查 ${id} 未覆盖这条理由声明的 AC`);
    }
    return { id: item.id, reason: item.reason.trim(), impact: item.impact.trim(),
      coveredBy: [...item.coveredBy], verifiedBy: [...item.verifiedBy] };
  });
}

export const requiresRiskReview = task => task.risk === "high" && task.riskContractVersion === 1 && Boolean(task.riskItems?.length);

export function reviewRiskItems(task, input, passing, checks) {
  const items = task.riskItems ?? [];
  if (passing && requiresRiskReview(task))
    verify(Array.isArray(input) && input.length === items.length, "evidence-missing", "审查通过须逐条覆盖 riskItems 并提交 riskAssessment");
  if (input === undefined) return;
  verify(Array.isArray(input) && input.length <= items.length, "contract-invalid", "riskAssessment 须引用本票的 riskItems");
  const ids = new Set();
  return input.map(item => {
    verify(items.some(risk => risk.id === item?.id) && !ids.has(item.id), "contract-invalid", "riskAssessment 须使用本票唯一的风险编号");
    ids.add(item.id);
    verify(["covered", "not_covered", "unverifiable"].includes(item.verdict), "contract-invalid", "riskAssessment.verdict 无效");
    verify(!passing || item.verdict === "covered", "evidence-missing", "风险未覆盖或无法验证时须提交 verdict=changes");
    verify(validText(item.evidence, 8000), "evidence-missing", "风险核对证据须为 1–8000 字符的非空文本");
    const jobs = item.checkIds === undefined ? undefined : evidenceJobs(item.checkIds, checks, item.id);
    return { id: item.id, verdict: item.verdict, evidence: item.evidence.trim(),
      ...(jobs && { checkIds: jobs.map(check => check.checkId), evidenceJobs: jobs }) };
  });
}

export function summarizeRisk(task, note) {
  if (note === undefined && !requiresRiskReview(task)) return;
  return verify(validText(note, 8000) && note.trim(), "evidence-missing", "请在 decision.riskNote 填写风险核对结论（1–8000 字符）");
}

export function summarizeDimensions(task, input, report, checks) {
  verify(input, "evidence-missing", "主控需核对开发提交的三维，并在 decision.dimensions 填写逐维结论");
  const compared = threeDimensions(Object.fromEntries(dimensions.map(name => {
    const item = input[name];
    return [name, { ...item, evidence: item?.evidence ?? item?.note }];
  })));
  for (const name of dimensions) {
    const item = input[name], result = compared[name];
    result.note = verify(validText(item.note, 8000) && item.note.trim(), "evidence-missing", `${name}.note 须说明独立核对范围和比较结果`);
    if (result.state !== "pass" || report?.dimensions?.[name]?.state !== "pass") {
      const reason = `三维核对 ${name}：${result.note}`;
      const developerChecks = checks.filter(check => !["independent", "controller"].includes(check.stage));
      const evidence = developerChecks.filter(check => Array.isArray(item.checkIds) && item.checkIds.includes(check.checkId) &&
        !["red", "regression"].includes(check.stage)).map(check => check.checkId);
      throw Object.assign(Error(reason), { verificationCode: "evidence-missing",
        nextAction: { command: "rework", args: { taskId: task.id, reason, ...(evidence.length && { evidence }) } } });
    }
    result.evidenceJobs = evidenceJobs(item.checkIds, checks, name);
  }
  return compared;
}
