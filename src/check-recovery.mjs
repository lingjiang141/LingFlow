import { successorAction } from './controller-governance.mjs';
import { readGit } from './quality.mjs';
import { includeIgnoredScopeWrites,originalTaskWrites,releasedTaskScope } from './task-scope.mjs';
import { preparationBudgetProposal,preparationTimeoutHint } from './preparation-budget.mjs';

export function preparationRecovery(state,task,job,receipt) {
  const writes=originalTaskWrites(task),root=state.projects.find(project=>project.id===task.projectId).root;
  let ownedDirty=[],ownershipError;
  try {
    const dirty=writes.length?readGit(root,['--literal-pathspecs','status','--porcelain=v1','-z','--no-renames','--untracked-files=all','--',...writes])
      .split('\0').filter(Boolean).map(row=>row.slice(3)):[];
    ownedDirty=includeIgnoredScopeWrites(root,task,{dirty}).dirty;
  }catch(error){ownershipError=error.message;}
  const nextAction=successorAction(state,task,ownedDirty);
  const key=check=>JSON.stringify((check.preSteps??[]).map(step=>[step.argv,step.outputs]));
  let exceedsMaximum=false;
  for(const [index,check] of (nextAction.args.tickets[0].verification?.checks??[]).entries()) {
    if(check.id!==job.check.id&&(!check.preSteps?.length||key(check)!==key(job.check)))continue;
    if(['independent','controller'].includes(check.stage)) {
      nextAction.remedy='主控探针仍限 60000ms；承接规划须缩小探针或将重准备工作交责任开发，不能提高主控时限。';
      continue;
    }
    const proposal=preparationBudgetProposal(check,receipt);
    nextAction.args.tickets[0].verification.checks[index]=proposal.check;
    exceedsMaximum ||= proposal.exceedsMaximum;
  }
  nextAction.message=preparationTimeoutHint+' 先完成 before 中的原票对账与停写释放，再核对承接票规划并 previewPlan；新参数只是提案。';
  if(ownershipError)Object.assign(nextAction,{ownershipUnavailable:true,ownershipError,
    remedy:'Git 状态暂不可读；保留文件，重新 diagnoseTask 获取准确 ownedDirty 后再派发。'});
  if(exceedsMaximum)nextAction.remedy='保守预算超过一小时上限，承接规划须拆分构建或复用可核验产物；不能直接采用被截到上限的预算。';
  const before=[];
  if(receipt.uncertain||receipt.timedOut)before.push({command:'reconcileCheck',ownerRole:'controller',ownerId:nextAction.ownerId,
    args:{jobId:job.id,evidence:'填写构建前置已终止的实际核对依据'}});
  if(['assigned','rework'].includes(task.state))before.push({command:'yieldForSchedule',ownerRole:'developer',ownerId:task.developerId,
    args:{taskId:task.id,reason:'构建前置超时，停写并交回以登记承接票'}});
  before.push({command:'releaseSchedule',ownerRole:'controller',ownerId:nextAction.ownerId,
    args:{taskId:task.id,reason:'已对账并停写，剩余工作由更新构建预算的承接票承担'}});
  nextAction.before=before;
  return {classification:'preparation-timeout',error:receipt.reason??preparationTimeoutHint,hint:preparationTimeoutHint,membersCanRetry:false,nextAction};
}

export function preparationActionView(job,task) {
  if(job.classification!=='preparation-timeout'||!job.nextAction)return job.nextAction;
  return {...job.nextAction,before:(job.nextAction.before??[]).filter(action=>
    action.command==='reconcileCheck'?job.state==='uncertain':
      action.command==='yieldForSchedule'?['assigned','rework'].includes(task.state)&&!releasedTaskScope(task):
        action.command==='releaseSchedule'?!releasedTaskScope(task):true)};
}
