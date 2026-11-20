export const wakeCoalesceMs = execution => execution?.wakeCoalesceMs ?? 25000;

export function turnBlocksDelivery(observation) {
  const turn = observation?.turn;
  return observation?.compacting === true || Boolean(turn?.startedAt && !(turn.endedAt >= turn.startedAt));
}

export function wakeDelay(unread, role, now, execution = {}) {
  const ms = wakeCoalesceMs(execution);
  if (!Number.isInteger(ms) || ms < 0 || ms > 30000) throw Error("wakeCoalesceMs 须为 0 到 30000 毫秒");
  // Startup and explicit responsibility changes are latency-sensitive. Routine
  // progress/results share a fixed window anchored to the first unread event.
  if (unread.some(notice => !notice.silent && (!role.seenContextRevision || /^(dispatch|review|resume|context|answer|patrol-resume|message|question):/.test(notice.key)))) return 0;
  return Math.max(0, Math.min(...unread.map(notice => notice.at)) + ms - now);
}
