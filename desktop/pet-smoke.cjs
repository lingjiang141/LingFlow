const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { installDesktopLifecycle } = require("./lifecycle.cjs");
const root = process.env.LINGFLOW_PET_SMOKE_DIR;
if (!root) throw Error("Use scripts/pet-smoke.mjs");
app.setPath("userData", path.join(root, "profile"));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const result = { errors: [] };
app.whenReady().then(async () => {
  const main = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, "selection-preload.cjs"), contextIsolation: true, sandbox: true } });
  await main.loadURL("data:text/html,<title>Pet smoke host</title>");
  const states = ["accepted", "ready", "trial", "superseded", "assigned", "rework", "reviewing", "waiting_verification", "queued", "paused", "queued", "queued"];
  const titles = ["统一 AI 出题入口", "移除重复表单", "资源预选状态回显", "旧入口兼容票", "生成记录面板", "停止任务交互", "状态一致性核对", "接口与界面联合验证", "空态与失败提示", "补齐边界回归", "资源列表刷新", "整版收口检查"];
  const snapshot = { projects: [{ id: "project", name: "员工考试系统" }], roles: [{ id: "dev", name: "开发成员" }],
    tasks: states.map((state, index) => ({ id: "ticket-" + index, projectId: "project", developerId: "dev", state,
      ticketKey: "R35-" + String(index + 1).padStart(2, "0"), title: titles[index],
      description: "核对页面中的实际行为，保持入口、状态与接口回执一致。", sources: { spec: { file: "R35 · AI 出题工作台.md", digest: index < 5 ? "revision-one" : index < 7 ? "revision-two" : "revision-three" } } })) };
  let pointer = { x: 400, y: 300 };
  let closed = false;
  const runtime = { workflow: { snapshot: async () => snapshot }, close: async () => {
    closed = true; result.serviceClosedOnQuit = true;
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  } };
  const lifecycle = installDesktopLifecycle(main, runtime, { petOptions: { directory: path.join(root, "data"), cursor: () => pointer } });
  const pet = lifecycle.pet;
  const web = pet.window.webContents;
  web.on("console-message", event => { if (event.level === "error" || event.level === 3) result.errors.push(event.message); });
  await pet.ready;
  const evaluate = code => web.executeJavaScript(code);
  async function until(code, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { const value = await evaluate(code); if (value) return value; await wait(60); }
    throw Error("Timed out: " + code);
  }
  const capture = async name => fs.writeFileSync(path.join(root, name + ".png"), (await web.capturePage()).toPNG());
  main.close();
  await until("document.getElementById('sprite').dataset.animation");
  await wait(250);
  result.closedPageKeptPet = !main.isDestroyed() && !main.isVisible() && pet.window.isVisible() && !closed;
  assert.equal(result.closedPageKeptPet, true);
  const idle = await evaluate("document.getElementById('sprite').dataset.animation");
  assert.notEqual(idle, "写代码");
  await capture("dsh-idle");
  const started = Date.now();
  await until(`document.getElementById('sprite').dataset.animation !== ${JSON.stringify(idle)}`, 29000);
  result.idleChangedAfterMs = Date.now() - started;
  assert.ok(result.idleChangedAfterMs >= 18000, "Must play two complete ten-second cycles before switching");
  await evaluate("document.getElementById('pet').click()");
  await until("document.getElementById('pet').getAttribute('aria-expanded') === 'true' && document.getElementById('sprite').dataset.animation === '写代码'");
  await wait(500);
  assert.equal(await evaluate("[...document.querySelectorAll('.surface')].every(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })"), true, "Panels must stay inside the native window");
  await capture("overview");
  assert.equal(await evaluate("document.querySelectorAll('.ticket').length"), states.length);
  assert.equal(await evaluate("document.getElementById('progress-label').textContent"), "3 / 11 已收口 · 1 已验收");
  assert.equal(await evaluate("document.querySelector('#active .ticket').dataset.id"), "ticket-4");
  assert.equal(await evaluate("document.querySelector('#closed .ticket').dataset.id"), "ticket-2");
  assert.equal(await evaluate("document.querySelector('#closed .ticket:last-child').dataset.id"), "ticket-3");
  result.priorityOrdering = true;
  assert.match(await evaluate("document.getElementById('spec').selectedOptions[0].textContent"), /本轮全部票/);
  const versionKey = JSON.stringify(["R35 · AI 出题工作台.md", "revision-two"]);
  await evaluate(`document.getElementById('spec').value = ${JSON.stringify(versionKey)}; document.getElementById('spec').dispatchEvent(new Event('change'))`);
  await until("document.querySelectorAll('.ticket').length === 2");
  assert.equal(await evaluate("document.getElementById('progress-label').textContent"), "0 / 2 已收口 · 0 已验收");
  await evaluate("document.getElementById('spec').value = 'current'; document.getElementById('spec').dispatchEvent(new Event('change'))");
  await until("document.querySelectorAll('.ticket').length === 12");
  result.specCycleIncludesAdditions = true;
  await capture("spec-cycle-all-revisions");
  main.showInactive();
  await wait(500);
  assert.equal(await evaluate("document.getElementById('sprite').dataset.animation"), "写代码", "Blur must not close viewing mode");
  main.hide();
  const before = pet.window.getBounds();
  await evaluate("window.lingflowPet.drag('start')"); await wait(60);
  pointer = { x: 360, y: 260 };
  await evaluate("window.lingflowPet.drag('move')"); await wait(60);
  await evaluate("window.lingflowPet.drag('end')"); await wait(60);
  const after = pet.window.getBounds();
  assert.ok(after.x !== before.x || after.y !== before.y, "Drag IPC must move the native window");
  result.dragged = true;
  const menu = pet.menu();
  result.characters = menu.items.filter(item => item.type === "radio").map(item => item.label);
  for (const item of menu.items.filter(item => item.type === "radio")) {
    item.click();
    await until(`document.getElementById('sprite').dataset.character === ${JSON.stringify(item.label.toLowerCase())} && document.getElementById('sprite').dataset.animation.includes('写代码')`);
    await wait(1600);
    await capture(item.label.toLowerCase() + "-viewing");
    assert.equal(await evaluate("document.getElementById('pet').getAttribute('aria-expanded')"), "true");
    await evaluate("document.getElementById('close').click()");
    await until(`document.getElementById('sprite').dataset.character === ${JSON.stringify(item.label.toLowerCase())} && !document.getElementById('sprite').dataset.animation.includes('写代码')`);
    await evaluate("document.getElementById('pet').click()");
    await until("document.getElementById('sprite').dataset.animation === '写代码'");
  }
  await evaluate("document.getElementById('close').click()");
  await until("document.getElementById('pet').getAttribute('aria-expanded') === 'false' && !document.getElementById('sprite').dataset.animation.includes('写代码')");
  assert.ok(pet.window.getBounds().width <= 184);
  snapshot.tasks.push(...Array.from({ length: 24 }, (_, index) => ({ ...snapshot.tasks[8], id: "more-" + index, ticketKey: "R35-" + (index + 20) })));
  await evaluate("document.getElementById('pet').click()");
  await until("document.querySelectorAll('.ticket').length === 36");
  assert.equal(await evaluate("document.querySelector('#waiting .tickets').scrollHeight > document.querySelector('#waiting .tickets').clientHeight"), true);
  result.allTicketsVisibleInScrollableGroups = true;
  lifecycle.menu.getMenuItemById("open").click();
  assert.equal(main.isVisible(), true);
  assert.equal(closed, false);
  lifecycle.menu.getMenuItemById("quit").click();
}).catch(error => { console.error(error); app.exit(1); });
