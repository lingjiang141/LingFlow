// 隔离视觉验证入口：独立 dataDir、端口 0、独立 Electron userData，
// 不会触碰用户正在运行的 LingFlow 服务或 DSH 会话。
// 由 scripts/visual-check.mjs spawn：electron --disable-gpu scripts/visual-main.cjs
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { mkdirSync, writeFileSync } = require("node:fs");

const target = process.env.LINGFLOW_VISUAL_DIR;
if (!target) {
  console.error("LINGFLOW_VISUAL_DIR missing");
  app.exit(1);
}

const dataDir = path.join(target, "data");
app.setName("LingFlow Visual");
app.setPath("userData", path.join(dataDir, "desktop"));
const locked = app.requestSingleInstanceLock();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let runtime;
let window;
const shots = [];
const screenshotErrors = [];
const consoleErrors = [];

async function capture(name) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const image = await window.webContents.capturePage();
      if (image.isEmpty()) throw Error("截图为空");
      writeFileSync(path.join(target, name + ".png"), image.toPNG());
      shots.push({ name, size: image.getSize() });
      await wait(140);
      return;
    } catch (error) {
      // 刚 reload / 改窗口尺寸时合成器偶尔还没出新帧，稍等重试即可。
      lastError = error;
      await wait(320);
    }
  }
  screenshotErrors.push(name + ": " + (lastError && lastError.message ? lastError.message : lastError));
  await wait(140);
}

// 在渲染进程里用 canvas 生成一张渐变测试图，避免引入任何图片二进制资源。
const gradientScript = (from, mid, to) => `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 1280, 800);
  gradient.addColorStop(0, ${JSON.stringify(from)});
  gradient.addColorStop(0.52, ${JSON.stringify(mid)});
  gradient.addColorStop(1, ${JSON.stringify(to)});
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1280, 800);
  let seed = 20261110;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let index = 0; index < 46; index += 1) {
    context.fillStyle = "rgba(255,255,255," + (0.02 + random() * 0.06).toFixed(3) + ")";
    context.beginPath();
    context.arc(random() * 1280, random() * 800, 40 + random() * 180, 0, Math.PI * 2);
    context.fill();
  }
  return canvas.toDataURL("image/png");
})()`;

async function importImage(name, colors) {
  const token = JSON.stringify(runtime.uiToken);
  const dataUrl = await window.webContents.executeJavaScript(gradientScript(...colors), true);
  const value = await window.webContents.executeJavaScript(
    `fetch("/api/ui/appearance", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ${token} },
      body: JSON.stringify({ action: "import", name: ${JSON.stringify(name)}, data: ${JSON.stringify(dataUrl)} }),
    }).then(async (response) => {
      const value = await response.json();
      return { ok: response.ok, status: response.status, value };
    })`,
    true,
  );
  if (!value.ok) throw Error("导入素材失败：" + value.status + " " + JSON.stringify(value.value));
  return value.value.asset;
}

if (!locked) app.quit();
else {
  app
    .whenReady()
    .then(async () => {
      const { startServer } = await import(pathToFileURL(path.join(__dirname, "../src/server.mjs")));
      runtime = await startServer({
        dataDir,
        port: 0,
        // 素材库也放进 .validation 的临时目录，避免往项目里真实的 ui/assets/ 塞测试图片。
        assetRoot: path.join(target, "assets"),
        pickProjectDirectory: async () => null,
      });
      window = new BrowserWindow({
        width: 1360,
        height: 900,
        minWidth: 880,
        minHeight: 650,
        title: "LingFlow Visual",
        backgroundColor: "#10141d",
        autoHideMenuBar: true,
        show: false,
        focusable: false,
        skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("console-message", (event) => {
        const level = event.level ?? "";
        if (level === "error" || level === "warning") consoleErrors.push(level + ": " + event.message);
      });
      await window.loadURL(`http://127.0.0.1:${runtime.port}/#${runtime.uiToken}`);
      window.showInactive();
      await wait(1400);
      const execute = (code) => window.webContents.executeJavaScript(code, true);

      const fixture = path.join(target, "project");
      mkdirSync(fixture, { recursive: true });
      const project = await runtime.workflow.call(
        "ui",
        "createProject",
        { name: "界面验收项目", root: fixture },
        "visual-project",
      );
      await runtime.workflow.call(
        "ui",
        "addRole",
        { projectId: project.id, kind: "controller", name: "主控 · 小鲸" },
        "visual-role-controller",
      );
      const developer = await runtime.workflow.call(
        "ui",
        "addRole",
        { projectId: project.id, kind: "developer", name: "开发 · 阿码" },
        "visual-role-developer",
      );
      await runtime.workflow.call(
        "ui",
        "addRole",
        { projectId: project.id, kind: "reviewer", name: "审查 · 严工" },
        "visual-role-reviewer",
      );
      await wait(3200);

      // 1) 深色默认
      await capture("01-dark");

      // 2) 七套预设主题（含浅色、薄荷极光、砂糖粉蓝、血色暗夜、柑橘暖阳）
      for (const theme of ["white", "lavender", "sky", "mint", "sugar", "crimson", "citrus"]) {
        await execute(`window.__lingflowAppearance.setTheme(${JSON.stringify(theme)})`);
        await wait(340);
        await capture("02-theme-" + theme);
      }
      await execute(`window.__lingflowAppearance.setTheme("dark")`);
      await wait(300);

      // 3) 导入自定义窗口背景图并应用
      const windowAsset = await importImage("窗口背景-极光.png", ["#1b2a4a", "#3a2a5e", "#0e1a2e"]);
      await execute(
        `window.__lingflowAppearance.setWallpaper({ url: ${JSON.stringify(windowAsset.url)}, x: 50, y: 50, opacity: 62 })`,
      );
      await wait(520);
      await capture("03-wallpaper");

      // 4) 刷新后验证偏好持久化
      window.webContents.reload();
      await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
      await wait(1100);
      const persisted = await execute(`(() => {
        const layer = document.getElementById("window-background");
        const style = layer ? getComputedStyle(layer) : null;
        return {
          theme: document.documentElement.dataset.theme,
          wallpaper: document.documentElement.dataset.wallpaper,
          backgroundSize: style ? style.backgroundSize : "",
          backgroundPosition: style ? style.backgroundPosition : "",
          opacity: style ? Number.parseFloat(style.opacity) : 0,
          hasImage: style ? style.backgroundImage !== "none" : false,
        };
      })()`);
      await capture("04-wallpaper-persisted");

      // 5) 窗口外观对话框
      await execute(`window.__lingflowAppearance.open()`);
      await wait(520);
      await capture("05-theme-dialog");
      const dialogSummary = await execute(`(() => {
        const dialog = document.getElementById("appearance-dialog");
        return dialog ? {
          open: dialog.open,
          themeCards: dialog.querySelectorAll(".preset-card").length,
          assets: dialog.querySelectorAll(".asset").length,
          hasRange: dialog.querySelectorAll('input[type="range"]').length,
        } : null;
      })()`);
      await execute(`document.getElementById("appearance-dialog")?.close()`);
      await wait(260);

      // 6) 成员卡背景图 / 底色
      const hasCards = await execute(`!!(window.__lingflowCards && window.__lingflowCards.set)`);
      let cardState = null;
      if (hasCards) {
        const cardAsset = await importImage("成员卡-星空.png", ["#241a3f", "#4a2a63", "#121b34"]);
        await execute(
          `window.__lingflowCards.set(${JSON.stringify(developer.id)}, { url: ${JSON.stringify(cardAsset.url)}, x: 50, y: 50, opacity: 88, color: "#2a2140" })`,
        );
        await wait(900);
        await capture("06-card-applied");
        await execute(`(() => { window.__lingflowCards.open(${JSON.stringify(developer.id)}); })()`);
        await wait(560);
        await capture("07-card-dialog");
        await execute(`document.getElementById("appearance-dialog")?.close()`);
        await wait(260);
        window.webContents.reload();
        await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
        await wait(1300);
        await capture("08-card-persisted");
        cardState = await execute(`(() => {
          const prefs = localStorage.getItem("lingflow.card-backgrounds.v1");
          const cards = [...document.querySelectorAll("article.role")];
          return {
            prefs: prefs ? JSON.parse(prefs) : null,
            cards: cards.map((card) => {
              const media = card.querySelector(".card-media");
              const style = media ? getComputedStyle(media) : null;
              return {
                name: card.querySelector(".role-name")?.textContent ?? "",
                icon: !!card.querySelector(".card-appearance"),
                hasImage: style ? style.backgroundImage !== "none" : false,
                opacity: style ? Number.parseFloat(style.opacity) : 0,
                color: getComputedStyle(card).backgroundColor,
              };
            }),
          };
        })()`);
      }

      // 7) 窗口比例变化：背景图不变形（cover + 百分比定位）
      await execute(`window.__lingflowAppearance.setWallpaper({ url: ${JSON.stringify(windowAsset.url)}, x: 50, y: 50, opacity: 62 })`);
      await wait(320);
      window.setSize(1000, 660);
      await wait(480);
      await capture("09-narrow");
      const narrow = await execute(`(() => {
        const layer = document.getElementById("window-background");
        const style = getComputedStyle(layer);
        return { width: innerWidth, height: innerHeight, backgroundSize: style.backgroundSize, backgroundPosition: style.backgroundPosition };
      })()`);
      window.setSize(1440, 820);
      await wait(480);
      await capture("10-wide");
      const wide = await execute(`(() => {
        const layer = document.getElementById("window-background");
        const style = getComputedStyle(layer);
        return { width: innerWidth, height: innerHeight, backgroundSize: style.backgroundSize, backgroundPosition: style.backgroundPosition };
      })()`);

      const page = await execute(`(() => {
        const themeButton = document.getElementById("theme-button");
        return {
          title: document.title,
          theme: document.documentElement.dataset.theme,
          wallpaper: document.documentElement.dataset.wallpaper,
          errors: (window.lingflowErrors || []).slice(),
          errorText: document.getElementById("error")?.textContent?.trim() ?? "",
          workspaceHidden: document.getElementById("workspace")?.hidden ?? null,
          themeButton: !!themeButton,
          themeButtonText: themeButton ? themeButton.innerText.replace(/\\s+/g, " ").trim() : "",
          roles: [...document.querySelectorAll("article.role")].map((card) => ({
            name: card.querySelector(".role-name")?.textContent ?? "",
            icon: !!card.querySelector(".card-appearance"),
            iconLabel: card.querySelector(".card-appearance")?.getAttribute("aria-label") ?? "",
            media: !!card.querySelector(".card-media"),
          })),
          dialog: !!document.getElementById("appearance-dialog"),
        };
      })()`);

      writeFileSync(
        path.join(target, "visual.json"),
        JSON.stringify(
          {
            ...page,
            shots,
            screenshotErrors,
            consoleErrors,
            assetCount: windowAsset ? 1 : 0,
            persisted,
            dialogSummary,
            narrow,
            wide,
            cardState,
          },
          null,
          2,
        ),
      );
      await runtime.close();
      app.exit(0);
    })
    .catch(async (error) => {
      console.error(error && error.stack ? error.stack : error);
      try {
        writeFileSync(
          path.join(target, "visual.json"),
          JSON.stringify({ fatal: String(error && error.message ? error.message : error), shots, screenshotErrors, consoleErrors }, null, 2),
        );
        if (runtime) await runtime.close();
      } catch {}
      app.exit(1);
    });
}
