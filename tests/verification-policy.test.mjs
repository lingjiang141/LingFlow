import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { alignBrowserArgv, assertCheckOwnership, browserCheckArgv, freezeBrowserChecks } from "../src/verification-policy.mjs";

const file = "e2e/account[1].spec.ts";
const entry = { file, title: "AC1: keeps (1+2) visible?", reason: "依赖真实浏览器焦点", covers: ["AC1"] };
const full = { id: "browser", stage: "full", argv: browserCheckArgv(entry), inputs: [file], covers: ["AC1"] };

function project(t) {
  const root = mkdtempSync(path.join(tmpdir(), "lingflow-check-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function freeze(root, entries, checks, files = []) {
  return freezeBrowserChecks(root, entries, checks, files, new Set(["AC1", "AC2"]));
}

test("a browser test input or write requires a declared case even when argv uses no browser runner", (t) => {
  const root = project(t);
  const unit = { ...full, argv: ["node", "unit.cjs"] };
  assert.throws(() => freeze(root, [], [unit]), { verificationCode: "contract-invalid", message: /缺少 verification\.browserE2E/ });
  assert.throws(() => freeze(root, [], [{ ...unit, inputs: ["unit.spec.ts"] }], [file]), /缺少 verification\.browserE2E/);
  writeFileSync(path.join(root, "panel.spec.ts"), 'import { test } from "@playwright/test";');
  assert.throws(() => freeze(root, [], [{ ...unit, inputs: ["panel.spec.ts"] }]), /panel\.spec\.ts/);
  writeFileSync(path.join(root, "unit.spec.ts"), 'import { test } from "vitest";');
  assert.deepEqual(freeze(root, [], [{ ...unit, inputs: ["unit.spec.ts"] }]), []);
});

test("only a frozen file, title and AC matched to the developer check can satisfy browser evidence", (t) => {
  const root = project(t);
  assert.deepEqual(freeze(root, [entry], [full]), [entry]);
  assert.throws(() => freeze(root, [], [{ ...full, inputs: ["browser-config.ts"] }]), /必须绑定/);
  assert.throws(() => freeze(root, [entry], [{ ...full, stage: "green" }]), /缺少开发 full/);
  assert.throws(() => freeze(root, [entry], [{ ...full, covers: ["AC2"] }]), /覆盖对应 AC/);
  assert.throws(() => freeze(root, [entry], [{ ...full, argv: full.argv.slice(0, 3) }]), /不接受全套/);
  assert.throws(() => freeze(root, [entry], [{ ...full, argv: [...full.argv, "--pass-with-no-tests"] }]), /不接受全套/);
  assert.throws(() => freeze(root, [{ ...entry, reason: "" }], [full]), /必须通过浏览器/);
  assert.throws(() => freeze(root, [{ ...entry, file: "../e2e/escape.spec.ts" }], [full]), /冻结的项目相对文件/);
  const selector = new RegExp(full.argv[3]);
  assert.ok(selector.test(String.raw`E:\project\e2e\account[1].spec.ts`));
  assert.ok(selector.test("/project/e2e/account[1].spec.ts"));
  assert.ok(!selector.test("/project/other-e2e/account[1].spec.ts"));
  const title = new RegExp(full.argv[5]);
  assert.ok(title.test(`account[1].spec.ts ${entry.title}`));
  assert.ok(!title.test("account[1].spec.ts AC1: keeps 12 visible?"));
});

test("approval does not turn browser wrappers or a full test suite into a controller probe", (t) => {
  const root = project(t);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
    verify: "npm run helper", helper: "npm run verify && npm run browser", browser: "playwright test",
    unit: "vitest run", "postunit": "npm run browser", all: "npm run full", full: "node --test", focused: "node --test acceptance.test.cjs",
  } }));
  for (const check of [
    { ...full, stage: "independent" },
    { id: "nested", stage: "controller", argv: ["npm", "run", "verify"] },
    { id: "lifecycle", stage: "batch", argv: ["npm", "run", "unit"] },
  ]) assert.throws(() => assertCheckOwnership(root, check), /浏览器 E2E 由责任开发/);
  assert.throws(() => assertCheckOwnership(root, { id: "suite", stage: "controller", argv: ["npm", "test"] }), /低负载短探针/);
  assert.throws(() => assertCheckOwnership(root, { id: "alias", stage: "controller", argv: ["npm", "run", "all"] }), /低负载短探针/);
  assert.doesNotThrow(() => assertCheckOwnership(root, { id: "focused", stage: "independent", argv: ["npm", "run", "focused"] }));
  assert.doesNotThrow(() => assertCheckOwnership(root, { id: "probe", stage: "independent", argv: ["node", "probe.cjs"] }));
  assert.doesNotThrow(() => assertCheckOwnership(root, { id: "batch", stage: "batch", argv: ["npm", "test"] }));
});

test("browser regression accepts a frozen whole file but cannot select undeclared files or replace case evidence", (t) => {
  const root = project(t);
  const regression = { ...full, stage: "regression", covers: [], argv: ["node","node_modules/@playwright/test/cli.js","test",file] };
  alignBrowserArgv([regression], [], [], "verification");
  assert.doesNotThrow(() => assertCheckOwnership(root, regression));
  assert.throws(() => assertCheckOwnership(root,{ ...regression,argv:[...regression.argv,"e2e/undeclared.spec.ts"] }), /冻结/);
  assert.throws(() => assertCheckOwnership(root,{ ...regression,argv:regression.argv.slice(0,3) }), /整套浏览器回归须/);
  assert.throws(() => freeze(root,[entry],[regression],[file]), /缺少开发 full/);
  assert.deepEqual(freeze(root,[entry],[full,regression],[file]),[entry]);
});

test('controller probes cannot hide subprocesses in inline code, project wrappers or npm aliases',t=>{
  const root=project(t);
  writeFileSync(path.join(root,'wrapped.cjs'),"require('node:child_process').spawnSync('npm',['run','build']);");
  writeFileSync(path.join(root,'indirect.cjs'),"require('./wrapped.cjs');");
  writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{probe:'node indirect.cjs'}}));
  for(const argv of [['node','-e',"require('child_process').execSync('npm run build')"],['node','-e',"require('./indirect.cjs')"],['node','--no-warnings','wrapped.cjs'],['node','wrapped.cjs'],['node','indirect.cjs'],['npm','run','probe']])
    assert.throws(()=>assertCheckOwnership(root,{id:'probe',stage:'controller',argv}),/主控探针不得|开发 full/);
});

test("equal browser argv with wrong covers reports covers, never an argv violation", (t) => {
  const root = project(t);
  const issues = [];
  const checks = [full, ...["red", "green"].map(stage => ({ ...full, id: stage, stage, covers: ["AC2"] }))];
  freezeBrowserChecks(root, [entry], checks, [file], new Set(["AC1", "AC2"]),
    (path, message, expected, remedy) => issues.push({ path, message, expected, remedy }));
  assert.deepEqual(issues.map(issue => issue.path), [".checks.red.covers", ".checks.green.covers"]);
  for (const issue of issues) {
    assert.match(issue.message, /covers 不一致/);
    assert.ok(issue.message.includes(JSON.stringify(["AC2"])));
    assert.ok(issue.message.includes(JSON.stringify(entry.covers)));
    assert.deepEqual(issue.expected, ["AC2", "AC1"]);
  }
});

test("browser argv normalization preserves equivalent escaping but rejects changed regex meaning", (t) => {
  const root = project(t);
  const argv = full.argv.map(arg => "  " + arg + "  ");
  argv[1] = " node_modules\\@playwright\\test\\cli.js ";
  argv[3] = argv[3].replaceAll(String.raw`[/\\]`, String.raw`[\\/]`);
  const normalized = { ...full, argv };
  alignBrowserArgv([normalized], [entry], [], "verification");
  assert.doesNotThrow(() => freeze(root, [entry], [normalized]));
  assert.doesNotThrow(() => freeze(root, [entry], [{ ...full, covers: ["AC2", "AC1"] }]));
  const changed = [...full.argv];
  changed[5] = changed[5].replace(String.raw`\s`, String.raw`\\s`);
  assert.throws(() => freeze(root, [entry], [{ ...full, argv: changed }]), /收到 argv=.*期望 argv=/);
});

test("literal browser argv alignment is independent of covers and missing inputs has its own remedy", (t) => {
  const root = project(t);
  const check = { ...full, argv: ["node", "node_modules/@playwright/test/cli.js", "test", file, "--grep", entry.title], covers: ["AC2"] };
  alignBrowserArgv([check], [entry], [], "verification");
  assert.deepEqual(check.argv, full.argv);
  assert.throws(() => freeze(root, [entry], [check]), /covers 不一致/);
  const issues = [];
  freezeBrowserChecks(root, [entry], [full, { ...full, id: "red", stage: "red", inputs: ["other.ts"] }], [file], new Set(entry.covers),
    (path, message, expected, remedy) => issues.push({ path, message, expected, remedy }));
  assert.deepEqual(issues.map(issue => issue.path), [".checks.red.inputs"]);
  assert.deepEqual(issues[0].expected, ["other.ts", file]);
});

test("browser argv mismatch preserves both complete raw argv values in diagnostics", (t) => {
  const root = project(t);
  const argv = [...full.argv];
  argv[5] = argv[5].replace("visible", "visiblX");
  const issues = [];
  freezeBrowserChecks(root, [entry], [full, { ...full, id: "red", stage: "red", argv }], [file], new Set(["AC1"]),
    (path, message, expected, remedy) => issues.push({ path, message, expected, remedy }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, ".checks.red.argv");
  assert.ok(issues[0].message.includes("收到 argv=" + JSON.stringify(argv)));
  assert.ok(issues[0].message.includes("期望 argv=" + JSON.stringify(full.argv)));
});
