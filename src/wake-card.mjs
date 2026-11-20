import { noticeQualitySummary } from "../ui/quality-summary.js";
import { handoffLines, handoffRecord } from "../ui/handoff-card.js";
import { silentResumeText } from "./controller-notices.mjs";

const LIMIT = 4;

const checkStates = {
  passed: "通过",
  failed: "失败",
  stale: "证据失效",
  uncertain: "待对账",
  interrupted: "已中断",
};

function excerpt(value, limit = 80) {
  const characters = Array.from(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return characters.length > limit
    ? characters.slice(0, limit).join("") + "…"
    : characters.join("");
}

function purpose(notice, task, job, kind, ref, phase) {
  if (notice.silent) return { label: "角色已开启 · 本轮无责任", detail: silentResumeText };
  switch (kind) {
    case "git-drift":
      return { label: "Git 提交漂移 · 提交者未知",
        detail: `${notice.drift?.from.slice(0, 12) ?? "?"} → ${notice.drift?.to.slice(0, 12) ?? "?"} · 冻结范围冲突 ${notice.drift?.conflicts.length ?? 0} 项`,
        next: `查看 describeDrift ${JSON.stringify({ taskId: notice.taskId })}，核对原票后处理。` };
    case "dispatch":
      if (task?.fingerprintRecovery) {
        return { label: "指纹口径已续接", detail: "原候选待重新交付", next: notice.summary, priority: 0 };
      }
      return {
        label:
          task?.reworkReason || task?.revision > 1
            ? "返工续接"
            : task?.scheduleVersion
              ? "调度更新后续接"
              : task?.readOnly
                ? "新只读任务"
                : "新开发任务",
        detail:
          task?.reworkReason || task?.revision > 1
            ? task.reworkReason
            : task?.scheduleHistory?.at(-1)?.reason,
        next: "查看原票范围和验收条件；动手前先核对冻结规划、写入边界和检查。",
      };
    case "review": {
      if (phase)
        return {
          label: "新独立审查",
          next: "核对当前候选、原需求、差异和检查证据，提交审查结论。",
        };
      const review = task?.reviews?.find((item) => item.id === ref);
      const verdict = review?.verdict;
      if (review?.classification === "contract-invalid" || review?.classification === "evidence-missing")
        return {
          label: review.classification === "contract-invalid" ? "审查发现契约需对账" : "审查证据待补",
          detail: review.findings,
          next: "核对原票契约或补齐证据，再决定如何续接。",
          priority: 0,
        };
      if (verdict === "changes" || notice.summary.startsWith("审查需返工"))
        return {
          label: "审查要求返工",
          detail: review?.findings,
          next: "查看阻塞发现，在原票安排返工。",
          priority: 0,
        };
      const passed =
        verdict === "pass" || notice.summary.startsWith("审查通过");
      return {
        label: passed ? "独立审查通过" : "审查回报已入库",
        detail: review?.findings,
        next:
          passed && task?.state === "waiting_verification"
            ? "核对审查证据，提交原票约定的主控收口检查。"
            : "核对审查结论、证据和剩余交付门槛。",
        priority: 2,
      };
    }
    case "report-blocked":
      return { label: "开发报告 · 交付受阻", detail: handoffRecord(notice, task)?.summary,
        next: "主控先核对程序诊断和成员说明，处理后沿原票续接。", priority: 0 };
    case "report": {
      const detail = task?.reports?.find((report) => report.id === ref)?.summary;
      return task?.state === "waiting_verification"
        ? {
            label: "开发已交付 · 待独立验证",
            detail,
            next: "核对交付证据，提交原票约定的独立检查。",
            priority: 2,
          }
        : {
            label: "开发报告已入库",
            detail,
            next: "查看交付结果、检查证据和剩余限制。",
            priority: 2,
          };
    }
    case "question":
      return {
        label: "成员遇到阻塞",
        detail: notice.summary.replace(/^任务阻塞：/, ""),
        next: "查看问题并沿原票答复。",
        priority: 0,
      };
    case "answer":
      return {
        label: "主控已答复",
        detail: notice.summary.replace(/^主控答复：/, ""),
        next: "阅读答复后沿原票续接。",
      };
    case "schedule":
      return {
        label: "成员请求调整调度",
        detail: task?.waitReason,
        next: "核对现场冲突后调整原票依赖、范围或资源。",
        priority: 0,
      };
    case "patrol-resume":
      return {
        label: "巡检安排原会话续接",
        detail: notice.summary,
        next: task
          ? "读取原票和当前进度，从已核实的检查点继续。"
          : "核对当前会话中断前的事项，沿原上下文续接。",
        priority: 0,
      };
    case "patrol-alert":
      return {
        label: "巡检发现会话异常",
        detail: notice.summary,
        next: "核对成员实际 DSH 状态和原票，按异常类型处理。",
        priority: 0,
      };
    case "preflight-ready":
      return { label: "准入恢复 · 原票已自动分派", next: "不需要确认或重复派单；沿原票等待回报。", priority: 2 };
    case "wake-abandoned":
      return { label: "原唤醒已停止重投", detail: notice.summary, priority: 0 };
    case "delivery-blocked":
      return { label: "原票投递受阻", detail: notice.summary, next: "从 list 查看原票投递状态及原因。明确拒绝达上限可用 redeliver；结果待对账时请成员在原会话读取 inbox。", priority: 0 };
    case "dependency-ready":
      return { label: "前置已满足 · 原票已自动分派", next: "沿原票查看，不重复派单。", priority: 2 };
    case "preflight":
      return {
        label: "任务准入受阻",
        detail: task?.waitReason,
        next: "核对准入条件和工作区，再处理原票。",
        priority: 0,
      };
    case "review-blocked":
      return {
        label: "自动派审受阻",
        next: "确认有可用的独立审查者。",
        priority: 0,
      };
    case "check":
    case "batch": {
      const label = kind === "batch" ? "累计验证" : "后台检查";
      const outcome =
        job?.check.stage === "red" && phase === "passed"
          ? "已记录预期失败"
          : (checkStates[phase] ?? "结果已回投");
      const count = job?.taskIds?.length;
      return {
        label: label + " · " + outcome,
        detail: job
          ? job.check.id + (count > 1 ? `（涉及 ${count} 张票）` : "")
          : notice.summary,
        next:
          phase === "passed"
            ? "查看证据，按原票进入下一步。"
            : "核对作业日志和状态，再决定怎么续接。",
        priority: phase === "passed" ? 2 : 0,
      };
    }
    case "check-reconcile":
    case "batch-stale":
      return {
        label: "后台验证需要对账",
        detail: kind === "batch-stale" ? notice.summary : "",
        next: "核实原作业、候选和资源状态后再处理。",
        priority: 0,
      };
    case "message":
      if (/^主控直达消息|^成员回复/.test(notice.summary))
        return { label: "团队消息", next: "在 inbox 阅读消息，必要时用 message 回复。" };
      return notice.summary.startsWith("规划已交付")
        ? { label: "规划已交付", next: "在 inbox 查看规划产物与待决项。" }
        : notice.summary.startsWith("主控已回复监管消息")
          ? { label: "主控已回复 · 监管频道", next: "读取 inbox，把主控原答复转告用户。" }
          : {
              label: "监管者转达 · 请主控处理",
              next: "从 inbox 读取原消息，处理后用 message 携带 replyTo 回复监管者。",
            };
    case "requirement":
      return {
        label: "协同主控已登记需求",
        detail: notice.summary.replace(/^协同主控已登记需求：/, ""),
        next: "核对确认依据和后续安排。",
      };
    case "resume":
      return {
        label: "角色已开启 · 沿原责任续接",
        next: "读取 inbox 的恢复索引。核对原票、实际工作区或当前候选、未答问题与现有检查回执后继续；不要重新派单或盲目重跑。",
        priority: 3,
      };
    case "context":
      return {
        label: "角色上下文已更新",
        detail: notice.summary,
        next: "读取当前身份和职责。",
        priority: 3,
      };
    default:
      return {
        label: "协作动态",
        detail: notice.summary,
        next: "读取收件箱查看原事项。",
        priority: 3,
      };
  }
}

export function wakeSummary(notices, tasks, jobs, roles = []) {
  const groups = new Map();
  for (const notice of notices) {
    const [kind, ref, phase] = notice.key.split(":");
    const task = !notice.silent && notice.taskId
      ? tasks.find((item) => item.id === notice.taskId)
      : undefined;
    const job =
      kind === "check" || kind === "batch"
        ? jobs.find((item) => item.id === ref)
        : undefined;
    const item = purpose(notice, task, job, kind, ref, phase);
    // Repeated blockers on the same ticket share a row; distinct jobs keep their names.
    const key = notice.silent ? "silent-resume" : JSON.stringify([kind, task?.id, item.label, job?.id, ["report", "report-blocked", "review"].includes(kind) ? ref : undefined]);
    const previous = groups.get(key);
    const quality = notice.silent ? null : noticeQualitySummary(notice, task);
    groups.set(key, { ...item, task, quality, handoff: notice.silent ? [] : handoffLines(notice, task, roles), count: (previous?.count ?? 0) + 1, hasPolicy: notice.actionable !== undefined, actionable: previous?.actionable || notice.actionable, controllerChecked: notice.controllerChecked && (previous?.controllerChecked ?? true) });
  }
  const items = [...groups.values()].sort(
    (a, b) => Number(Boolean(b.actionable)) - Number(Boolean(a.actionable)) || (a.priority ?? 1) - (b.priority ?? 1),
  );
  const shown = items.slice(0, LIMIT);
  const lines = shown.map(({ label, detail, next, task, quality, handoff, count, hasPolicy, actionable, controllerChecked }) => {
    const ticket = task
      ? `｜任务 ${excerpt(task.ticketKey || task.id.slice(0, 8), 24)}《${excerpt(task.title, 58)}》`
      : "";
    const snippet = excerpt(detail, handoff.length ? 1200 : 80);
    const extra = count > 1 ? `（共 ${count} 条）` : "";
    const result = quality ? `\n  ${quality.fromReviewAssignment ? "开发自测：\n  " : ""}${quality.line}` : "";
    const truncated = snippet.endsWith("…") && handoff.length ? "\n  摘要已截断；请用上面的 inspect 查看完整原文。" : "";
    return `- ${hasPolicy ? "[actionable: " + Boolean(actionable) + "; 主控已自查: " + Boolean(controllerChecked) + "] " : ""}${label}${ticket}${extra}${snippet ? "\n  摘要：" + snippet : ""}${next ? "\n  下一步：" + next : ""}${result}${handoff.map((line) => "\n  " + line).join("")}${truncated}`;
  });
  const remaining =
    notices.length - shown.reduce((total, item) => total + item.count, 0);
  if (remaining > 0) lines.push(`另有 ${remaining} 条，收件箱可查看全部事项。`);
  return lines.join("\n");
}
