import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./helpers/evidence-fixture.mjs";
import { gitState, scopeBaseline } from "../src/quality.mjs";
import { commandTimeout, executionPolicy } from "../src/execution-policy.mjs";
import { startServer } from "../src/server.mjs";
import { readConfig } from "../src/config.mjs";
import { apply } from "../adapters/dsh/index.mjs";

const preload = `
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import path from 'node:path';
if (workerData && !workerData.readOnly) {
  const exec = cp.execFileSync;
  const read = fs.readFileSync;
  let delayed = false;
  cp.execFileSync = (program, ...args) => {
    if (program === 'git' && !delayed && existsSync(path.join(workerData.dataDir, 'delay-rebind'))) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 17000);
    }
    return exec(program, ...args);
  };
  fs.readFileSync = (file, ...args) => {
    if (!delayed && typeof file === 'string' && path.basename(file) === 'outside-99.txt' &&
        existsSync(path.join(workerData.dataDir, 'delay-fingerprint'))) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
    return read(file, ...args);
  };
  syncBuiltinESMExports();
}`;

async function commitImplementation(f) {
  f.put(f.testFile, "require('node:assert/strict').equal(require('../implementation.cjs'), 'new');");
  assert.equal((await f.run("red")).state, "passed");
  f.put("implementation.cjs", "module.exports = 'new';");
  f.git("add", "implementation.cjs", f.testFile);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "controller candidate");
  f.call("Dev", "yieldForSchedule", { taskId: f.taskId, reason: "stop for baseline reconciliation" });
  const diagnostic = f.call("Lead", "diagnoseTask", { taskId: f.taskId });
  assert.equal(diagnostic.nextAction?.command, "rebindCommittedWork", JSON.stringify(diagnostic));
  return { ...diagnostic.nextAction.args, reason: "confirmed implementation commit belongs to original ticket" };
}

if (process.argv[2] === "probe") {
  const disposers = [];
  const fingerprintTimeout = process.argv[3] === "fingerprint-timeout";
  const f = await fixture({ after: fn => disposers.push(fn) }, "AssertionError", { untrackedFiles: fingerprintTimeout ? 130 : 0 });
  const args = await commitImplementation(f);
  f.close();
  const config = readConfig(f.dir);
  const timeout = process.argv[3].includes("timeout");
  config.execution = { timeouts: { evidenceMs: fingerprintTimeout ? 1500 : timeout ? 1000 : 60000 } };
  writeFileSync(config.path, JSON.stringify(config));
  const app = await startServer({ dataDir: f.dir, port: 0 });
  const effects = [];
  try {
    const lead = f.roles.find(role => role.kind === "controller");
    await app.workflow.call("ui", "enable", { roleId: lead.id, enabled: true }, "reenable");
    await app.workflow.call("Lead", "inbox");
    writeFileSync(config.path, JSON.stringify({ ...config, port: app.port }));
    const toolsModule = path.join(f.dir, "define-tool.mjs");
    writeFileSync(toolsModule, "export const defineTool = x => x;");
    let tool;
    const agent = { id: "Lead", status: "idle", inbox: { nextTurn: [], nextStep: [] },
      ctx: { tools: { register: definition => { tool = definition; } } } };
    await apply({ agents: { list: () => [agent], get: () => agent }, on() {}, sessionController: {},
      logger: () => ({ warn() {} }), effect: fn => effects.push(fn()) }, { dataDir: f.dir, toolsModule });
    const call = (command, args, operationId) => tool.execute({ command, args: JSON.stringify(args), operationId }, { agent });
    writeFileSync(path.join(f.dir, fingerprintTimeout ? "delay-fingerprint" : "delay-rebind"), "1");
    const start = performance.now();
    const result = await call("rebindCommittedWork", args, "same-rebind");
    const elapsedMs = Math.round(performance.now() - start);
    if (timeout) {
      assert.equal(result.error, "timeout");
      assert.equal(result.phase, "ownership-fingerprint");
      assert.equal(result.state, "unknown");
      assert.equal(result.operationId, "same-rebind");
      assert.equal(typeof result.scannedFiles, "number");
      if (fingerprintTimeout) assert.equal(result.scannedFiles, 128);
      assert.ok(elapsedMs < 2000, JSON.stringify(result));
    } else {
      assert.equal(result.state, "applied");
      assert.ok(elapsedMs >= 17000);
    }
    let receipt;
    for (let i = 0; i < 220; i++) {
      receipt = await call("operation", { id: "same-rebind" });
      if (receipt.state === "stored") break;
      await delay(100);
    }
    assert.equal(receipt.state, "stored");
    const replay = await call("rebindCommittedWork", args, "same-rebind");
    assert.equal(replay.state, "applied");
    assert.deepEqual(replay.summary, receipt.result.summary);
    assert.equal((await app.workflow.snapshot()).tasks[0].scheduleHistory.length, 1);
    console.log(JSON.stringify({ mode: process.argv[3], elapsedMs, state: result.state, phase: result.phase,
      scannedFiles: replay.scannedFiles, replay: replay.state, history: 1 }));
  } finally {
    for (const dispose of effects) if (typeof dispose === "function") dispose();
    await app.close(); for (const dispose of disposers) dispose();
  }
} else {
  test("rebind, diagnose and delivery use the same configurable evidence budget", () => {
    for (const command of ["rebindCommittedWork", "diagnoseTask", "deliveryEvidence"]) {
      assert.equal(commandTimeout(command, executionPolicy()), 60000);
      assert.equal(commandTimeout(command, executionPolicy({ timeouts: { evidenceMs: 90000 } })), 90000);
    }
    assert.equal(commandTimeout("list", executionPolicy()), 5000);
  });
  test("rebind reports filtered ownership counts and retry never appends another baseline", async t => {
    const f = await fixture(t);
    const count = process.env.LINGFLOW_LARGE_FIXTURE === "1" ? 80000 : 80;
    for (const dir of ["node_modules", "apps/web/dist"]) mkdirSync(path.join(f.root, dir), { recursive: true });
    for (let i = 0; i < count; i++) f.put((i % 2 ? "node_modules/" : "apps/web/dist/") + i + ".txt", "noise");
    const args = await commitImplementation(f);
    const start = performance.now();
    const result = f.call("Lead", "rebindCommittedWork", args, "rebind-once");
    const elapsedMs = Math.round(performance.now() - start);
    assert.equal(result.state, "applied");
    assert.equal(result.scannedFiles, 0);
    assert.ok(elapsedMs < 60000);
    const replay = f.call("Lead", "rebindCommittedWork", args, "rebind-once");
    assert.deepEqual(replay, result);
    const task = f.store.read().tasks[0];
    assert.equal(task.scheduleHistory.length, 1);
    const rawGit = gitState(f.root, task, []);
    scopeBaseline(f.root, task, [], rawGit);
    assert.equal(rawGit.ownershipMetrics.scannedFiles, count);
    console.log(JSON.stringify({ noiseFiles: count, rebindMs: elapsedMs, filtered: result.scannedFiles, unfiltered: rawGit.ownershipMetrics.scannedFiles }));
  });
  for (const mode of ["slow", "timeout", "fingerprint-timeout"]) test(`DSH adapter rebind ${mode} preserves original operation`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
      fileURLToPath(import.meta.url), "probe", mode], { timeout: 45000, windowsHide: true });
    console.log(stdout.trim());
  });
}
