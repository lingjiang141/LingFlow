// 外观基础设施：窗口主题与角色卡背景共用的图片素材、偏好读写和设置对话框。
// 图片素材本身由服务端保存在项目目录（默认 ui/assets/），这里只处理浏览器侧的选择与预览。

const THEME_KEY = "lingflow.theme.v1";
const CARDS_KEY = "lingflow.card-backgrounds.v1";

const ASSET_URL = /^\/assets\/[a-f0-9]{24}\.(png|jpg|gif|webp|bmp)$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SVG_NS = "http://www.w3.org/2000/svg";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_OPACITY = 100;

export const PREF = { theme: THEME_KEY, cards: CARDS_KEY };

// 预设主题只负责配色标识；真正的色值在 style.css 里通过 html[data-theme] 定义。
export const THEMES = [
  {
    id: "dark",
    name: "深色主题",
    hint: "默认 · 夜间专注",
    colors: ["#10141d", "#19212e", "#7b9bfa"],
  },
  {
    id: "white",
    name: "白色主题",
    hint: "明亮 · 高对比",
    colors: ["#eef2fa", "#ffffff", "#4c6ef0"],
  },
  {
    id: "lavender",
    name: "淡紫色主题",
    hint: "柔和 · 低饱和",
    colors: ["#f2ecfb", "#fdfbff", "#9678d3"],
  },
  {
    id: "sky",
    name: "淡蓝色主题",
    hint: "清透 · 安静",
    colors: ["#e9f3fc", "#fbfdff", "#3f8fd4"],
  },
];

// 页面加载时 hash 里还带着 uiToken（app.js 会把它抹掉并写进 sessionStorage），
// 因此刷新后要能从这里取回，否则素材接口会 401。
function initialToken() {
  const fromHash = location.hash.slice(1);
  if (fromHash) return fromHash;
  try {
    return sessionStorage.getItem("lingflow.uiToken") || "";
  } catch {
    return "";
  }
}

let token = initialToken();

export function setToken(value) {
  if (value) token = value;
}

// ---------------------------------------------------------------- 基础工具

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function numeric(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function readPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式或配额不足时静默降级：本次会话仍然可用，只是不持久化。
  }
}

export function normalizeColor(value) {
  const text = String(value ?? "").trim();
  return HEX_COLOR.test(text) ? text.toLowerCase() : "";
}

// image: { url, x, y, opacity }，x/y 为 0-100 的定位百分比，opacity 为 0-100 的不透明度。
export function normalizeImage(value) {
  if (!value || typeof value !== "object") return null;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!ASSET_URL.test(url)) return null;
  return {
    url,
    x: clamp(numeric(value.x, 50), 0, 100),
    y: clamp(numeric(value.y, 50), 0, 100),
    opacity: clamp(numeric(value.opacity, DEFAULT_OPACITY), 0, 100),
  };
}

// background-size: cover 保证任意窗口比例下都不拉伸变形；百分比定位让用户能自由挪动可见区域。
export function paintImage(layer, image) {
  if (!layer) return;
  const value = normalizeImage(image);
  if (!value) {
    layer.style.backgroundImage = "none";
    layer.style.opacity = "0";
    return;
  }
  layer.style.backgroundImage = `url("${value.url}")`;
  layer.style.backgroundPosition = `${value.x}% ${value.y}%`;
  layer.style.opacity = String(clamp(value.opacity, 0, 100) / 100);
}

// ---------------------------------------------------------------- 图标

function svg(paths) {
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("viewBox", "0 0 24 24");
  root.setAttribute("fill", "none");
  root.setAttribute("stroke", "currentColor");
  root.setAttribute("stroke-width", "1.7");
  root.setAttribute("stroke-linecap", "round");
  root.setAttribute("stroke-linejoin", "round");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    root.append(path);
  }
  return root;
}

// 通用的「图片文件」样式图标：圆角相框 + 山形 + 太阳。
export function imageFileIcon() {
  return svg([
    "M3.75 5.5A1.75 1.75 0 0 1 5.5 3.75h13A1.75 1.75 0 0 1 20.25 5.5v13a1.75 1.75 0 0 1-1.75 1.75h-13A1.75 1.75 0 0 1 3.75 18.5v-13Z",
    "M4.1 16.9l4.6-5.2a1.5 1.5 0 0 1 2.25.05l2.35 2.9 1.6-1.8a1.5 1.5 0 0 1 2.25.05l2.65 3.2",
    "M15.4 8.55h.01",
  ]);
}

export function paletteIcon() {
  return svg([
    "M12 3.2a8.8 8.8 0 1 0 0 17.6h1.55a2.05 2.05 0 0 0 1.5-3.45 1.85 1.85 0 0 1 1.4-3.1h1.05a3.1 3.1 0 0 0 3.1-3.2A8.8 8.8 0 0 0 12 3.2Z",
    "M7.6 12.1h.01",
    "M9.85 8.35h.01",
    "M14.5 7.7h.01",
    "M17.2 10.4h.01",
  ]);
}

export function plusIcon() {
  return svg(["M12 5.2v13.6", "M5.2 12h13.6"]);
}

export function closeIcon() {
  return svg(["M6.4 6.4l11.2 11.2", "M17.6 6.4 6.4 17.6"]);
}

// ---------------------------------------------------------------- 素材库

let assetCache = null;
let assetTask = null;
const assetListeners = new Set();

export function onAssetsChanged(listener) {
  assetListeners.add(listener);
  return () => assetListeners.delete(listener);
}

export function cachedAssets() {
  return assetCache ?? [];
}

function broadcastAssets() {
  const assets = cachedAssets();
  for (const listener of [...assetListeners]) {
    try {
      listener(assets);
    } catch (error) {
      console.error(error);
    }
  }
}

async function appearanceRequest(body) {
  const response = await fetch("/api/ui/appearance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  let value = {};
  try {
    value = await response.json();
  } catch {
    value = {};
  }
  if (!response.ok) throw Error(value.error || "外观素材服务暂不可用");
  return value;
}

export async function loadAssets(force = false) {
  if (!force && assetCache) return assetCache;
  if (!assetTask) {
    assetTask = appearanceRequest({ action: "list" })
      .then((value) => {
        assetCache = Array.isArray(value.assets) ? value.assets : [];
        return assetCache;
      })
      .finally(() => {
        assetTask = null;
      });
  }
  return assetTask;
}

export async function importImageDataUrl(dataUrl, name) {
  const value = await appearanceRequest({
    action: "import",
    name,
    data: String(dataUrl),
  });
  if (!value.asset?.url) throw Error("导入结果异常，请重试");
  assetCache = [value.asset, ...cachedAssets().filter((item) => item.id !== value.asset.id)];
  broadcastAssets();
  return value.asset;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Error("读取图片失败，请重试"));
    reader.readAsDataURL(file);
  });
}

export async function importImageFile(file) {
  if (!file) throw Error("没有选择图片");
  const type = String(file.type || "");
  if (type && !type.startsWith("image/")) throw Error("请选择图片文件");
  if (file.size > MAX_IMAGE_BYTES) throw Error("图片过大（上限 16 MB）");
  return importImageDataUrl(await readAsDataUrl(file), file.name || "背景图片");
}

export async function removeAsset(id) {
  await appearanceRequest({ action: "remove", id });
  assetCache = cachedAssets().filter((item) => item.id !== id);
  broadcastAssets();
}

// ---------------------------------------------------------------- 设置对话框

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(className, icon, label) {
  const button = element("button", className);
  button.type = "button";
  button.append(icon);
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

function rangeRow(labelText, value) {
  const row = element("div", "appearance-range");
  const label = element("label", "appearance-range-label", labelText);
  const input = element("input");
  input.type = "range";
  input.min = "0";
  input.max = "100";
  input.step = "1";
  input.value = String(Math.round(value));
  const output = element("output", "appearance-range-value", Math.round(value) + "%");
  label.append(output);
  row.append(label, input);
  return { row, input, output };
}

export function openAppearanceDialog(spec = {}) {
  document.getElementById("appearance-dialog")?.remove();

  const state = {
    theme: typeof spec.theme === "string" ? spec.theme : "",
    image: normalizeImage(spec.image),
    color: normalizeColor(spec.color),
  };
  let colorEnabled = Boolean(spec.color !== undefined && spec.color !== null);

  const dialog = element("dialog", "appearance-dialog");
  dialog.id = "appearance-dialog";

  const head = element("div", "appearance-head");
  const headText = element("div", "appearance-head-text");
  headText.append(
    element("h2", undefined, spec.title ?? "外观设置"),
    element(
      "p",
      "appearance-subtitle",
      spec.description ?? "外观设置保存在本机，导入的图片会复制到项目目录。",
    ),
  );
  const closeButton = iconButton("appearance-close", closeIcon(), "关闭");
  head.append(headText, closeButton);

  const body = element("div", "appearance-body");

  // 主题预设
  const presetSection = element("section", "appearance-section");
  const presetHead = element("div", "appearance-section-head");
  presetHead.append(
    element("b", undefined, "主题"),
    element("span", undefined, "预设配色，立即生效"),
  );
  const presetGrid = element("div", "preset-grid");
  presetSection.append(presetHead, presetGrid);
  for (const theme of spec.presets ?? THEMES) {
    const card = element("button", "preset-card");
    card.type = "button";
    card.dataset.theme = theme.id;
    card.title = theme.hint || theme.name;
    const swatch = element("span", "preset-swatch");
    for (const color of theme.colors ?? []) {
      const dot = element("i");
      dot.style.background = color;
      swatch.append(dot);
    }
    card.append(swatch, element("span", "preset-name", theme.name));
    card.addEventListener("click", () => {
      state.theme = theme.id;
      syncPresets();
      notify("theme");
    });
    presetGrid.append(card);
  }
  if (!spec.presets || spec.presets.length) body.append(presetSection);

  // 背景图片
  const imageSection = element("section", "appearance-section");
  const imageHead = element("div", "appearance-section-head");
  imageHead.append(
    element("b", undefined, "背景图片"),
    element("span", undefined, "点击缩略图即可套用，保存在项目目录"),
  );
  const toolbar = element("div", "appearance-toolbar");
  const importButton = element("button", "appearance-import", "导入图片");
  importButton.type = "button";
  importButton.prepend(plusIcon());
  const hint = element("span", "appearance-hint", "PNG / JPEG / GIF / WebP / BMP · 单张 ≤ 16 MB");
  toolbar.append(importButton, hint);
  const fileInput = element("input", "appearance-file");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const gallery = element("div", "asset-grid");
  imageSection.append(imageHead, toolbar, gallery, fileInput);
  body.append(imageSection);

  // 位置 / 透明度 / 底色
  const initialOpacity = clamp(numeric(spec.defaultOpacity, DEFAULT_OPACITY), 0, 100);
  const controlSection = element("section", "appearance-section");
  const controlHead = element("div", "appearance-section-head");
  controlHead.append(
    element("b", undefined, "位置与透明度"),
    element("span", undefined, "拖动滑块即时生效 · 背景等比裁切，窗口缩放不变形"),
  );
  const controlGrid = element("div", "appearance-controls");
  const previewWrap = element("div", "appearance-preview-wrap");
  const preview = element("div", "appearance-preview");
  const previewTint = element("div", "appearance-preview-tint");
  const previewImage = element("div", "appearance-preview-image");
  // 底色在图片更下一层，和成员卡上的叠放顺序一致。
  preview.append(previewTint, previewImage);
  previewWrap.append(element("span", "appearance-hint", "实时预览"), preview);
  const sliders = element("div", "appearance-sliders");
  const horizontal = rangeRow("水平位置", state.image?.x ?? 50);
  const vertical = rangeRow("垂直位置", state.image?.y ?? 50);
  const opacity = rangeRow("不透明度", state.image?.opacity ?? initialOpacity);
  sliders.append(horizontal.row, vertical.row, opacity.row);

  let colorInput = null;
  if (colorEnabled) {
    const colorRow = element("div", "appearance-color-row");
    const label = element("label", "appearance-color-label", "卡片底色");
    colorInput = element("input", "appearance-color");
    colorInput.type = "color";
    colorInput.value = state.color || spec.fallbackColor || "#1b2433";
    const themeButton = element("button", "subtle appearance-color-theme", "跟随主题");
    themeButton.type = "button";
    const colorNote = element("span", "appearance-color-note");
    colorRow.append(label, colorInput, themeButton, colorNote);
    sliders.append(colorRow);
    const describe = () => {
      colorNote.textContent = state.color ? state.color : "使用主题默认底色";
      themeButton.disabled = !state.color;
      colorInput.value = state.color || spec.fallbackColor || "#1b2433";
    };
    describe();
    colorInput.addEventListener("input", () => {
      state.color = normalizeColor(colorInput.value);
      describe();
      notify("color");
    });
    themeButton.addEventListener("click", () => {
      state.color = "";
      describe();
      notify("color");
    });
    // 重置或换图后刷新底色的说明文字。
    dialog.addEventListener("appearance-sync", describe);
  }
  controlGrid.append(previewWrap, sliders);
  controlSection.append(controlHead, controlGrid);
  body.append(controlSection);

  // 底部动作
  const actions = element("div", "appearance-actions");
  const clearButton = element("button", "danger subtle", "移除背景图");
  clearButton.type = "button";
  const resetButton = element("button", "subtle", "恢复默认");
  resetButton.type = "button";
  resetButton.hidden = typeof spec.onReset !== "function";
  const doneButton = element("button", "primary", "完成");
  doneButton.type = "button";
  const spacer = element("span", "appearance-spacer");
  actions.append(clearButton, spacer, resetButton, doneButton);

  const errorLine = element("p", "appearance-error");
  errorLine.setAttribute("role", "alert");

  dialog.append(head, body, actions, errorLine);

  // -------------------------------------------------------------- 渲染逻辑

  function snapshot() {
    return {
      theme: state.theme,
      image: state.image ? { ...state.image } : null,
      color: colorEnabled ? state.color : undefined,
    };
  }

  function notify(reason) {
    if (typeof spec.onChange === "function") {
      try {
        spec.onChange(snapshot(), reason);
      } catch (error) {
        console.error(error);
      }
    }
    syncPreview();
    syncControls();
  }

  function syncPreview() {
    paintImage(previewImage, state.image);
    previewTint.style.background = colorEnabled && state.color ? state.color : "";
    preview.classList.toggle("is-empty", !state.image);
  }

  function syncControls() {
    const disabled = !state.image;
    for (const row of [horizontal, vertical, opacity]) {
      row.input.disabled = disabled;
      row.row.classList.toggle("is-disabled", disabled);
    }
    if (state.image) {
      horizontal.input.value = String(Math.round(state.image.x));
      vertical.input.value = String(Math.round(state.image.y));
      opacity.input.value = String(Math.round(state.image.opacity));
      horizontal.output.textContent = Math.round(state.image.x) + "%";
      vertical.output.textContent = Math.round(state.image.y) + "%";
      opacity.output.textContent = Math.round(state.image.opacity) + "%";
    }
    clearButton.disabled = !state.image;
    dialog.dispatchEvent(new Event("appearance-sync"));
  }

  function syncPresets() {
    for (const card of presetGrid.children) {
      card.classList.toggle("is-active", card.dataset.theme === state.theme);
      card.setAttribute(
        "aria-pressed",
        card.dataset.theme === state.theme ? "true" : "false",
      );
    }
  }

  function selectAsset(asset) {
    state.image = {
      url: asset.url,
      x: state.image?.x ?? 50,
      y: state.image?.y ?? 50,
      opacity: state.image?.opacity ?? initialOpacity,
    };
    notify("image");
    renderGallery();
  }

  function renderGallery() {
    const assets = cachedAssets();
    gallery.replaceChildren();
    if (!assets.length) {
      gallery.append(
        element(
          "p",
          "asset-empty",
          assetCache === null ? "正在读取本地图片…" : "还没有导入过图片，点击「导入图片」添加。",
        ),
      );
      return;
    }
    for (const asset of assets) {
      const tile = element("div", "asset-tile");
      const pick = element("button", "asset");
      pick.type = "button";
      pick.title = asset.name || "背景图片";
      pick.setAttribute("aria-label", "使用图片：" + (asset.name || "背景图片"));
      pick.style.backgroundImage = `url("${asset.url}")`;
      pick.classList.toggle("is-selected", state.image?.url === asset.url);
      pick.addEventListener("click", () => selectAsset(asset));
      const remove = iconButton("asset-remove", closeIcon(), "删除这张图片");
      remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        remove.disabled = true;
        try {
          await removeAsset(asset.id);
          if (state.image?.url === asset.url) {
            state.image = null;
            notify("remove");
          }
          renderGallery();
        } catch (error) {
          showError(error);
          remove.disabled = false;
        }
      });
      tile.append(pick, remove);
      gallery.append(tile);
    }
  }

  function showError(error) {
    errorLine.textContent = error?.message || String(error);
    errorLine.classList.add("is-visible");
  }

  function clearError() {
    errorLine.textContent = "";
    errorLine.classList.remove("is-visible");
  }

  // -------------------------------------------------------------- 事件

  for (const [row, key] of [
    [horizontal, "x"],
    [vertical, "y"],
    [opacity, "opacity"],
  ]) {
    row.input.addEventListener("input", () => {
      if (!state.image) return;
      state.image[key] = Number(row.input.value);
      row.output.textContent = row.input.value + "%";
      notify("position");
    });
  }

  importButton.addEventListener("click", () => {
    clearError();
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    if (!files.length) return;
    importButton.disabled = true;
    try {
      let last = null;
      for (const file of files) last = await importImageFile(file);
      if (last) selectAsset(last);
    } catch (error) {
      showError(error);
    } finally {
      importButton.disabled = false;
    }
  });

  clearButton.addEventListener("click", () => {
    state.image = null;
    notify("clear");
    renderGallery();
  });

  resetButton.addEventListener("click", () => {
    if (typeof spec.onReset !== "function") return;
    spec.onReset();
    const next = spec.resetState ?? {};
    state.theme = typeof next.theme === "string" ? next.theme : state.theme;
    state.image = normalizeImage(next.image);
    if (colorEnabled) state.color = normalizeColor(next.color);
    syncPresets();
    notify("reset");
    renderGallery();
  });

  closeButton.addEventListener("click", () => dialog.close());
  doneButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  document.body.append(dialog);
  syncPresets();
  syncPreview();
  syncControls();
  renderGallery();
  dialog.showModal();

  loadAssets()
    .then(() => renderGallery())
    .catch(showError);
  const stopWatching = onAssetsChanged(() => renderGallery());
  dialog.addEventListener("close", stopWatching, { once: true });

  return {
    dialog,
    close: () => dialog.close(),
    refresh: renderGallery,
  };
}
