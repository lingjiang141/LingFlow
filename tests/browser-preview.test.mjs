import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { browserCheckArgv } from "../src/verification-policy.mjs";

const file = "e2e/ai-generation.spec.ts";
const title = "R35-01 the wizard renders one form with or without preselected resources";
const browser = { file, title, reason: "冻结已有浏览器用例验证后继票", covers: ["AC-5"] };
const implementation = "browser-implementation.txt";

async function successor(t, playwrightRoot) {
  const f = await fixture(t);
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "prepare successor fixture" });
  f.put(implementation, "old");
  f.put(file, playwrightRoot ? `const { test, expect } = require(${JSON.stringify(path.join(playwrightRoot, "node_modules/@playwright/test"))});
const fs = require('node:fs');
test(${JSON.stringify(title)}, () => expect(fs.readFileSync(${JSON.stringify(implementation)}, 'utf8')).toBe('new'));
` : "// previously committed browser test\n");
  if (playwrightRoot) {
    mkdirSync(path.join(f.root, "node_modules/@playwright/test"), { recursive: true });
    f.put("node_modules/@playwright/test/cli.js", `require(${JSON.stringify(path.join(playwrightRoot, "node_modules/@playwright/test/cli.js"))});`);
    f.put("package.json", JSON.stringify({ type: "commonjs" }));
    f.put("playwright.config.cjs", "module.exports = { testDir: './e2e', outputDir: 'node_modules/.cache/playwright', workers: 1, reporter: 'line' };\n");
    f.git("add", "playwright.config.cjs", "package.json");
  }
  f.git("add", file, implementation);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "previous ticket supplied tests");
  const plan = {
    requirementId: f.store.read().requirements[0].id,
    sources: { spec: "spec.md", tickets: "tickets.md", attempts: "attempts.md" },
    tickets: [{ key: "R35-05", developerId: f.roles.find(role => role.kind === "developer").id,
      title: "Existing test successor", description: "Change implementation with existing tests", risk: "high", riskReason: "browser behavior",
      writes: [implementation, file], reads: playwrightRoot ? ["playwright.config.cjs", "package.json"] : [], browserE2E: [browser],
      verification: {
        acceptance: [{ id: "AC-5", text: "wizard renders one form" }, { id: "AC-6", text: "other behavior" }],
        testWrites: [file],
        checks: [
          ...["red", "green", "full"].map(stage => ({ id: "r35-05-" + stage, stage, argv: browserCheckArgv(browser),
            inputs: [file], covers: ["AC-5"], ...(stage === "red" && { expectedOutput: "Expected:" }) })),
          { id: "other-full", stage: "full", argv: ["node", "-e", "0"], inputs: [implementation], covers: ["AC-6"] },
        ],
      },
    }],
  };
  return { ...f, plan, preview: input => f.call("Lead", "previewPlan", input ?? plan) };
}

test("native preview accepts the exact R35 red/green browser argv and reports independent binding errors", async t => {
  const f = await successor(t);
  const original = JSON.stringify(f.plan);
  assert.equal(f.preview().state, "valid");
  assert.equal(JSON.stringify(f.plan), original, "preview must not mutate caller arguments");
  for (const covers of [["AC-6"], ["AC-5", "AC-6"]]) {
    const plan = structuredClone(f.plan);
    for (const check of plan.tickets[0].verification.checks.filter(check => ["red", "green"].includes(check.stage))) check.covers = covers;
    const result = f.preview(plan);
    if (covers.includes("AC-5")) { assert.equal(result.state, "valid"); continue; }
    assert.equal(result.state, "invalid");
    assert.deepEqual(result.violations.map(issue => issue.path), [
      "tickets[R35-05].verification.checks.r35-05-red.covers", "tickets[R35-05].verification.checks.r35-05-green.covers",
    ]);
    assert.ok(result.violations.every(issue => issue.message.includes("covers 不一致")));
  }
  const wrongTitle = structuredClone(f.plan);
  const raw = wrongTitle.tickets[0].verification.checks[0].argv;
  raw[5] = "  " + raw[5].replace("wizard", "wizXrd") + "  ";
  const issue = f.preview(wrongTitle).violations.find(issue => issue.path.endsWith("r35-05-red.argv"));
  assert.ok(issue.message.includes("收到 argv=" + JSON.stringify(raw)));
  assert.ok(issue.message.includes("期望 argv=" + JSON.stringify(browserCheckArgv(browser))));
  const equivalent = structuredClone(f.plan);
  equivalent.tickets[0].verification.checks[0].argv = browserCheckArgv(browser).map(arg => " " + arg + " ");
  equivalent.tickets[0].verification.checks[0].argv[3] = equivalent.tickets[0].verification.checks[0].argv[3]
    .replaceAll(String.raw`[/\\]`, String.raw`[\\/]`);
  assert.equal(f.preview(equivalent).state, "valid");
  const schema = f.call("Lead", "schema", { command: "previewPlan" });
  assert.deepEqual(Object.fromEntries(Object.entries(schema.browserChecks.stages).map(([stage, rule]) => [stage, rule.allowed])),
    { red: true, green: true, full: true, regression: true, independent: false, controller: false, batch: false });
});

test("committed browser test runs real Playwright red, green and full without editing the test", {
  skip: !process.env.LINGFLOW_PLAYWRIGHT_ROOT && "Set LINGFLOW_PLAYWRIGHT_ROOT to an installed Playwright project",
}, async t => {
  const f = await successor(t, process.env.LINGFLOW_PLAYWRIGHT_ROOT);
  assert.equal(f.preview().state, "valid");
  const taskId = f.call("Lead", "dispatchPlan", f.plan).tasks[0].taskId;
  const before = readFileSync(path.join(f.root, file));
  const run = async checkId => {
    const { jobId } = f.call("Dev", "check", { taskId, checkId });
    for (let i = 0; i < 300; i++) {
      const job = f.store.read().checkJobs.find(job => job.id === jobId);
      if (!["queued", "launching"].includes(job.state)) {
        assert.equal(job.state, "passed", JSON.stringify(job));
        return job;
      }
      await delay(100);
    }
    assert.fail("browser runner did not finish");
  };
  const red = await run("r35-05-red");
  assert.equal(red.receipt.failureOutputSeen, true);
  f.put(implementation, "new");
  await run("r35-05-green");
  await run("r35-05-full");
  assert.deepEqual(readFileSync(path.join(f.root, file)), before);
  f.git("diff", "--exit-code", "HEAD", "--", file);
});
