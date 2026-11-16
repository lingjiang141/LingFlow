export const WAKE_LOST_MS = 120000;
export const activeWake = wake => wake.state !== 'consumed' && !wake.consumedAt && !wake.supersededAt;
export const handoffAge = (wake, now) => Math.max(0, now - (wake.handedOffAt ?? wake.admittedAt ?? wake.at ?? now));

export function normalizeWake(wake, now) {
  wake.noticeIds ??= [];
  wake.deliveryRetry ??= 0;
  if(wake.text)wake.payloadGeneration ??= wake.deliveryRetry;
  wake.deliveryAttempts ??= Math.max(wake.loggedAttempt ?? 0, wake.state === 'enqueued' ? 1 : 0);
  wake.handedOffAt ??= wake.admittedAt ?? (wake.state === 'enqueued' ? wake.at ?? now : null);
  // Legacy terminal rows may have no consumption time; do not invent one.
  wake.consumedAt ??= wake.state === 'consumed' ? wake.supersededAt ?? null : null;
}

export function consumeWake(wake, now, reason) {
  wake.state = 'consumed'; wake.consumedAt ??= now;
  if(reason) { wake.supersededAt = now; wake.closeReason = reason; }
}

export function countDeliveryAttempts(wake, attempt) {
  const previous = wake.countedDeliveryAttempt ?? 0;
  if(Number.isSafeInteger(attempt) && attempt > previous && attempt <= 4) {
    wake.deliveryAttempts = (wake.deliveryAttempts ?? 0) + attempt - previous;
    wake.countedDeliveryAttempt = attempt;
  }
}

export function requeueWake(wake, now, reason) {
  normalizeWake(wake,now);
  wake.state = 'pending'; wake.deliveryRetry = (wake.deliveryRetry ?? 0) + 1;
  wake.requeuedAt = now; wake.requeueReason = reason;
  delete wake.loggedAttempt; delete wake.countedDeliveryAttempt; delete wake.diagnostic;
}

export function mergeWakeNotices(wake, notices, now) {
  const ids = notices.map(notice=>notice.id), old = new Set(wake.noticeIds);
  const added = ids.filter(id=>!old.has(id));
  if(added.length) {
    wake.mergedNoticeIds = [...new Set([...(wake.mergedNoticeIds??[]),...added])];
    wake.noticeIds = [...old,...added];
    // A payload already offered to a bridge must retain its own ACK identity.
    if(wake.state !== 'pending' || wake.text && wake.payloadGeneration===wake.deliveryRetry) requeueWake(wake,now,'new-notices');
    wake.mergedAt = now;
  }
  wake.payloadNoticeIds = ids;
  return added;
}

export function wakeHealth(state, roleIds, now = Date.now()) {
  const roles = new Set(Array.isArray(roleIds)?roleIds:[roleIds]);
  const wakes = state.wakes.filter(wake=>roles.has(wake.roleId));
  const stuck = wakes.filter(wake=>activeWake(wake) &&
    (wake.lostAt || wake.state === 'enqueued' && handoffAge(wake,now)>=WAKE_LOST_MS));
  return { stuck:stuck.length, oldestStuckAgeMs:stuck.length?Math.max(...stuck.map(wake=>handoffAge(wake,now))):0,
    lastDeliveredAt:Math.max(0,...wakes.map(wake=>wake.handedOffAt??wake.admittedAt??0))||null };
}

export function recoverLostWakes(state, now, event, notify) {
  for(const wake of state.wakes) {
    normalizeWake(wake,now);
    if(activeWake(wake)&&!state.notices.some(notice=>wake.noticeIds.includes(notice.id)&&!notice.readAt)) {
      consumeWake(wake,now,'notices-read');continue;
    }
    if(!activeWake(wake)||wake.state!=='enqueued'||handoffAge(wake,now)<WAKE_LOST_MS)continue;
    const ageMs=handoffAge(wake,now);
    requeueWake(wake,now,'delivery-lost');wake.lostAt=now;
    event('wake.delivery_lost',{wakeId:wake.id,noticeIds:[...wake.noticeIds],roleId:wake.roleId,ageMs,generation:wake.deliveryRetry});
    const role=state.roles.find(role=>role.id===wake.roleId);
    if(role)notify(role,wake,ageMs);
  }
}

// Audit every uncovered unread notice once per blocking condition, including
// deliberate policy suppression. Never roll back the event by throwing here.
export function auditWakeCoverage(state, role, selection, reason, now, event) {
  const wakes=state.wakes.filter(wake=>wake.roleId===role.id&&activeWake(wake));
  const blocking=wakes.find(wake=>wake.state==='enqueued')??wakes[0];
  const groups=new Map();
  for(const notice of state.notices.filter(notice=>notice.roleId===role.id&&!notice.readAt)) {
    if(wakes.some(wake=>['pending','enqueued'].includes(wake.state)&&wake.noticeIds.includes(notice.id))) {
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
