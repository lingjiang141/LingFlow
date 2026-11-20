import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { activeDshJobs } from "./telemetry.mjs";
import { turnBlocksDelivery } from "../../src/wake-policy.mjs";

const maxAttempts = 4;
const renameWait = new Int32Array(new SharedArrayBuffer(4));

// Persistent intent + stable DSH request ID. Never retry an uncertain admission blindly.
export function createRelay({ file, agents, controller, api, signal, activeJobs = activeDshJobs, ensureTools, observe }) {
  const ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const lanes = new Map();
  const inFlight = new Map();
  const deferred = new Map();
  function pendingInput(agent) {
    const nextTurn = agent?.inbox?.nextTurn;
    const nextStep = agent?.inbox?.nextStep;
    if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) return {};
    const canDropPendingInput = typeof agent.runMaintenance === "function" && typeof agent.inbox.remove === "function";
    const items = [...nextTurn, ...nextStep];
    if (!items.length) return { pendingInputKinds: [] };
    const kinds = items.map(item => {
      const requestId = item?.source?.rpcId;
      if (typeof requestId === "string" && requestId.startsWith("lingflow-")) {
        const wakeId = requestId.slice("lingflow-".length).replace(/-g\d+$/, "");
        const entry = ledger[`${agent.id}:${wakeId}`];
        if (entry?.admittedIds?.includes(requestId) || entry?.state === "admitted" && entry.requestId === requestId) return "lingflow";
      }
      return item?.id || requestId ? "host" : "unknown";
    });
    const pendingInputKinds = [...new Set(kinds)];
    if (pendingInputKinds.includes("unknown")) return { pendingInputKinds };
    const identities = batch => batch.map(item => [item.id ?? null, item.source?.rpcId ?? null, item.content ?? null]);
    const pendingInputFingerprint = createHash("sha256").update(JSON.stringify([identities(nextTurn), identities(nextStep)])).digest("hex");
    return { pendingInputKinds, pendingInputFingerprint, canDropPendingInput,
      ...(canDropPendingInput && { pendingInputIds: items.map(item => item.id ?? null) }) };
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(ledger), { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 3) throw error;
        // Retry only the atomic replacement while a Windows reader holds the file.
        Atomics.wait(renameWait, 0, 0, 8 * 2 ** attempt);
      }
    }
  };
  function observed(agent, requestId) {
    try {
      const messages = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
      const events = agent.session.snapshotEvents();
      const matches = (m) => m?.source?.rpcId === requestId;
      if (
        messages.some(matches) ||
        events.some(
          (e) =>
            (e.type === "user/message" && matches(e.data)) ||
            (e.type === "agent/inbox/spliced" &&
              e.data?.inserted?.some(matches)),
        )
      )
        return true;
      return false;
    } catch {
      return null;
    }
  }
  const acknowledge = (wake, entry) => api("ack", {
    wakeId: wake.id, sessionId: wake.sessionId,
    delivery: { attempt: entry.attempt??1, generation: entry.generation??0, outcomes: entry.outcomes??[] },
  });
  async function deliver(wake) {
    if (wake.dropPendingInput) return dropPendingInput(wake);
    const key = wake.sessionId + ":" + wake.id;
    const agent = agents.get(wake.sessionId);
    if (ensureTools && (!agent || !ensureTools(agent))) {
      deferred.set(wake.sessionId, { id: key, state: "waiting", reason: "bridge-tools-missing" });
      return;
    }
    let entry = ledger[key];
    const generation = wake.deliveryRetry ?? 0;
    if(entry && (entry.generation??0)!==generation) {
      if(generation<(entry.generation??0))return;
      if(['intent','uncertain'].includes(entry.state)) {
        const oldId=entry.requestId??('lingflow-'+wake.id+((entry.generation??0)?'-g'+entry.generation:''));
        if(observed(agent,oldId)!==true) {
          deferred.set(wake.sessionId,{id:key,state:'waiting',reason:'uncertain'});
          return;
        }
        entry.state='admitted';save();
      }
      entry=undefined;
    }
    if (entry?.state === "admitted") {
      await acknowledge(wake, entry);
      return;
    }
    const requestId = "lingflow-" + wake.id + (generation?"-g"+generation:"");
    if (entry && ["intent", "uncertain"].includes(entry.state)) {
      const known = observed(agent, requestId);
      if (known === true) {
        entry.state = "admitted";
        save();
        await acknowledge(wake, entry);
        return;
      }
      // A previous request may have been accepted after the last observed event.
      if (entry.state !== "uncertain") {
        entry.state = "uncertain";
        if (entry.attempt) entry.outcomes.push({ attempt: entry.attempt, at: Date.now(), result: "uncertain" });
        save();
      }
      return;
    }
    if (entry?.state === "exhausted" || Date.now() < (entry?.retryAt ?? 0)) return;
    const protectedController = Object.hasOwn(wake, "controllerTurnId");
    const intervention = wake.taskIntervention === true && !protectedController;
    const queuedInputFingerprint = protectedController ? null : wake.queuedInputFingerprint;
    let promptMode;
    const ready = () => {
      if (ensureTools && !ensureTools(agent)) {
        deferred.set(wake.sessionId, { id: key, state: "waiting", reason: "bridge-tools-missing" });
        return false;
      }
      const jobs = intervention ? 0 : agent && activeJobs(agent);
      const observation = (protectedController || intervention) && agent ? observe?.(agent) : undefined;
      const steerIntervention = intervention && agent?.status === "running";
      const phaseBlocked = steerIntervention ? observation?.compacting : turnBlocksDelivery(observation);
      const queueReady = queuedInputFingerprint
        ? pendingInput(agent).pendingInputFingerprint === queuedInputFingerprint
        : agent?.inbox?.nextTurn?.length === 0 && agent?.inbox?.nextStep?.length === 0;
      const reason = !agent || agents.get(wake.sessionId) !== agent ? "offline" :
        agent.status !== "idle" && !steerIntervention ? "session-busy" :
        phaseBlocked ? (protectedController ? "controller-turn" : "session-busy") :
        !steerIntervention && !queueReady ? "inbox-not-empty" :
        protectedController && wake.controllerTurnId !== (observation?.turn?.id ?? null) ? "turn-boundary-changed" :
        !intervention && jobs === null ? "jobs-unknown" : !intervention && jobs > 0 ? "background-jobs" : null;
      if (reason) deferred.set(wake.sessionId, { id: key, state: "waiting", reason });
      else deferred.delete(wake.sessionId);
      promptMode = steerIntervention || queuedInputFingerprint ? "steer" : "queue";
      return !reason;
    };
    if (!ready()) return;
    try {
      if (!(await api("valid", { wakeId: wake.id, sessionId: wake.sessionId, generation })).valid) return;
    } catch (error) {
      deferred.set(wake.sessionId, { id: key, state: "waiting", reason: "validation-unavailable" });
      throw error;
    }
    if (!ready()) return;
    const attempt = (entry?.attempt ?? 0) + 1;
    const previous = ledger[key];
    const admittedIds = [...new Set([...(previous?.admittedIds ?? []), ...(previous?.state === "admitted" ? [previous.requestId] : [])])].slice(-8);
    ledger[key] = entry = { state: "intent", requestId, attempt, generation, at: Date.now(), outcomes: entry?.outcomes ?? [],
      ...(admittedIds.length && { admittedIds }) };
    try {
      save();
    } catch (error) {
      if (previous) ledger[key] = previous;
      else delete ledger[key];
      deferred.set(wake.sessionId, { id: key, state: "waiting", reason: "ledger-unavailable" });
      throw error;
    }
    let response;
    let failure;
    try {
      const timeout = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
      response = await Promise.race([controller.prompt(
        {
          sessionId: wake.sessionId,
          requestId,
          content: [{ type: "text", text: wake.text }],
          mode: promptMode,
        },
        timeout,
      ), new Promise((_, reject) => timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }))]);
    } catch (error) {
      failure = error;
    }
    if (response?.accepted === true || observed(agents.get(wake.sessionId), requestId) === true) {
      entry.state = "admitted";
      save();
      // The host can rebuild a preset while accepting the prompt. Keep the
      // accepted identity, but withhold ACK until that registry is repaired.
      if (ensureTools && !ensureTools(agents.get(wake.sessionId))) {
        deferred.set(wake.sessionId, { id: key, state: "waiting", reason: "bridge-tools-missing" });
        return;
      }
      await acknowledge(wake, entry);
      return;
    }
    const rejected = response?.accepted === false || (failure?.isDSHRemoteError === true &&
      ["session/agent-busy", "session/not-found"].includes(failure.code));
    const at = Date.now();
    if (rejected) {
      entry.state = attempt >= maxAttempts ? "exhausted" : "retry";
      entry.retryAt = at + 2000 * 2 ** (attempt - 1);
    } else entry.state = "uncertain";
    entry.outcomes.push({ attempt, at, result: rejected ? "rejected" : "uncertain" });
    save();
    if (!rejected) throw Error("DSH 投递结果待对账；保留原唤醒编号，不重复入队");
  }
  async function dropPendingInput(wake) {
    const key = "drop:" + wake.sessionId + ":" + wake.id;
    const ack = inputDrop => api("ack", { wakeId: wake.id, sessionId: wake.sessionId, delivery: { inputDrop } });
    if (ledger[key]?.inputDrop) return ack(ledger[key].inputDrop);
    const agent = agents.get(wake.sessionId);
    if (!agent || agent.status !== "idle" || activeJobs(agent) !== 0 ||
        typeof agent.runMaintenance !== "function" || typeof agent.inbox.remove !== "function") return;
    if (!(await api("valid", { wakeId: wake.id, sessionId: wake.sessionId })).valid || agents.get(wake.sessionId) !== agent) return;
    const inputDrop = await agent.runMaintenance(async signal => {
      signal?.throwIfAborted();
      if (activeJobs(agent) !== 0 || pendingInput(agent).pendingInputFingerprint !== wake.queuedInputFingerprint)
        return { state: "queue-changed", ids: [] };
      const items = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
      if (items.some(item => typeof item.id !== "string" || !item.id || item.id.length > 200))
        return { state: "queue-changed", ids: [] };
      const ids = [];
      for (const item of items) {
        try {
          if (!agent.inbox.remove(item.id)) return { state: "partial", ids };
          ids.push(item.id);
        } catch { return { state: "partial", ids }; }
      }
      return { state: "dropped", ids };
    });
    ledger[key] = { inputDrop };
    save();
    return ack(inputDrop);
  }
  function enqueue(wake) {
    const sessionId = wake.sessionId;
    const key = `${sessionId}:${wake.id}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const run = (lanes.get(sessionId) ?? Promise.resolve()).then(() => {
      signal?.throwIfAborted();
      return deliver(wake);
    });
    const tail = run.catch(() => {});
    lanes.set(sessionId, tail);
    inFlight.set(key, run);
    void tail.then(() => {
      if (lanes.get(sessionId) === tail) lanes.delete(sessionId);
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
    return run;
  }
  return {
    pendingInput,
    async accept(wakes) {
      const results = await Promise.allSettled(wakes.map(enqueue));
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
    },
    diagnostics() {
      return [...Object.entries(ledger)
        .filter(([, v]) => ["intent", "uncertain", "retry", "exhausted"].includes(v.state))
        .map(([id, v]) => ({ id, ...v, generation: v.generation ?? 0 })), ...deferred.values()];
    },
  };
}
