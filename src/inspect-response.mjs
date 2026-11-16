import { compactCheck } from './check-status-response.mjs';
const size = value => Buffer.byteLength(JSON.stringify(value));
const limitBytes = 189000; // Reserve metadata overhead below the 190KB response ceiling.
function fullResponse(value, args) {
  if (args.section !== undefined) {
    const supported = { acceptance: value.verification?.acceptance, "baseline.other": value.baseline?.other, checkJobs: value.checkJobs, reports: value.reports, scheduleHistory: value.scheduleHistory, reviews: value.reviews, events: value.events };
    if (!Object.hasOwn(supported,args.section)) throw Error("inspect section 仅支持 full、acceptance、baseline.other、checkJobs、reports、scheduleHistory、reviews、events");
    const offset=args.offset??0,limit=args.limit??50;
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200) throw Error("inspect offset 须非负，limit 须为 1–200");
    const source=supported[args.section]??[],items=source.slice(offset,offset+limit);
    const result={taskId:value.id,section:args.section,offset,items,total:source.length,scanned:source.length,totalBytes:size(source)};
    while(items.length&&size(result)>limitBytes)items.pop();
    result.nextOffset=offset+items.length<source.length?offset+items.length:null;
    result.truncated=items.length<Math.min(limit,Math.max(0,source.length-offset));
    if(!items.length&&offset<source.length) {result.truncated=true;result.nextOffset=null;result.detail="单条记录超过响应上限，保留在本地历史中";}
    return result;
  }
  const totalBytes=size(value);
  if(totalBytes<=limitBytes)return value;
  const copy=structuredClone(value);
  copy.truncated=true;copy.totalBytes=totalBytes;copy.omitted=[];
  const fields=[[copy.baseline,"other","baseline.other"],[copy,"checkJobs","checkJobs"],[copy,"scheduleHistory","scheduleHistory"],[copy,"reports","reports"],[copy,"reviews","reviews"]];
  for(const [object,key,section] of fields) {
    if(size(copy)<=limitBytes)break;
    if(!object?.[key])continue;
    copy.omitted.push({section,total:object[key].length,items:object[key].length,nextAction:{command:"inspect",args:{taskId:value.id,section,offset:0,limit:50}}});
    object[key]=[];
  }
  if(size(copy)>limitBytes)return {id:value.id,state:value.state,title:String(value.title).slice(0,500),truncated:true,totalBytes,
    detail:"单票正文超限，请按 section 分页；完整记录仍保留在本地",omitted:copy.omitted};
  return copy;
}

export function inspectResponse(value, args = {}) {
  const scanned = { baselineOther: value.baseline?.other?.length ?? 0, checkJobs: value.checkJobs?.length ?? 0,
    reports: value.reports?.length ?? 0, reviews: value.reviews?.length ?? 0, acceptance: value.verification?.acceptance?.length ?? 0, events: value.eventCount ?? value.events?.length ?? 0 };
  if (args.section === 'full') {
    const result = fullResponse(value, {});
    return { ...result, truncated: result.truncated ?? false, scanned };
  }
  if (args.section !== undefined) return fullResponse(value, args);
  const allowed = ['id','ticketKey','projectId','state','risk','readOnly','candidate','revision','scheduleVersion','assignee','developerId',
    'admittedAt','deliveredAt','reportedAt','acceptedAt','verificationMode','deliveryState','deliveryIssue','blockedBy','ownerState','wakeHealth',
    'ownerSilentForMs','lastHeartbeatAt','lastTurnState','environmentFailure','environmentFailureReason','reason','hint','membersCanRetry','nextAction','supersededBy','supersession','abandonment','staleReason','scopeReleased','scopeConflict','evidence'];
  const result = Object.fromEntries(allowed.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  result.title = String(value.title ?? '').slice(0, 500);
  result.description = String(value.description ?? '').slice(0, 4000);
  const acceptance = value.verification?.acceptance ?? [];
  result.acceptance = acceptance.slice(0, 100).map(ac => ({ id: ac.id, text: String(ac.text ?? '').slice(0, 2000) }));
  result.checks = (value.checkJobs ?? []).slice(-50).map(compactCheck);
  const report = value.reports?.at(-1);
  result.reports = report ? [{ id: report.id, revision: report.revision, candidate: report.candidate, at: report.at,
    summary: String(report.summary ?? '').slice(0, 4000), outcome: report.outcome,
    manifest: { testChanges: report.manifest?.testChanges?.slice(0, 20) ?? [],
      testChangeCount: report.manifest?.testChanges?.length ?? 0, fileCount: report.manifest?.files?.length ?? 0 } }] : [];
  result.scanned = scanned;
  result.totalBytes = size(value);
  result.events = value.events?.slice(0,3) ?? [];
  const counts = {'baseline.other':scanned.baselineOther,checkJobs:scanned.checkJobs,reports:scanned.reports,reviews:scanned.reviews,scheduleHistory:value.scheduleHistory?.length??0,acceptance:scanned.acceptance,events:scanned.events};
  result.omitted = Object.entries(counts).map(([section,items]) => ({ section, items,
    nextAction: { command: 'inspect', args: { taskId: value.id, section, offset: 0, limit: 50 } } }));
  result.truncated = Boolean(scanned.baselineOther || scanned.checkJobs || scanned.reports || scanned.reviews || value.scheduleHistory?.length ||
    scanned.events>3 || acceptance.some(ac => String(ac.text ?? '').length > 2000) || acceptance.length > 100);
  if (size(result) > limitBytes) {
    result.truncated = true;
    result.acceptance = result.acceptance.slice(0, 30).map(ac => ({ ...ac, text: ac.text.slice(0, 500) }));
    result.checks = result.checks.slice(-10);
  }
  if (size(result) > limitBytes) return { id: value.id, state: value.state, title: result.title,
    acceptance: result.acceptance, checks: result.checks, reports: [], scanned, truncated: true, totalBytes: result.totalBytes, omitted: result.omitted };
  return result;
}
