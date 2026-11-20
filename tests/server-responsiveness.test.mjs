import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";
import { Store } from "../src/store.mjs";
import { apply } from "../adapters/dsh/index.mjs";

const marker = "git-in-progress";
const preload = `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { workerData } from "node:worker_threads";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
if (workerData) {
  const exec = cp.execFileSync;
  let delayed = false;
  cp.execFileSync = (program, ...args) => {
    const exists = (file) => existsSync(path.join(workerData.dataDir, file));
    if (program === "git" && !delayed && (workerData.readOnly ? exists("block-evidence") : exists("block-writer") || !(exists("block-evidence") || exists("defer-writer")))) {
      delayed = true;
      writeFileSync(path.join(workerData.dataDir, ${JSON.stringify(marker)}), "started");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, exists("long-delay") ? 17000 : 5600);
    }
    return exec(program, ...args);
  };
  syncBuiltinESMExports();
}
`;
const exec = promisify(execFile);

if (process.argv[2] === "probe") {
  await probe(process.argv[3]);
} else {
  test("slow heartbeat Git preflight leaves committed reads and heartbeats responsive", async () => {
    const { stdout } = await exec(process.execPath, [
      "--import", "data:text/javascript," + encodeURIComponent(preload),
      fileURLToPath(import.meta.url), "probe",
    ], { timeout: 25000, windowsHide: true });
    assert.match(stdout, /probe passed/);
    console.log(stdout.trim());
  });
  test("slow evidence returns a bounded partial response without delaying list or wake validation", async () => {
    const { stdout } = await exec(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
      fileURLToPath(import.meta.url), "probe", "evidence"], { timeout: 20000, windowsHide: true });
    console.log(stdout.trim());
  });
  for (const mode of ["check", "check-timeout", "check-async"]) {
    test(`slow Git through the actual DSH tool path preserves receipt in ${mode} mode`, async () => {
      const { stdout } = await exec(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
        fileURLToPath(import.meta.url), "probe", mode], { timeout: 29000, windowsHide: true });
      console.log(stdout.trim());
    });
  }
}

async function probe(mode) {
  mkdirSync(".validation", { recursive: true });
  const fixture = mkdtempSync(path.resolve(".validation", "responsiveness-"));
  const root = path.join(fixture, "project");
  const dataDir = path.join(fixture, "runtime");
  mkdirSync(root);
  writeFileSync(path.join(root, "feature.txt"), "fixture");
  const git = (...args) => exec("git", args, { cwd: root, windowsHide: true });
  await git("init");
  await git("add", "feature.txt");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");

  // Seed the original role bindings before the service opens the database.
  const store = new Store(path.join(dataDir, "workflow.sqlite"));
  store.change((state) => {
    state.projects.push({ id: "project", name: "fixture", root });
    state.roles.push(
      { id: "controller", projectId: "project", kind: "controller", name: "Lead", sessionId: "lead-session" },
      { id: "developer", projectId: "project", kind: "developer", name: "Dev", sessionId: "dev-session" },
    );
    state.requirements.push({ id: "requirement", projectId: "project", text: "fixture", source: "fixture" });
  });
  store.close();
  if (mode === "evidence") writeFileSync(path.join(dataDir, "block-evidence"), "1");
  if (mode?.startsWith("check")) writeFileSync(path.join(dataDir, "defer-writer"), "1");
  const config = readConfig(dataDir);
  config.execution = { projects: { project: { timeouts: {
    ...(mode === "evidence" && { evidenceMs: 4100 }), ...(mode === "check-timeout" && { writeMs: 1000 }),
  } } } };
  writeFileSync(config.path, JSON.stringify(config));

  const app = await startServer({ dataDir, port: 0 });
  const base = "http://127.0.0.1:" + app.port;
  const { bridgeToken } = readConfig(dataDir);
  const post = async (route, token, body, timeout = 5000) => {
    const response = await fetch(base + route, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const bridgeCall = (command) => post("/api/bridge/call", bridgeToken, { command, sessionId: "dev-session" });
  const heartbeat = () => post("/api/bridge/heartbeat", bridgeToken, {
    sessions: [{ id: "dev-session", state: "idle", pending: 0, jobs: 0 }],
  });
  try {
    await app.workflow.call("ui", "enable", { roleId: "developer", enabled: true }, "enable-dev");
    await bridgeCall("inbox");
    // Only the normal heartbeat scheduler can admit this persisted ticket.
    const fixtureStore = new Store(path.join(dataDir, "workflow.sqlite"));
    try {
      fixtureStore.change((state) => state.tasks.push({
        id: "ticket", projectId: "project", requirementId: "requirement", title: "fixture",
        developerId: "developer", assignee: "developer", revision: 1, state: "queued", risk: "low",
        writes: ["feature.txt"], reads: [], resources: [], dependencies: [], ownedDirty: [],
        reports: [], reviews: [], questions: [], verification: { testWrites: [], checks: mode?.startsWith("check") ? [{
          id: "green", stage: "green", argv: ["node", "-e", "process.stdout.write('fixture passed')"],
          inputs: ["feature.txt"], covers: [], timeoutMs: 10000, expectedExit: 0,
        }] : [] },
      }));
    } finally {
      fixtureStore.close();
    }
    if (mode?.startsWith("check")) {
      await heartbeat();
      const toolsModule = path.join(dataDir, "define-tool.mjs");
      writeFileSync(toolsModule, "export const defineTool = (tool) => tool");
      writeFileSync(config.path, JSON.stringify({ ...config, port: app.port }));
      const definitions = new Map(), effects = [];
      const agent = { id: "dev-session", status: "idle", inbox: { nextTurn: [], nextStep: [] },
        ctx: { tools: { register: (tool) => definitions.set(tool.name, tool) } } };
      await apply({ agents: { list: () => [agent], get: () => agent }, on() {}, sessionController: {},
        logger: () => ({ warn() {} }), effect: (fn) => effects.push(fn()) }, { dataDir, toolsModule });
      try {
        const call = (command, args, operationId) => definitions.get("lingflow_team").execute({ command, args: JSON.stringify(args), operationId }, { agent });
        const args = { taskId: "ticket", checkId: "green", ...(mode === "check-async" && { async: true }) };
        const op = "stable-check";
        if (mode === "check") writeFileSync(path.join(dataDir, "long-delay"), "1");
        writeFileSync(path.join(dataDir, "block-writer"), "1");
        const start = performance.now();
        const result = await call("check", args, op);
        const elapsed = Math.round(performance.now() - start);
        if (mode === "check-timeout") {
          assert.equal(result.error, "timeout");
          assert.equal(result.phase, "ownership-fingerprint");
          assert.equal(result.scannedFiles, 0);
          assert.equal(result.operationId, op);
          assert.ok(elapsed < 2500);
        } else {
          assert.ok(result.jobId);
          if (mode === "check-async") assert.ok(elapsed < 1000);
          else assert.ok(elapsed >= 17000);
        }
        let receipt;
        for (let n = 0; n < 80; n++) {
          receipt = await call("operation", { id: op });
          if (receipt.state === "stored") break;
          await delay(100);
        }
        assert.equal(receipt.state, "stored");
        const id = receipt.result.jobId;
        assert.equal((await call("check", args, op)).jobId, id);
        assert.equal((await call("checkStatus", { taskId: "ticket" })).length, 1);
        assert.equal((await call("checkStatus", { jobId: id })).source, "dsh-adapter");
        if (mode === "check-async") {
          let job;
          for (let n = 0; n < 110; n++) {
            job = await call("checkStatus", { jobId: id });
            if (["passed", "failed", "stale", "uncertain"].includes(job.state)) break;
            await delay(100);
          }
          assert.equal(job.state, "passed", job.error);
          const directReplay = await post("/api/bridge/call", bridgeToken, { sessionId: "dev-session", command: "check", args, operationId: op });
          assert.equal(directReplay.source, "bridge-direct");
          assert.equal(directReplay.jobId, id);
        }
        console.log(`${mode}: result returned in ${elapsed} ms; original check record ${id} was stored exactly once`);
      } finally { for (const dispose of effects) if (typeof dispose === "function") dispose(); }
      return;
    }
    if (mode === "evidence") {
      let wake;
      for (let attempt = 0; attempt < 30 && !wake; attempt++) {
        if (attempt) await delay(50);
        [wake] = (await heartbeat()).deliveries;
      }
      assert.ok(wake, "the fixture must have a pending wake before concurrent validation");
      const taskCall = (command, timeout) => post("/api/bridge/call", bridgeToken,
        { command, sessionId: "dev-session", args: { taskId: "ticket" } }, timeout);
      const started = performance.now();
      const diagnostic = taskCall("diagnoseTask", 7000);
      void diagnostic.catch(() => {});
      for (let i = 0; i < 100 && !existsSync(path.join(dataDir, marker)); i++) await delay(20);
      assert.ok(existsSync(path.join(dataDir, marker)));
      const quick = performance.now();
      const [list, valid, inspect, evidence] = await Promise.all([
        bridgeCall("list"), post("/api/bridge/valid", bridgeToken, { wakeId: wake.id, sessionId: wake.sessionId }),
        taskCall("inspect"), taskCall("deliveryEvidence"),
      ]);
      const quickMs = Math.round(performance.now() - quick);
      assert.ok(quickMs < 1000);
      assert.equal(list.tasks[0].deliveryState, "pending");
      assert.deepEqual(valid, { valid: true });
      assert.equal(inspect.id, "ticket");
      assert.equal(inspect.evidence.available, false);
      assert.equal(evidence.evidence.available, false);
      const partial = await diagnostic;
      const evidenceMs = Math.round(performance.now() - started);
      assert.ok(evidenceMs < 5000);
      assert.equal(partial.taskId, "ticket");
      assert.equal(partial.evidence.available, false);
      assert.equal(partial.evidence.reason, "evidence-timeout");
      console.log(`partial evidence ${evidenceMs} ms, concurrent list/inspect/wake validation ${quickMs} ms`);
      return;
    }
    const start = performance.now();
    const pendingHeartbeat = heartbeat();
    // Attach the rejection handler while waiting for the slow call to begin.
    void pendingHeartbeat.catch(() => {});
    for (let i = 0; i < 150 && !existsSync(path.join(dataDir, marker)); i++) await delay(20);
    assert.equal(readFileSync(path.join(dataDir, marker), "utf8"), "started");

    const readsStarted = performance.now();
    const [health, list, guide, secondHeartbeat] = await Promise.all([
      fetch(base + "/api/ui/hello", { signal: AbortSignal.timeout(5000) }),
      bridgeCall("list"),
      bridgeCall("guide"),
      heartbeat(),
    ]);
    const readMs = Math.round(performance.now() - readsStarted);
    assert.equal(health.status, 200);
    assert.equal(list.tasks[0].state, "queued");
    assert.match(guide.guide, /快速模式/);
    assert.deepEqual(secondHeartbeat.deliveries, []);
    assert.ok(readMs < 1500, "concurrent requests took " + readMs + " ms");
    assert.deepEqual((await pendingHeartbeat).deliveries, []);
    const heartbeatMs = Math.round(performance.now() - start);
    assert.ok(heartbeatMs < 2000, "first heartbeat took " + heartbeatMs + " ms");

    for (let i = 0; i < 200; i++) {
      const snapshot = await app.workflow.snapshot();
      if (snapshot.tasks[0].state === "assigned") {
        assert.equal(snapshot.notices.filter((n) => n.taskId === "ticket").length, 1);
        let deliveries = [];
        for (let attempt = 0; attempt < 20 && !deliveries.length; attempt++) {
          ({ deliveries } = await heartbeat());
          if (!deliveries.length) await delay(25);
        }
        assert.equal(deliveries.length, 1);
        const { id: wakeId, sessionId } = deliveries[0];
        assert.equal(wakeId, snapshot.wakes.at(-1).id);
        assert.deepEqual(await post("/api/bridge/valid", bridgeToken, { wakeId, sessionId }), { valid: true });
        assert.deepEqual(await post("/api/bridge/ack", bridgeToken, { wakeId, sessionId }), { state: "stored" });
        assert.equal((await bridgeCall("inbox")).tasks[0].id, "ticket");
        assert.deepEqual((await heartbeat()).deliveries, []);
        console.log(`probe passed: concurrent reads and second heartbeat ${readMs} ms, first heartbeat ${heartbeatMs} ms`);
        return;
      }
      await delay(50);
    }
    assert.fail("The original ticket was never admitted after Git preflight");
  } finally {
    await app.close();
  }
}
