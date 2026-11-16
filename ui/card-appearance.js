// 成员角色卡的「自定义背景图」：右上角图标按钮、图片层与偏好持久化。
// 卡片结构仍由 app.js 渲染，这里只负责装饰；本模块缺失或加载失败时主界面退化为默认卡片。

import {
  DEFAULT_OPACITY,
  PREF,
  clamp,
  imageFileIcon,
  normalizeColor,
  normalizeImage,
  openAppearanceDialog,
  paintImage,
  readPref,
  writePref,
} from "./appearance.js";

// 已经挂过点击监听的卡片。app.js 每次重绘都会创建新节点，这里只防止同一节点被重复调用时叠加监听。
const wired = new WeakSet();
// roleId -> { id, name }：对话框标题和 window.__lingflowCards 需要角色名。
const knownRoles = new Map();

// ---------------------------------------------------------------- 偏好读写

// 单条偏好：{ url, x, y, opacity, color }，没有图片时只保留 { color }。
function normalizeEntry(value) {
  if (!value || typeof value !== "object") return null;
  const image = normalizeImage(value);
  const color = normalizeColor(value.color);
  if (!image && !color) return null;
  return image ? { ...image, color } : { color };
}

function loadEntries() {
  const raw = readPref(PREF.cards, null);
  const result = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [roleId, value] of Object.entries(raw)) {
    const entry = normalizeEntry(value);
    if (entry) result[roleId] = entry;
  }
  return result;
}

// 整张表常驻内存，写入时整体序列化；空表也写回 {}，保证 localStorage 里没有空条目。
let entries = loadEntries();

function saveEntries() {
  writePref(PREF.cards, entries);
}

function entryImage(roleId) {
  const entry = entries[roleId];
  return entry ? normalizeImage(entry) : null;
}

function entryColor(roleId) {
  const entry = entries[roleId];
  return entry ? normalizeColor(entry.color) : "";
}

// ---------------------------------------------------------------- 卡片 DOM

function ensureLayer(card) {
  let layer = card.querySelector(":scope > .card-media");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "card-media";
    layer.setAttribute("aria-hidden", "true");
    // 媒体层永远垫在最底下，卡片正文由 style.css 统一抬到 z-index: 1。
    card.insertBefore(layer, card.firstChild);
  }
  return layer;
}

function ensureButton(card) {
  let button = card.querySelector(":scope > .card-appearance");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "card-appearance";
    button.title = "自定义背景图";
    button.setAttribute("aria-label", "自定义角色卡背景");
    button.setAttribute("aria-haspopup", "dialog");
    button.append(imageFileIcon());
    card.append(button);
  }
  return button;
}

function paintCard(card, roleId) {
  const image = entryImage(roleId);
  const color = entryColor(roleId);
  paintImage(ensureLayer(card), image);
  if (color) card.style.backgroundColor = color;
  else card.style.removeProperty("background-color");
  card.classList.toggle("has-media", Boolean(image));
}

function findCard(roleId) {
  for (const card of document.querySelectorAll(".role")) {
    if (card.dataset.roleId === roleId) return card;
  }
  return null;
}

// 重绘会整批替换卡片节点，所以只按 roleId 在当前 DOM 里找，不能缓存节点引用。
function paintMounted(roleId) {
  for (const card of document.querySelectorAll(".role")) {
    if (card.dataset.roleId === roleId) paintCard(card, roleId);
  }
}

// input[type=color] 只接受 #rrggbb；getComputedStyle 返回的是 rgb()/rgba()，这里换算一次。
function computedHex(card) {
  try {
    const value = getComputedStyle(card).backgroundColor || "";
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    const match = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i.exec(value);
    if (!match) return "";
    const hex = (part) =>
      clamp(Math.round(Number(part)), 0, 255)
        .toString(16)
        .padStart(2, "0");
    return "#" + hex(match[1]) + hex(match[2]) + hex(match[3]);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- 设置对话框

function openEditor(roleId, card) {
  const target = card ?? findCard(roleId);
  const role = knownRoles.get(roleId);
  return openAppearanceDialog({
    title: `成员卡外观 · ${role?.name || roleId}`,
    description:
      "为这张成员卡挑一张背景图，可拖动位置、调整不透明度；底色在图片下面，调低不透明度就能看到。图片保存在项目目录，设置只存在本机。",
    // 卡片版不展示窗口主题预设，只保留图片、位置/透明度与底色。
    presets: [],
    theme: null,
    image: entryImage(roleId),
    color: entryColor(roleId),
    fallbackColor: target ? computedHex(target) : "",
    defaultOpacity: DEFAULT_OPACITY,
    resetState: { image: null, color: "" },
    onChange(next) {
      commit(roleId, next);
    },
    onReset() {
      clearRole(roleId);
    },
  });
}

// 图片透明度与卡片底色是两层：底色写在卡片背景上，图片层叠在它上面。
function commit(roleId, next) {
  const image = normalizeImage(next?.image);
  const color = normalizeColor(next?.color);
  if (image) entries[roleId] = { ...image, color };
  else if (color) entries[roleId] = { color };
  else delete entries[roleId];
  saveEntries();
  paintMounted(roleId);
}

// ---------------------------------------------------------------- 对外接口

export function decorateRoleCard(card, role) {
  if (!card || card.nodeType !== 1) return;
  const roleId = String(role?.id ?? "").trim();
  if (!roleId) return;

  knownRoles.set(roleId, { id: roleId, name: String(role?.name ?? "") });
  card.dataset.roleId = roleId;
  card.classList.add("has-appearance");

  ensureLayer(card);
  const button = ensureButton(card);
  paintCard(card, roleId);

  if (!wired.has(card)) {
    wired.add(card);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        openEditor(roleId, card);
      } catch (error) {
        console.warn("打开成员卡外观设置失败", error);
      }
    });
  }
}

function snapshot(roleId) {
  const image = entryImage(roleId);
  const color = entryColor(roleId);
  return {
    roleId,
    name: knownRoles.get(roleId)?.name ?? "",
    image: image ? { ...image } : null,
    color,
    hasBackground: Boolean(image || color),
  };
}

// set 接受 { url, x, y, opacity, color } 的任意子集；url 传空表示清掉图片。
function setRole(roleId, patch) {
  const id = String(roleId ?? "");
  if (!id) return snapshot("");
  const value = patch && typeof patch === "object" ? patch : {};
  const current = entries[id] ?? null;

  let image = normalizeImage(current);
  if ("url" in value) {
    if (!value.url) image = null;
    else {
      const next = normalizeImage({
        url: value.url,
        x: image?.x ?? 50,
        y: image?.y ?? 50,
        opacity: image?.opacity ?? DEFAULT_OPACITY,
      });
      // 只接受 /assets/<24hex>.<ext>：非法地址不破坏已有设置，只提示一次。
      if (next) image = next;
      else console.warn("忽略无效的背景图地址", value.url);
    }
  }
  if (image && ("x" in value || "y" in value || "opacity" in value)) {
    image = normalizeImage({
      url: image.url,
      x: "x" in value ? value.x : image.x,
      y: "y" in value ? value.y : image.y,
      opacity: "opacity" in value ? value.opacity : image.opacity,
    });
  }

  const color =
    "color" in value ? normalizeColor(value.color) : normalizeColor(current?.color);
  if (image) entries[id] = { ...image, color };
  else if (color) entries[id] = { color };
  else delete entries[id];
  saveEntries();
  paintMounted(id);
  return snapshot(id);
}

function clearRole(roleId) {
  const id = String(roleId ?? "");
  if (!id) return snapshot("");
  delete entries[id];
  saveEntries();
  paintMounted(id);
  return snapshot(id);
}

// 供桌面端视觉验证脚本驱动；普通使用不需要触碰。
if (typeof window !== "undefined") {
  window.__lingflowCards = {
    open(roleId) {
      const id = String(roleId ?? "");
      const card = findCard(id);
      if (!card && !knownRoles.has(id)) return null;
      return openEditor(id, card);
    },
    get(roleId) {
      return snapshot(String(roleId ?? ""));
    },
    set(roleId, patch) {
      return setRole(roleId, patch);
    },
    clear(roleId) {
      return clearRole(roleId);
    },
  };
}
