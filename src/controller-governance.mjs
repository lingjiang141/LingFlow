import { coversPath } from './files.mjs';
import { readGit } from './quality.mjs';
import { originalTaskWrites, releasedTaskScope } from './task-scope.mjs';

export const releasedConfirmationMessage = '该票已释放，请用 dispatchPlan 登记承接票并把在途改动作为 ownedDirty 传入。';
export const developerEvidenceMessage = '该证据只能由责任开发成员重跑产生；主控不得在本机执行该命令后自称已验';
export const takeoverMessage = '这些改动属于原票成员的劳动成果，不能由主控提交，请登记承接票';
const lead = check => ['independent','controller'].includes(check.stage);

export function evidenceNextAction(task, check, controllerId) {
  const ownerRole=lead(check)?'controller':'developer';
  const action={command:'check',ownerRole,ownerId:lead(check)?controllerId:task.developerId,
    args:{taskId:task.id,checkId:check.id,...(!lead(check)&&{ticketKey:task.ticketKey})},
    message:lead(check)?'仅由主控通过 check 提交本票冻结的短探针，不在 shell 直接执行。':developerEvidenceMessage};
  if (!lead(check)&&['changes_requested','ready','trial','waiting_review','waiting_verification','waiting_batch','reviewing'].includes(task.state))
    action.returnToOwner={command:'rework',args:{taskId:task.id,reason:'证据需责任开发成员补齐：'+check.id,evidence:[check.id]}};
  return action;
}

// This is a proposal, never a dispatch or a new scope authorization. Normal
// preview/freeze/ownership/admission checks still run when the controller uses it.
export function releaseHandoff(state, task, git) {
  const writes=[...originalTaskWrites(task)];
  const ownedDirty=[...new Set(git.dirty.filter(file=>coversPath(writes,file)))].sort();
  if(!ownedDirty.length)return {};
  return {handoff:{ticketKey:task.ticketKey,writes,ownedDirty,instruction:takeoverMessage+'；核对承接票的规划授权和冻结检查后，将 ownedDirty 原样交给开发成员，主控不得接手实现。'},
    nextAction:successorAction(state,task,ownedDirty)};
}

export function successorAction(state,task,ownedDirty=[]) {
  const writes=[...originalTaskWrites(task)];
  const members=state.roles.filter(role=>role.projectId===task.projectId&&role.kind==='developer'&&!role.archivedAt);
  const idle=members.find(role=>role.enabled&&role.state==='idle'&&role.pending===0&&role.jobs===0);
  const developer=idle??members.find(role=>role.id===task.developerId);
  const base=(task.ticketKey??'HANDOFF').slice(0,55);
  let suffix=1,key;
  do{key=`${base}-HANDOFF-${suffix++}`;}while(state.tasks.some(peer=>peer.projectId===task.projectId&&peer.ticketKey===key));
  const plan=state.plans.find(plan=>plan.id===task.planId);
  const documents=plan?.documents??task.sources??{};
  const ticketFiles=Object.entries(documents).filter(([name])=>name==='tickets'||name.startsWith('ticket:')).map(([,doc])=>doc.file);
  const sources={spec:documents.spec?.file??task.sources?.spec?.file,
    tickets:ticketFiles.length===1?ticketFiles[0]:ticketFiles,
    attempts:documents.attempts?.file??task.sources?.attempts?.file};
  const ticket={key,developerId:developer?.id??task.developerId,title:task.title,description:task.description,
    risk:task.risk,riskReason:task.riskReason,readOnly:task.readOnly,writes,reads:[...(task.reads??[])],
    contextReads:[...(task.contextReads??[])],resources:[...(task.resources??[])],ownedDirty,
    after:(task.dependencies??[]).map(taskId=>({taskId,stage:task.dependencyStages?.[taskId]??'verified'})),
    ...(task.verification&&{verification:structuredClone(task.verification)})};
  // Frozen checks store an empty optional marker; public dispatch input uses
  // absence for that marker. Keep the skeleton valid through the real parser.
  for(const check of ticket.verification?.checks??[])if(!check.expectedOutput)delete check.expectedOutput;
  return {command:'dispatchPlan',ownerRole:'controller',ownerId:task.dispatchedBy,
      args:{requirementId:task.requirementId,sources,tickets:[ticket]},
      message:'先用相同 args 执行 previewPlan 核对新票与规划正文；sources 中有机读票号约束时须先补批准的承接票正文。空闲开发者不存在时保留原开发责任，正常准入等待空闲。'};
}

function summarized(task) {
  return Boolean(task.summarizedAt||task.controllerEvidence||task.trialInstructions||['trial','accepted'].includes(task.state));
}
export function projectGovernance(root, tasks, limit=50) {
  const raw=readGit(root,['log',`-${limit}`,'--format=%x00%x00LF-COMMIT%x00%H%x00%ct%x00','--name-only','-z','--no-renames','--root','--diff-merges=first-parent','HEAD','--']);
  const commits=raw.split('\0\0LF-COMMIT\0').slice(1).map(record=>{
    const [commit,seconds,...files]=record.split('\0');
    return {commit,at:Number(seconds)*1000,files:files.map(file=>file.replace(/^\r?\n/,'')).filter(Boolean)};
  });
  const order=new Map(commits.map((commit,index)=>[commit.commit,index]));
  const records=[];
  for(const task of tasks.filter(task=>!summarized(task)&&originalTaskWrites(task).length)) {
    const firstBaseline=task.scheduleHistory?.find(item=>item.previous?.baseline?.head)?.previous.baseline;
    const baseline=firstBaseline?.deliveryBase??firstBaseline?.head??task.baseline?.deliveryBase??task.baseline?.head;
    // A pre-existing commit must not be blamed on a task created later.
    const baseIndex=order.get(baseline);
    const afterBaseline=baseline&&baseIndex===undefined?new Set(readGit(root,['rev-list',`-${limit}`,'HEAD','^'+baseline,'--']).trim().split(/\r?\n/)):null;
    const release=task.abandonment??task.supersession??task.releasedScope;
    const releaseIndex=order.get(release?.head);
    for(const [index,commit] of commits.entries()) {
      if(baseIndex!==undefined?index>=baseIndex:commit.at+999<(task.acceptedAt??0))continue;
      if(afterBaseline&&!afterBaseline.has(commit.commit))continue;
      if(commit.commit===baseline)continue;
      const files=commit.files.filter(file=>coversPath(originalTaskWrites(task),file));
      if(!files.length)continue;
      const released=releasedTaskScope(task)&&(releaseIndex!==undefined?index<releaseIndex:!release?.at||commit.at+999>=release.at);
      records.push({commit:commit.commit,ticketKey:task.ticketKey,taskId:task.id,files,at:commit.at,
        kind:released?'released-work-committed':'in-flight-work-committed',
        attribution:'scope-and-lifecycle-only; Git author does not prove controller identity'});
    }
  }
  return {limit,scannedCommits:commits.length,records};
}
