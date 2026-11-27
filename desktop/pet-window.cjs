const { BrowserWindow, ipcMain, screen, Menu, app } = require("electron");
const { mkdirSync, readFileSync, writeFileSync, renameSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createPetAssets } = require("./pet-assets.cjs");
const { fitBounds, aroundCenter } = require("./pet-geometry.cjs");

const THEME_IDS = new Set(["dark", "white", "lavender", "sky", "mint", "sugar", "crimson", "citrus"]);

function createDesktopPet(mainWindow, runtime, { directory = app.getPath("userData"), cursor = () => screen.getCursorScreenPoint() } = {}) {
  mkdirSync(directory, { recursive: true });
  const preferencesFile = path.join(directory, "pet.json");
  let saved = {};
  try { saved = JSON.parse(readFileSync(preferencesFile, "utf8")); } catch {}
  const assets = createPetAssets(path.join(directory, "pet-cache"));
  let character = assets.catalog.characters.some(item => item.id === saved.character) ? saved.character : "dsh";
  let theme = THEME_IDS.has(saved.theme) ? saved.theme : "dark";
  let selection = saved.selection ?? {}, expanded = false, dragging, regions = [], disposed = false, ignore;
  const defaultBounds = area => fitBounds({ x: area.x + area.width - 220, y: area.y + area.height - 220, width: 184, height: 184 }, area);
  let restBounds = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    ? fitBounds({ x: saved.x, y: saved.y, width: 184, height: 184 }, screen.getDisplayNearestPoint({ x: saved.x + 92, y: saved.y + 92 }).workArea)
    : defaultBounds(screen.getPrimaryDisplay().workArea);
  const pet = new BrowserWindow({ ...restBounds, transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: "#00000000", title: "LingFlow · 桌宠",
    webPreferences: { preload: path.join(__dirname, "pet-preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const model = import(pathToFileURL(path.join(__dirname, "../ui/pet-model.js")));
  const save = () => {
    writeFileSync(preferencesFile + ".tmp", JSON.stringify({ character, theme, selection, x: restBounds.x, y: restBounds.y }));
    renameSync(preferencesFile + ".tmp", preferencesFile);
  };
  const publish = () => { if (!disposed) pet.webContents.send("lingflow-pet:change", { character, theme, expanded }); };
  const validSelection = value => value && typeof value === "object" && typeof value.projectId === "string" &&
    value.projectId.length < 200 && (value.specKey == null || typeof value.specKey === "string" && value.specKey.length < 2000);
  const pick = value => { if (validSelection(value)) { selection = { projectId: value.projectId, specKey: value.specKey ?? "current" }; save(); publish(); } };
  const setExpanded = value => {
    if (disposed) return;
    value = value === true;
    if (value !== expanded) {
      if (value) restBounds = pet.getBounds();
      const area = screen.getDisplayMatching(restBounds).workArea;
      pet.setBounds(value ? aroundCenter(restBounds, 760, 640, area) : fitBounds(restBounds, area));
      expanded = value;
    }
    publish();
    return { expanded };
  };
  const selectCharacter = id => {
    if (!assets.catalog.characters.some(item => item.id === id)) return;
    character = id; save(); publish();
  };
  const menu = () => Menu.buildFromTemplate([
    { label: "更换形象", enabled: false },
    ...assets.catalog.characters.map(item => ({ label: item.name, type: "radio", checked: character === item.id, click: () => selectCharacter(item.id) })),
    { type: "separator" },
    { label: "收起状态概览", enabled: expanded, click: () => setExpanded(false) },
    { label: "打开 LingFlow", click: () => { mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
  ]);
  const handlers = [], listeners = [];
  const handle = (channel, action) => {
    channel = "lingflow-pet:" + channel;
    ipcMain.handle(channel, (event, ...args) => { if (event.sender !== pet.webContents) throw Error("无效桌宠窗口"); return action(...args); });
    handlers.push(channel);
  };
  const listen = (channel, action, sender = () => pet.webContents) => {
    channel = "lingflow-pet:" + channel;
    const callback = (event, ...args) => { if (!disposed && event.sender === sender()) action(...args); };
    ipcMain.on(channel, callback); listeners.push([channel, callback]);
  };
  handle("initialize", () => ({ catalog: assets.catalog, character, theme, expanded }));
  handle("image", (id, animation) => assets.image(id, animation));
  handle("snapshot", async () => {
    let snapshot;
    if (runtime.workflow) snapshot = await runtime.workflow.snapshot();
    else {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/api/ui/snapshot`, { method: "POST", headers: {
        "Content-Type": "application/json", Authorization: "Bearer " + runtime.uiToken,
      }, body: "{}", signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw Error("进度服务暂不可用");
      snapshot = await response.json();
    }
    return (await model).petProgress(snapshot, selection);
  });
  handle("open-tool", async (projectId, tool) => {
    if (typeof projectId !== "string" || !["folder", "cmd"].includes(tool)) throw Error("无效项目工具参数");
    if (runtime.workflow) {
      const snapshot = await runtime.workflow.snapshot();
      const project = snapshot.projects.find(item => item.id === projectId);
      if (!project) throw Error("未找到对应项目");
      const { defaultOpenProjectTool } = await import(pathToFileURL(path.join(__dirname, "../src/project-tool.mjs")));
      return defaultOpenProjectTool(project.root, tool);
    }
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/ui/open-project-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + runtime.uiToken },
      body: JSON.stringify({ projectId, tool }),
      signal: AbortSignal.timeout(4000),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(value.error || "操作失败");
    return value;
  });
  handle("expanded", setExpanded);
  listen("pick", value => { if (validSelection(value)) { pick(value); mainWindow.webContents.send("lingflow-pet:selection-changed", selection); } });
  listen("selection", pick, () => mainWindow.webContents);
  listen("theme", value => { if (THEME_IDS.has(value) && value !== theme) { theme = value; save(); publish(); } }, () => mainWindow.webContents);
  listen("show", () => show({ useDefaultPosition: true }), () => mainWindow.webContents);
  listen("menu", () => menu().popup({ window: pet }));
  listen("regions", value => { if (Array.isArray(value) && value.length <= 10) regions = value.filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)); });
  listen("drag", phase => {
    if (phase === "start") { dragging = { pointer: cursor(), bounds: pet.getBounds() }; pet.setIgnoreMouseEvents(false); ignore = false; }
    if (phase === "move" && dragging) {
      const point = cursor();
      pet.setBounds(fitBounds({ ...dragging.bounds, x: dragging.bounds.x + point.x - dragging.pointer.x,
        y: dragging.bounds.y + point.y - dragging.pointer.y }, screen.getDisplayNearestPoint(point).workArea));
    }
    if (phase === "end") {
      dragging = null;
      restBounds = aroundCenter(pet.getBounds(), 184, 184, screen.getDisplayMatching(pet.getBounds()).workArea); save();
    }
  });
  const hitTimer = setInterval(() => {
    if (disposed || !pet.isVisible() || dragging) return;
    const bounds = pet.getBounds(), pointer = cursor();
    const x = pointer.x - bounds.x, y = pointer.y - bounds.y;
    const next = !regions.some(rect => x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height);
    if (next !== ignore) { pet.setIgnoreMouseEvents(next, { forward: true }); ignore = next; }
  }, 60);
  pet.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pet.webContents.on("will-navigate", event => event.preventDefault());
  pet.on("close", event => { if (!disposed) { event.preventDefault(); pet.hide(); } });
  const ready = pet.loadFile(path.join(__dirname, "pet/index.html"));
  function show({ useDefaultPosition = false } = {}) {
    void ready.then(() => {
      if (disposed) return;
      if (useDefaultPosition && !pet.isVisible()) {
        const area = screen.getPrimaryDisplay().workArea;
        restBounds = defaultBounds(area);
        pet.setBounds(expanded ? aroundCenter(restBounds, 760, 640, area) : restBounds);
      }
      pet.setAlwaysOnTop(true);
      pet.showInactive();
      if (process.platform === "win32") pet.moveTop();
      publish();
    });
  }
  return { window: pet, ready, show, menu, selectCharacter, setExpanded,
    toggle: () => pet.isVisible() ? pet.hide() : show({ useDefaultPosition: true }),
    dispose() {
      if (disposed) return;
      disposed = true; clearInterval(hitTimer);
      for (const channel of handlers) ipcMain.removeHandler(channel);
      for (const [channel, callback] of listeners) ipcMain.removeListener(channel, callback);
      pet.destroy();
    },
  };
}
module.exports = { createDesktopPet };
