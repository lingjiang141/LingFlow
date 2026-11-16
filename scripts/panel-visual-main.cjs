// 侧边栏一致性验证的 Electron 主进程（由 scripts/panel-visual.mjs spawn）。
//
// 同一个窗口（同尺寸 / zoom=1 / 同一 devicePixelRatio）先后加载两个目标：
//   A：假 DSH 宿主页，body 里只有 <iframe src="/lingflow-panel/api/frame">，即侧边栏真实链路；
//   B：http://127.0.0.1:<servicePort>/#<uiToken>，即独立窗口真实加载方式。
// 每一侧：等加载完成 -> insertCSS 关动效 -> 等 document.fonts.ready -> 等 SETTLE_MS ->
// 连续截图直到两张逐字节一致 -> 存 PNG -> 再对页面本身做一遍 DOM/排版/CSSOM 采样。
//
// 判据是「像素容差 + 结构断言」两件都过才算 PASS：
//   像素：两张位图字节数相同，且 differingPixels / (width*height) <= 0.001；
//   结构：标题、html 属性、元素数量、关键元素 rect+computed style、--lf-* 变量完全相等。
// 产物：a-frame.png / b-direct.png / diff-heatmap.png / compare.png / visual.json。
// 它自己不起服务、不读应用数据、不改任何应用文件。
const { app, BrowserWindow, nativeImage } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const target = process.env.LINGFLOW_VISUAL_DIR || "";
const urlA = process.env.LINGFLOW_VISUAL_A || "";
const urlB = process.env.LINGFLOW_VISUAL_B || "";
const sizeText = (process.env.LINGFLOW_VISUAL_SIZE || "1120x760").trim();
const settleMs = Number(process.env.LINGFLOW_VISUAL_SETTLE_MS || 4000);
// 像素容差：差异像素占比上限（千分之一）。嵌入 frame 的合成会让极少数 AA 边缘出现 ±1/255 的舍入差，
// 这不是布局或内容差异，所以判据用比例而不是"必须 0 字节不同"。
const TOLERANCE_RATIO = 0.001;
// 可选：除了 insertCSS，再把禁动效 CSS 塞进每个内容文档（constructable stylesheet）。
// 默认关闭：页面自带 CSP style-src 'self' 会丢掉 <style>，而文档级覆盖本身会改变 AA 舍入。
const frameStill = process.env.LINGFLOW_VISUAL_FRAME_STILL === "1";
// 可选：强制设备像素比（默认跟随系统 DPI，150% 缩放 => 1.5）。
const forcedScale = Number(process.env.LINGFLOW_VISUAL_SCALE || 0);
// 可选：产物文件名后缀（窄宽预览用 "-narrow"），同时决定 visual<suffix>.json。
// 默认空串 = 原行为（a-frame.png / b-direct.png / visual.json）。
const suffix = process.env.LINGFLOW_VISUAL_SUFFIX || "";
const MAX_CAPTURES = 6;
const CAPTURE_GAP_MS = 500;
const EMPTY_RETRY = 5;
const EMPTY_RETRY_GAP_MS = 150;
const FRAME_WAIT_MS = 15000;

// 两侧同一条规则：动效/过渡全部关掉，光标不参与像素，避免两次独立截图因动画相位不同而不同。
const STILL_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" +
  // 鼠标落在窗口上时 :hover 会让某个按钮变成「悬停态」，两侧光标位置不同就会出现一条
  // 整块高亮差异（实测 28909 像素）。pointer-events:none 只影响命中测试，不改绘制结果。
  "*{pointer-events:none!important}";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sizeMatch = /^(\d+)x(\d+)$/.exec(sizeText);
const width = sizeMatch ? Number(sizeMatch[1]) : 0;
const height = sizeMatch ? Number(sizeMatch[2]) : 0;
const configured = Boolean(target && urlA && urlB && width > 0 && height > 0);

function redact(value) {
  return String(value || "").replace(/#.*$/, "");
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function short(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 220 ? text.slice(0, 217) + "..." : text;
}

// PNG 的 IHDR 尺寸，用来交叉核对截图到底是不是 WxH（可发现 1px 级系统性偏差）。
function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

let finished = false;
let win = null;
let wc = null;
const consoleMessages = [];
const shots = { a: "", b: "" };
const extraFiles = { compare: "", diffHeatmap: "" };

function writeResult(payload) {
  mkdirSync(target, { recursive: true });
  const file = path.join(target, "visual" + suffix + ".json");
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
  return file;
}

function baseResult(extra) {
  return {
    ok: false,
    pass: false,
    identical: false,
    size: { width, height },
    aBytes: 0,
    bBytes: 0,
    differingBytes: -1,
    differingPixels: -1,
    firstDiffIndex: -1,
    firstDiffPixel: null,
    tolerance: null,
    structure: null,
    shots: { a: shots.a, b: shots.b },
    compare: extraFiles.compare,
    diffHeatmap: extraFiles.diffHeatmap,
    settleMs,
    note: "",
    ...extra,
  };
}

function fail(error) {
  if (finished) return;
  finished = true;
  console.error(error && error.stack ? error.stack : errorText(error));
  try {
    writeResult(
      baseResult({
        error: errorText(error),
        note: "Electron main process failed before the comparison completed; shots that were already captured are kept on disk.",
      }),
    );
  } catch {
    // 写不进去就只能靠 stderr 了
  }
  app.exit(1);
}

function finish(code) {
  if (finished) return;
  finished = true;
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
  app.exit(code);
}

function frames() {
  const list = [];
  const visit = (frame) => {
    if (!frame) return;
    list.push(frame);
    let children = [];
    try {
      children = frame.frames ? Array.from(frame.frames) : [];
    } catch {
      children = [];
    }
    for (const child of children) visit(child);
  };
  try {
    visit(wc.mainFrame);
  } catch {
    // 主 frame 还没准备好
  }
  return list;
}

async function frameStates() {
  const states = [];
  for (const frame of frames()) {
    let url = "";
    try {
      url = frame.url;
    } catch {
      url = "";
    }
    const state = { url: redact(url), ready: "unknown", title: "", error: null };
    try {
      const value = await frame.executeJavaScript("({ ready: document.readyState, title: document.title })", false);
      state.ready = value && value.ready ? value.ready : "unknown";
      state.title = value && value.title ? String(value.title) : "";
    } catch (error) {
      state.error = errorText(error);
    }
    states.push(state);
  }
  return states;
}

async function loadTarget(url) {
  const settled = new Promise((resolve, reject) => {
    const cleanup = () => {
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onFail = (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
      if (isMainFrame === false) return;
      cleanup();
      reject(new Error("did-fail-load " + errorCode + " " + errorDescription + " on " + redact(failedUrl)));
    };
    wc.once("did-finish-load", onFinish);
    wc.on("did-fail-load", onFail);
  });
  const stopped = new Promise((resolve) => {
    const done = () => {
      wc.removeListener("did-stop-loading", done);
      resolve();
    };
    wc.once("did-stop-loading", done);
  });
  await wc.loadURL(url);
  await Promise.race([stopped, settled.then(() => wait(1000))]);
  await settled;
}

// 等服务页在某个 frame 里真正加载完（A 是 iframe，B 是主 frame；两者都是服务 origin）。
async function waitForServiceFrame(serviceOrigin) {
  const deadline = Date.now() + FRAME_WAIT_MS;
  for (;;) {
    const states = await frameStates();
    const loaded = states.some((state) => !state.error && state.ready === "complete" && state.url.startsWith(serviceOrigin));
    if (loaded) return { loaded: true, states };
    if (Date.now() > deadline) return { loaded: false, states };
    await wait(150);
  }
}

async function injectStill() {
  try {
    await wc.insertCSS(STILL_CSS);
  } catch {
    // 注入失败不致命：截图稳定判定还会兜住
  }
  if (!frameStill) return;
  // 可选路径（仅诊断用）：页面自带 CSP style-src 'self'，往服务页里插 <style> 会被拦；
  // 用 constructable stylesheet 走 CSSOM（不受 style-src 限制），A/B 两侧内容文档都能生效。
  // 注意它会改变少数 AA 边缘的舍入（实测 ~85 个 ±1/255 像素），所以默认不开。
  const code =
    "(function(){var css=" +
    JSON.stringify(STILL_CSS) +
    ";" +
    "if(typeof CSSStyleSheet==='function'){try{var sheet=new CSSStyleSheet();sheet.replaceSync(css);" +
    "var list=Array.prototype.slice.call(document.adoptedStyleSheets||[]).filter(function(s){return s!==sheet;});" +
    "list.push(sheet);document.adoptedStyleSheets=list;return 'adopted';}catch(e){}}" +
    "try{var id='__panel_visual_still__';if(document.getElementById(id))return 'present';" +
    "var style=document.createElement('style');style.id=id;style.textContent=css;" +
    "(document.head||document.documentElement).appendChild(style);return 'inline-style';}catch(e){return 'failed';}})()";
  for (const frame of frames()) {
    try {
      await frame.executeJavaScript(code, false);
    } catch {
      // frame 正在导航，忽略
    }
  }
}

async function waitForFonts() {
  for (const frame of frames()) {
    try {
      await frame.executeJavaScript("document.fonts ? document.fonts.ready.then(function(){return document.fonts.status;}) : 'none'", false);
    } catch {
      // frame 正在导航，忽略
    }
  }
}

// 双 rAF：确保截图前真的有一次新帧提交（隐藏/刚 reload 的窗口尤其需要）。
async function nextFrame() {
  try {
    await wc.executeJavaScript(
      "new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(function(){resolve(true);});});})",
      false,
    );
  } catch {
    // 文档正在导航
  }
}

// capturePage() 偶尔返回空 NativeImage：重试几次，仍空则返回 null（由调用方决定怎么办）。
async function captureOnce() {
  for (let attempt = 0; attempt < EMPTY_RETRY; attempt += 1) {
    await nextFrame();
    let image = null;
    try {
      image = await wc.capturePage();
    } catch (error) {
      consoleMessages.push("capturePage failed: " + errorText(error));
    }
    if (image && !image.isEmpty()) return image;
    if (attempt === 0) {
      // 空图通常是窗口被判定为 hidden/occluded：重新显示并抬高层级再试。
      try {
        win.setAlwaysOnTop(true, "screen-saver");
        win.showInactive();
        win.moveTop();
      } catch {
        // 窗口正在销毁
      }
    }
    if (attempt < EMPTY_RETRY - 1) await wait(EMPTY_RETRY_GAP_MS);
  }
  return null;
}

// 连续截图，直到两张逐字节一致（最多 MAX_CAPTURES 次，间隔 CAPTURE_GAP_MS）。
async function captureStable() {
  let previous = null;
  let last = null;
  let attempts = 0;
  for (let index = 0; index < MAX_CAPTURES; index += 1) {
    attempts = index + 1;
    const image = await captureOnce();
    if (!image) {
      if (index < MAX_CAPTURES - 1) await wait(CAPTURE_GAP_MS);
      continue;
    }
    const bitmap = image.toBitmap();
    const capture = {
      image,
      bitmap,
      png: image.toPNG(),
      size: image.getSize(),
      scaleFactors: image.getScaleFactors(),
    };
    last = capture;
    if (previous && previous.equals(bitmap)) return { ...capture, stable: true, attempts };
    previous = bitmap;
    if (index < MAX_CAPTURES - 1) await wait(CAPTURE_GAP_MS);
  }
  if (!last) return null;
  return { ...last, stable: false, attempts };
}

// ---- 结构采样：这段 JS 在 A 的 iframe 文档与 B 的顶层文档里各跑一遍，结果必须完全相等 ----
const STRUCTURE_JS = [
  "(function(){",
  "var round=function(n){return Math.round(n*2)/2;};",
  "var rectOf=function(el){if(!el)return null;var r=el.getBoundingClientRect();return [round(r.left),round(r.top),round(r.width),round(r.height)];};",
  "var styleOf=function(el){if(!el)return null;var s=getComputedStyle(el);return [s.color,s.backgroundColor,s.fontSize,s.fontFamily,s.borderRadius];};",
  "var keySelectors=['.brand','aside','main header','#roles','#board','#notices','#theme-dock','#new-project','#requests','#requirements','main','aside nav'];",
  "var countSelectors=['#roles','#requests','#requirements','#board','#notices','.brand','main header'];",
  "var counts={total:document.querySelectorAll('*').length};",
  "countSelectors.forEach(function(sel){counts[sel]=document.querySelectorAll(sel).length;});",
  "var elements={};",
  "keySelectors.forEach(function(sel){var el=document.querySelector(sel);elements[sel]=el?{rect:rectOf(el),style:styleOf(el)}:null;});",
  "var names={};",
  "try{for(var i=0;i<document.styleSheets.length;i++){var rules=document.styleSheets[i].cssRules||[];",
  "for(var j=0;j<rules.length;j++){var st=rules[j].style;if(!st)continue;",
  "for(var k=0;k<st.length;k++){var p=st[k];if(p.indexOf('--')===0)names[p]=1;}}}}catch(e){}",
  "var rootStyle=getComputedStyle(document.documentElement);",
  "var vars={};",
  "Object.keys(names).sort().forEach(function(name){if(name.indexOf('--lf-')!==0)return;vars[name]=rootStyle.getPropertyValue(name).trim();});",
  "return {title:document.title,",
  "lang:document.documentElement.getAttribute('lang'),",
  "dataTheme:document.documentElement.getAttribute('data-theme'),",
  "dataWallpaper:document.documentElement.getAttribute('data-wallpaper'),",
  "counts:counts,elements:elements,vars:vars,",
  "viewport:[window.innerWidth,window.innerHeight],",
  "scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],",
  // 窄宽预览关心的布局指标：是否出现横向滚动、侧栏实际宽度、主区是否被压扁。
  "metrics:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,",
  "scrollHeight:document.documentElement.scrollHeight,clientHeight:document.documentElement.clientHeight,",
  "bodyScrollWidth:document.body.scrollWidth,",
  "asideWidth:(document.querySelector('aside')?document.querySelector('aside').getBoundingClientRect().width:null),",
  "mainWidth:(document.querySelector('main')?document.querySelector('main').getBoundingClientRect().width:null)}};",
  "})()",
].join("");

async function probeStructure(serviceOrigin) {
  const candidates = frames().filter((frame) => {
    try {
      return String(frame.url || "").startsWith(serviceOrigin);
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) return { ok: false, error: "no frame on " + serviceOrigin, frame: null };
  const frame = candidates[candidates.length - 1];
  try {
    const data = await frame.executeJavaScript(STRUCTURE_JS, false);
    return { ok: Boolean(data), data, frame: redact(frame.url), error: null };
  } catch (error) {
    return { ok: false, error: errorText(error), frame: redact(frame.url) };
  }
}

function compareStructures(probeA, probeB) {
  const checks = [];
  const mismatches = [];
  const record = (name, left, right) => {
    const ok = JSON.stringify(left) === JSON.stringify(right);
    checks.push({ name, ok, a: short(left), b: short(right) });
    if (!ok) mismatches.push({ path: name, a: short(left), b: short(right) });
    return ok;
  };
  if (!probeA || !probeA.ok || !probeB || !probeB.ok) {
    const reason =
      (!probeA && "A: probe missing") ||
      (probeA && probeA.error) ||
      (!probeB && "B: probe missing") ||
      (probeB && probeB.error) ||
      "probe failed";
    return {
      ok: false,
      checks,
      mismatches: [{ path: "probe", a: probeA && probeA.ok ? "ok" : String((probeA && probeA.error) || "missing"), b: probeB && probeB.ok ? "ok" : String((probeB && probeB.error) || "missing") }],
      error: reason,
      frame: { a: probeA ? probeA.frame : null, b: probeB ? probeB.frame : null },
      a: probeA && probeA.data ? probeA.data : null,
      b: probeB && probeB.data ? probeB.data : null,
    };
  }
  const a = probeA.data;
  const b = probeB.data;
  record("title", a.title, b.title);
  record("html.lang", a.lang, b.lang);
  record("html.data-theme", a.dataTheme, b.dataTheme);
  record("html.data-wallpaper", a.dataWallpaper, b.dataWallpaper);
  record("counts.total", a.counts.total, b.counts.total);
  for (const selector of Object.keys(a.counts)) {
    if (selector === "total") continue;
    record("counts[" + selector + "]", a.counts[selector], (b.counts || {})[selector] ?? null);
  }
  for (const selector of Object.keys(a.elements)) {
    const left = a.elements[selector];
    const right = (b.elements || {})[selector] || null;
    record("elements[" + selector + "].rect", left ? left.rect : null, right ? right.rect : null);
    record("elements[" + selector + "].style", left ? left.style : null, right ? right.style : null);
  }
  record("css.varNames", Object.keys(a.vars), Object.keys(b.vars || {}));
  for (const name of Object.keys(a.vars)) record("css[" + name + "]", a.vars[name], (b.vars || {})[name] ?? null);
  record("viewport", a.viewport, b.viewport);
  record("scroll", a.scroll, b.scroll);
  record("metrics", a.metrics, b.metrics);
  return {
    ok: mismatches.length === 0,
    checks,
    mismatches,
    frame: { a: probeA.frame, b: probeB.frame },
    a,
    b,
  };
}

// 5x7 点阵字体，只为 compare.png 上标 A/B 文案用（不引入任何依赖）。
const FONT = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

// 写入一个 BGRA 像素（Electron 的 toBitmap()/createFromBitmap() 在 Windows 上就是 BGRA）。
function putPixel(buffer, offset, blue, green, red) {
  buffer[offset] = blue;
  buffer[offset + 1] = green;
  buffer[offset + 2] = red;
  buffer[offset + 3] = 255;
}

function drawText(buffer, bufferWidth, bufferHeight, x0, y0, text, scale, blue, green, red) {
  let cursor = x0;
  for (const character of String(text)) {
    const glyph = FONT[character] || FONT[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row][column] !== "#") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = cursor + column * scale + dx;
            const py = y0 + row * scale + dy;
            if (px < 0 || py < 0 || px >= bufferWidth || py >= bufferHeight) continue;
            putPixel(buffer, (py * bufferWidth + px) * 4, blue, green, red);
          }
        }
      }
    }
    cursor += 6 * scale;
  }
}

// 差异热图：差异像素涂红，其余全黑。
function writeHeatmap(a, b, file) {
  const width = a.size.width;
  const height = a.size.height;
  const out = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    let differs = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (a.bitmap[offset + channel] !== b.bitmap[offset + channel]) {
        differs = true;
        break;
      }
    }
    if (differs) putPixel(out, offset, 0, 0, 255);
    else putPixel(out, offset, 0, 0, 0);
  }
  writeFileSync(file, nativeImage.createFromBitmap(out, { width, height }).toPNG());
  extraFiles.diffHeatmap = file;
  return file;
}

// 左右并排对照图：A | B，中间 8px 分隔线，顶部标 A/B 文案。
function writeComparison(a, b, file) {
  const width = a.size.width;
  const height = a.size.height;
  const gap = 8;
  const labelHeight = 40;
  const totalWidth = width * 2 + gap;
  const totalHeight = height + labelHeight;
  const out = Buffer.alloc(totalWidth * totalHeight * 4);
  // 底色 = 页面 canvas 色 #10141d
  for (let index = 0; index < totalWidth * totalHeight; index += 1) putPixel(out, index * 4, 0x1d, 0x14, 0x10);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    a.bitmap.copy(out, ((y + labelHeight) * totalWidth) * 4, y * rowBytes, (y + 1) * rowBytes);
    b.bitmap.copy(out, ((y + labelHeight) * totalWidth + width + gap) * 4, y * rowBytes, (y + 1) * rowBytes);
  }
  for (let y = labelHeight; y < totalHeight; y += 1) {
    for (let x = width; x < width + gap; x += 1) putPixel(out, (y * totalWidth + x) * 4, 0x00, 0x00, 0x00);
  }
  drawText(out, totalWidth, totalHeight, 12, 9, "A / SIDEBAR FRAME", 3, 0xff, 0xff, 0xff);
  drawText(out, totalWidth, totalHeight, width + gap + 12, 9, "B / DIRECT WINDOW", 3, 0xff, 0xff, 0xff);
  writeFileSync(file, nativeImage.createFromBitmap(out, { width: totalWidth, height: totalHeight }).toPNG());
  extraFiles.compare = file;
  return file;
}

async function captureSide(label, url, serviceOrigin, shotName) {
  await loadTarget(url);
  wc.setZoomFactor(1);
  const frameWait = await waitForServiceFrame(serviceOrigin);
  if (!frameWait.loaded) {
    throw new Error(
      label + ": the service page never finished loading inside " + redact(url) + "; frames=" + JSON.stringify(frameWait.states),
    );
  }
  // 等子 frame 全部 complete，再注入禁动 CSS、等字体与稳定。
  const readyDeadline = Date.now() + FRAME_WAIT_MS;
  for (;;) {
    const states = await frameStates();
    const pending = states.filter((state) => !state.error && state.ready !== "complete");
    if (pending.length === 0 || Date.now() > readyDeadline) break;
    await wait(150);
  }
  await injectStill();
  await waitForFonts();
  await wait(settleMs);

  const capture = await captureStable();
  if (!capture) throw new Error(label + ": capturePage() never produced a non-empty image");

  const file = path.join(target, shotName + suffix + ".png");
  writeFileSync(file, capture.png);
  shots[shotName.startsWith("a") ? "a" : "b"] = file;

  const probe = await probeStructure(serviceOrigin);
  const states = await frameStates();
  let devicePixelRatio = 0;
  try {
    devicePixelRatio = await wc.executeJavaScript("window.devicePixelRatio", false);
  } catch {
    devicePixelRatio = 0;
  }

  return {
    label,
    file,
    bitmap: capture.bitmap,
    png: capture.png,
    size: capture.size,
    pngSize: pngSize(capture.png),
    bitmapBytes: capture.bitmap.length,
    pngBytes: capture.png.length,
    scaleFactors: capture.scaleFactors,
    stable: capture.stable,
    attempts: capture.attempts,
    frames: states,
    probe,
    devicePixelRatio,
  };
}

async function main() {
  win = new BrowserWindow({
    // show:true：隐藏窗口在 Windows 上常被判定为 occluded 而不出帧，capturePage() 会一直空图。
    // 随后立刻 showInactive()，不抢用户焦点；窗口也很小且 focusable:false。
    show: true,
    width,
    height,
    useContentSize: true,
    // frame 的滚动条槽（gutter）与未绘制区域透出的是宿主底色，而不是 frame 内页面的 canvas 色：
    // A 里那条竖向空槽如果透出纯黑，就和 B 里 root 滚动条槽的页面底色 #10141d 不同。
    // 所以把窗口底色设成页面 canvas 色（--lf-bg #10141d，桌面端 visual-main.cjs 用的也是它）。
    backgroundColor: "#10141d",
    title: "LingFlow Panel Visual",
    autoHideMenuBar: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: false,
      backgroundThrottling: false,
    },
  });
  wc = win.webContents;
  win.setMenuBarVisibility(false);
  win.showInactive();
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  // setZoomFactor(1) 是默认值，这里显式写一遍，A/B 完全同参数。
  wc.setZoomFactor(1);

  wc.on("console-message", (event, level, message) => {
    const details = event && typeof event === "object" && "level" in event ? event : { level, message };
    const text = String(details.message ?? "");
    if (details.level === "error" || details.level === "warning") {
      consoleMessages.push(String(details.level) + ": " + text.slice(0, 400));
    }
  });
  wc.on("render-process-gone", (_event, details) => fail(new Error("render-process-gone: " + (details && details.reason))));
  wc.on("did-fail-load", (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (isMainFrame) fail(new Error("did-fail-load " + errorCode + " " + errorDescription + " on " + redact(failedUrl)));
  });
  win.on("closed", () => {
    win = null;
    wc = null;
  });

  const [contentWidth, contentHeight] = win.getContentSize();
  if (contentWidth !== width || contentHeight !== height) {
    win.setContentSize(width, height);
    await wait(200);
  }
  const actualContentSize = win.getContentSize();
  console.log("[panel-visual-main] window content size " + actualContentSize.join("x") + " (requested " + width + "x" + height + ")");

  const serviceOrigin = new URL(urlB).origin;
  // 两侧独立执行：即使一侧失败也把另一侧截完、把已拿到的 PNG 留在盘上，便于诊断。
  let a = null;
  let b = null;
  const sideErrors = [];
  try {
    a = await captureSide("A (sidebar iframe)", urlA, serviceOrigin, "a-frame");
  } catch (error) {
    sideErrors.push(errorText(error));
  }
  try {
    b = await captureSide("B (direct)", urlB, serviceOrigin, "b-direct");
  } catch (error) {
    sideErrors.push(errorText(error));
  }
  if (!a || !b) {
    writeResult(
      baseResult({
        error: sideErrors.join(" | ") || "capture failed",
        note: "One or both sides could not be captured; any PNG that was already captured is kept next to visual.json.",
        shots: { a: shots.a, b: shots.b },
      }),
    );
    finish(1);
    return;
  }

  // 逐字节比较两张稳定位图（BGRA，4 字节/像素）。
  const limit = Math.min(a.bitmap.length, b.bitmap.length);
  const sameLength = a.bitmap.length === b.bitmap.length;
  let differingBytes = 0;
  let differingPixels = 0;
  let firstDiffIndex = -1;
  for (let index = 0; index < limit; index += 1) {
    if (a.bitmap[index] === b.bitmap[index]) continue;
    if (firstDiffIndex < 0) firstDiffIndex = index;
    differingBytes += 1;
  }
  for (let pixel = 0; pixel * 4 < limit; pixel += 1) {
    const offset = pixel * 4;
    if (
      a.bitmap[offset] !== b.bitmap[offset] ||
      a.bitmap[offset + 1] !== b.bitmap[offset + 1] ||
      a.bitmap[offset + 2] !== b.bitmap[offset + 2] ||
      a.bitmap[offset + 3] !== b.bitmap[offset + 3]
    ) {
      differingPixels += 1;
    }
  }
  if (!sameLength && firstDiffIndex < 0) firstDiffIndex = limit;
  const sizeMatch =
    Boolean(a.size) &&
    Boolean(b.size) &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    (!a.pngSize || !b.pngSize || (a.pngSize.width === b.pngSize.width && a.pngSize.height === b.pngSize.height));
  const identical = sameLength && differingBytes === 0 && sizeMatch;

  const captureWidth = a.size ? a.size.width : width;
  const captureHeight = a.size ? a.size.height : height;
  const totalPixels = captureWidth * captureHeight;
  const ratio = totalPixels > 0 ? differingPixels / totalPixels : 1;
  const tolerancePassed = sameLength && sizeMatch && ratio <= TOLERANCE_RATIO;
  const firstDiffPixel =
    firstDiffIndex >= 0 && captureWidth > 0
      ? { x: Math.floor(firstDiffIndex / 4) % captureWidth, y: Math.floor(Math.floor(firstDiffIndex / 4) / captureWidth) }
      : null;

  const structure = compareStructures(a.probe, b.probe);
  const fileA = a.file;
  const fileB = b.file;
  let heatmapFile = "";
  let compareFile = "";
  if (sameLength && sizeMatch) {
    try {
      heatmapFile = writeHeatmap(a, b, path.join(target, "diff-heatmap" + suffix + ".png"));
    } catch (error) {
      consoleMessages.push("diff-heatmap failed: " + errorText(error));
    }
    try {
      compareFile = writeComparison(a, b, path.join(target, "compare" + suffix + ".png"));
    } catch (error) {
      consoleMessages.push("compare.png failed: " + errorText(error));
    }
  }

  const pass = tolerancePassed && structure.ok;
  const notes = [
    "A loads a fake DSH host page whose only body element is the sidebar iframe -> /lingflow-panel/api/frame -> 302 -> service page.",
    "B loads the service page directly with the token in the fragment, exactly like the desktop window.",
    "The host paints its canvas and the iframe element with the app canvas colour (#10141d): a frame's scrollbar gutter and unpainted area take the host backdrop, not the page canvas, so a mismatched host colour would show up as a gutter strip difference.",
    "PASS requires differingPixels/(width*height) <= " +
      TOLERANCE_RATIO +
      " with equal bitmap lengths AND an exact match of the DOM/layout/CSSOM probe; antialias rounding inside a composited frame can move a few odd-edge bytes by 1/255, which is why the pixel criterion is a ratio.",
    "Motion/transition disabled with insertCSS; document.fonts.ready awaited; " +
      settleMs +
      "ms settle; each side re-captured until two consecutive captures were byte-identical.",
    "Window is shown (showInactive, never focused) because hidden/occluded windows stop producing frames on Windows; native window occlusion detection and background throttling are disabled for this process only.",
    "The sidebar frame here is an <iframe> (the panel's non-webview fallback) rather than a <webview> guest, and both sides are captured at equal viewport size, so the panel header/toolbar is outside the comparison.",
  ];
  if (!a.stable || !b.stable) {
    notes.push("WARNING: capture did not stabilise within " + MAX_CAPTURES + " attempts (A=" + a.attempts + ", B=" + b.attempts + ").");
  }
  if (!sameLength) notes.push("Bitmap byte lengths differ: A=" + a.bitmapBytes + ", B=" + b.bitmapBytes + ".");
  if (sameLength && !sizeMatch) notes.push("Reported capture sizes differ.");
  if (frameStill) notes.push("LINGFLOW_VISUAL_FRAME_STILL=1: motion-off CSS was also injected into the content documents (diagnostic mode).");
  if (forcedScale > 0) notes.push("LINGFLOW_VISUAL_SCALE=" + forcedScale + ": device scale factor was forced.");

  const payload = baseResult({
    ok: pass,
    pass,
    identical,
    size: a.size ? { width: a.size.width, height: a.size.height } : { width, height },
    aBytes: a.bitmapBytes,
    bBytes: b.bitmapBytes,
    differingBytes,
    differingPixels,
    firstDiffIndex,
    firstDiffPixel,
    tolerance: {
      maxRatio: TOLERANCE_RATIO,
      differingPixels,
      totalPixels,
      ratio,
      passed: tolerancePassed,
      sameLength,
      sizeMatch,
    },
    structure,
    // 窄宽预览要看的布局指标（A/B 两侧应完全一致）。
    metrics: structure.a && structure.a.metrics ? structure.a.metrics : structure.b ? structure.b.metrics : null,
    requestedSize: { width, height },
    shots: { a: fileA, b: fileB },
    compare: compareFile,
    diffHeatmap: heatmapFile,
    settleMs,
    note: notes.join(" "),
    diagnostics: {
      serviceOrigin,
      frameStill,
      forcedScale: forcedScale > 0 ? forcedScale : null,
      captureSize: { width: captureWidth, height: captureHeight },
      contentSize: { width: actualContentSize[0], height: actualContentSize[1] },
      devicePixelRatio: { a: a.devicePixelRatio, b: b.devicePixelRatio },
      captures: {
        a: {
          size: a.size,
          pngSize: a.pngSize,
          bitmapBytes: a.bitmapBytes,
          pngBytes: a.pngBytes,
          scaleFactors: a.scaleFactors,
          attempts: a.attempts,
          stable: a.stable,
        },
        b: {
          size: b.size,
          pngSize: b.pngSize,
          bitmapBytes: b.bitmapBytes,
          pngBytes: b.pngBytes,
          scaleFactors: b.scaleFactors,
          attempts: b.attempts,
          stable: b.stable,
        },
      },
      frames: { a: a.frames, b: b.frames },
      structureFrames: structure.frame,
      structureCheckCount: structure.checks.length,
      structureMismatches: structure.mismatches.slice(0, 12),
      consoleMessages: consoleMessages.slice(0, 20),
    },
  });

  const file = writeResult(payload);
  console.log(
    JSON.stringify({
      ok: payload.ok,
      pass,
      identical,
      size: payload.size,
      aBytes: payload.aBytes,
      bBytes: payload.bBytes,
      differingBytes,
      differingPixels,
      firstDiffPixel,
      ratio,
      tolerancePassed,
      structureOk: structure.ok,
      structureChecks: structure.checks.length,
      stable: { a: a.stable, b: b.stable },
      metrics: payload.metrics,
      shots: payload.shots,
      compare: compareFile,
      diffHeatmap: heatmapFile,
      visualJson: file,
    }),
  );
  finish(pass ? 0 : 1);
}

if (!configured) {
  console.error(
    "[panel-visual-main] missing/invalid env: LINGFLOW_VISUAL_DIR, LINGFLOW_VISUAL_A, LINGFLOW_VISUAL_B, LINGFLOW_VISUAL_SIZE",
  );
  app.exit(1);
} else {
  mkdirSync(path.join(target, "electron"), { recursive: true });
  // 独立 userData，避免和用户正在跑的 LingFlow 桌面端抢单实例锁 / 缓存；成功后 runner 会删掉它。
  app.setName("LingFlow Panel Visual");
  app.setPath("userData", path.join(target, "electron"));
  // Windows 下隐藏/被遮挡的窗口会被 Chromium 判定为 occluded 而停止出帧，capturePage() 就会一直拿到空图；
  // 关掉遮挡检测与后台节流，让窗口照常合成（只影响本进程，不改应用任何东西）。
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  if (forcedScale > 0) app.commandLine.appendSwitch("force-device-scale-factor", String(forcedScale));
  // 两侧都钉在 sRGB，避免 frame 表面与宿主表面走不同的色彩空间转换。
  app.commandLine.appendSwitch("force-color-profile", "srgb");
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", (reason) => fail(reason));
  // 窗口销毁后不让 Electron 自己退出，由脚本决定退出码。
  app.on("window-all-closed", () => {});

  if (!app.requestSingleInstanceLock()) {
    console.error("[panel-visual-main] another instance holds the single instance lock");
    app.exit(1);
  } else {
    app.whenReady().then(main).catch(fail);
  }
}