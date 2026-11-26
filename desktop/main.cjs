const { app, BrowserWindow, dialog } = require("electron");
const { installDesktopLifecycle, restoreWindow } = require("./lifecycle.cjs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const dataDir =
  process.env.LINGFLOW_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "LingFlow");
app.setName("LingFlow");
app.setPath("userData", path.join(dataDir, "desktop"));
const locked = app.requestSingleInstanceLock();
let mainWindow, runtime;
async function captureSmokePage(window, file, errors) {
  try {
    const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw Error("截图为空");
    writeFileSync(file, image.toPNG());
  } catch (error) {
    // Renderer interaction can still be verified when Windows compositor is unavailable.
    errors.push(path.basename(file) + ": " + error.message);
  }
}
if (!locked) app.quit();
else {
  app.on("second-instance", () => {
    restoreWindow(mainWindow);
  });
  app
    .whenReady()
    .then(async () => {
      const { startServer } = await import(
        pathToFileURL(path.join(__dirname, "../src/server.mjs"))
      );
      const pickProjectDirectory = async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
          title: "选择项目目录",
          properties: ["openDirectory"],
        });
        return canceled ? null : filePaths[0];
      };
      // Prefer hosting: the window can then offer the native directory picker.
      // When the sidebar panel already owns the service, attach to it instead of
      // failing on the port - both entrances must share one workflow loop.
      try {
        runtime = await startServer({
          dataDir,
          port: process.env.LINGFLOW_SMOKE_DIR ? 0 : undefined,
          pickProjectDirectory,
        });
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
        const { ensureService } = await import(
          pathToFileURL(path.join(__dirname, "../src/instance.mjs"))
        );
        const service = await ensureService({ dataDir });
        runtime = {
          port: service.port,
          uiToken: service.uiToken,
          attached: true,
          close: async () => {},
        };
      }
      mainWindow = new BrowserWindow({
        width: 1360,
        height: 900,
        minWidth: 880,
        minHeight: 650,
        title: "LingFlow",
        backgroundColor: "#10141d",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "selection-preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      const lifecycle = installDesktopLifecycle(mainWindow, runtime);
      mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      mainWindow.webContents.on("will-navigate", (event) =>
        event.preventDefault(),
      );
      mainWindow.webContents.session.setPermissionRequestHandler(
        (_web, _permission, callback) => callback(false),
      );
      await mainWindow.loadURL(
        `http://127.0.0.1:${runtime.port}/#${runtime.uiToken}`,
      );
      if (process.env.LINGFLOW_SMOKE_DIR) {
        const target = process.env.LINGFLOW_SMOKE_DIR;
        const screenshotErrors = [];
        mkdirSync(target, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const emptyBody = await mainWindow.webContents.executeJavaScript(
          "document.body.innerText",
        );
        await captureSmokePage(mainWindow, path.join(target, "empty.png"), screenshotErrors);
        const fixture = path.join(target, "fixture");
        mkdirSync(fixture, { recursive: true });
        const projectFields = await mainWindow.webContents.executeJavaScript(
          `document.getElementById('first-project').click();const projectFields=[...document.querySelectorAll('#fields input')].map(input=>input.name);document.getElementById('field-name').value='LingFlow 界面验证';document.getElementById('field-root').value=${JSON.stringify(fixture)};document.getElementById('modal-form').requestSubmit();projectFields;`,
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        const emptyTeam = await mainWindow.webContents.executeJavaScript(
          "!document.getElementById('no-roles').hidden && !document.getElementById('roles').childElementCount",
        );
        await mainWindow.webContents.executeJavaScript(`
          document.getElementById('controller-settings').click();
          document.getElementById('field-policy').value = '先核对流程证据';
          document.getElementById('modal-form').requestSubmit();
        `);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const smokeProject = (await runtime.workflow.snapshot()).projects[0];
        const savedControllerPolicy = smokeProject?.controllerPolicy;
        const smokeController = await runtime.workflow.call("ui", "addRole", {
          projectId: smokeProject.id, kind: "controller", name: "主控界面验证",
        }, "desktop-role-prompt");
        await mainWindow.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const timer = setInterval(() => {
              if ([...document.querySelectorAll('.role-name')].some((item) => item.textContent === '主控界面验证')) {
                clearInterval(timer);
                clearTimeout(timeout);
                resolve();
              }
            }, 50);
            const timeout = setTimeout(() => {
              clearInterval(timer);
              reject(new Error('主控未显示在测试工作台'));
            }, 5000);
          });
        `);
        const controllerIdentityDefault = await mainWindow.webContents.executeJavaScript(`
          document.getElementById('controller-settings').click();
          const controllerPicker = document.getElementById('field-target');
          controllerPicker.value = ${JSON.stringify(smokeController.id)};
          controllerPicker.dispatchEvent(new Event('change'));
          const defaultIdentity = document.getElementById('field-policy').value;
          document.getElementById('field-policy').value = '只核对收口证据';
          document.getElementById('modal-form').requestSubmit();
          defaultIdentity;
        `);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const savedControllerIdentity = (await runtime.workflow.snapshot()).roles
          .find((role) => role.id === smokeController.id)?.identityPrompt;
        await mainWindow.webContents.executeJavaScript(
          `document.getElementById('add-role').click();const kind=document.getElementById('field-kind');kind.value='custom';kind.dispatchEvent(new Event('change'));document.getElementById('field-workflowKind').value='reviewer';document.getElementById('field-customLabel').value='质量工程师';document.getElementById('field-name').value='自定义审查';document.getElementById('field-identityPrompt').value='检查交互边界';document.querySelector('.preset-editor').open=true;document.getElementById('preset-name').value='审查预设';document.getElementById('create-prompt-preset').click();`,
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        await mainWindow.webContents.executeJavaScript(
          `const preset=document.getElementById('field-preset');document.getElementById('field-identityPrompt').value='临时内容';preset.selectedIndex=1;preset.dispatchEvent(new Event('change'));document.getElementById('modal-form').requestSubmit();`,
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        const renameOnly = await mainWindow.webContents.executeJavaScript(
          `const name=[...document.querySelectorAll('.role-name')].find(button=>button.textContent==='自定义审查');name.click();const renameOnly=document.querySelectorAll('#fields input').length===1&&!document.getElementById('field-identityPrompt');document.getElementById('field-name').value='质量审查员';document.getElementById('modal-form').requestSubmit();renameOnly;`,
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        const page = await mainWindow.webContents.executeJavaScript(
          "({title:document.title,body:document.body.innerText,errors:window.lingflowErrors||[],boardColumns:[...document.querySelectorAll('#board .column h3')].map(h=>h.textContent),manualDispatch:!!document.querySelector('#approve,#dispatch')})",
        );
        page.checksPanel = await mainWindow.webContents.executeJavaScript(`
          document.getElementById('check-settings').click();
          const checkFields = document.getElementById('fields');
          const checks = { content: checkFields.innerText, editable: !document.querySelector('#modal-form [type=submit]').hidden || !!checkFields.querySelector('select,input') };
          document.getElementById('cancel').click();
          checks;
        `);
        page.emptyBody = emptyBody;
        page.screenshotErrors = screenshotErrors;
        page.projectFields = projectFields;
        page.emptyTeam = emptyTeam;
        page.savedControllerPolicy = savedControllerPolicy;
        page.controllerIdentityDefault = controllerIdentityDefault;
        page.savedControllerIdentity = savedControllerIdentity;
        page.renameOnly = renameOnly;
        const customRole = (await runtime.workflow.snapshot()).roles.find((r) => r.name === "质量审查员");
        page.savedPrompt = customRole?.identityPrompt;
        page.customRoleLabel = customRole?.customLabel;
        const request = await runtime.workflow.request({ roleId: customRole.id, sessionId: "desktop-reviewer", cwd: fixture });
        await runtime.workflow.call("ui", "confirmBinding", { requestId: request.id }, "smoke-confirm-reviewer");
        page.deliveryControls = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            async function waitFor(read) {
              for (let attempt = 0; attempt < 60; attempt++) {
                const result = read();
                if (result) return result;
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              throw Error('角色卡没有显示预期状态');
            }
            const roleCard = () => [...document.querySelectorAll('.role')].find((card) => card.querySelector('.role-name')?.textContent === '质量审查员');
            const button = (label) => [...roleCard().querySelectorAll('button')].find((item) => !item.disabled && item.textContent === label);
            const feedback = () => roleCard().querySelector('.role-feedback')?.textContent;
            (await waitFor(() => button('开启角色'))).click();
            const enablePending = feedback();
            const silentResume = await waitFor(() => feedback()?.includes('本轮无责任') && feedback());
            (await waitFor(() => button('暂停新投递'))).click();
            const pausePending = feedback();
            const paused = await waitFor(() => feedback()?.includes('已保留原任务') && feedback());
            (await waitFor(() => button('解绑会话'))).click();
            const unbindConfirmation = document.getElementById('modal').innerText;
            document.getElementById('cancel').click();
            const cancelKeptBinding = Boolean(button('解绑会话'));
            button('解绑会话').click();
            document.getElementById('modal-form').requestSubmit();
            await waitFor(() => !document.getElementById('modal').open && roleCard().textContent.includes('等待会话绑定'));
            const canEnableAfterUnbind = Boolean(button('开启角色'));
            return { enablePending, silentResume, pausePending, paused, unbindConfirmation, cancelKeptBinding, canEnableAfterUnbind };
          })()
        `);
        const newBinding = await runtime.workflow.request({ roleId: customRole.id, sessionId: "desktop-reviewer-new", cwd: fixture });
        await mainWindow.webContents.executeJavaScript(`
          (async () => {
            for (let attempt = 0; attempt < 80; attempt++) {
              const confirm = [...document.querySelectorAll('#requests .binding')].find(row => row.textContent.includes('desktop-reviewer-new'))?.querySelector('button');
              if (confirm) { confirm.click(); return; }
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw Error('新会话的绑定申请未显示');
          })()
        `);
        for (let attempt = 0; attempt < 40; attempt++) {
          const snapshot = await runtime.workflow.snapshot();
          const member = snapshot.roles.find(role => role.id === customRole.id);
          if (snapshot.requests.find(request => request.id === newBinding.id)?.confirmed) {
            page.reboundMember = member.sessionId === "desktop-reviewer-new" && !member.enabled;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await captureSmokePage(mainWindow, path.join(target, "desktop.png"), screenshotErrors);
        page.deleteConfirmation = await mainWindow.webContents.executeJavaScript(`
          document.getElementById('delete-project').click();
          const confirmation = document.getElementById('modal').innerText;
          document.getElementById('cancel').click();
          if (document.getElementById('workspace').hidden) throw Error('Cancel hid the project');
          document.getElementById('delete-project').click();
          document.getElementById('modal-form').requestSubmit();
          confirmation;
        `);
        await new Promise((resolve) => setTimeout(resolve, 800));
        page.deletedProject = await mainWindow.webContents.executeJavaScript(
          "!document.getElementById('empty').hidden && !document.querySelector('#projects button')",
        );
        page.projectDirectoryRetained = existsSync(fixture);
        if (lifecycle.tray) {
          const contentsId = mainWindow.webContents.id;
          mainWindow.close();
          page.trayHidden = !mainWindow.isDestroyed() && !mainWindow.isVisible() && !lifecycle.tray.isDestroyed();
          const health = await fetch("http://127.0.0.1:" + runtime.port + "/api/ui/hello");
          page.serviceWhileHidden = health.ok && (await health.json()).app === "lingflow";
          lifecycle.tray.emit("click");
          page.trayRestored = mainWindow.isVisible() && mainWindow.webContents.id === contentsId;
          mainWindow.minimize();
          page.trayMinimized = mainWindow.isMinimized();
          lifecycle.menu.getMenuItemById("open").click();
          page.trayMenuRestored = mainWindow.isVisible() && !mainWindow.isMinimized();
          mainWindow.close();
          page.trayServicePort = runtime.port;
        }
        if (process.env.LINGFLOW_DSH_TOOLS) {
          const toolsDir = path.join(target, "dsh-contract");
          mkdirSync(toolsDir, { recursive: true });
          const { verifyDshContract } = await import(
            pathToFileURL(path.join(__dirname, "../scripts/dsh-contract.mjs"))
          );
          // Contract caller uses configured port; smoke server uses an isolated port.
          const configPath = path.join(dataDir, "config.json");
          const config = JSON.parse(
            require("node:fs").readFileSync(configPath),
          );
          config.port = runtime.port;
          writeFileSync(configPath, JSON.stringify(config));
          page.dshContract = await verifyDshContract({
            toolsModule: process.env.LINGFLOW_DSH_TOOLS,
            dataDir,
            workflow: runtime.workflow,
            projectRoot: toolsDir,
          });
        }
        writeFileSync(
          path.join(target, "desktop.json"),
          JSON.stringify(page, null, 2),
        );
        if (lifecycle.menu) lifecycle.menu.getMenuItemById("quit").click();
        else app.quit();
      }
    })
    .catch((error) => {
      if (process.env.LINGFLOW_SMOKE_DIR) console.error(error);
      else dialog.showErrorBox("LingFlow 启动失败", error.message);
      app.exit(1);
    });
}
