import { turnBlocksDelivery } from "./wake-policy.mjs";

export const WAKE_LOST_MS = 120000;
const maxLosses = 3;
export const lossDeadline = wake => WAKE_LOST_MS * 2 ** Math.min(wake.deliveryLosses ?? 0, maxLosses - 1);
export const activeWake = wake => ['pending', 'enqueued'].includes(wake.state) && !wake.consumedAt && !wake.supersededAt;
export const handoffAge = (wake, now) => Math.max(0, now - (wake.handedOffAt ?? wake.admittedAt ?? wake.at ?? now));
export const wakeGeneration = wake => wake.generation ?? wake.deliveryRetry ?? 0;
export const selfDiagnosticNotice = notice => notice.selfDiagnostic === true || /^wake-(stuck|abandoned):/.test(notice.key);
export const wakeRecipientBusy = (role, now) => role?.bridgePresent !== false && now - role?.connectedAt < 15000 &&
  (role.state === "running" || role.pending > 0 || Boolean(role.pendingInputFingerprint) || role.jobs > 0 ||
    turnBlocksDelivery(role.observation));

export function normalizeWake(wake, now) {
  wake.noticeIds ??= [];
  wake.deliveryRetry ??= 0;
  wake.generation ??= wake.deliveryRetry;
  wake.deliveryLosses ??= 0;
  if(wake.text)wake.payloadGeneration ??= wake.generation;
  wake.deliveryAttempts ??= Math.max(wake.loggedAttempt ?? 0, wake.state === 'enqueued' ? 1 : 0);
  wake.handedOffAt ??= wake.admittedAt ?? (wake.state === 'enqueued' ? wake.at ?? now : null);
  // Legacy terminal rows may have no consumption time; do not invent one.
  wake.consumedAt ??= wake.state === 'consumed' ? wake.supersededAt ?? null : null;
}

export function consumeWake(wake, now, reason) {
  wake.consumedAt ??= now;
  if (wake.state === "failed") return;
  wake.state = 'consumed';
  if(reason) { wake.supersededAt = now; wake.closeReason = reason; }
}

export function countDeliveryAttempts(wake, attempt) {
  const previous = wake.countedDeliveryAttempt ?? 0;
  if(Number.isSafeInteger(attempt) && attempt > previous) {
    wake.deliveryAttempts = (wake.deliveryAttempts ?? 0) + attempt - previous;
    wake.countedDeliveryAttempt = attempt;
  }
}

export function requeueWake(wake, now, reason) {
  normalizeWake(wake,now);
  wake.state = 'pending';
  wake.generation++;
  if (["delivery-lost", "controller-retry", "controller-rearm", "idle-rearm"].includes(reason))
    wake.deliveryRetry++;
  wake.requeuedAt = now; wake.requeueReason = reason;
  delete wake.loggedAttempt; delete wake.countedDeliveryAttempt; delete wake.diagnostic;
}

export function mergeWakeNotices(wake, notices, now, { defer = false } = {}) {
  normalizeWake(wake, now);
  const ids = notices.map(notice=>notice.id), old = new Set(wake.noticeIds);
  const offered = wake.payloadNoticeIds ?? wake.noticeIds;
  if (defer && (wake.state === "enqueued" || wake.text)) wake.payloadNoticeIds ??= offered;
  const added = ids.filter(id=>!old.has(id));
  if(added.length) {
    wake.mergedNoticeIds = [...new Set([...(wake.mergedNoticeIds??[]),...added])];
    wake.noticeIds = [...old,...added];
    wake.mergedAt = now;
  }
  if (defer) return added;
  const pendingOffer = wake.state === "pending" && wake.text && wake.payloadGeneration === wake.generation;
  if ((wake.state === "enqueued" || pendingOffer) && (ids.some(id => !offered.includes(id)) ||
      pendingOffer && offered.some(id => !ids.includes(id)))) requeueWake(wake, now, "new-notices");
  if (wake.state === "pending") wake.payloadNoticeIds = ids;
  return added;
}

export function consolidateActiveWakes(state, role, now) {
  const active = state.wakes.filter(wake => wake.roleId === role.id && activeWake(wake));
  if (active.length < 2) return;
  const sameSession = active.filter(wake => wake.sessionId === role.sessionId);
  const keeper = sameSession.find(wake => !wake.queueDrainOnly && wake.state === "enqueued") ??
    sameSession.find(wake => !wake.queueDrainOnly) ?? sameSession[0];
  for (const wake of active) {
    if (wake === keeper) continue;
    if (keeper && !keeper.queueDrainOnly)
      mergeWakeNotices(keeper, (wake.noticeIds ?? []).map(id => ({ id })), now, { defer: true });
    consumeWake(wake, now, "duplicate-active-wake");
    if (role.queueDrainWakeId === wake.id) delete role.queueDrainWakeId;
  }
}

export function wakeHealth(state, roleIds, now = Date.now()) {
  const roles = new Set(Array.isArray(roleIds)?roleIds:[roleIds]);
  const wakes = state.wakes.filter(wake=>roles.has(wake.roleId));
  const diagnosticIds = new Set(state.notices.filter(selfDiagnosticNotice).map(notice => notice.id));
  const busy = new Set(state.roles.filter(role => wakeRecipientBusy(role, now)).map(role => role.id));
  const stuck = wakes.filter(wake => !(wake.noticeIds ?? []).every(id => diagnosticIds.has(id)) &&
    (wake.state === "failed" && !wake.consumedAt || activeWake(wake) && !busy.has(wake.roleId) &&
    (wake.state === "enqueued" ? handoffAge(wake, now) >= lossDeadline(wake) : wake.lostAt)));
  const unread = new Set(state.notices.filter(notice => !notice.readAt && !notice.workConfirmedAt).map(notice => notice.id));
  const blocked = state.roles.filter(role => roles.has(role.id) && busy.has(role.id) &&
    role.deliveryBlock?.code === "stale-turn" && role.deliveryBlock.noticeIds.some(id => unread.has(id)));
  const ages = [...stuck.map(wake => handoffAge(wake, now)), ...blocked.map(role => now - role.deliveryBlock.since)];
  return { stuck: ages.length, oldestStuckAgeMs: Math.max(0, ...ages),
    lastDeliveredAt:Math.max(0,...wakes.map(wake=>wake.handedOffAt??wake.admittedAt??0))||null };
}

export function rearmLostWake(state, role, now, event, eligible, { reason, manual = false, cutoff = now } = {}) {
  const active = state.wakes.find(wake => wake.roleId === role.id && !wake.queueDrainOnly && activeWake(wake));
  const notices = new Map(state.notices.filter(notice => notice.roleId === role.id && !notice.readAt &&
      !notice.workConfirmedAt && !selfDiagnosticNotice(notice))
    .map(notice => [notice.id, notice]));
  const survivors = new Map();
  const sources = state.wakes.filter(wake => {
    if (wake.roleId !== role.id || wake.state !== "failed" || wake.consumedAt || wake.closeReason !== "delivery-loss-limit" ||
        !manual && (wake.autoRearmedAt || (wake.failedAt ?? 0) >= cutoff || !wake.noticeIds.every(id => notices.has(id)))) return false;
    const entries = eligible(role, wake.noticeIds.map(id => notices.get(id)).filter(Boolean));
    for (const notice of entries) survivors.set(notice.id, notice);
    return entries.length > 0;
  });
  const restored = [...survivors.values()];
  if (!restored.length) return null;
  for (const drain of state.wakes) if (drain.roleId === role.id && drain.queueDrainOnly && activeWake(drain)) {
    consumeWake(drain, now, "business-wake-replaces-drain");
    if (role.queueDrainWakeId === drain.id) delete role.queueDrainWakeId;
  }
  const wake = active ?? sources.at(-1);
  if (active) {
    wake.lastCloseReason = sources.at(-1).closeReason;
    wake.deliveryLosses = 0;
    mergeWakeNotices(wake, restored, now, { defer: true });
  }
  else {
    wake.lastCloseReason = wake.closeReason;
    delete wake.closeReason;
    delete wake.failedAt;
    delete wake.lostAt;
    wake.sessionId = role.sessionId;
    wake.deliveryLosses = 0;
    wake.noticeIds = restored.map(notice => notice.id);
    // An older generation can still get an ACK from the host's durable ledger.
    requeueWake(wake, now, manual ? "controller-rearm" : "idle-rearm");
  }
  wake.autoRearmedAt ??= manual ? sources.find(item => item.autoRearmedAt)?.autoRearmedAt : now;
  for (const source of sources) {
    if (source === wake) continue;
    consumeWake(source, now, "rearmed-into-current-wake");
    source.rearmedInto = wake.id;
  }
  for (const {id} of restored) delete notices.get(id).wakeSuppression;
  const result = { wakeId: wake.id, noticeIds: restored.map(notice => notice.id), roleId: role.id,
    previousWakeIds: sources.map(source => source.id), reason, manual };
  event("wake.rearmed", result);
  return result;
}

export function recoverLostWakes(state, now, event, notify, eligible = (_role, notices) => notices, canRearm, rearmEligible = eligible) {
  for(const wake of state.wakes) {
    normalizeWake(wake,now);
    if (!activeWake(wake) && (wake.state !== "failed" || wake.consumedAt)) continue;
    const role = state.roles.find(role => role.id === wake.roleId);
    if (wake.queueDrainOnly) {
      if (role?.pendingInputFingerprint !== wake.queuedInputFingerprint) consumeWake(wake, now, "queued-input-changed");
      continue;
    }
    const notices = state.notices.filter(notice => wake.noticeIds.includes(notice.id));
    const unread = notices.filter(notice => !notice.readAt && !notice.workConfirmedAt && !selfDiagnosticNotice(notice));
    if (!unread.length || role && !eligible(role, unread).length) {
      consumeWake(wake, now, unread.length ? "no-actionable-responsibility" : "notices-read");
      continue;
    }
    if (wake.state === "failed") continue;
    // A live busy member can still read this card in its current turn.
    if (wakeRecipientBusy(role, now)) continue;
    const ageMs = handoffAge(wake, now);
    if (wake.deliveryLosses < maxLosses) {
      if (wake.state !== "enqueued" || ageMs < lossDeadline(wake)) continue;
      wake.deliveryLosses++;
      wake.lostAt = now;
      event("wake.delivery_lost", { wakeId: wake.id, noticeIds: [...wake.noticeIds], roleId: wake.roleId,
        ageMs, generation: wake.generation, deliveryRetry: wake.deliveryRetry, deliveryAttempts: wake.deliveryAttempts,
        deliveryLosses: wake.deliveryLosses });
      if (role) role.consecutiveWakeLosses = (role.consecutiveWakeLosses ?? 0) + 1;
    }
    if (role?.consecutiveWakeLosses >= maxLosses && role.toolHealthSupported &&
        (role.provider ?? "dsh") === "dsh" && !role.pendingToolHealthCheck) {
      role.pendingToolHealthCheck = { id: wake.id + ":" + wake.deliveryLosses, at: now };
      event("wake.tools-health-requested", { roleId: role.id, wakeId: wake.id, id: role.pendingToolHealthCheck.id });
    }
    if (wake.deliveryLosses >= maxLosses) {
      wake.state = "failed";
      wake.failedAt = now;
      wake.closeReason = "delivery-loss-limit";
      event("wake.abandoned", { wakeId: wake.id, noticeIds: [...wake.noticeIds], roleId: wake.roleId,
        deliveryLosses: wake.deliveryLosses, deliveryAttempts: wake.deliveryAttempts,
        generation: wake.generation, deliveryRetry: wake.deliveryRetry });
    } else {
      requeueWake(wake, now, "delivery-lost");
    }
    if (role) notify(role, wake, ageMs);
  }
  if (canRearm) for (const role of state.roles)
    if (canRearm(role)) rearmLostWake(state, role, now, event, rearmEligible, { reason: "fresh-idle-heartbeat" });
}

// Audit every uncovered unread notice once per blocking condition, including
// deliberate policy suppression. Never roll back the event by throwing here.
export function auditWakeCoverage(state, role, selection, reason, now, event) {
  const wakes=state.wakes.filter(wake=>wake.roleId===role.id&&activeWake(wake));
  const blocking=wakes.find(wake=>wake.state==='enqueued')??wakes[0];
  const groups=new Map();
  for(const notice of state.notices.filter(notice=>notice.roleId===role.id&&!notice.readAt&&!notice.workConfirmedAt)) {
    if (selfDiagnosticNotice(notice)) continue;
    if(wakes.some(wake=>(reason ? wake.payloadNoticeIds ?? wake.noticeIds : wake.noticeIds).includes(notice.id))) {
      delete notice.wakeSuppression;continue;
    }
    const policy=selection.suppressedNotices?.find(item=>item.id===notice.id)?.reason;
    const why=policy??(!selection.actionable?'non-actionable-only':reason??'invariant-uncovered');
    const blockingWakeId=blocking?.id??null;
    if(notice.wakeSuppression?.reason===why&&notice.wakeSuppression.blockingWakeId===blockingWakeId)continue;
    notice.wakeSuppression={reason:why,blockingWakeId,at:now};
    const key=JSON.stringify([why,blockingWakeId]);
    const group=groups.get(key)??{wakeId:blockingWakeId,noticeIds:[],roleId:role.id,reason:why,blockingWakeId,
      ageMs:blocking?handoffAge(blocking,now):Math.max(0,now-notice.at)};
    group.noticeIds.push(notice.id);groups.set(key,group);
  }
  for(const group of groups.values())event('wake.suppressed',group);
}
