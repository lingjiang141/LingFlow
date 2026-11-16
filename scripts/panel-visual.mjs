// 侧边栏一致性验证（runner）。
//
// 在隔离的 dataDir / 端口 0 上起一个真实服务，再起一个假的 DSH 宿主页把
// createPanelHost() 的路由原样挂上，然后由 Electron 里各截一张图：
//   A = 侧边栏真实链路：宿主页 -> <iframe src="/lingflow-panel/api/frame"> -> 302 -> 服务页
//   B = 独立窗口真实加载方式：直接 http://127.0.0.1:<servicePort>/#<uiToken>
// 判据是「像素容差 + 结构断言」两件都过才算 PASS（详见 panel-visual-main.cjs 顶部注释）：
//   像素：两张位图字节数相同，且差异像素占比 <= 0.001；
//   结构：标题 / html 属性 / 元素数量 / 关键元素 rect+computed style / --lf-* 变量完全相等。
// 产物：a-frame.png、b-direct.png、diff-heatmap.png、compare.png、visual.json，并镜像到 latest.json。
//
// 可选 --size 380x820：默认跑完 1120x760 后，再用同样的 A/B 流程在窄宽下跑第二趟，
// 产物加 -narrow 后缀（a-frame-narrow.png / compare-narrow.png / diff-heatmap-narrow.png …），
// 结果以 narrow 字段并入同一份 visual.json；不带 --size 时行为与原来完全一致。
// 不碰用户正在运行的服务、真实数据目录和任何应用文件。
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON_TIMEOUT_MS = 180_000;
const CAPTURE_SIZE = "1120x760";
// 截图前静置时长：页面有 setInterval 轮询（2.5s 一次）会重渲染，给足时间再截，降低无意义差异。
const SETTLE_MS = 4000;

const cliArgs = process.argv.slice(2);
// --keep：保留 Electron 的 userData 目录（默认 pass 后删掉，避免仓库里堆缓存）。
const keepElectronData = cliArgs.includes("--keep");
// --size WxH：额外跑一趟窄宽预览（默认不加跑，只跑 1120x760）。
const cliValue = (name) => {
  const index = cliArgs.indexOf(name);
  return index >= 0 && cliArgs[index + 1] ? cliArgs[index + 1].trim() : "";
};
const previewSize = cliValue("--size");
if (previewSize && !/^\d+x\d+$/.test(previewSize)) {
  console.error("[panel-visual] invalid --size " + JSON.stringify(previewSize) + ", expected WxH e.g. 380x820");
  process.exit(1);
}

// 假 DSH 宿主页：body 里只有侧边栏那个 iframe，铺满 viewport，无 margin/border/padding。
// 宿主画布与 iframe 元素都填成页面 canvas 色（--lf-bg #10141d）：
// frame 的滚动条槽（gutter）和未绘制区域透出的是宿主底色而不是 frame 内页面的 canvas 色，
// 透明宿主会让 frame 表面带 alpha 走一次额外混合，AA 边缘出现 ±1/255 的舍入差。
// 真实侧边栏（panel/client.js）给 iframe 的也是不透明底色，这里用页面 canvas 色让两侧真正可比。
const HOST_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>DSH sidebar panel harness</title>
    <style>html,body{margin:0;height:100%;overflow:hidden;background:#10141d}</style>
  </head>
  <body><iframe src="/lingflow-panel/api/frame" style="position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;background:#10141d"></iframe></body>
</html>`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

// POST /api/ui/call：Bearer uiToken，body {command, args, operationId}；成功时响应就是命令结果的 JSON。
function callUi(port, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/ui/call",
        method: "POST",
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: "Bearer " + token,
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = null;
          }
          const status = response.statusCode ?? 0;
          if (status >= 400 || (json && json.ok === false)) {
            reject(new Error("ui/call " + body.command + " -> " + status + ": " + (json ? json.error : raw.slice(0, 300))));
            return;
          }
          if (json === null) {
            reject(new Error("ui/call " + body.command + " returned non-JSON: " + raw.slice(0, 300)));
            return;
          }
          resolve(json);
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("ui/call " + body.command + " timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

// 假的 DSH 宿主：/host.html 是外壳页，其余请求按 method+path 交给 createPanelHost() 的真实 handler。
function startFakeHost(routes) {
  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("bad request");
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/host.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(HOST_PAGE);
        return;
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      for (const [, method, route, handler] of routes) {
        if (request.method !== method || url.pathname !== route) continue;
        await handler(request, response);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found: " + url.pathname);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("fake host error: " + errorText(error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        server,
        port,
        origin: "http://127.0.0.1:" + port,
        close: () =>
          new Promise((done) => {
            try {
              server.closeAllConnections();
            } catch {
              // 老版本 Node 没有 closeAllConnections
            }
            server.close(() => done());
          }),
      });
    });
  });
}

// 预检侧边栏链路：不跟随重定向，确认 frame 路由真的给了 302（wrap 捕获异常时会变成 200 JSON）。
function probeFrame(port) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/lingflow-panel/api/frame", method: "GET", timeout: 20000 },
      (response) => {
        response.resume();
        resolve({
          status: response.statusCode ?? 0,
          locationHasToken: String(response.headers.location || "").includes("#"),
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: 0, error: "timeout" });
    });
    request.on("error", (error) => resolve({ status: 0, error: errorText(error) }));
    request.end();
  });
}

const startedAt = Date.now();
const runRoot = path.join(repoRoot, ".validation", "panel-visual");
let runDir = path.join(runRoot, timestamp());
for (let index = 2; existsSync(runDir); index += 1) runDir = path.join(runRoot, timestamp() + "-" + index);
const dataDir = path.join(runDir, "data");
mkdirSync(dataDir, { recursive: true });
const latestPath = path.join(runRoot, "latest.json");
const electronDataDir = path.join(runDir, "electron");

let service = null;
let host = null;
let child = null;
let exitCode = 1;

try {
  const { createPanelHost } = await import(new URL("../src/panel-host.mjs", import.meta.url));
  const { startServer } = await import(new URL("../src/server.mjs", import.meta.url));

  // 1) 隔离的真实服务：dataDir 在本次 run 目录里，端口 0 随机分配。
  service = await startServer({ dataDir, port: 0 });
  const serviceUrl = "http://127.0.0.1:" + service.port;
  console.log("[panel-visual] run dir      : " + runDir);
  console.log("[panel-visual] service      : " + serviceUrl + "  (port 0, isolated dataDir)");

  // 2) 可选播种：一个项目 + 两个角色，让截图里有真实内容；失败只记录，不影响比对。
  let seed = { ok: false };
  try {
    const projectDir = path.join(runDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const project = await callUi(service.port, service.uiToken, {
      command: "createProject",
      args: { name: "Panel visual check", root: projectDir },
      operationId: "panel-visual-project",
    });
    await callUi(service.port, service.uiToken, {
      command: "addRole",
      args: { projectId: project.id, kind: "controller", name: "Lead" },
      operationId: "panel-visual-role-controller",
    });
    await callUi(service.port, service.uiToken, {
      command: "addRole",
      args: { projectId: project.id, kind: "developer", name: "Dev" },
      operationId: "panel-visual-role-developer",
    });
    seed = { ok: true, projectId: project.id, roles: ["controller", "developer"] };
    console.log("[panel-visual] seed         : project " + project.id + " + 2 roles");
  } catch (error) {
    seed = { ok: false, error: errorText(error) };
    console.log("[panel-visual] seed         : skipped (" + seed.error + ")");
  }

  // 3) 假 DSH 宿主：真实 panel 路由 + 一个只有 iframe 的外壳页。
  const panel = createPanelHost({ dataDir, port: service.port });
  host = await startFakeHost(panel.routes);
  const hostUrl = host.origin + "/host.html";
  const targetB = serviceUrl + "/#" + service.uiToken;
  console.log("[panel-visual] fake host    : " + host.origin + "  (" + panel.routes.length + " panel routes mounted)");

  const frameProbe = await probeFrame(host.port);
  if (frameProbe.status !== 302) {
    console.log("[panel-visual] frame probe  : WARNING expected 302, got " + frameProbe.status + " " + JSON.stringify(frameProbe));
  } else {
    console.log("[panel-visual] frame probe  : 302 with token in Location");
  }

  const electronExe = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  if (!existsSync(electronExe)) throw new Error("Electron binary not found: " + electronExe);

  // 单趟 A/B：起一个 Electron 进程（同一窗口先 A 后 B），退出后读回 visual<suffix>.json。
  const runElectronPass = async (passSize, passSuffix) => {
    const passStartedAt = Date.now();
    const env = {
      ...process.env,
      LINGFLOW_VISUAL_DIR: runDir,
      LINGFLOW_VISUAL_A: hostUrl,
      LINGFLOW_VISUAL_B: targetB,
      LINGFLOW_VISUAL_SIZE: passSize,
      LINGFLOW_VISUAL_SETTLE_MS: String(SETTLE_MS),
      LINGFLOW_VISUAL_SUFFIX: passSuffix,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    child = spawn(electronExe, ["--disable-gpu", path.join(repoRoot, "scripts", "panel-visual-main.cjs")], {
      cwd: repoRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 已经退出
      }
    }, ELECTRON_TIMEOUT_MS);

    const exit = await new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", (error) => settle({ error: errorText(error) }));
      child.once("exit", (code, signal) => settle({ code, signal }));
    });
    clearTimeout(timer);

    if (timedOut) {
      console.log("[panel-visual] TIMEOUT     : electron did not finish within " + ELECTRON_TIMEOUT_MS / 1000 + "s; killed.");
    }
    if (exit.error) console.log("[panel-visual] spawn error : " + exit.error);
    console.log(
      "[panel-visual] electron    : size=" + passSize + " suffix=" + (passSuffix || "(none)") + " exit=" + (exit.code ?? "null") + " signal=" + (exit.signal ?? "null"),
    );

    const resultPath = path.join(runDir, "visual" + passSuffix + ".json");
    let result = null;
    if (existsSync(resultPath)) {
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (error) {
        console.error("[panel-visual] visual" + passSuffix + ".json is not valid JSON: " + errorText(error));
      }
    } else {
      console.error("[panel-visual] missing " + resultPath);
    }
    return {
      size: passSize,
      suffix: passSuffix,
      exit,
      stdout,
      stderr,
      timedOut,
      result,
      resultPath,
      durationMs: Date.now() - passStartedAt,
    };
  };

  // 4) 主趟：1120x760（默认行为不变）。
  const mainPass = await runElectronPass(CAPTURE_SIZE, "");
  const result = mainPass.result;
  const pass = !mainPass.timedOut && Boolean(result && result.pass === true);

  // 5) 可选窄宽预览：同样的 A/B 流程 + 同样的判据，产物加 -narrow 后缀。
  let narrow = null;
  if (previewSize && previewSize !== CAPTURE_SIZE) {
    console.log("[panel-visual] narrow      : second A/B pass at " + previewSize);
    const narrowPass = await runElectronPass(previewSize, "-narrow");
    const narrowResult = narrowPass.result;
    const narrowStructure = narrowResult && narrowResult.structure ? narrowResult.structure : null;
    const narrowTolerance = narrowResult && narrowResult.tolerance ? narrowResult.tolerance : null;
    narrow = {
      size: previewSize,
      identical: narrowResult ? Boolean(narrowResult.identical) : false,
      differingPixels: narrowTolerance ? narrowTolerance.differingPixels : -1,
      totalPixels: narrowTolerance ? narrowTolerance.totalPixels : 0,
      ratio: narrowTolerance ? narrowTolerance.ratio : null,
      passed: Boolean(!narrowPass.timedOut && narrowResult && narrowResult.pass === true),
      structure: narrowStructure
        ? {
            ok: Boolean(narrowStructure.ok),
            checks: Array.isArray(narrowStructure.checks) ? narrowStructure.checks.length : 0,
            mismatches: Array.isArray(narrowStructure.mismatches) ? narrowStructure.mismatches : [],
          }
        : null,
      metrics: narrowResult ? narrowResult.metrics || null : null,
      shots: narrowResult ? narrowResult.shots : null,
      compare: narrowResult ? narrowResult.compare : "",
      diffHeatmap: narrowResult ? narrowResult.diffHeatmap : "",
      visualJson: narrowPass.resultPath,
      durationMs: narrowPass.durationMs,
      stdout: narrowPass.stdout.trim().slice(-4000),
      stderr: narrowPass.stderr.trim().slice(-4000),
    };
    if (result) {
      // 窄宽结果并入同一份 visual.json
      result.narrow = narrow;
      writeFileSync(path.join(runDir, "visual.json"), JSON.stringify(result, null, 2) + "\n");
    }
    if (narrow.metrics) {
      console.log(
        "[panel-visual] narrow layout: scrollWidth=" +
          narrow.metrics.scrollWidth +
          " clientWidth=" +
          narrow.metrics.clientWidth +
          " asideWidth=" +
          narrow.metrics.asideWidth +
          " mainWidth=" +
          narrow.metrics.mainWidth +
          (narrow.metrics.scrollWidth > narrow.metrics.clientWidth ? "  (horizontal scroll)" : "  (no horizontal scroll)"),
      );
    }
    console.log(
      "RESULT-NARROW pass=" +
        narrow.passed +
        " size=" +
        previewSize +
        " diffPx=" +
        narrow.differingPixels +
        "/" +
        narrow.totalPixels +
        " ratio=" +
        (narrow.ratio === null ? "n/a" : Number(narrow.ratio).toFixed(6)) +
        " struct=" +
        (narrow.structure ? narrow.structure.ok === true : false),
    );
  }

  const passOverall = pass && (!narrow || narrow.passed);
  const durationMs = Date.now() - startedAt;
  const tolerance = result && result.tolerance ? result.tolerance : null;
  const structure = result && result.structure ? result.structure : null;

  if (result) {
    if (result.error) console.log("[panel-visual] error       : " + result.error);
    if (result.size) console.log("[panel-visual] size        : " + result.size.width + "x" + result.size.height);
    console.log(
      "[panel-visual] bytes       : A=" +
        result.aBytes +
        " B=" +
        result.bBytes +
        " differing=" +
        result.differingBytes +
        " pixels=" +
        result.differingPixels +
        (result.firstDiffPixel ? " firstDiffPixel=" + result.firstDiffPixel.x + "," + result.firstDiffPixel.y : ""),
    );
    if (tolerance) {
      console.log(
        "[panel-visual] tolerance   : " +
          (tolerance.passed ? "PASS" : "FAIL") +
          " ratio=" +
          Number(tolerance.ratio).toFixed(6) +
          " <= " +
          tolerance.maxRatio +
          " (sameLength=" +
          tolerance.sameLength +
          ")",
      );
    }
    if (structure) {
      const checks = Array.isArray(structure.checks) ? structure.checks : [];
      const passedChecks = checks.filter((check) => check.ok).length;
      console.log("[panel-visual] structure   : " + (structure.ok ? "PASS" : "FAIL") + " (" + passedChecks + "/" + checks.length + " checks)");
      console.log("               checks: " + checks.map((check) => check.name).join(", "));
      for (const mismatch of (structure.mismatches || []).slice(0, 8)) {
        console.log("               MISMATCH " + mismatch.path + "  A=" + mismatch.a + "  B=" + mismatch.b);
      }
      if (structure.frame) console.log("               frames: A=" + structure.frame.a + "  B=" + structure.frame.b);
    }
    if (result.shots) console.log("[panel-visual] shots       : A=" + result.shots.a + "  B=" + result.shots.b);
    if (result.compare) console.log("[panel-visual] compare     : " + result.compare);
    if (result.diffHeatmap) console.log("[panel-visual] heatmap     : " + result.diffHeatmap);
    if (result.note) console.log("[panel-visual] note        : " + result.note);
  }
  console.log("[panel-visual] duration    : " + (durationMs / 1000).toFixed(1) + "s");
  console.log("[panel-visual] VERDICT     : " + (passOverall ? "PASS - same UI (tolerance + structure)" : "FAIL - see numbers above"));
  // 供人/脚本核对的一行摘要。
  console.log(
    "RESULT pass=" +
      pass +
      " diffPx=" +
      (tolerance ? tolerance.differingPixels : -1) +
      "/" +
      (tolerance ? tolerance.totalPixels : 0) +
      " ratio=" +
      (tolerance ? Number(tolerance.ratio).toFixed(6) : "n/a") +
      " struct=" +
      (structure ? structure.ok === true : false) +
      " aBytes=" +
      (result ? result.aBytes : 0) +
      " bBytes=" +
      (result ? result.bBytes : 0),
  );

  const summary = {
    ...(result || { ok: false, pass: false, identical: false, error: "visual.json was not produced" }),
    run: {
      dir: runDir,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      serviceUrl,
      hostUrl,
      targetBOrigin: serviceUrl,
      size: CAPTURE_SIZE,
      previewSize: previewSize || null,
      settleMs: SETTLE_MS,
      seed,
      frameProbe,
      electronExit: mainPass.exit.code ?? null,
      electronSignal: mainPass.exit.signal ?? null,
      timedOut: mainPass.timedOut,
      mainPass: {
        size: mainPass.size,
        durationMs: mainPass.durationMs,
        stdout: mainPass.stdout.trim().slice(-4000),
        stderr: mainPass.stderr.trim().slice(-4000),
      },
      narrowPass: narrow
        ? {
            size: narrow.size,
            durationMs: narrow.durationMs,
            stdout: narrow.stdout,
            stderr: narrow.stderr,
          }
        : null,
      keepElectronData,
      stdout: mainPass.stdout.trim().slice(-4000),
      stderr: mainPass.stderr.trim().slice(-4000),
    },
  };
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(latestPath, JSON.stringify(summary, null, 2) + "\n");
  console.log("[panel-visual] visual.json : " + path.join(runDir, "visual.json"));
  console.log("[panel-visual] latest.json : " + latestPath);

  // 6) Electron 的 userData 只是这次运行的缓存：通过后删掉，别让仓库里堆东西（--keep 可保留）。
  if (!keepElectronData && passOverall && existsSync(electronDataDir)) {
    try {
      rmSync(electronDataDir, { recursive: true, force: true });
      console.log("[panel-visual] cleanup     : removed " + electronDataDir);
    } catch (error) {
      console.log("[panel-visual] cleanup     : could not remove " + electronDataDir + " (" + errorText(error) + ")");
    }
  } else if (!keepElectronData && existsSync(electronDataDir)) {
    console.log("[panel-visual] cleanup     : kept " + electronDataDir + " (run did not pass; useful for diagnosis)");
  }

  exitCode = passOverall ? 0 : 1;
} catch (error) {
  console.error("[panel-visual] FAILED: " + (error && error.stack ? error.stack : errorText(error)));
  try {
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(
      latestPath,
      JSON.stringify(
        {
          ok: false,
          pass: false,
          identical: false,
          error: errorText(error),
          run: { dir: runDir, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt },
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    // 镜像失败就算了，真实错误已经打印
  }
  exitCode = 1;
} finally {
  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill();
    } catch {
      // 已经退出
    }
    await wait(200);
  }
  if (service) {
    try {
      await service.close();
    } catch (error) {
      console.error("[panel-visual] service close failed: " + errorText(error));
    }
  }
  if (host) {
    try {
      await host.close();
    } catch (error) {
      console.error("[panel-visual] fake host close failed: " + errorText(error));
    }
  }
}

process.exitCode = exitCode;