const activityEvents = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "tool/call",
  "tool/result",
  "assistant/message",
  "job/registered",
  "job/settled",
]);

export function activeDshJobs(agent, host) {
  for (const owner of [() => host?.jobs, () => agent.ctx?.jobs]) {
    try {
      const jobs = owner()?.list(agent.id);
      if (Array.isArray(jobs))
        return jobs.filter((job) => ["running", "stopping"].includes(job.status)).length;
    } catch {
      // Some hosts expose a scoped service that is inaccessible to the bridge.
    }
  }
  try {
    const active = new Set();
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === "job/registered") active.add(event.data.jobId);
      if (event.type === "job/settled") active.delete(event.data.jobId);
    }
    return active.size;
  } catch {
    return null;
  }
}

function endState(reason) {
  if (/continuation[_-]limit|auto.*continu.*limit/i.test(String(reason?.kind ?? reason?.code ?? "")))
    return { outcome: "failed", code: "continuation-limit" };
  const cause = reason?.reason;
  const failureKinds = ["error", "provider", "provider-error"];
  if (
    failureKinds.includes(reason?.kind) ||
    failureKinds.includes(cause?.kind)
  ) {
    const error = reason?.error ?? cause?.error ?? cause ?? reason;
    const code =
      String(
        error?.code ??
          error?.status ??
          reason?.code ??
          cause?.code ??
          "UNKNOWN",
      )
        .replace(/[^a-z0-9_-]/gi, "")
        .slice(0, 60) || "UNKNOWN";
    const detail = String(
      error?.message ?? reason?.message ?? cause?.message ?? "",
    ).slice(0, 1000);
    const retryableCode =
      /^(408|429|5\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|network[_-]?error|timeout|overloaded|server[_-]?error|rate[_-]?limit(?:_exceeded)?)$/i;
    const permanent =
      /quota|credit|billing|unauthori[sz]ed|invalid api key|forbidden/i.test(
        detail,
      );
    const retryable =
      !permanent &&
      (retryableCode.test(code) ||
        (code === "UNKNOWN" &&
          /network|fetch failed|socket hang up|timed? ?out/i.test(detail)));
    return { outcome: retryable ? "transient" : "failed", code };
  }
  if (
    ["aborted", "cancelled", "canceled", "interrupted"].includes(reason?.kind)
  )
    return { outcome: "cancelled" };
  return { outcome: "ended" };
}

export function createDshTelemetry(ctx) {
  const sessions = new WeakMap();
  const get = (session) => {
    if (!sessions.has(session))
      sessions.set(session, { activityAt: 0, loaded: false });
    return sessions.get(session);
  };
  function record(session, event) {
    if (!activityEvents.has(event?.type) || !session) return;
    const data = get(session);
    const at = Number.isSafeInteger(event.time) ? event.time : Date.now();
    data.activityAt = Math.max(at, data.activityAt);
    if (event.type !== "turn/start" && event.type !== "turn/end") return;
    if (at < (data.lifecycleAt ?? 0)) return;
    data.lifecycleAt = at;
    if (event.type === "turn/start") {
      data.turn = { id: String(event.seq ?? at) + ":" + at, startedAt: at };
    } else if (event.type === "turn/end") {
      data.turn = {
        ...(data.turn ?? { id: "end:" + (event.seq ?? at) }),
        endedAt: at,
        ...endState(event.data?.reason),
      };
    }
  }
  ctx.on("session/event", record);
  ctx.on("agent/assistant-stream", ({ agent }) => {
    if (agent?.session) get(agent.session).activityAt = Date.now();
  });
  return function observe(agent) {
    if (!agent.session) return { activityAt: 0 };
    const data = get(agent.session);
    if (!data.loaded) {
      data.loaded = true;
      try {
        for (const event of agent.session.snapshotEvents().slice(-200))
          record(agent.session, event);
      } catch {
        // Live host status remains available when the event history is not.
      }
    }
    return { activityAt: data.activityAt, turn: data.turn };
  };
}
