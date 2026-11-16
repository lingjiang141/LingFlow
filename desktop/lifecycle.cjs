const { app, Menu, Tray } = require("electron");
const path = require("node:path");
const { createDesktopPet } = require("./pet-window.cjs");

function restoreWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function installDesktopLifecycle(window, runtime, { petOptions } = {}) {
  let tray;
  let menu;
  let quitting = false;
  let stopped = false;
  const pet = createDesktopPet(window, runtime, petOptions);

  if (process.platform === "win32") {
    tray = new Tray(path.join(__dirname, "tray.ico"));
    const openWindow = () => {
      if (!quitting) restoreWindow(window);
    };
    tray.setToolTip("LingFlow");
    menu = Menu.buildFromTemplate([
      { id: "open", label: "打开 LingFlow", click: openWindow },
      { id: "pet", label: "显示 / 隐藏桌宠", click: () => pet.toggle() },
      { type: "separator" },
      { id: "quit", label: "退出 LingFlow", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", openWindow);
    tray.on("double-click", openWindow);
  }
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
    pet.show();
  });

  app.on("window-all-closed", () => {
    if (!tray && !quitting) app.quit();
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    pet.dispose();
    Promise.resolve()
      .then(() => runtime.close())
      .catch((error) => console.error("LingFlow 关闭本地服务失败：", error.message))
      .finally(() => {
        stopped = true;
        app.quit();
      });
  });
  app.once("will-quit", () => tray?.destroy());

  return { tray, menu, pet };
}

module.exports = { installDesktopLifecycle, restoreWindow };
