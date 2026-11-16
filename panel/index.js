import { readFileSync } from "node:fs";
import { defaultDataDir } from "../src/config.mjs";
import { createPanelHost } from "../src/panel-host.mjs";

/**
 * LingFlow sidebar panel - host half.
 *
 * Deliberately thin: it only registers same-origin JSON routes and forwards them
 * to the single LingFlow service. All workflow state, delivery deduplication and
 * background checks stay in that service, so the sidebar can never start a
 * second workflow loop next to the standalone window.
 */

export const name = "lingflow-panel";
export const inject = [];

const VERSION = (() => {
  try {
    return (
      JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
        .version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
})();

const methodGuard = (method, handler) => (request, response) => {
  const actual = String(request.method || "GET").toUpperCase();
  if (actual !== method) {
    response.writeHead(405, {
      "Content-Type": "application/json; charset=utf-8",
      Allow: method,
    });
    response.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
    return;
  }
  return handler(request, response);
};

export function apply(ctx, config = {}) {
  const dataDir =
    config?.dataDir || process.env.LINGFLOW_DATA_DIR || defaultDataDir();
  const host = createPanelHost({
    dataDir,
    port: Number.isInteger(config?.port) && config.port > 0 ? config.port : null,
    version: VERSION,
  });

  ctx.inject(["webServer"], (child) => {
    for (const [label, method, routePath, handler] of host.routes) {
      child.effect(
        () =>
          child.webServer.register({
            kind: "exact",
            path: routePath,
            handler: methodGuard(method, handler),
          }),
        `lingflow-panel: ${label} route`,
      );
    }
    child.effect(() => {
      // Warm-up only probes: DSH itself must never spawn a LingFlow process that
      // the user did not ask for. The first panel request starts or attaches.
      const timer = setTimeout(() => {
        import("../src/instance.mjs")
          .then(async ({ probeInstance }) => {
            const { readConfig } = await import("../src/config.mjs");
            const shared = readConfig(dataDir);
            const probe = await probeInstance(
              Number.isInteger(config?.port) ? config.port : shared.port,
              { token: shared.uiToken, timeoutMs: 800 },
            );
            if (probe.running && !probe.authorized)
              ctx.logger?.warn?.(
                "LingFlow 服务在运行，但版本较旧（没有侧边栏令牌）。退出独立窗口后会改用共享服务。",
              );
          })
          .catch(() => {});
      }, 2000);
      timer.unref?.();
      return () => {
        clearTimeout(timer);
        host.dispose();
      };
    }, "lingflow-panel: warm probe");
  });
}
