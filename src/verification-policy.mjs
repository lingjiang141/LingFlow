import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const CONTROLLER_CHECK_BOUNDARY = "主控负责用户沟通、规划、派发与验收裁决。业务代码、红绿验证、全量自测和票内浏览器 E2E 交给开发；详细独立审查交给审查成员。主控核对最终候选与证据，只提交冻结的低负载收口探针；缺证沿原票交回责任人。共同累计检查由 LingFlow 后台执行。";

const developerStages = new Set(["red", "green", "full"]);
export const browserStageRules = Object.fromEntries([
  ...[...developerStages].map(stage => [stage, { allowed: true, selection: "single-declared-file-and-title",
    inputs: "must-include-browserE2E.file", covers: "must-include-browserE2E.covers; extra-ticket-ACs-allowed", testChangeRequired: false }]),
  ["regression", { allowed: true, selection: "explicit-frozen-whole-files; no-grep", covers: "empty", testChangeRequired: false }],
  ...["independent", "controller", "batch"].map(stage => [stage, { allowed: false, reason: "浏览器检查由责任开发执行" }]),
]);
const browserRunner = /(?:^|[\s/\\"'=;&|])(?:@playwright[/\\]test|playwright(?:-core)?|cypress|webdriverio|wdio|puppeteer|selenium-webdriver|testcafe)(?=$|[\s/\\"'.;&|])/i;
const specFile = /(?:^|\/)(?:[^/]+\.(?:test|spec|cy)\.[cm]?[jt]sx?)$/i;
const browserFile = /(?:^|\/)(?:e2e|playwright|cypress)\/.*\.(?:test|spec|cy)\.[cm]?[jt]sx?$/i;
export const INDEPENDENT_LIMIT_MS = 60000;
const playwrightCLI = "node_modules/@playwright/test/cli.js";

function smallProjectFile(root, file) {
  const absolute = path.resolve(root, file);
  try {
    const relative = path.relative(realpathSync(root), realpathSync(absolute));
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) return "";
    const stat = lstatSync(absolute);
    return stat.isFile() && stat.size <= 256 * 1024 ? readFileSync(absolute, "utf8") : "";
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return "";
    throw error;
  }
}

function browserSpec(root, file) {
  return browserFile.test(file) || /\.cy\.[cm]?[jt]sx?$/i.test(file) ||
    (specFile.test(file) && /["'](?:@playwright\/test|playwright|puppeteer|cypress|webdriverio|selenium-webdriver|testcafe)(?:\/[^"']*)?["']/i.test(smallProjectFile(root, file)));
}

function* npmScripts(root, argv) {
  if (argv[0] !== "npm") return;
  let scripts;
  const raw = smallProjectFile(root, "package.json");
  try { scripts = raw ? JSON.parse(raw).scripts : {}; } catch { return; }
  const entry = argv[1] === "test" ? "test" : argv[2];
  const seen = new Set();
  const visits = [entry, `pre${entry}`, `post${entry}`];
  while (visits.length) {
    const name = visits.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const script = scripts?.[name];
    if (typeof script !== "string") continue;
    yield script;
    for (const match of script.matchAll(/\bnpm\s+(?:(test)\b|(?:run|run-script)\s+["']?([\w:.-]+))/g)) {
      const nested = match[1] || match[2];
      visits.push(nested, `pre${nested}`, `post${nested}`);
    }
  }
}

const testRunner = /(?:^|[\s/\\"'=;&|])(?:vitest|jest|mocha|ava|tap)(?:\.(?:[cm]?js|exe))?(?=$|[\s"';&|])/i;
const explicitTest = /[^\s"';&|]+\.(?:spec|test)\.[cm]?[jt]sx?(?=$|[\s"';&|])/i;

function invalid(message) {
  throw Object.assign(Error(message), { verificationCode: "contract-invalid" });
}

// Let Playwright treat the file selector as a regex on either path separator.
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function browserFileSelector(file) {
  return `(?:^|[/\\\\])${file.split("/").map(escape).join("[/\\\\]")}$`;
}
export function browserCheckArgv({ file, title }) {
  return ["node", playwrightCLI, "test", browserFileSelector(file), "--grep", `(?:^|\\s)${escape(title)}$`];
}

// JSON decoding has already happened. Do not unescape again: \\s and \\\\s
// mean different things to the regex engine. Only canonicalize equivalent syntax.
function normalizeSelector(value, fileSelector) {
  try {
    if (fileSelector) value = value.replaceAll(String.raw`[\\/]`, String.raw`[/\\]`)
      .replaceAll(String.raw`[\/\\]`, String.raw`[/\\]`);
    return new RegExp(value).source;
  } catch { return value; }
}
export function normalizeBrowserArgv(argv) {
  if (!Array.isArray(argv)) return argv;
  const args = argv.map(value => String(value).trim());
  if (args[0] !== "node" || args[1]?.replaceAll("\\", "/") !== playwrightCLI) return argv;
  args[1] = playwrightCLI;
  return args.map((arg, index) => index >= 3 && arg.startsWith("(?:^|") ? normalizeSelector(arg, index === 3 || !args.includes("--grep")) : arg);
}
const receivedArgv = new WeakMap();
const sameArgv = (left, right) => JSON.stringify(normalizeBrowserArgv(left)) === JSON.stringify(normalizeBrowserArgv(right));
const coversCase = (check, entry) => entry.covers.every(id => check.covers.includes(id));

function browserBindingIssues(check, cases) {
  if (!cases.length) return [{ field: "browserE2E", expected: [{ file: "e2e/example.spec.ts", title: "literal case title", reason: "为何必须通过浏览器验证", covers: check.covers }],
    message: `检查 ${check.id}：浏览器命令必须绑定有效的 browserE2E 声明，当前没有可用声明。`,
    remedy: "先补齐或修正票根或 verification.browserE2E 的 file、title、reason 和 covers，再核对命令。" }];
  const matched = cases.filter(entry => sameArgv(check.argv, browserCheckArgv(entry)));
  if (!matched.length) {
    const expectedEntry = cases.find(entry => normalizeBrowserArgv(check.argv)[3] === normalizeBrowserArgv(browserCheckArgv(entry))[3]) ??
      cases.find(entry => check.inputs.includes(entry.file)) ?? cases[0];
    const expected = browserCheckArgv(expectedEntry);
    return [{ field: "argv", expected,
      message: `检查 ${check.id}：浏览器命令必须绑定一个声明的文件和标题；不接受全套、额外参数或间接浏览器脚本。收到 argv=${JSON.stringify(receivedArgv.get(check) ?? check.argv)}；期望 argv=${JSON.stringify(expected)}`,
      remedy: "复制对应 browserE2E 文件和完整标题生成的 expected argv；不要修改 covers 来掩盖命令差异。" }];
  }
  const entry = matched[0];
  const issues = [];
  if (!check.inputs.includes(entry.file)) issues.push({ field: "inputs", expected: [...new Set([...check.inputs, entry.file])],
    message: `检查 ${check.id}：inputs 未冻结浏览器文件。收到 inputs=${JSON.stringify(check.inputs)}；必须包含=${JSON.stringify(entry.file)}`,
    remedy: "将声明的浏览器文件加入本检查 inputs，保留其余实际依赖。" });
  if (!coversCase(check, entry)) issues.push({ field: "covers", expected: [...new Set([...check.covers, ...entry.covers])],
    message: `检查 ${check.id}：covers 不一致，必须覆盖对应 AC（包含 browserE2E.covers，可额外覆盖本票 AC）。收到 check.covers=${JSON.stringify(check.covers)}；browserE2E.covers=${JSON.stringify(entry.covers)}`,
    remedy: "核对用例确实证明哪些 AC；在红绿同键约束下对齐 covers 与 browserE2E.covers，不要改 argv。" });
  return issues;
}

export function assertCheckOwnership(root, check, cases) {
  const raw = check;
  check = { ...check, argv: normalizeBrowserArgv(check.argv) };
  receivedArgv.set(check, receivedArgv.get(raw) ?? raw.argv);
  const scripts = [...npmScripts(root, check.argv)];
  const browser = [...check.argv, ...scripts].some((value) => browserRunner.test(value));
  if (check.stage === "regression") {
    if (browser) {
      const [program, cli, verb, ...targets] = check.argv;
      if (program !== "node" || cli !== playwrightCLI || verb !== "test" || !targets.every((target) => check.inputs.some((file) => browserSpec(root, file) && target === browserFileSelector(file))))
        invalid("浏览器 regression 使用 node Playwright CLI test，只允许 inputs 中冻结的整文件路径；整套回归不加筛选参数。");
      if (!targets.length) invalid("整套浏览器回归须在 argv 与 inputs 明确列出整套测试文件，避免执行未冻结的文件");
    }
    return;
  }
  if (developerStages.has(check.stage)) {
    if (browser && cases) {
      const issue = browserBindingIssues(check, cases)[0];
      if (issue) invalid(issue.message);
    }
    return;
  }
  if (browser) invalid(`检查 ${check.id}：浏览器 E2E 由责任开发执行。请移到开发检查并绑定 verification.browserE2E。`);
  if (check.stage !== "batch") {
    const [program, sub, script] = check.argv;
    if (program === "npm" && check.argv.slice(1).some((arg) => /^(?:-w|--workspace|--workspaces)(?:=|$)/.test(arg)))
      invalid("主控收口只允许冻结的低负载短探针，不允许 npm workspace 套件或构建；请交责任开发。");
    const command = check.argv.join(" ");
    const broadRunner = (value) => {
      if (/\bnode(?:\.exe)?\s+--test(?:\s|$)/i.test(value))
        return !/\bnode(?:\.exe)?\s+--test\s+["']?[^\s"';&|*?]+\.[cm]?[jt]sx?(?=$|[\s"';&|])/i.test(value) && !explicitTest.test(value);
      return testRunner.test(value) && !explicitTest.test(value);
    };
    if ((program === "npm" && (sub === "test" || script === "test")) ||
        broadRunner(command) || scripts.some((body) => body.split(/&&|[;|]/).some(broadRunner)))
      invalid(`检查 ${check.id}：主控收口只允许冻结的低负载短探针。请把测试套件交给开发，主控改用独立的短探针。`);
  }
}

export function alignBrowserArgv(checks, cases, warnings, prefix, rawChecks = checks) {
  for (const check of checks) {
    receivedArgv.set(check, rawChecks.find(raw => raw?.id === check.id)?.argv ?? check.argv);
    check.argv = normalizeBrowserArgv(check.argv);
    if (check.argv[0] !== "node" || check.argv[1] !== playwrightCLI || check.argv[2] !== "test") continue;
    if (check.stage === "regression") {
      check.argv = check.argv.map((arg, index) => index >= 3 && check.inputs.includes(arg) && specFile.test(arg) ? browserFileSelector(arg) : arg);
      continue;
    }
    const [,,,file, flag, title] = check.argv;
    if (!Array.isArray(cases) || check.argv.length !== 6 || flag !== "--grep") continue;
    const match = cases.find((entry) => entry?.file === file && (entry.title === title || (typeof entry.title === "string" && /^(?:[A-Z][\w]*-\d+)$/.test(title) && entry.title.startsWith(title + " "))));
    if (match && cases.filter((entry) => entry?.file === file && (entry.title === title || entry.title?.startsWith?.(title + " "))).length === 1) {
      check.argv = browserCheckArgv(match);
      warnings.push({ path: prefix + ".checks." + check.id + ".argv", message: "已将 Hive 票号或字面标题筛选收敛为票面唯一具名用例" });
    }
  }
}

export function freezeBrowserChecks(root, entries, checks, testWrites, acIds, collect) {
  const valid = [];
  const emit = collect ?? ((_path, message) => invalid(message));
  const report = (suffix, message, entry) => emit(".browserE2E" + suffix, message,
    entry ?? {file:"e2e/example.spec.ts",title:"literal case title",reason:"why browser is required",covers:[...acIds].slice(0,1)},
    "填入票面具名浏览器用例；用 browserCheckArgv 对应的 argv 绑定 full 检查，整文件用 regression");
  if (!Array.isArray(entries) || entries.length > 20) { report("", "verification.browserE2E 须为数组，最多 20 条"); return valid; }
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const id = JSON.stringify([entry?.file, entry?.title]);
    if (seen.has(id) || !entry || typeof entry.file !== "string" || typeof entry.title !== "string" || !entry.title.trim() || entry.title !== entry.title.trim() || entry.title.length > 400 || /[\r\n\0]/.test(entry.title) ||
        typeof entry.reason !== "string" || !entry.reason.trim() || entry.reason.length > 8000 || !Array.isArray(entry.covers) || !entry.covers.length || new Set(entry.covers).size !== entry.covers.length || !entry.covers.every((ac) => acIds.has(ac))) {
      report("["+index+"]", "浏览器用例格式无效或重复：填写 {file,title,reason,covers}，说明为何必须通过浏览器验证并引用已有 AC"); continue;
    }
    if (!checks.some((check) => check.inputs.includes(entry.file))) {
      report("["+index+"]", entry.file+" 必须是检查 inputs 中冻结的项目相对文件"); continue;
    }
    seen.add(id);
    valid.push({ file: entry.file, title: entry.title, reason: entry.reason.trim(), covers: entry.covers });
  }
  const files = new Set([...testWrites, ...checks.filter((c)=>c.stage!=="regression").flatMap((c)=>c.inputs)].filter((file)=>browserSpec(root,file)));
  for(const file of files) if(!valid.some((c)=>c.file===file)) report("", "浏览器测试文件 "+file+" 缺少 verification.browserE2E（也可放票根）", {file,title:"literal case title",reason:"why browser is required",covers:[...acIds].slice(0,1)});
  for(const check of checks) {
    if(!developerStages.has(check.stage))continue;
    const browser = [...check.argv, ...npmScripts(root, check.argv)].some(value => browserRunner.test(value));
    if (browser) for (const issue of browserBindingIssues(check, valid))
      emit(issue.field === "browserE2E" ? ".browserE2E" : ".checks."+check.id+"."+issue.field, issue.message, issue.expected, issue.remedy);
  }
  for(const entry of valid) if(!checks.some((c)=>c.stage==="full"&&binds(c,entry))) report("", "浏览器用例 "+entry.file+" · "+entry.title+" 缺少开发 full 检查", {stage:"full",argv:browserCheckArgv(entry),inputs:[entry.file],covers:entry.covers});
  return valid;
}
function binds(check, entry) {
  return developerStages.has(check.stage) && check.inputs.includes(entry.file) &&
    coversCase(check, entry) && sameArgv(check.argv, browserCheckArgv(entry));
}
