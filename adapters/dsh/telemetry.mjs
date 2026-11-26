const activityEvents = new Set([
  "turn/start",
  "turn/end",
  "compaction/start",
  "compaction/end",
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

export function createDshTelemetry(ctx, onTurnEnd) {
  const sessions = new WeakMap();
  function record(data, event) {
    if (!activityEvents.has(event?.type)) return;
    const at = Number.isSafeInteger(event.time) ? event.time : Date.now();
    data.activityAt = Math.max(at, data.activityAt);
    const [kind, edge] = event.type.split("/");
    if (kind !== "turn" && kind !== "compaction") return;
    const previous = data.lifecycle[kind];
    const seq = Number.isSafeInteger(event.seq) ? event.seq : null;
    if (previous && (seq !== null && previous.seq !== null ? seq <= previous.seq : at < previous.at)) return;
    const turn = event.data?.turn;
    if (edge === "end" && previous?.open && previous.turn != null && turn != null && previous.turn !== turn) return;
    data.lifecycle[kind] = { at, seq, turn, open: edge === "start" };
    if (kind === "compaction") return;
    if (edge === "start") {
      data.turn = { id: String(seq ?? at) + ":" + at, startedAt: at };
    } else {
      data.turn = {
        ...(data.turn ?? { id: "end:" + (seq ?? at) }),
        endedAt: at,
        ...endState(event.data?.reason),
      };
    }
  }
  const get = (session) => {
    if (sessions.has(session)) return sessions.get(session);
    const data = { activityAt: 0, lifecycle: {} };
    sessions.set(session, data);
    try {
      // An open turn or compaction can start well before the recent activity window.
      for (const event of session.snapshotEvents()) record(data, event);
    } catch {
      // Live events still track sessions whose history is unavailable.
    }
    return data;
  };
  ctx.on("session/event", (session, event) => {
    if (!session || !activityEvents.has(event?.type)) return;
    const previousTurn = sessions.get(session)?.turn;
    const data = get(session);
    record(data, event);
    if (event.type === "turn/end" && data.turn !== previousTurn && data.turn?.startedAt &&
        data.turn.endedAt >= data.turn.startedAt && data.lifecycle.turn.turn === event.data?.turn) {
      onTurnEnd?.(session);
    }
  });
  ctx.on("agent/assistant-stream", ({ agent }) => {
    if (agent?.session) get(agent.session).activityAt = Date.now();
  });
  return function observe(agent) {
    if (!agent.session) return { activityAt: 0 };
    const data = get(agent.session);
    return { activityAt: data.activityAt, turn: data.turn, compacting: data.lifecycle.compaction?.open === true };
  };
}
