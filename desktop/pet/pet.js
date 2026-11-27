import { PetAnimator } from "./animator.js";
const api = window.lingflowPet, $ = id => document.getElementById(id);
const configuration = await api.initialize();
const animator = new PetAnimator($("sprite"), api, configuration.catalog);
const THEME_IDS = new Set(["dark", "white", "lavender", "sky", "mint", "sugar", "crimson", "citrus"]);
function applyTheme(nextTheme) {
  document.documentElement.dataset.theme = THEME_IDS.has(nextTheme) ? nextTheme : "dark";
}
applyTheme(configuration.theme);
let expanded = configuration.expanded, character = configuration.character, view, refreshing, groupSignature, drag;
const element = (tag, text, className) => {
  const result = document.createElement(tag); result.textContent = text; if (className) result.className = className; return result;
};
function regions() {
  requestAnimationFrame(() => api.regions([$("pet"), ...expanded ? [$("overview"), $("closed"), $("active"), $("waiting")] : []]
    .map(node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; })));
}
function layout() {
  $("stage").classList.toggle("expanded", expanded);
  const scale = expanded ? Math.min(innerWidth / 760, innerHeight / 640) : Math.min(innerWidth / 184, innerHeight / 184);
  $("stage").style.transform = `scale(${scale})`;
  for (const node of [$("overview"), $("closed"), $("active"), $("waiting"), $("gesture-hint"), document.querySelector(".orbit")]) node.hidden = !expanded;
  $("pet").setAttribute("aria-expanded", String(expanded));
  regions();
}
async function toggle(value = !expanded) { await api.expanded(value); }
api.onChange(state => {
  if (state.theme) applyTheme(state.theme);
  character = state.character; expanded = state.expanded;
  void animator.setMode(character, expanded); layout(); void refresh();
});
$("close").onclick = () => toggle(false);
window.addEventListener("keydown", event => { if (event.key === "Escape") void toggle(false); });
$("pet").oncontextmenu = event => { event.preventDefault(); api.menu(); };
$("pet").onpointerdown = event => {
  if (event.button !== 0) return;
  drag = { x: event.screenX, y: event.screenY, moved: false };
  $("pet").setPointerCapture(event.pointerId);
};
$("pet").onpointermove = event => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) > 5) { drag.moved = true; api.drag("start"); }
  if (drag.moved) api.drag("move");
};
$("pet").onpointerup = event => {
  if (!drag) return;
  const moved = drag.moved; drag = null;
  $("pet").releasePointerCapture(event.pointerId);
  if (moved) api.drag("end"); else void toggle();
};
$("pet").onpointercancel = () => { if (drag?.moved) api.drag("end"); drag = null; };
$("pet").onclick = event => { if (event.detail === 0) void toggle(); };
window.addEventListener("resize", layout);
const resizeObserver = new ResizeObserver(regions);
for (const node of document.querySelectorAll(".surface")) resizeObserver.observe(node);
function options(select, entries, selected) {
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...entries.map(([value, text]) => { const option = element("option", text); option.value = value; return option; }));
    select.dataset.options = signature;
  }
  select.value = selected ?? "";
}
$("project").onchange = () => api.select({ projectId: $("project").value, specKey: "current" });
$("spec").onchange = () => api.select({ projectId: $("project").value, specKey: $("spec").value });
$("open-folder").onclick = () => { if (view?.project?.id) void api.openTool(view.project.id, "folder").catch(() => {}); };
$("open-cmd").onclick = () => { if (view?.project?.id) void api.openTool(view.project.id, "cmd").catch(() => {}); };
function render(next) {
  view = next;
  const hasProject = Boolean(next.project?.id);
  $("open-folder").disabled = !hasProject;
  $("open-cmd").disabled = !hasProject;
  options($("project"), next.projects.map(project => [project.id, project.name]), next.project?.id);
  options($("spec"), next.scopes, next.selectionKey);
  $("spec").title = next.spec?.file ?? "";
  const plannedCount = next.plannedCount ?? 0;
  $("progress-label").textContent = next.spec
    ? (plannedCount
      ? `已派 ${next.completed} / ${next.total} 收口 · 验收 ${next.accepted} · 规划 ${plannedCount}`
      : `${next.completed} / ${next.total} 已收口 · ${next.accepted} 已验收`)
    : "在主控会话登记 Spec 后查看进展";
  $("percentage").replaceChildren(document.createTextNode(String(next.percent)), element("span", "%"));
  $("progress-fill").style.width = next.percent + "%";
  $("progress-accepted").style.width = (next.total ? Math.round(next.accepted / next.total * 100) : 0) + "%";
  $("ring").style.setProperty("--p", next.percent);
  $("caption").textContent = next.spec
    ? (plannedCount
      ? `${next.percent}% · 已派 ${next.total} / 规划 ${plannedCount}`
      : `${next.percent}% · ${next.completed}/${next.total} 票`)
    : "LingFlow";
  const signature = JSON.stringify(next.groups);
  if (signature !== groupSignature) {
    groupSignature = signature;
    for (const group of next.groups) {
      const container = $(group.id).querySelector(".tickets"), scroll = container.scrollTop;
      const open = new Set([...container.querySelectorAll("details[open]")].map(node => node.dataset.id));
      const retired = group.tickets.filter(ticket => ticket.retired).length;
      const plannedInGroup = group.tickets.filter(ticket => ticket.planned).length;
      $(group.id).querySelector("h2 b").textContent = retired
        ? `${group.tickets.length - retired} · 历史 ${retired}`
        : plannedInGroup
          ? `${group.tickets.length - plannedInGroup} · 规划 ${plannedInGroup}`
          : group.tickets.length;
      container.replaceChildren(...group.tickets.map(ticket => {
        const card = element("details", "", "ticket" + (ticket.retired ? " retired" : "")); card.dataset.id = ticket.id; card.dataset.state = ticket.state; card.open = open.has(ticket.id);
        const summary = element("summary", ""), top = element("div", "", "ticket-top");
        top.append(element("span", ticket.key, "ticket-key"), element("span", ticket.label, "ticket-state"));
        summary.append(top, element("div", ticket.title, "ticket-title"), element("p", ticket.summary, "ticket-blurb"));
        card.append(summary, element("p", `责任人 · ${ticket.assignee}${ticket.waitReason ? "\n" + ticket.waitReason : ""}`, "ticket-extra"));
        return card;
      }));
      if (!group.tickets.length) container.append(element("p", "此刻没有这类票", "empty"));
      container.scrollTop = scroll;
    }
  }
  regions();
}
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = api.snapshot().then(next => {
    render(next); $("connection").textContent = "实时同步"; $("connection").classList.remove("stale");
  }).catch(() => {
    $("connection").textContent = view ? "连接中断 · 保留上次进度" : "正在连接…"; $("connection").classList.add("stale");
    $("caption").textContent = "连接中断";
  }).finally(() => { refreshing = null; });
  return refreshing;
}
void animator.setMode(character, expanded); layout(); void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
