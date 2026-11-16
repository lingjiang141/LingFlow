#!/usr/bin/env node
/**
 * Loads panel/client.js the way the DSH client bundle loader does — a
 * `window.__ModuleLoader__.load({id, factory})` call whose factory receives a
 * `require` — and asserts the module registers the sidebar icon and the main
 * panel. This is a static smoke test, not a render test: it cannot prove how the
 * panel looks inside DSH, only that the module evaluates and its slot contract
 * is what the host expects.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const CLIENT = path.resolve(
  fileURLToPath(new URL("../panel/client.js", import.meta.url)),
);
const SOURCE = readFileSync(CLIENT, "utf8");

/** A React stand-in: only what the module touches at load and apply time. */
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  useEffect() {},
  useMemo: (build) => build(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useCallback: (fn) => fn,
};

function load() {
  let exported = null;
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, "lingflow-panel");
        exported = factory((name) => {
          assert.equal(name, "react", "client must only require react");
          return react;
        });
      },
    },
  };
  new Function("window", "console", SOURCE)(window, {
    warn() {},
    error() {},
    log() {},
  });
  assert.ok(exported, "模块必须调用 window.__ModuleLoader__.load");
  return exported;
}

test("client bundle evaluates and exposes slots injection", () => {
  const exported = load();
  assert.deepEqual(exported.inject, ["slots"]);
  assert.equal(typeof exported.apply, "function");
});

test("apply registers the sidebar icon and the main panel", () => {
  const exported = load();
  const registered = [];
  const ctx = {
    get: () => null,
    slots: {
      inject(name, install) {
        install();
        return () => {};
      },
      register(config, component) {
        registered.push({ config, component });
        return () => {};
      },
    },
  };
  exported.apply(ctx);
  assert.equal(registered.length, 2, "应当只注册两个槽位");
  const icon = registered.find((item) => item.config.name === "sidebar.panellist");
  const main = registered.find((item) => item.config.name === "main");
  assert.ok(icon, "缺少 sidebar.panellist 注册");
  assert.ok(main, "缺少 main 注册");
  assert.equal(icon.config.id, "lingflow-panel");
  assert.equal(typeof icon.config.order, "number");
  assert.equal(typeof icon.config.label, "function");
  assert.equal(typeof icon.config.label(), "string");
  assert.equal(main.config.key, "lingflow-panel");
  assert.equal(typeof icon.component, "function");
  assert.equal(typeof main.component, "function");
});

test("client hardcodes no external origin and no blocking dialogs", () => {
  const exported = load();
  assert.ok(SOURCE.includes("'/lingflow-panel/api'"));
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(SOURCE), "不得直连外部地址");
  assert.ok(!/window\.confirm\s*\(/.test(SOURCE), "不得调用 window.confirm");
  assert.ok(!/window\.prompt\s*\(/.test(SOURCE), "不得调用 window.prompt");
  assert.equal(
    (SOURCE.match(/dangerouslySetInnerHTML/g) ?? []).length,
    0,
    "内嵌真实页面后不再需要注入样式",
  );
  assert.deepEqual(exported.inject, ["slots"]);
});

test("client embeds the real LingFlow page instead of redrawing it", () => {
  load();
  // One UI: the panel frames the same file the desktop window loads.
  assert.ok(
    /FRAME_PATH = API \+ '\/frame'/.test(SOURCE),
    "必须通过宿主的 /frame 路由拿到真实页面",
  );
  assert.ok(
    /new URL\(FRAME_PATH, globalThis\.location\.href\)/.test(SOURCE),
    "frame 地址必须按当前宿主 origin 解析",
  );
  // Desktop shell first (webview lease), plain frame as the fallback.
  assert.ok(/dshDesktop/.test(SOURCE) && /\.acquire\(/.test(SOURCE), "缺少桌面 webview 桥");
  assert.ok(/createElement\('webview'\)/.test(SOURCE), "缺少 webview 分支");
  assert.ok(/h\('iframe'/.test(SOURCE), "缺少 iframe 兜底");
  assert.ok(
    /api' \+ '\/status'|API \+ '\/status'/.test(SOURCE),
    "必须轮询宿主状态以发现服务重启",
  );
  // No second workflow client: the panel never calls the service's own routes.
  assert.ok(!/\/api\/ui\//.test(SOURCE), "面板不得直连服务内部接口");
  assert.ok(!/Bearer/.test(SOURCE), "渲染层不得持有令牌");
});

test("client keeps LingFlow's own chrome outside the framed page", () => {
  load();
  // The page stays exactly the window's UI; the extra controls live above it.
  for (const action of ["reload", "restart", "desktop", "diagnose"])
    assert.ok(SOURCE.includes("'" + action + "'"), "缺少工具栏动作：" + action);
  assert.ok(/API \+ '\/restart'/.test(SOURCE), "重启按钮必须走宿主路由");
  assert.ok(/API \+ '\/open'/.test(SOURCE), "独立窗口按钮必须走宿主路由");
  assert.ok(!/\/api\/ui\//.test(SOURCE), "工具栏也不得直连服务内部接口");
});

test("client starts with a plain frame and escalates on a watchdog", () => {
  load();
  // A blocked frame reports nothing at all, so a timer is the only signal that
  // the embed never painted; the desktop bridge is the second attempt.
  assert.ok(
    /readStored\(STORE_MODE\) === 'webview' \? 'webview' : 'iframe'/.test(SOURCE),
    "默认渲染方式必须是网页框架（桌面视图需显式选择）",
  );
  assert.ok(/FRAME_SETTLE_MS/.test(SOURCE), "缺少超时监视");
  assert.ok(/fallback-webview/.test(SOURCE), "超时后必须自动切到桌面视图");
  assert.ok(/STORE_MODE/.test(SOURCE) && /localStorage/.test(SOURCE), "渲染方式必须可记住");
});

test("client reports its own failures to the host log", () => {
  load();
  // Inside DSH there is no console the operator can read, so the panel posts
  // breadcrumbs to the host, which appends them to a file.
  assert.ok(/API \+ '\/log'/.test(SOURCE), "缺少渲染层日志上报");
  assert.ok(/createLogger/.test(SOURCE));
  assert.ok(/remember\(\s*'mount'/.test(SOURCE), "挂载时必须留下第一行日志");
  assert.ok(/frame-timeout|frame-failed/.test(SOURCE), "加载失败必须留痕");
});

test("main panel renders its chrome on the first pass", () => {
  // A component that throws while rendering leaves DSH with nothing to paint,
  // which looks exactly like the blank panel this test grew out of.
  const exported = load();
  let component = null;
  const ctx = {
    get: () => null,
    slots: {
      inject: (name, install) => install(),
      register: (config, candidate) => {
        if (config.name === "main") component = candidate;
        return () => {};
      },
    },
  };
  exported.apply(ctx);
  assert.equal(typeof component, "function");

  const tree = component({})
  assert.ok(tree, "面板必须返回一个元素");
  const text = JSON.stringify(tree)
  assert.ok(text.includes("lingflow-panel") || text.includes("LingFlow"), "面板内容里找不到自己");
  // The bar has to exist on the very first frame: it is the only visible signal
  // that the panel mounted when the framed page is still connecting.
  for (const key of ["reloadTitle", "restartTitle", "desktopTitle", "diagnoseTitle"])
    assert.ok(SOURCE.includes(key), "工具栏缺少按钮：" + key);
});

