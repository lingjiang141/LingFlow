import { inspectedEntities, inspectionMetadata } from "./controller-notices.mjs";
import { Worker } from "node:worker_threads";
import { commandTimeout, commandTimeoutResult, executionPolicy } from "./execution-policy.mjs";

const readCommands = new Set([
  "guide", "schema", "context", "operation", "checkStatus", "inspectPlan",
  "messages", "list", "inspect", "scopePreview", "cacheDiagnostics", "buildCache",
]);
const evidenceCommands = new Set(["checkEvidence", "deliveryEvidence", "previewPlan", "diagnoseTask", "describeDrift", "governance"]);
const heartbeatBudgetMs = 650;

async function startWorker(dataDir, readOnly, execution) {
  const worker = new Worker(new URL("./workflow-worker.mjs", import.meta.url), {
    name: readOnly ? "lingflow-reader" : "lingflow-writer",
    workerData: { dataDir, readOnly, execution },
  });
  const pending = new Map();
  let nextId = 0;
  let failure;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  worker.on("message", ({ ready, id, result, error, verificationCode, violations, nextAction, unownedWrites, blockers, progress, inspection }) => {
    if (ready) return resolveReady();
    const request = pending.get(id);
    if (!request) return;
    if (progress) return request.onProgress?.(progress);
    pending.delete(id);
    if (error !== undefined) request.reject(Object.assign(Error(error), { verificationCode, violations, nextAction, unownedWrites, blockers }));
    else {
      if (inspection && result && typeof result === "object") Object.defineProperty(result, inspectionMetadata, { value: inspection });
      request.resolve(result);
    }
  });
  function stopped(error) {
    failure ??= error;
    rejectReady(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  }
  worker.on("error", stopped);
  const exited = new Promise((resolve) => worker.once("exit", (code) => {
    stopped(Error("LingFlow 工作流线程已退出（" + code + "）"));
    resolve();
  }));

  async function submit(method, args, onProgress, timeoutMs) {
    if (failure) throw failure;
    if (pending.size >= 64 && method !== "close")
      throw Error("LingFlow 工作流正在处理其他请求，请稍后重试");
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      worker.postMessage({ id, method, args, trackProgress: Boolean(onProgress), timeoutMs });
      pending.set(id, { resolve, reject, onProgress });
    });
  }
  await ready;
  return {
    run: (method, ...args) => submit(method, args),
    submit,
    terminate: () => worker.terminate(),
    async close() {
      if (!failure) {
        try {
          await submit("close", []);
        } catch {
          await worker.terminate();
        }
      }
      await exited;
    },
  };
}

export async function startWorkflowRuntime(dataDir, execution) {
  // The writer owns scheduling, receipts and check recovery. The reader sees
  // only committed data through a separate SQLite connection in WAL mode.
  const writer = await startWorker(dataDir, false, execution);
  let reader;
  try {
    reader = await startWorker(dataDir, true, execution);
  } catch (error) {
    await writer.close();
    throw error;
  }
  let evidenceWorker;
  let evidenceBusy = false;
  const defaultPolicy = executionPolicy(execution);
  async function policy(sessionId, command, args, provider) {
    return execution?.projects ? reader.run("commandPolicy", sessionId, command, args, provider) :
      { timeoutMs: commandTimeout(command, defaultPolicy) };
  }
  async function withDeadline(work, ms, fallback) {
    let timer;
    try {
      return await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback()), ms); })]);
    } finally { clearTimeout(timer); }
  }
  async function readEvidence(args, timeoutMs, timeoutResult, onProgress) {
    const partial = (reason) => reader.run("call", ...args, reason);
    if (evidenceBusy) return partial("evidence-busy");
    evidenceBusy = true;
    const worker = evidenceWorker ??= startWorker(dataDir, true, execution);
    const work = worker.then((lane) => lane.submit("call", args, onProgress, timeoutMs));
    let timedOut = false;
    try {
      return await withDeadline(work, timeoutMs, async () => {
        timedOut = true;
        void worker.then((lane) => lane.terminate()).catch(() => {}).finally(() => {
          evidenceWorker = undefined;
          evidenceBusy = false;
        });
        const timeout = timeoutResult();
        return { ...await partial("evidence-timeout"), ...timeout };
      }).then(async (result) => result?.classification === "ownership-timeout" ?
        { ...await partial("evidence-timeout"), ...timeoutResult() } : result).catch(async (error) => {
        if (error.verificationCode !== "ownership-timeout") throw error;
        return { ...await partial("evidence-timeout"), ...timeoutResult() };
      });
    } finally {
      if (!timedOut) evidenceBusy = false;
    }
  }

  const heartbeats = new Map([
    ["dsh", { pending: false, deliveries: [] }],
    ["codex", { pending: false, deliveries: [] }],
  ]);
  async function heartbeat(sessions, now = Date.now(), provider = "dsh") {
    if (!Array.isArray(sessions) || sessions.length > 100) throw Error("sessions 无效");
    const heartbeat = heartbeats.get(provider);
    if (!heartbeat) throw Error("未知会话类型");
    // A timed out reply can leave pending wakes in SQLite. The next poll can
    // offer those same IDs and the relay still verifies them before admission.
    const available = heartbeat.deliveries.filter((wake) => sessions.some((session) =>
      session?.id === wake.sessionId && !session.toolsMissing?.length &&
      (wake.taskIntervention && session.state === "running" || session.state === "idle" &&
        (wake.queuedInputFingerprint ? session.pendingInputFingerprint === wake.queuedInputFingerprint && (wake.taskIntervention || session.jobs === 0)
          : session.pending === 0 && (wake.taskIntervention || !(session.jobs > 0)))),
    ));
    heartbeat.deliveries = [];
    if (available.length || heartbeat.pending) return { deliveries: available };

    heartbeat.pending = true;
    let deferred = false;
    const work = writer.run("heartbeat", sessions, now, provider).then((result) => {
      if (deferred) heartbeat.deliveries = result.deliveries;
      return result;
    }).finally(() => { heartbeat.pending = false; });
    let timer;
    try {
      return await Promise.race([work, new Promise((resolve) => {
        timer = setTimeout(() => {
          deferred = true;
          resolve({ deliveries: [] });
        }, heartbeatBudgetMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    workflow: {
      snapshot: () => reader.run("snapshot"),
      catalog: () => reader.run("catalog"),
      bridgeBindings: () => reader.run("bridgeBindings"),
      validWake: (...args) => reader.run("validWake", ...args),
      request: (...args) => writer.run("request", ...args),
      acknowledge: (...args) => writer.run("acknowledge", ...args),
      commandPolicy: (...args) => reader.run("commandPolicy", ...args),
      call: async (sessionId, command, args, operationId, provider = "dsh", source) => {
        const observedAt = Date.now();
        const started = performance.now();
        const { timeoutMs } = await policy(sessionId, command, args, provider);
        const input = [sessionId, command, args, operationId, provider];
        let progress = { phase: "queued" };
        const onProgress = (update) => { progress = { ...progress, ...update }; };
        const timeout = () => commandTimeoutResult({ command, args, operationId }, Math.round(performance.now() - started), progress);
        const reconcileTimeout = async () => {
          const result = timeout();
          if (command !== "rebindCommittedWork" || !operationId) return result;
          const receipt = await withDeadline(reader.run("call", sessionId, "operation", { id: operationId }, undefined, provider),
            200, () => null).catch(() => null);
          return receipt?.state === "stored" ? { ...result, state: "applied", result: receipt.result,
            next: "原 operationId 已落库；使用原编号重试可读取同一结果，不会重复重绑。" } : result;
        };
        const result = await (evidenceCommands.has(command) ? readEvidence(input, timeoutMs, timeout, onProgress) : withDeadline(
          (readCommands.has(command) ? reader : writer).submit("call", [...input, undefined, source], onProgress, timeoutMs), timeoutMs, reconcileTimeout)
          .catch((error) => { if (error.verificationCode === "ownership-timeout") return reconcileTimeout(); throw error; }));
        const observed = inspectedEntities(command, args, result);
        if (observed && result?.[inspectionMetadata]) void writer.run("recordInspection", sessionId, observed, observedAt, provider).catch(() => {});
        return result;
      },
      heartbeat,
    },
    async close() {
      await Promise.all([reader.close(), writer.close(), evidenceWorker?.then((lane) => lane.terminate()).catch(() => {})]);
    },
  };
}
