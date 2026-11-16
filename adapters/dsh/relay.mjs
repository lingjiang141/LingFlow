import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { activeDshJobs } from "./telemetry.mjs";

const maxAttempts = 4;

// Persistent intent + stable DSH request ID. Never retry an uncertain admission blindly.
export function createRelay({ file, agents, controller, api, signal, activeJobs = activeDshJobs, ensureTools }) {
  const ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const lanes = new Map();
  const inFlight = new Map();
  const deferred = new Map();
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(ledger), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
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
    const ready = () => {
      if (ensureTools && !ensureTools(agent)) {
        deferred.set(wake.sessionId, { id: key, state: "waiting", reason: "bridge-tools-missing" });
        return false;
      }
      const jobs = agent && activeJobs(agent);
      const reason = !agent || agents.get(wake.sessionId) !== agent ? "offline" : agent.status !== "idle" ? "session-busy" :
        agent.inbox?.nextTurn?.length !== 0 || agent.inbox?.nextStep?.length !== 0 ? "inbox-not-empty" :
        jobs === null ? "jobs-unknown" : jobs > 0 ? "background-jobs" : null;
      if (reason) deferred.set(wake.sessionId, { id: key, state: "waiting", reason });
      else deferred.delete(wake.sessionId);
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
    ledger[key] = entry = { state: "intent", requestId, attempt, generation, at: Date.now(), outcomes: entry?.outcomes ?? [] };
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
          mode: "queue",
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
