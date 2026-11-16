const { app, BrowserWindow } = require("electron");
const { connect } = require("node:net");
const { once } = require("node:events");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { installDesktopLifecycle } = require("./lifecycle.cjs");
const root = process.env.LINGFLOW_TRAY_EXIT_SMOKE_DIR;
if (!root) throw Error("Use scripts/tray-exit-smoke.mjs");
app.setPath("userData", path.join(root, "profile"));
app.whenReady().then(async () => {
  const { startServer } = await import(pathToFileURL(path.join(__dirname, "../src/server.mjs")));
  const runtime = await startServer({ dataDir: path.join(root, "data"), port: 0 });
  const main = new BrowserWindow({ show: false });
  await main.loadURL("data:text/html,<title>Tray exit regression</title>");
  const lifecycle = installDesktopLifecycle(main, runtime, { petOptions: { directory: path.join(root, "pet") } });
  await lifecycle.pet.ready;
  main.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(main.isDestroyed(), false);
  assert.equal(lifecycle.pet.window.isVisible(), true);
  const socket = connect(runtime.port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  const received = once(runtime.server, "request");
  socket.write(`POST /api/ui/snapshot HTTP/1.1\r\nHost: 127.0.0.1:${runtime.port}\r\nAuthorization: Bearer ${runtime.uiToken}\r\nContent-Length: 1000\r\n\r\n{`);
  await received;
  const started = Date.now();
  app.once("will-quit", () => {
    const result = {
      elapsedMs: Date.now() - started,
      port: runtime.port,
      windowsRemaining: BrowserWindow.getAllWindows().length,
      trayDestroyed: lifecycle.tray.isDestroyed(),
      serviceStopped: !runtime.server.listening,
    };
    writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  });
  lifecycle.menu.getMenuItemById("quit").click();
  lifecycle.menu.getMenuItemById("quit").click();
}).catch(error => { console.error(error); app.exit(1); });
