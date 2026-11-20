import { specBoard, specChoices } from "./spec-board.js";
import { excerpt, handoffLines, handoffRecord } from "./handoff-card.js";
import { formatQualitySummary, noticeQualitySummary, qualityDimensions, qualityStateLabel } from "./quality-summary.js";
import { roleDeliveryPresentation } from "./role-delivery.js";

// uiToken 只在首次加载时出现在 hash 里；抹掉 hash 前先存进 sessionStorage，
// 这样窗口内刷新（F5 / 比例变化后重载）仍然能通过服务端鉴权。
const token = (() => {
  const fromHash = location.hash.slice(1);
  try {
    if (fromHash) sessionStorage.setItem("lingflow.uiToken", fromHash);
    return fromHash || sessionStorage.getItem("lingflow.uiToken") || "";
  } catch {
    return fromHash;
  }
})();
history.replaceState(null, "", location.pathname);
window.lingflowErrors = [];
window.addEventListener("error", (e) => window.lingflowErrors.push(e.message));
window.addEventListener("unhandledrejection", (e) =>
  window.lingflowErrors.push(String(e.reason)),
);
const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
};
// 成员卡外观模块：模块缺失时自动退化为纯默认卡片，主界面不受影响。
// 这里用顶层 await 等它就绪，否则首屏第一轮渲染会漏掉卡片装饰（要等下一次 2.5s 轮询才补上）。
const cardAppearance = await import("./card-appearance.js").catch(() => null);
const decorateRoleCard =
  typeof cardAppearance?.decorateRoleCard === "function"
    ? cardAppearance.decorateRoleCard
    : () => {};
let state,
  projectId,
  polling;
const status = {
  queued: "等待准入",
  assigned: "开发中",
  rework: "返工中",
  paused: "待调整调度",
  blocked: "已阻塞",
  superseded: "已被替代",
  waiting_verification: "待独立验证",
  waiting_batch: "等待累计验证",
  waiting_review: "等待审查",
  reviewing: "审查中",
  changes_requested: "待主控处理",
  ready: "待汇总",
  trial: "待用户试用",
  accepted: "已验收",
};
const taskStatus = (task) => task.blockedBy?.some(blocker => blocker.code === "bridge-tools-missing") ? "工具未恢复 · bridge-tools-missing" : (task.scopeReleased || task.releasedScope) && task.state !== "superseded" ? "范围已释放" : ["assigned", "rework"].includes(task.state) && !task.deliveredAt
  ? "已分配 · 待送达" : status[task.state] ?? task.state;
const roleLabels = { controller: "主控", developer: "开发", reviewer: "审查", supervisor: "监管者" };
const legacyRoleLabels = { planner: "规划（旧角色）", tester: "测试（旧角色）" };
const riskLabels = { low: "低风险", medium: "中风险", high: "高风险" };
const specSelection = new Map();
const roleActions = new Map();
const resumeLabels = {
  silent: "角色已开启 · 本轮无责任，无需核对或回报",
  offline: "续接已登记 · 等原会话上线", "waiting-idle": "续接已登记 · 等原会话空闲且没有排队输入",
  pending: "续接已登记 · 待送达", delivered: "续接提示已送达 · 等成员读取",
  read: "成员已读取续接提示", "delivery-issue": "续接送达待对账 · 见上方说明",
};
async function api(route, body = {}) {
  const response = await fetch("/api/ui/" + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error);
  return value;
}
async function call(command, args, operationId = crypto.randomUUID()) {
  return api("call", { command, args, operationId });
}
function button(label, action, className) {
  const b = node("button", label, className);
  b.type = "button";
  b.onclick = () => Promise.resolve(action()).catch(showError);
  return b;
}
async function changeRoleDelivery(role, enabled, resume = false) {
  roleActions.set(role.id, { pending: true, message: enabled ? "正在登记续接…" : "正在暂停新投递…" });
  render();
  try {
    const receipt = await call("enable", { roleId: role.id, enabled, ...(resume && { resume: true }) });
    await polling;
    const current = state.roles.find((item) => item.id === role.id);
    if (current) Object.assign(current, receipt);
    roleActions.delete(role.id);
  } catch (error) {
    roleActions.set(role.id, { error: true, message: "操作未确认：" + error.message });
  }
  render();
  await refresh();
}
function showError(error) {
  $("error").hidden = false;
  $("error").textContent = error.message;
}
function form(title, fields, submit, submitLabel = "确认") {
  $("modal-title").textContent = title;
  $("fields").replaceChildren();
  $("form-error").textContent = "";
  const submitButton = $("modal-form").querySelector("[type=submit]");
  submitButton.hidden = false;
  submitButton.textContent = submitLabel;
  for (const field of fields) {
    const label = node("label", field.label);
    label.htmlFor = "field-" + field.name;
    const input = node(
      field.options ? "select" : field.multiline ? "textarea" : "input",
    );
    input.id = "field-" + field.name;
    input.name = field.name;
    if (field.options)
      for (const [value, text] of field.options) {
        const option = node("option", text);
        option.value = value;
        input.append(option);
      }
    if (!field.options || field.value !== undefined)
      input.value = field.value ?? "";
    input.required = !field.optional;
    if (field.placeholder) input.placeholder = field.placeholder;
    $("fields").append(label, input);
  }
  const operationId = crypto.randomUUID();
  $("modal-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.submitter ?? e.target.querySelector("[type=submit]");
    b.disabled = true;
    try {
      await submit(Object.fromEntries(new FormData(e.target)), operationId);
      $("modal").close();
      await refresh();
    } catch (error) {
      $("form-error").textContent = error.message;
    } finally {
      b.disabled = false;
    }
  };
  if (!$("modal").open) $("modal").showModal();
}
function newProject() {
  form(
    "添加本地项目",
    [
      { name: "name", label: "项目名称" },
      {
        name: "root",
        label: "已有项目的绝对目录",
        placeholder: "E:\\Projects\\MyApp",
      },
    ],
    async (v, op) => {
      const project = await call("createProject", { name: v.name, root: v.root }, op);
      projectId = project.id;
    },
  );
  const input = $("field-root");
  const browse = button("选择目录…", async () => {
    browse.disabled = true;
    $("form-error").textContent = "";
    try {
      const { directory } = await api("pick-project-directory");
      if (directory && input.isConnected) input.value = directory;
    } catch (error) {
      if (input.isConnected) $("form-error").textContent = error.message;
    } finally {
      browse.disabled = false;
    }
  });
  input.onclick = () => browse.click();
  const row = node("div", undefined, "directory-field");
  input.before(row);
  row.append(input, browse);
}
function deleteProject() {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  form(
    `删除项目「${project.name}」？`,
    [],
    (_v, op) => call("deleteProject", { projectId: project.id }, op),
    "删除项目",
  );
  $("fields").append(
    node("p", "将移除 LingFlow 中的成员绑定、需求、任务和协作记录。项目文件和 DSH 会话会保留。"),
    node("p", project.root),
  );
}
const memberFields = [
  { name: "name", label: "成员名称" },
  {
    name: "preset",
    label: "应用提示词预设",
    optional: true,
    options: [["", "手动填写"]],
  },
  {
    name: "identityPrompt",
    label: "身份提示词（留空使用角色默认）",
    optional: true,
    multiline: true,
    placeholder:
      "例如：你负责前端交付。优先检查交互边界，并把已验证的步骤写进报告。",
  },
];
function wirePresetPicker() {
  const picker = $("field-preset");
  const prompt = $("field-identityPrompt");
  const presets = new Map(
    (state.promptPresets ?? []).map((preset) => [preset.id, preset]),
  );
  const editor = node("details", undefined, "preset-editor");
  const label = node("label", "预设名称");
  const name = node("input");
  name.id = "preset-name";
  label.htmlFor = name.id;
  const message = node("p", undefined, "muted");
  message.setAttribute("role", "status");
  const actions = node("div", undefined, "preset-actions");
  let busy = false;

  function renderPresets(selectedId) {
    const empty = node("option", "手动填写");
    empty.value = "";
    picker.replaceChildren(
      empty,
      ...[...presets.values()].map((preset) => {
        const option = node("option", preset.name);
        option.value = preset.id;
        return option;
      }),
    );
    picker.value = selectedId;
    name.value = presets.get(selectedId)?.name ?? "";
    update.disabled = remove.disabled = !presets.has(selectedId);
  }
  async function changePreset(action) {
    if (busy) return;
    const submit = $("modal-form").querySelector("[type=submit]");
    busy = true;
    submit.disabled = true;
    picker.disabled = true;
    message.textContent = "";
    try {
      await action();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      busy = false;
      submit.disabled = false;
      picker.disabled = false;
    }
  }
  function savePreset(presetId) {
    return changePreset(async () => {
      const saved = await call("savePromptPreset", {
        presetId,
        name: name.value,
        identityPrompt: prompt.value,
      });
      presets.set(saved.id, saved);
      renderPresets(saved.id);
      message.textContent = "预设已保存";
      await refresh();
    });
  }
  const create = button("另存为新预设", () => savePreset());
  create.id = "create-prompt-preset";
  const update = button("更新所选预设", () => savePreset(picker.value));
  const remove = button("删除所选预设", () =>
    changePreset(async () => {
      const presetId = picker.value;
      await call("deletePromptPreset", { presetId });
      presets.delete(presetId);
      renderPresets("");
      message.textContent = "预设已删除，表单中的提示词已保留";
      await refresh();
    }),
  );
  picker.onchange = () => {
    const selected = presets.get(picker.value);
    if (selected) prompt.value = selected.identityPrompt;
    name.value = selected?.name ?? "";
    update.disabled = remove.disabled = !selected;
    message.textContent = "";
  };
  actions.append(create, update, remove);
  editor.append(
    node("summary", "管理提示词预设"),
    label,
    name,
    actions,
    message,
  );
  $("fields").append(editor);
  renderPresets("");
}

$("add-role").onclick = () => {
  form(
    "添加团队成员",
    [
      {
        name: "kind",
        label: "角色类型",
        options: [...Object.entries(roleLabels), ["custom", "自定义角色"]],
        value: "developer",
      },
      {
        name: "customLabel",
        label: "自定义角色名称",
        placeholder: "例如：测试、技术顾问",
      },
      {
        name: "workflowKind",
        label: "按哪类工作流职责运行",
        options: Object.entries(roleLabels),
        value: "developer",
      },
      ...memberFields,
    ],
    (v, op) =>
      call(
        "addRole",
        {
          projectId,
          name: v.name,
          identityPrompt: v.identityPrompt,
          kind: v.kind === "custom" ? v.workflowKind : v.kind,
          customLabel: v.kind === "custom" ? v.customLabel : undefined,
        },
        op,
      ),
  );
  const roleType = $("field-kind");
  const workflowKind = $("field-workflowKind");
  const prompt = $("field-identityPrompt");
  const toggleCustomFields = () => {
    const custom = roleType.value === "custom";
    for (const fieldName of ["customLabel", "workflowKind"]) {
      const input = $("field-" + fieldName);
      input.disabled = !custom;
      input.hidden = !custom;
      input.labels[0].hidden = !custom;
    }
    const kind = custom ? workflowKind.value : roleType.value;
    prompt.placeholder =
      state.roleIdentityDefaults?.[kind] ?? memberFields.find((field) => field.name === "identityPrompt").placeholder;
  };
  roleType.onchange = toggleCustomFields;
  workflowKind.onchange = toggleCustomFields;
  toggleCustomFields();
  wirePresetPicker();
};

function renameMember(role) {
  form(
    "修改成员名称",
    [{ name: "name", label: "成员名称", value: role.name }],
    (v, op) => call("editRole", { roleId: role.id, name: v.name }, op),
  );
}
$("new-project").onclick = newProject;
$("first-project").onclick = newProject;
$("delete-project").onclick = deleteProject;
$("controller-settings").onclick = () => {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  const members = state.roles.filter(
    (r) => r.projectId === project.id && r.kind === "controller" && !r.archivedAt,
  );
  const defaultFor = (target) =>
    target === "project"
      ? (state.controllerPolicyDefault ?? "")
      : (state.roleIdentityDefaults?.controller ?? "");
  const savedFor = (target) =>
    target === "project"
      ? project.controllerPolicy
      : members.find((r) => r.id === target)?.identityPrompt;
  const valueFor = (target) => {
    const saved = savedFor(target);
    return typeof saved === "string" && saved.trim() && saved.trim() !== "undefined"
      ? saved
      : defaultFor(target);
  };
  form(
    "主控提示词",
    [
      { name: "target", label: "应用范围", options: [
        ["project", "项目行为规范"],
        ...members.map((r) => [r.id, r.name + " · 个人身份提示词"]),
      ] },
      { name: "policy", label: "提示词", multiline: true, optional: true, value: valueFor("project") },
    ],
    (values, op) => {
      const prompt = values.policy === defaultFor(values.target) ? "" : values.policy;
      if (values.target === "project")
        return call("setControllerPolicy", { projectId: project.id, policy: prompt }, op);
      return call("editRole", { roleId: values.target, identityPrompt: prompt }, op);
    },
  );
  const picker = $("field-target");
  const prompt = $("field-policy");
  picker.onchange = () => { prompt.value = valueFor(picker.value); };
  $("fields").append(
    node("p", "项目规范适用于本项目的主控。个人身份随角色下发。留空或恢复内置后保存，即使用内置内容。", "muted"),
    button("恢复内置", () => { prompt.value = defaultFor(picker.value); }),
  );
};
$("check-settings").onclick = () => {
  $("modal-title").textContent = "后台检查";
  $("form-error").textContent = "";
  $("modal-form").onsubmit = (event) => event.preventDefault();
  $("modal-form").querySelector("[type=submit]").hidden = true;
  const jobs = (state.checkJobs ?? []).filter((job) => job.projectId === projectId).slice(-20).reverse();
  $("fields").replaceChildren(node("p", "按原票冻结的检查命令执行。责任成员提交检查，累计检查达到条件时自动排队。", "muted"));
  if (!jobs.length) $("fields").append(node("p", "暂无后台检查记录"));
  for (const job of jobs) {
    const task = state.tasks.find((item) => item.id === (job.taskId ?? job.taskIds?.[0]));
    const summary = `${task?.ticketKey ?? task?.title ?? "累计检查"} · ${job.check.id} · ${job.state}`;
    $("fields").append(node("p", summary));
    if (task) $("fields").append(button("查看原票与检查记录", () => detail(task)));
  }
  if (!$("modal").open) $("modal").showModal();
};
$("patrol-settings").onclick = () => {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  form("自动巡检", [{
    name: "enabled", label: "项目巡检", value: project.autoPatrol === false ? "off" : "on",
    options: [["on", "开启巡检和有限续接"], ["off", "暂停自动巡检"]],
  }], (values, op) => call("setAutoPatrol", { projectId: project.id, enabled: values.enabled === "on" }, op), "保存");
  $("fields").append(node("p", "巡检查看已开启角色的实时 DSH 状态。确认空闲且有需要续接的责任时有限重试；异常和待对账情况显示在团队会话。", "muted"));
};
$("cancel").onclick = () => $("modal").close();
function showDimensions(title, record) {
  const section = node("section", undefined, "quality-dimensions");
  section.append(node("h3", title));
  if (record) section.append(node("p", formatQualitySummary(record)));
  for (const [key, label] of Object.entries(qualityDimensions)) {
    const item = record?.dimensions?.[key];
    const row = node("div", undefined, "quality-row");
    row.dataset.result = item?.state ?? "missing";
    row.append(node("strong", label), node("span", qualityStateLabel(item?.state)));
    if (item?.evidence) row.append(node("p", item.evidence));
    if (item?.evidenceJobs?.length) row.append(node("small", "检查：" + item.evidenceJobs.map(({ checkId }) => checkId).join("、")));
    section.append(row);
  }
  return section;
}
function detail(task) {
  $("modal-title").textContent = task.title;
  $("fields").replaceChildren();
  $("form-error").textContent = "";
  $("modal-form").querySelector("[type=submit]").hidden = true;
  const requirement = state.requirements.find(
    (r) => r.id === task.requirementId,
  );
  const timing = task.waitTimings;
  const seconds = ms => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " 秒";
  const content = [
    `任务：${task.id}`,
    `状态：${taskStatus(task)} / 风险：${riskLabels[task.risk] ?? "未标记风险"}`,
    task.sources?.spec?.file && `冻结规格：${task.sources.spec.file} · ${task.sources.spec.digest?.slice(0, 8) ?? "—"}`,
    `版本：${task.revision}`,
    `受理：${new Date(task.acceptedAt).toLocaleString()}`,
    `DSH 送达：${task.deliveredAt ? new Date(task.deliveredAt).toLocaleString() : "尚无回执"}`,
    `报告入库：${task.reportedAt ? new Date(task.reportedAt).toLocaleString() : "尚未报告"}`,
    `需求：${requirement?.text}`,
    `任务：${task.description}`,
    task.ownerSilentForMs > 0 && `成员静默：${Math.floor(task.ownerSilentForMs / 60000)} 分钟 · 最近心跳 ${task.lastHeartbeatAt ? new Date(task.lastHeartbeatAt).toLocaleTimeString() : "未知"} · 回合 ${task.lastTurnState}`,
    task.supersededBy && `后继票：${task.supersededBy}（历史证据保留）`,
    task.releasedScope && `范围已释放：${task.releasedScope.reason}`,
    `写入范围：${task.writes.join("、")}`,
    `读取范围：${task.reads.join("、")}`,
    task.contextReads?.length && `背景阅读（不锁写入）：${task.contextReads.join("、")}`,
    `共享资源：${task.resources.join("、") || "无"}`,
    `依赖任务：${task.dependencies.join("、") || "无"}`,
    task.ticketKey && `规划票编号：${task.ticketKey}`,
    requirement?.source && `用户确认依据：${requirement.source}`,
    task.waitReason && `等待：${task.waitReason}`,
    timing && (timing.trackedSince || timing.checkQueueMs > 0) &&
      `分段等待：前置 ${timing.trackedSince ? seconds(timing.dependencyMs) : "—"} · 资源／范围 ${timing.trackedSince ? seconds(timing.resourceMs) : "—"} · 成员 ${timing.trackedSince ? seconds(timing.memberMs) : "—"} · 检查排队 ${seconds(timing.checkQueueMs)}`,
    task.developerChecksPending && "责任开发待登记检查配方",
    task.blockedBy?.map(blocker => blocker.detail ?? blocker.code).join("；"),
    !task.readOnly && !task.verification && "旧票缺少冻结契约，历史仍可查看；剩余工作由主控用正式计划登记后继票。",
    task.progress && `进度：${task.progress}`,
    task.reworkReason && `返工原因：${task.reworkReason}`,
    task.trialInstructions && `试用步骤：${task.trialInstructions}`,
    task.acceptance && `验收：${task.acceptance.evidence ?? task.acceptance}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  $("fields").append(node("pre", content));
  const report = task.reports.findLast((item) => item.revision === task.revision && item.candidate === task.candidate);
  const review = report && task.reviews.findLast((item) => item.candidate === report.candidate &&
    (item.revision !== undefined ? item.revision === report.revision : item.at >= report.at));
  $("fields").append(showDimensions("当前候选 · 开发自测", report));
  if (task.risk === "high" || review) $("fields").append(showDimensions("当前候选 · 独立审查", review));
  else $("fields").append(node("p", "本票不要求独立审查", "muted"));
  if (task.controllerEvidence)
    $("fields").append(node("pre", "主控证据核对\n" + JSON.stringify(task.controllerEvidence, null, 2)));
  for (const report of task.reports)
    $("fields").append(
      node("pre", "开发交付\n" + formatQualitySummary(report) + "\n" + JSON.stringify(report, null, 2)),
    );
  for (const report of task.blockedReports ?? [])
    $("fields").append(node("pre", "开发交付受阻 · 未受理候选\n" + formatQualitySummary(report) + "\n" + JSON.stringify(report, null, 2)));
  for (const review of task.reviews)
    $("fields").append(
      node("pre", "独立审查\n" + formatQualitySummary(review) + "\n" + JSON.stringify(review, null, 2)),
    );
  const actions = node("div", undefined, "detail-actions");
  const checkClassifications = {
    "contract-invalid": "契约需对账",
    "evidence-missing": "证据待补",
    "quality-failed": "已确认质量问题",
    "environment-failed": "环境/前置失败",
  };
  for (const job of (state.checkJobs ?? []).filter((item) => item.taskId === task.id || item.taskIds?.includes(task.id))) {
    const classification = checkClassifications[job.classification];
    $("fields").append(node("p", `后台检查 · ${job.check.id} · ${job.state}${job.source === "bridge-direct" ? " · 直连桥接" : ""}${classification ? " · " + classification : ""}${job.error ? " · " + job.error : ""}`));
    if (job.environmentFailure && job.hint) $("fields").append(node("p", job.hint));
    if (job.output) $("fields").append(button("查看检查日志", async () => {
      const evidence = await call("checkEvidence", { jobId: job.id });
      if ($("modal").open) $("fields").append(node("pre", evidence.log || "无输出"));
    }));
    if (job.state === "uncertain") actions.append(button("核对中断检查…", () =>
      form("确认旧检查已结束", [{ name: "evidence", label: "旧进程已退出、资源可安全复用的依据", multiline: true }],
        (values, op) => call("reconcileCheck", { jobId: job.id, ...values }, op))));
  }
  if (task.state === "ready" && task.verification)
    $("fields").append(node("p", "等待 DSH 主控核对证据并汇总试用步骤。", "muted"));
  if (task.state === "ready" && task.readOnly)
    actions.append(
      button("主控汇总试用", () =>
        form(
          "交付用户试用",
          [
            {
              name: "instructions",
              label: "启动方式、试用步骤与已知限制",
              multiline: true,
            },
          ],
          (v, op) => call("summarize", { taskId: task.id, ...v }, op),
        ),
      ),
    );
  if (task.state === "trial" && (task.readOnly || task.verification))
    actions.append(
      button("记录业务验收", () =>
        form(
          "用户业务验收",
          [
            {
              name: "evidence",
              label: "实际试用结果与验收记录",
              multiline: true,
            },
          ],
          (v, op) => call("accept", { taskId: task.id, ...v }, op),
        ),
      ),
    );
  if (
    [
      "changes_requested",
      "ready",
      "trial",
      "waiting_review",
      "waiting_verification",
      "waiting_batch",
      "reviewing",
    ].includes(task.state)
  )
    actions.append(
      button("安排返工", () =>
        form(
          "沿原票返工",
          [{ name: "reason", label: "问题与返工要求", multiline: true }],
          (v, op) => call("rework", { taskId: task.id, ...v }, op),
        ),
      ),
    );
  for (const q of task.questions) {
    $("fields").append(
      node("pre", `问题：${q.text}\n答复：${q.answer ?? "待处理"}`),
    );
    if (!q.answer)
      actions.append(
        button("答复问题", () =>
          form(
            "答复：" + q.text,
            [{ name: "text", label: "答复", multiline: true }],
            (v, op) =>
              call("answer", { taskId: task.id, questionId: q.id, ...v }, op),
          ),
        ),
      );
  }
  $("fields").append(actions);
  if (!$("modal").open) $("modal").showModal();
}
function render() {
  const project = state.projects.find((p) => p.id === projectId);
  $("empty").hidden = !!project;
  $("workspace").hidden = !project;
  $("delete-project").hidden = !project;
  $("controller-settings").hidden = !project;
  $("check-settings").hidden = !project;
  $("project-title").textContent = project?.name ?? "让协作有始有终。";
  $("project-path").textContent = project?.root ?? "连接真实会话，从一次明确的需求开始。";
  $("projects").replaceChildren(
    ...state.projects.map((p) =>
      button(
        p.name,
        () => {
          projectId = p.id;
          render();
        },
        p.id === projectId ? "active" : "",
      ),
    ),
  );
  if (!project) return;
  $("patrol-settings").textContent = project.autoPatrol === false ? "自动巡检 · 已暂停" : "自动巡检 · 已开启";
  $("roles").replaceChildren(
    ...state.roles
      .filter((r) => r.projectId === projectId && !r.archivedAt)
      .map((r) => {
        const card = node("article", undefined, "role");
        const heading = node("h3");
        const name = button(r.name, () => renameMember(r), "role-name");
        name.title = "点击改名";
        name.setAttribute("aria-label", `修改成员名称：${r.name}`);
        heading.append(name);
        card.append(heading);
        card.append(
          node(
            "small",
            [
              r.customLabel
                ? `${r.customLabel} · 按${roleLabels[r.kind] ?? legacyRoleLabels[r.kind]}运行`
                : roleLabels[r.kind] ?? legacyRoleLabels[r.kind],
              r.isPrimary ? "通知负责人" : "",
            ]
              .filter(Boolean)
              .join(" · "),
            "muted",
          ),
        );
        const delivery = roleDeliveryPresentation(r);
        card.append(node("p", delivery.status));
        if (delivery.issue) card.append(node("p", delivery.issue));
        if (r.patrolStatus) card.append(node("p", "巡检：" + r.patrolStatus.label, "muted"));
        const activity = roleActions.get(r.id);
        const feedback = activity?.message ?? (r.enabled ? resumeLabels[r.resumeStatus] : r.sessionId ? "已保留原任务；不会终止正在运行的会话。" : null);
        if (feedback) {
          const line = node("p", feedback, "role-feedback" + (activity?.error ? " role-feedback-error" : ""));
          line.setAttribute("role", activity?.error ? "alert" : "status");
          card.append(line);
        }
        const b = button(r.enabled ? "暂停新投递" : "开启角色", () => changeRoleDelivery(r, !r.enabled));
        b.title = r.enabled ? "保留原任务，暂停 LingFlow 的投递及此角色的团队工具访问；不会终止宿主会话" : "恢复投递与团队工具，沿原会话续接";
        b.disabled = !r.sessionId || Boolean(activity?.pending);
        const actions = node("div", undefined, "role-actions");
        actions.append(b);
        if (delivery.rearm) {
          const rearm = button("恢复未读投递", async () => {
            const result = await call(delivery.rearm.command, delivery.rearm.args);
            if (result.state === "blocked") throw Error(result.detail);
            await refresh();
          });
          rearm.disabled = !r.connected || Boolean(activity?.pending);
          actions.append(rearm);
        }
        if (r.enabled && r.sessionId) {
          const resume = button("续接原会话", () => changeRoleDelivery(r, true, true));
          resume.title = "用于会话中断或投递卡住；等原会话空闲后发出续接提示，不重新派单";
          resume.disabled = Boolean(activity?.pending) || ["offline", "waiting-idle"].includes(r.resumeStatus);
          actions.append(resume);
        }
        if (r.kind === "controller" && !r.isPrimary)
          actions.append(
            button("设为通知负责人", async () => {
              await call("setPrimaryController", { roleId: r.id });
              await refresh();
            }),
          );
        if (!r.isPrimary && !r.enabled)
          actions.append(
            button("归档成员", () =>
              form(`归档 ${r.name}（保留历史）`, [], (_v, op) =>
                call("archiveRole", { roleId: r.id }, op),
              ),
            ),
          );
        card.append(actions);
        try {
          decorateRoleCard(card, r);
        } catch (error) {
          console.warn("角色卡外观装饰失败", error);
        }
        return card;
      }),
  );
  $("no-roles").hidden = $("roles").childElementCount > 0;
  $("requests").replaceChildren(
    ...state.requests
      .filter(
        (r) =>
          !r.confirmed &&
          state.roles.some(
            (a) =>
              a.id === r.roleId && a.projectId === projectId && !a.archivedAt,
          ),
      )
      .map((r) => {
        const row = node(
          "div",
          `绑定申请 · ${state.roles.find((a) => a.id === r.roleId).name} · ${r.sessionId}`,
          "binding",
        );
        row.append(
          button("确认绑定", async () => {
            await call("confirmBinding", { requestId: r.id });
            await refresh();
          }),
        );
        return row;
      }),
  );
  const boardScope = specBoard(state.tasks, projectId, specSelection.get(projectId));
  const { current, selected, tasks: visibleTasks } = boardScope;
  window.lingflowDesktop?.select({ projectId, specKey: specSelection.get(projectId) ?? "current" });
  const picker = $("spec-scope");
  const scopes = specChoices(boardScope);
  const optionsKey = JSON.stringify(scopes);
  if (picker.dataset.options !== optionsKey) {
    picker.replaceChildren(...scopes.map(([value, label]) => {
      const option = node("option", label);
      option.value = value;
      return option;
    }));
    picker.dataset.options = optionsKey;
  }
  picker.value = boardScope.selectionKey;
  picker.onchange = () => {
    specSelection.set(projectId, picker.value);
    render();
  };
  const count = (field, value) => visibleTasks.filter((task) => task[field] === value).length;
  const risks = Object.entries(riskLabels).map(([risk, label]) => label + " " + count("risk", risk));
  $("spec-summary").textContent = [
    selected?.kind === "cycle" ? `规格周期 · ${selected.versions.length} 个冻结版本` : selected ? "冻结版本 " + selected.digest.slice(0, 8) : !current ? "尚无已登记规格" : null,
    "已验收 " + count("state", "accepted") + "/" + visibleTasks.length + " 张",
    ...risks,
    selected ? "只统计已登记票，未登记草稿不计入" : !current && picker.value !== "all" ? "下方显示全部任务" : null,
  ].filter(Boolean).join(" · ");
  const groups = [
    ["进行中", ["queued", "assigned", "rework", "paused", "blocked"]],
    ["审查与处理", ["waiting_review", "waiting_verification", "waiting_batch", "reviewing", "changes_requested"]],
    ["交付与验收", ["ready", "trial", "accepted", "superseded"]],
  ];
  $("board").replaceChildren(
    ...groups.map(([title, states]) => {
      const column = node("div", undefined, "column");
      const tasks = visibleTasks.filter((t) => states.includes(t.state));
      column.append(node("h3", title + " · " + tasks.length));
      const list = node("div", undefined, "task-list");
      column.append(list);
      if (!tasks.length) list.append(node("p", "暂无任务", "muted"));
      for (const t of tasks) {
        const card = node("article", undefined, "task");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.title = [t.ticketKey, t.title, taskStatus(t), t.waitReason, t.progress].filter(Boolean).join(" · ");
        card.onclick = () => detail(t);
        card.onkeydown = (e) => {
          if (e.key === "Enter") detail(t);
        };
        card.append(
          node("h4", t.ticketKey ? t.ticketKey + " · " + t.title : t.title),
          node(
            "small",
            taskStatus(t) + (t.waitReason ? " · " + t.waitReason : ""),
          ),
          node(
            "small",
            (riskLabels[t.risk] ?? "未标记风险") + (t.risk === "high" && !t.readOnly ? " · 独立审查" : ""),
            "risk",
          ),
        );
        if (t.progress) card.append(node("small", "最近进度：" + t.progress, "task-progress"));
        if (t.ownerSilentForMs > 0) card.append(node("small", `成员静默 ${Math.floor(t.ownerSilentForMs / 60000)} 分钟${t.ownerState === "silent" ? " · 可由主控恢复" : ""}`, "task-progress"));
        list.append(card);
      }
      return column;
    }),
  );
  const roles = new Set(
    state.roles.filter((r) => r.projectId === projectId).map((r) => r.id),
  );
  $("notices").replaceChildren(
    ...state.notices
      .filter((n) => roles.has(n.roleId))
      .slice(-8)
      .reverse()
      .map((n) => {
        const row = node("div", `${n.readAt ? "已读取" : "待处理"} · ${n.summary}`, "notice");
        const task = state.tasks.find((item) => item.id === n.taskId);
        const quality = noticeQualitySummary(n, task);
        if (quality) {
          if (quality.fromReviewAssignment) row.append(node("div", "开发自测"));
          row.append(node("div", quality.line));
        }
        const report = handoffRecord(n, task);
        if (report?.summary || report?.findings) row.append(node("div", excerpt(report.summary ?? report.findings, 1200)));
        for (const line of handoffLines(n, task, state.roles)) row.append(node("div", line));
        if (task) row.append(button("查看原票", () => detail(task)));
        return row;
      }),
  );
}
function refresh() {
  return polling ??= api("snapshot").then((snapshot) => {
    state = snapshot;
    if (!state.projects.some((p) => p.id === projectId))
      projectId = state.projects[0]?.id;
    render();
    $("error").hidden = true;
  }).catch(showError).finally(() => { polling = undefined; });
}
await refresh();
setInterval(refresh, 2500);
if (window.lingflowDesktop) {
  $("desktop-pet").hidden = false;
  $("desktop-pet").onclick = () => window.lingflowDesktop.showPet();
  window.lingflowDesktop.onSelection(selection => {
    projectId = selection.projectId; specSelection.set(projectId, selection.specKey);
    if (state) render(); else void refresh();
  });
}
