import { createHttpService } from "./http-service.mjs";
import { parseCommandRequest } from "./command-arguments.mjs";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startWorkflowRuntime } from "./workflow-runtime.mjs";
import { defaultDataDir, readConfig } from "./config.mjs";
import { createAppearanceLibrary, defaultAssetRoot } from "./appearance.mjs";

export { defaultDataDir };

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

/**
 * Only flat files directly under ui/ may be served, and only with a renderable
 * extension. The name check (basename, no separators, no dotfiles) is what makes
 * `/../package.json` and `%2e%2e%2f` variants dead ends instead of file reads.
 */
function staticFile(route) {
  const file = route === "/" ? "index.html" : route.slice(1);
  if (!file || file !== path.basename(file) || file.startsWith(".")) return null;
  if (/[/\\]/.test(file)) return null;
  const type = STATIC_TYPES[path.extname(file).toLowerCase()];
  return type ? { file, type } : null;
}

const VERSION = (() => {
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
        .version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
})();

export async function startServer({
  dataDir = defaultDataDir(),
  port,
  uiToken,
  pickProjectDirectory,
  assetRoot = defaultAssetRoot,
} = {}) {
  // The shared config owns both tokens, so every entrance (desktop window,
  // sidebar host, DSH adapter) can attach to whichever process bound the port.
  const config = readConfig(dataDir);
  uiToken = uiToken ?? config.uiToken;
  const startedAt = Date.now();
  let runtime, closing;
  const staticRoot = fileURLToPath(new URL("../ui/", import.meta.url));
  // Imported appearance images are copied into the project folder, so this
  // library owns the bytes and the index; nothing points back to the source file.
  const appearance = createAppearanceLibrary(assetRoot);
  const authorize = (request, token) => {
    const provided =
      request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (
      typeof token !== "string" ||
      provided.length !== token.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
    )
      throw Error("未授权");
  };
  const authorized = (request, token) => {
    try {
      authorize(request, token);
      return true;
    } catch {
      return false;
    }
  };
  // The desktop window is not the only entrance: the DSH sidebar embeds this
  // exact page in a frame. Inside the DSH desktop app that parent document is
  // served from the privileged `dsh-app://app/` scheme, not from http, so the
  // scheme itself has to be named here — otherwise Chromium drops the frame
  // and all the sidebar shows is an empty white box. Loopback http parents stay
  // allowed too (browser entrance), and a remote page is still never allowed.
  // Override with LINGFLOW_FRAME_ANCESTORS when an unusual host is in use.
  // Keep to the CSP host-source grammar: IPv6 literals such as http://[::1]:*
  // are not valid there and make the browser drop the whole entry with a warning.
  const frameAncestors =
    process.env.LINGFLOW_FRAME_ANCESTORS ||
    "'self' http://127.0.0.1:* http://localhost:* dsh-app:";
  const { server, close: closeHttp } = createHttpService(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-LingFlow-Instance", "lingflow");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors ${frameAncestors}`,
    );
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        throw Error("来源不匹配");
      const route = new URL(req.url, origin).pathname;
      if (!runtime) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "LingFlow 正在启动" }));
        return;
      }
      const { workflow } = runtime;
      // Identity probe: lets other entrances decide "attach or start" without
      // spoofing anything. The token is only reported as a boolean.
      if (req.method === "GET" && route === "/api/ui/hello") {
        const boundPort = server.address().port;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            app: "lingflow",
            port: boundPort,
            version: VERSION,
            startedAt,
            authorized: authorized(req, uiToken),
          }),
        );
        return;
      }
      if (req.method === "GET" && route.startsWith("/assets/")) {
        const fileName = route.slice("/assets/".length);
        const file = appearance.fileFor(fileName);
        let bytes;
        try {
          if (!file) throw Error("图片不存在");
          bytes = readFileSync(file);
        } catch {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader("Content-Type", appearance.mimeFor(fileName));
        // Content-addressed file names never change, so this overrides the
        // no-store default set for every response above.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end(bytes);
        return;
      }
      const staticAsset = req.method === "GET" ? staticFile(route) : null;
      if (staticAsset) {
        let bytes;
        try {
          bytes = readFileSync(path.join(staticRoot, staticAsset.file));
        } catch {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader("Content-Type", staticAsset.type);
        res.end(bytes);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      const isUi = route.startsWith("/api/ui/"),
        isBridge = route.startsWith("/api/bridge/");
      if (!isUi && !isBridge) throw Error("未知接口");
      authorize(req, isUi ? uiToken : config.bridgeToken);
      // Only the appearance route carries image bytes; everything else keeps the
      // old 256 KiB ceiling. 24 MiB leaves room for 16 MiB of base64 (~4/3).
      const limit = route === "/api/ui/appearance" ? 24 * 1024 * 1024 : 256 * 1024;
      const chunks = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > limit) throw Error("请求过大");
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw || "{}");
      let argumentWarnings = [];
      if (route === "/api/ui/call" || route === "/api/bridge/call") {
        const { sessionId, ...envelope } = body;
        const parsed = parseCommandRequest(envelope);
        if (parsed.error) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(parsed));
          return;
        }
        body.args = parsed.args;
        argumentWarnings = parsed.warnings;
      }
      let result;
      if (route === "/api/ui/snapshot") result = workflow.snapshot();
      else if (route === "/api/ui/call")
        result = workflow.call("ui", body.command, body.args, body.operationId);
      else if (route === "/api/ui/appearance") {
        const actions = {
          list: () => appearance.list(),
          import: () => appearance.importImage({ name: body.name, data: body.data }),
          remove: () => appearance.remove(body.id),
        };
        if (typeof body?.action !== "string" || !Object.hasOwn(actions, body.action))
          throw Error("未知动作");
        result = actions[body.action]();
      } else if (route === "/api/ui/pick-project-directory" && pickProjectDirectory)
        result = { directory: await pickProjectDirectory() };
      else if (route === "/api/bridge/catalog") result = workflow.catalog();
      else if (route === "/api/bridge/bindings") result = workflow.bridgeBindings();
      else if (route === "/api/bridge/request") result = workflow.request(body);
      else if (route === "/api/bridge/heartbeat")
        result = workflow.heartbeat(body.sessions);
      else if (route === "/api/bridge/valid")
        result = workflow.validWake(body.wakeId, body.sessionId, body.generation);
      else if (route === "/api/bridge/ack")
        result = workflow.acknowledge(body.wakeId, body.sessionId, "dsh", body.delivery);
      else if (route === "/api/bridge/policy") {
        if (typeof body.sessionId !== "string" || body.sessionId === "ui") throw Error("无效会话身份");
        result = workflow.commandPolicy(body.sessionId, body.command);
      }
      else if (route === "/api/bridge/call") {
        if (body.sessionId === "ui") throw Error("无效会话身份");
        const source = req.headers["x-lingflow-client"] === "dsh-adapter" ? "dsh-adapter" : "bridge-direct";
        result = workflow.call(
          body.sessionId,
          body.command,
          body.args,
          body.operationId,
          "dsh",
          source,
        ).then((value) => value && !Array.isArray(value) && (body.operationId || value.error === "timeout") ?
          { ...value, source: value.source ?? source } : value);
      } else throw Error("未知接口");
      result = await result;
      if (argumentWarnings.length && result && typeof result === "object" && !Array.isArray(result))
        result = { ...result, warnings: [...(result.warnings ?? []), ...argumentWarnings] };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.message === "未授权" ? 401 : 400, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ error: error.message, code: error.verificationCode, violations: error.violations, nextAction: error.nextAction,
        unownedWrites: error.unownedWrites, blockers: error.blockers, rejected: error.rejected }));
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port ?? config.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    throw error;
  }
  // Bind the exclusive port before touching runtime state. A second launch must
  // never disable roles belonging to the already-running instance.
  try {
    runtime = await startWorkflowRuntime(dataDir, config.execution);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    server,
    workflow: runtime.workflow,
    port: server.address().port,
    uiToken,
    close: () => (closing ??= closeHttp()
      .then(() => runtime.close())),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const requestedPort = Number(flag("--port"));
  const app = await startServer({
    dataDir: flag("--data-dir") || defaultDataDir(),
    port: Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : undefined,
  });
  console.log(
    "LingFlow 本地服务已启动，端口 " +
      app.port +
      "；独立窗口和 DSH 侧边栏共用这一个服务。",
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, async () => {
      await app.close();
      process.exit(0);
    });
}
