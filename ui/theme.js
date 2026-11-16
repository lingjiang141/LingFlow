// 窗口外观：左上角 Logo 下方的主题切换按钮、四套预设主题与自定义窗口背景图。
import {
  DEFAULT_OPACITY,
  PREF,
  THEMES,
  normalizeImage,
  openAppearanceDialog,
  paintImage,
  paletteIcon,
  readPref,
  writePref,
} from "./appearance.js";

const DEFAULT_THEME = "dark";
const THEME_IDS = new Set(THEMES.map((theme) => theme.id));

let theme = DEFAULT_THEME;
let wallpaper = null;
let syncButton = () => {};

function describe(themeId) {
  return THEMES.find((item) => item.id === themeId) ?? THEMES[0];
}

function applyTheme(themeId) {
  theme = THEME_IDS.has(themeId) ? themeId : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
}

function applyWallpaper(image) {
  wallpaper = normalizeImage(image);
  // 比例变化时由 background-size: cover 自适应，这里只负责定位与透明度。
  paintImage(document.getElementById("window-background"), wallpaper);
  document.documentElement.dataset.wallpaper = wallpaper ? "1" : "0";
}

function save() {
  writePref(PREF.theme, { theme, wallpaper });
}

function load() {
  const value = readPref(PREF.theme, null);
  return {
    theme: THEME_IDS.has(value?.theme) ? value.theme : DEFAULT_THEME,
    wallpaper: normalizeImage(value?.wallpaper),
  };
}

function openEditor() {
  openAppearanceDialog({
    title: "窗口外观",
    description:
      "选择一套预设主题，或导入图片作为整个窗口的背景。图片会复制保存到项目目录，之后可以随时切回已导入的图片。",
    theme,
    image: wallpaper,
    onChange(next) {
      applyTheme(next.theme);
      applyWallpaper(next.image);
      save();
      syncButton();
    },
    onReset() {},
    resetState: { theme: DEFAULT_THEME, image: null },
  });
}

function mountButton() {
  const dock = document.getElementById("theme-dock");
  if (!dock) return;
  const button = document.createElement("button");
  button.id = "theme-button";
  button.className = "theme-button";
  button.type = "button";

  const glyph = document.createElement("span");
  glyph.className = "theme-glyph";
  glyph.append(paletteIcon());

  const label = document.createElement("span");
  label.className = "theme-label";

  const swatches = document.createElement("span");
  swatches.className = "theme-swatches";
  for (let index = 0; index < 3; index += 1) swatches.append(document.createElement("i"));

  const chevron = document.createElement("span");
  chevron.className = "theme-chevron";
  chevron.textContent = "▾";

  button.append(glyph, label, swatches, chevron);
  button.addEventListener("click", openEditor);
  dock.replaceChildren(button);

  syncButton = () => {
    const current = describe(theme);
    label.textContent = current.name;
    button.dataset.appearance = theme;
    const dots = [...swatches.children];
    const colors = wallpaper ? ["#6f7d96", ...(current.colors ?? []).slice(1)] : current.colors ?? [];
    dots.forEach((dot, index) => {
      dot.style.background = colors[index] ?? "transparent";
    });
    swatches.classList.toggle("is-custom", Boolean(wallpaper));
    button.title = wallpaper
      ? "窗口外观 · " + current.name + " + 自定义背景图"
      : "切换窗口主题 · 当前" + current.name;
    button.setAttribute("aria-label", button.title);
  };
  syncButton();
}

export function setTheme(themeId) {
  applyTheme(themeId);
  save();
  syncButton();
  return theme;
}

export function setWallpaper(value) {
  applyWallpaper(value);
  save();
  syncButton();
  return wallpaper ? { ...wallpaper } : null;
}

const preference = load();
applyTheme(preference.theme);
applyWallpaper(preference.wallpaper);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountButton, { once: true });
} else {
  mountButton();
}

// 供桌面端视觉验证脚本驱动，普通使用不需要触碰。
window.__lingflowAppearance = {
  get theme() {
    return theme;
  },
  get wallpaper() {
    return wallpaper ? { ...wallpaper } : null;
  },
  defaultOpacity: DEFAULT_OPACITY,
  themes: THEMES.map((item) => item.id),
  setTheme,
  setWallpaper,
  open: openEditor,
};
