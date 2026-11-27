import { isHistoricalTicket, specBoard, specChoices, ticketColumns } from "./spec-board.js";
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
  abandoned: "已放弃",
  waiting_verification: "待独立验证",
  waiting_batch: "等待累计验证",
  waiting_review: "等待审查",
  reviewing: "审查中",
  changes_requested: "待主控处理",
  ready: "待汇总",
  trial: "待用户试用",
  accepted: "已验收",
};
const taskStatus = (task) => isHistoricalTicket(task) ?
  (task.state === "abandoned" || task.state === "superseded" ? status[task.state] : "范围已释放") :
  task.blockedBy?.some(blocker => blocker.code === "member-archived") ? "原责任成员已归档 · 待主控处理" :
  task.blockedBy?.some(blocker => blocker.code === "bridge-tools-missing") ? "工具未恢复 · bridge-tools-missing" : ["assigned", "rework"].includes(task.state) && !task.deliveredAt
  ? "已分配 · 待送达" : status[task.state] ?? task.state;
const roleLabels = { controller: "主控", developer: "开发", reviewer: "审查", supervisor: "监管者" };
const legacyRoleLabels = { planner: "规划（旧角色）", tester: "测试（旧角色）" };
const riskLabels = { low: "低风险", medium: "中风险", high: "高风险" };
const specSelection = new Map();
const roleActions = new Map();
const expandedNotices = new Set();
let riskFilter = "all";
let showHistory = false;
let taskPage = 1;
let openRoleMenu = null;
document.addEventListener("click", (e) => {
  if (openRoleMenu && !e.target.closest(".role-more-wrap")) {
    openRoleMenu = null;
    document.querySelectorAll(".role-menu").forEach((m) => { m.hidden = true; });
  }
});
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
  b.onclick = (e) => Promise.resolve(action(e)).catch(showError);
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
function unbindMember(role) {
  form(
    `解绑「${role.name}」的会话？`,
    [],
    async (_values, operationId) => {
      await polling;
      const receipt = await call("unbindRole", { roleId: role.id, expectedSessionId: role.sessionId }, operationId);
      if (receipt.error) throw Error(receipt.message ?? "解绑失败，请刷新后重试");
      roleActions.delete(role.id);
    },
    "解绑会话",
  );
  $("fields").append(
    node("p", "此成员会暂停投递并等待绑定。现有票据、未读消息和旧对话保留。"),
    node("p", role.provider === "codex" ? "在新会话绑定同一成员，回到成员卡开启角色。" :
      "在同一项目的新 DSH 对话使用 lingflow_connect 申请原成员，再回这里确认绑定并开启角色。"),
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
function renameProject(project = state.projects.find((p) => p.id === projectId)) {
  if (!project) return;
  form(
    "重命名工作区",
    [{ name: "name", label: "工作区名称", value: project.name, placeholder: "例如：官网改版" }],
    async (v, op) => {
      const name = v.name.trim();
      if (!name) throw Error("工作区名称不能为空");
      if (name.length > 80) throw Error("工作区名称不能超过 80 个字符");
      if (name === project.name) return;
      await call("renameProject", { projectId: project.id, name }, op);
    },
    "保存名称",
  );
  const input = $("field-name");
  input.maxLength = 80;
  $("fields").append(node("p", "名称只影响 LingFlow 中的显示与成员上下文；项目目录、成员绑定和 DSH 会话保持不变。", "muted"));
  input.focus();
  input.select();
}
const pencilIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.1 2.2a1.6 1.6 0 0 1 2.3 0l.4.4a1.6 1.6 0 0 1 0 2.3l-7.6 7.6-3.2.8.8-3.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m9.8 3.5 2.7 2.7" stroke="currentColor" stroke-width="1.4"/></svg>';
const folderIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.1l1.2 1.4H13c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const terminalIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.6 6.2 7 8 4.6 9.8M8.3 10.2h3.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const pathTail = (root = "") => root.split(/[\\/]+/).filter(Boolean).slice(-2).join(" / ") || root;
const PROJECT_ORDER_KEY = "lingflow.projectOrder";
let draggingProjectId = null;
let suppressProjectClick = false;
function loadProjectOrder() {
  try {
    const raw = localStorage.getItem(PROJECT_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveProjectOrder(ids) {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(ids));
  } catch {}
}
function orderedProjects(projects) {
  const order = loadProjectOrder();
  if (!order.length) return projects;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...projects].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}
function projectItem(p) {
  const item = node("div", undefined, "project-item" + (p.id === projectId ? " active" : ""));
  item.dataset.id = p.id;
  const link = button("", () => {
    if (suppressProjectClick) {
      suppressProjectClick = false;
      return;
    }
    if (projectId === p.id) return;
    projectId = p.id;
    taskPage = 1;
    render();
  }, "project-link");
  link.title = `${p.name}\n${p.root}\n双击重命名 · 长按拖动调整顺序`;
  link.ondblclick = () => renameProject(p);
  if (p.id === projectId) link.setAttribute("aria-current", "page");
  const meta = node("span", undefined, "project-meta");
  meta.append(node("b", p.name), node("small", pathTail(p.root)));
  link.append(node("span", [...p.name.trim()][0]?.toUpperCase() ?? "◈", "project-avatar"), meta);
  const rename = button("", () => renameProject(p), "icon-button project-rename");
  rename.innerHTML = pencilIcon;
  rename.title = "重命名工作区";
  rename.setAttribute("aria-label", `重命名工作区：${p.name}`);
  item.append(link, rename);

  let holdTimer = null;
  let dragStart = null;
  let dropTarget = null;
  const clearIndicators = () => {
    for (const el of $("projects").querySelectorAll(".project-item")) {
      el.classList.remove("drop-before", "drop-after");
    }
  };
  const finishDrag = (commit) => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (draggingProjectId !== p.id) { dragStart = null; return; }
    item.classList.remove("is-dragging");
    document.body.classList.remove("is-reordering-projects");
    clearIndicators();
    if (commit && dropTarget && dropTarget.id !== p.id) {
      const current = orderedProjects(state?.projects ?? []).map((x) => x.id).filter((id) => id !== p.id);
      const targetIndex = current.indexOf(dropTarget.id);
      if (targetIndex !== -1) {
        current.splice(dropTarget.after ? targetIndex + 1 : targetIndex, 0, p.id);
        saveProjectOrder(current);
      }
    }
    draggingProjectId = null;
    dragStart = null;
    dropTarget = null;
    suppressProjectClick = true;
    setTimeout(() => { suppressProjectClick = false; }, 0);
    render();
  };
  item.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".project-rename")) return;
    if ((state?.projects?.length ?? 0) < 2) return;
    dragStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    holdTimer = setTimeout(() => {
      holdTimer = null;
      draggingProjectId = p.id;
      item.classList.add("is-dragging");
      document.body.classList.add("is-reordering-projects");
      try { item.setPointerCapture(e.pointerId); } catch {}
    }, 240);
  });
  item.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    if (draggingProjectId !== p.id) {
      if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 6) {
        clearTimeout(holdTimer); holdTimer = null; dragStart = null;
      }
      return;
    }
    clearIndicators();
    dropTarget = null;
    const siblings = [...$("projects").querySelectorAll(".project-item")];
    for (const el of siblings) {
      if (el === item) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const after = e.clientY > rect.top + rect.height / 2;
        el.classList.add(after ? "drop-after" : "drop-before");
        dropTarget = { id: el.dataset.id, after };
        break;
      }
    }
    if (!dropTarget && siblings.length) {
      const first = siblings[0];
      const last = siblings[siblings.length - 1];
      if (e.clientY < first.getBoundingClientRect().top && first !== item) {
        first.classList.add("drop-before");
        dropTarget = { id: first.dataset.id, after: false };
      } else if (e.clientY > last.getBoundingClientRect().bottom && last !== item) {
        last.classList.add("drop-after");
        dropTarget = { id: last.dataset.id, after: true };
      }
    }
  });
  item.addEventListener("pointerup", () => finishDrag(true));
  item.addEventListener("pointercancel", () => finishDrag(false));
  return item;
}
$("new-project").onclick = newProject;
$("first-project").onclick = newProject;
$("delete-project").onclick = deleteProject;
$("open-folder").innerHTML = folderIcon;
$("open-folder").onclick = () => {
  if (!projectId) return;
  void api("open-project-tool", { projectId, tool: "folder" }).catch(showError);
};
$("open-cmd").innerHTML = terminalIcon;
$("open-cmd").onclick = () => {
  if (!projectId) return;
  void api("open-project-tool", { projectId, tool: "cmd" }).catch(showError);
};
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
  if (task.state === "ready" && task.verification && !isHistoricalTicket(task))
    $("fields").append(node("p", "等待 DSH 主控核对证据并汇总试用步骤。", "muted"));
  if (task.state === "ready" && task.readOnly && !isHistoricalTicket(task))
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
  if (task.state === "trial" && (task.readOnly || task.verification) && !isHistoricalTicket(task))
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
  $("project-tools").hidden = !project;
  $("controller-settings").hidden = !project;
  $("check-settings").hidden = !project;
  $("project-title").textContent = project?.name ?? "让协作有始有终。";
  $("project-path").textContent = project?.root ?? "连接真实会话，从一次明确的需求开始。";
  $("project-path").classList.toggle("is-path", !!project);
  $("project-count").hidden = !state.projects.length;
  $("project-count").textContent = state.projects.length;
  if (!draggingProjectId) {
    $("projects").replaceChildren(...orderedProjects(state.projects).map(projectItem));
  }
  if (!project) return;
  $("patrol-settings").textContent = project.autoPatrol === false ? "自动巡检 · 已暂停" : "自动巡检 · 已开启";
  const activeRoles = state.roles.filter((r) => r.projectId === projectId && !r.archivedAt);
  $("roles-count").textContent = `(${activeRoles.length})`;
  $("roles").replaceChildren(
    ...activeRoles.map((r) => {
      const card = node("article", undefined, "role");
      card.dataset.state = r.enabled ? "enabled" : r.sessionId ? "paused" : "unbound";
      const head = node("div", undefined, "role-head");
      const name = button(r.name, () => renameMember(r), "role-name");
      name.title = "点击改名";
      name.setAttribute("aria-label", `修改成员名称：${r.name}`);
      const connState = !r.sessionId ? "unbound" : !r.connected ? "offline" : r.state === "running" ? "running" : "idle";
      const connText = !r.sessionId ? "待绑定" : !r.connected ? "离线" : r.state === "running" ? "运行中" : "空闲";
      const dot = node("span", connText, "role-dot");
      dot.dataset.status = connState;
      head.append(name, dot);
      card.append(head);

      const roleKind = r.customLabel ? `${r.customLabel}(${roleLabels[r.kind] ?? legacyRoleLabels[r.kind]})` : (roleLabels[r.kind] ?? legacyRoleLabels[r.kind]);
      const metaParts = [roleKind, r.isPrimary ? "通知负责人" : "", r.sessionId ? `待输入 ${r.pending ?? 0}` : "等待会话绑定"].filter(Boolean);
      card.append(node("p", metaParts.join(" · "), "role-meta"));

      const delivery = roleDeliveryPresentation(r);
      const activity = roleActions.get(r.id);
      const alertText = activity?.error || activity?.pending ? activity.message : delivery.issue ? delivery.issue : activity?.message;
      if (alertText) {
        const line = node("p", alertText, "role-feedback" + (activity?.error || delivery.issue ? " role-feedback-error" : ""));
        line.title = alertText;
        line.setAttribute("role", activity?.error ? "alert" : "status");
        card.append(line);
      }

      const mainBtn = button(
        !r.sessionId ? "等待绑定" : r.enabled ? "暂停投递" : "开启角色",
        () => changeRoleDelivery(r, !r.enabled),
        r.enabled ? "role-primary-btn is-enabled" : "role-primary-btn is-paused",
      );
      mainBtn.title = r.enabled ? "保留原任务，暂停 LingFlow 的投递及此角色的团队工具访问；不会终止宿主会话" : "恢复投递与团队工具，沿原会话续接";
      mainBtn.disabled = !r.sessionId || Boolean(activity?.pending);

      const extraItems = [];
      if (delivery.rearm) {
        const rearm = button("恢复未读投递", async () => {
          openRoleMenu = null;
          const result = await call(delivery.rearm.command, delivery.rearm.args);
          if (result.state === "blocked") throw Error(result.detail);
          await refresh();
        });
        rearm.disabled = !r.connected || Boolean(activity?.pending);
        extraItems.push(rearm);
      }
      if (r.enabled && r.sessionId) {
        const resume = button("续接原会话", () => { openRoleMenu = null; return changeRoleDelivery(r, true, true); });
        resume.disabled = Boolean(activity?.pending) || ["offline", "waiting-idle"].includes(r.resumeStatus);
        extraItems.push(resume);
      }
      if (r.sessionId) {
        const unbind = button("解绑会话", () => { openRoleMenu = null; return unbindMember(r); });
        unbind.disabled = Boolean(activity?.pending);
        extraItems.push(unbind);
      }
      if (r.kind === "controller" && !r.isPrimary) {
        extraItems.push(button("设为通知负责人", async () => {
          openRoleMenu = null;
          await call("setPrimaryController", { roleId: r.id });
          await refresh();
        }));
      }
      if (!r.isPrimary && !r.enabled) {
        extraItems.push(button("归档成员", () => {
          openRoleMenu = null;
          form(`归档「${r.name}」？`, [], (_v, op) => call("archiveRole", { roleId: r.id }, op), "归档成员");
          $("fields").append(node("p", "成员会从当前团队移除。未完成的原票和协作记录保留，由主控另行处理。"));
        }));
      }

      const actions = node("div", undefined, "role-actions");
      actions.append(mainBtn);
      if (extraItems.length) {
        const moreWrap = node("div", undefined, "role-more-wrap");
        const menu = node("div", undefined, "role-menu");
        const isMenuOpen = openRoleMenu === r.id;
        menu.hidden = !isMenuOpen;
        if (isMenuOpen) card.classList.add("is-menu-open");
        menu.append(...extraItems);
        const moreBtn = button("···", (e) => {
          e?.stopPropagation();
          openRoleMenu = openRoleMenu === r.id ? null : r.id;
          document.querySelectorAll(".role.is-menu-open").forEach((c) => c.classList.remove("is-menu-open"));
          document.querySelectorAll(".role-menu").forEach((m) => { m.hidden = true; });
          const nextOpen = openRoleMenu === r.id;
          menu.hidden = !nextOpen;
          card.classList.toggle("is-menu-open", nextOpen);
        }, "role-more-btn");
        moreBtn.title = "更多成员操作";
        moreBtn.setAttribute("aria-label", "更多成员操作");
        moreWrap.append(moreBtn, menu);
        actions.append(moreWrap);
      }
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
          !r.confirmed && !r.cancelledAt &&
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
  const projectPlanned = (state.plannedTickets ?? []).filter((item) => item.projectId === projectId);
  const boardScope = specBoard(state.tasks, projectId, specSelection.get(projectId), projectPlanned);
  const { current, selected, tasks: visibleTasks, plannedTickets: visiblePlanned = [] } = boardScope;
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
    taskPage = 1;
    render();
  };
  const currentTasks = visibleTasks.filter(task => !isHistoricalTicket(task));
  const historicalTasks = visibleTasks.filter(task => isHistoricalTicket(task));
  const count = (field, value) => currentTasks.filter((task) => task[field] === value).length;
  const closedStates = new Set(["ready", "trial", "accepted"]);
  const closedCount = currentTasks.filter((task) => closedStates.has(task.state)).length;
  const acceptedCount = count("state", "accepted");
  const totalCurrent = currentTasks.length;
  const percent = totalCurrent ? Math.round((closedCount / totalCurrent) * 1000) / 10 : 0;
  const lowCount = count("risk", "low");
  const medCount = count("risk", "medium");
  const highCount = count("risk", "high");
  const columns = ticketColumns(visibleTasks);
  const activeReviewCount = (columns[0]?.tasks.length ?? 0) + (columns[1]?.tasks.length ?? 0);

  for (const btn of $("risk-filters").querySelectorAll(".filter-pill")) {
    btn.classList.toggle("is-active", btn.dataset.risk === riskFilter);
    btn.onclick = () => { riskFilter = btn.dataset.risk; taskPage = 1; render(); };
  }

  const versionText = selected?.kind === "cycle"
    ? `冻结 ${selected.versions.length} 版`
    : selected ? `冻结 ${selected.digest.slice(0, 6)}` : "未登记";
  const m1 = node("div", undefined, "metric-card");
  m1.append(node("div", `收口进度（${versionText}）`, "metric-label"));
  const m1Row = node("div", undefined, "metric-row");
  const m1Val = node("div", undefined, "metric-value");
  m1Val.innerHTML = `${closedCount} <span>/ ${totalCurrent}</span>`;
  const m1Right = node("span", `已验收 ${acceptedCount} · ${percent}%`, "metric-pct");
  m1Row.append(m1Val, m1Right);
  const m1Bar = node("div", undefined, "metric-bar");
  const m1Fill = node("div", undefined, "metric-bar-fill");
  m1Fill.style.width = `${totalCurrent ? (closedCount / totalCurrent) * 100 : 0}%`;
  m1Bar.append(m1Fill);
  m1.append(m1Row, m1Bar);
  if (visiblePlanned.length) {
    m1.append(node("div", `已规划待派发 ${visiblePlanned.length} 张（不计入收口分母）`, "metric-sub metric-planned-note"));
  }

  const m2 = node("div", undefined, "metric-card");
  m2.append(node("div", "风险分布", "metric-label"));
  const m2Row = node("div", undefined, "metric-risk-nums");
  m2Row.append(
    node("span", `低 ${lowCount}`, "risk-low"),
    node("span", " / ", "risk-sep"),
    node("span", `中 ${medCount}`, "risk-med"),
    node("span", " / ", "risk-sep"),
    node("span", `高 ${highCount}`, "risk-high"),
  );
  const m2Bar = node("div", undefined, "metric-bar metric-risk-bar");
  const riskSum = Math.max(1, lowCount + medCount + highCount);
  for (const [cls, n] of [["seg-low", lowCount], ["seg-med", medCount], ["seg-high", highCount]]) {
    if (!n) continue;
    const seg = node("div", undefined, cls);
    seg.style.width = `${(n / riskSum) * 100}%`;
    m2Bar.append(seg);
  }
  m2.append(m2Row, m2Bar);

  const m3 = node("div", undefined, "metric-card");
  m3.append(node("div", "进行中 / 审查处理", "metric-label"));
  const m3Row = node("div", undefined, "metric-inline");
  m3Row.append(
    node("span", String(activeReviewCount), "metric-value"),
    node("span", activeReviewCount ? "· 优先置顶展示" : "· 自动折叠空列", "metric-sub"),
  );
  m3.append(m3Row);

  const m4 = node("div", undefined, "metric-card metric-card-toggle" + (showHistory ? " is-active" : ""));
  m4.append(node("div", "历史归档票据", "metric-label"));
  const m4Row = node("div", undefined, "metric-inline metric-inline-tight");
  m4Row.append(
    node("span", String(historicalTasks.length), "metric-value"),
    node("span", showHistory ? "张正式Tickets 点击收起" : "张正式Tickets 点击展开全部", "metric-sub"),
  );
  m4.append(m4Row);
  m4.tabIndex = 0;
  m4.setAttribute("role", "button");
  m4.onclick = () => { showHistory = !showHistory; render(); };
  m4.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showHistory = !showHistory; render(); } };

  $("spec-metrics").replaceChildren(m1, m2, m3, m4);

  const delivered = columns[2]?.tasks ?? [];
  const orderedTasks = [
    ...[...(columns[0]?.tasks ?? [])].reverse(),
    ...[...(columns[1]?.tasks ?? [])].reverse(),
    ...delivered.filter(t => !isHistoricalTicket(t)).reverse(),
    ...(showHistory ? delivered.filter(isHistoricalTicket).reverse() : []),
  ].filter((t) => riskFilter === "all" || t.risk === riskFilter);
  const filteredPlanned = visiblePlanned.filter((p) => riskFilter === "all" || p.risk === riskFilter);
  const boardItems = [
    ...orderedTasks.map((item) => ({ kind: "task", item })),
    ...filteredPlanned.map((item) => ({ kind: "planned", item })),
  ];
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(boardItems.length / pageSize));
  taskPage = Math.min(Math.max(1, taskPage), totalPages);
  const displayedItems = boardItems.slice((taskPage - 1) * pageSize, taskPage * pageSize);

  const list = node("div", undefined, "task-list");
  if (!displayedItems.length) list.append(node("p", "当前筛选下暂无票据", "muted empty-board"));
  for (const entry of displayedItems) {
    if (entry.kind === "planned") {
      const p = entry.item;
      const card = node("article", undefined, "task is-planned");
      card.dataset.risk = p.risk ?? "none";
      const depsText = p.dependsOn?.length ? `前置：${p.dependsOn.join("、")}` : "";
      const badgeText = p.requirementClosed ? "该需求已收口 · 未派发" : "已规划 · 待派发";
      card.title = [p.key, p.title, badgeText, depsText].filter(Boolean).join(" · ");

      const left = node("div", undefined, "task-main");
      if (p.key) left.append(node("span", p.key, "task-key"));
      left.append(node("span", p.title ?? p.key, "task-title"));
      if (depsText) left.append(node("span", depsText, "task-deps"));

      const right = node("div", undefined, "task-meta");
      right.append(node("span", badgeText, "planned-badge" + (p.requirementClosed ? " is-closed-req" : "")));
      const riskBadge = node("span", riskLabels[p.risk] ?? "未标记", "risk-badge");
      riskBadge.dataset.risk = p.risk ?? "none";
      right.append(riskBadge);

      card.append(left, right);
      list.append(card);
      continue;
    }
    const t = entry.item;
    const card = node("article", undefined, "task");
    card.dataset.risk = t.risk ?? "none";
    if (isHistoricalTicket(t)) card.classList.add("is-historical");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.title = [t.ticketKey, t.title, taskStatus(t), t.waitReason, t.progress].filter(Boolean).join(" · ");
    card.onclick = () => detail(t);
    card.onkeydown = (e) => { if (e.key === "Enter") detail(t); };

    const left = node("div", undefined, "task-main");
    if (t.ticketKey) left.append(node("span", t.ticketKey, "task-key"));
    left.append(node("span", t.title, "task-title"));

    const right = node("div", undefined, "task-meta");
    right.append(node("span", taskStatus(t), "task-state-text"));
    const riskBadge = node("span", riskLabels[t.risk] ?? "未标记", "risk-badge");
    riskBadge.dataset.risk = t.risk ?? "none";
    right.append(riskBadge);

    card.append(left, right);
    list.append(card);
  }
  const boardChildren = [list];
  if (boardItems.length > pageSize) {
    const footer = node("div", undefined, "board-footer");
    footer.append(node("span", `共 ${boardItems.length} 张 · 第 ${taskPage} / ${totalPages} 页`));
    const pager = node("div", undefined, "board-pager");
    const prev = button("上一页", () => { taskPage--; render(); }, "board-page-btn");
    prev.disabled = taskPage <= 1;
    pager.append(prev);
    const pages = totalPages <= 7
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : [...new Set([1, taskPage - 1, taskPage, taskPage + 1, totalPages].filter(p => p >= 1 && p <= totalPages))].sort((a, b) => a - b);
    let lastPage = 0;
    for (const p of pages) {
      if (lastPage && p - lastPage > 1) pager.append(node("span", "…", "board-page-ellipsis"));
      const numBtn = button(String(p), () => { taskPage = p; render(); }, "board-page-btn" + (p === taskPage ? " is-active" : ""));
      pager.append(numBtn);
      lastPage = p;
    }
    const next = button("下一页", () => { taskPage++; render(); }, "board-page-btn");
    next.disabled = taskPage >= totalPages;
    pager.append(next);
    footer.append(pager);
    boardChildren.push(footer);
  }
  $("board").replaceChildren(...boardChildren);
  const roles = new Set(
    state.roles.filter((r) => r.projectId === projectId).map((r) => r.id),
  );
  $("notices").replaceChildren(
    ...state.notices
      .filter((n) => roles.has(n.roleId))
      .slice(-8)
      .reverse()
      .map((n) => {
        const task = state.tasks.find((item) => item.id === n.taskId);
        const report = handoffRecord(n, task);
        const quality = noticeQualitySummary(n, task);
        const [kind] = (n.key ?? "").split(":");
        const rawSummary = String(n.summary ?? "");
        const jsonMatch = rawSummary.match(/^(.*?)(?:\s*[:：]\s*(\{[\s\S]*\}))$/);
        let displaySummary = jsonMatch ? jsonMatch[1].trim() : rawSummary;
        let parsedJson = null;
        if (jsonMatch) {
          try { parsedJson = JSON.parse(jsonMatch[2]); } catch {}
        }
        if (parsedJson?.from && parsedJson?.to) {
          displaySummary += `  ${String(parsedJson.from).slice(0, 7)} → ${String(parsedJson.to).slice(0, 7)}`;
        }
        const hasBlocking = Boolean(report?.openItems?.some((item) => item.blocking));
        const isAlert = kind === "report-blocked" || kind === "question" || report?.verdict === "changes" || hasBlocking || Boolean(report?.gate?.conflicts?.length) || /漂移|阻断|失败|冲突|异常|告警/.test(rawSummary);
        const row = node("div", undefined, "notice" + (n.readAt ? "" : " is-unread") + (isAlert ? " is-alert" : ""));

        const head = node("div", undefined, "notice-head");
        const headLeft = node("div", undefined, "notice-head-left");
        const tagLabel = /漂移/.test(rawSummary) ? "Git 提交漂移"
          : /spec/i.test(rawSummary) ? "spec 已更新"
          : kind === "report-blocked" ? "交付阻断"
          : kind === "question" ? "成员提问"
          : kind === "review" ? "审查反馈"
          : n.readAt ? "已读取" : "待处理";
        const tag = node("span", tagLabel, "notice-tag");
        tag.dataset.tone = isAlert ? "alert" : /spec/i.test(rawSummary) ? "info" : "neutral";
        headLeft.append(tag);
        if (task?.ticketKey) headLeft.append(node("span", task.ticketKey, "notice-ticket"));
        headLeft.append(node("span", displaySummary, "notice-summary"));

        const detailLines = [
          parsedJson ? "原始 JSON：" + JSON.stringify(parsedJson, null, 2) : null,
          quality ? (quality.fromReviewAssignment ? "开发自测 · " : "") + quality.line : null,
          report?.summary || report?.findings ? excerpt(report.summary ?? report.findings, 600) : null,
          ...handoffLines(n, task, state.roles),
        ].filter(Boolean);

        const headActions = node("div", undefined, "notice-actions");
        const noticeKey = n.id ?? n.key ?? rawSummary;
        const isExpanded = expandedNotices.has(noticeKey);
        if (detailLines.length) {
          headActions.append(button(isExpanded ? "收起详情" : (parsedJson ? "展开原始 JSON" : "展开详情"), () => {
            if (expandedNotices.has(noticeKey)) expandedNotices.delete(noticeKey);
            else expandedNotices.add(noticeKey);
            render();
          }, "notice-btn-ghost"));
        }
        if (task) headActions.append(button("查看原票", () => detail(task), isAlert ? "notice-btn-primary" : "notice-btn-ghost"));
        head.append(headLeft, headActions);
        row.append(head);

        const files = report?.gate?.conflicts?.length ? report.gate.conflicts
          : Array.isArray(parsedJson?.committedBetween) && parsedJson.committedBetween.length ? parsedJson.committedBetween
          : report?.manifest?.files?.length ? report.manifest.files.map((f) => f.file) : [];
        if (isAlert && report?.gate?.reason) {
          row.append(node("div", excerpt(report.gate.reason, 220), "notice-desc"));
        } else if (isAlert && report?.blocker) {
          row.append(node("div", excerpt(report.blocker, 220), "notice-desc"));
        }
        if (files.length) {
          const fileWrap = node("div", undefined, "notice-files");
          for (const f of files.slice(0, 6)) fileWrap.append(node("code", f, "notice-file"));
          if (files.length > 6) fileWrap.append(node("code", `+${files.length - 6} 项`, "notice-file"));
          row.append(fileWrap);
        }
        if (isExpanded && detailLines.length) {
          const box = node("div", undefined, "notice-details");
          for (const line of detailLines) box.append(node("div", line));
          row.append(box);
        }
        return row;
      }),
  );
}
function refresh() {
  return polling ??= api("snapshot").then((snapshot) => {
    state = snapshot;
    if (!state.projects.some((p) => p.id === projectId))
      projectId = orderedProjects(state.projects)[0]?.id;
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
