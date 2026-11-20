import { successorAction } from './controller-governance.mjs';
import { readGit } from './quality.mjs';
import { includeIgnoredScopeWrites,originalTaskWrites,releasedTaskScope } from './task-scope.mjs';
import { preparationBudgetProposal,preparationTimeoutHint,preparationTiming } from './preparation-budget.mjs';

const budgetRevisionHint = "主控用 reviseSchedule {allowCheckRevision:true} 授权。责任开发执行返回的 registerChecks {replace:true}，只调整 preSteps.timeoutMs 和 timeoutMs。";
const preparationRecipe = check => JSON.stringify((check.preSteps??[]).map(step=>[step.argv,step.outputs]));
const controllerCheck = check => ['independent','controller'].includes(check.stage);

export function preparationRevision(state, task, job) {
  const checks = task.verification?.checks ?? [];
  if (!job || job.taskId !== task.id || job.classification !== 'preparation-timeout' || job.invalidated ||
      releasedTaskScope(task) || task.developerChecksPending || controllerCheck(job.check) ||
      !['assigned','rework','paused','ready','trial'].includes(task.state)) return;
  if (state.checkJobs.some(item => item.taskId === task.id && item.check.id === job.check.id &&
      item.state === 'passed' && (item.finishedAt ?? 0) > (job.finishedAt ?? Infinity))) return;
  const failed = checks.find(check => check.id === job.check.id && JSON.stringify(check) === JSON.stringify(job.check));
  if (!failed || !state.checkJobs.some(item => item.taskId === task.id && item.state === 'passed' && item.receipt &&
    !item.receipt.environmentFailure && ['red','green'].includes(item.check.stage) &&
    checks.some(check => check.id === item.check.id && JSON.stringify(check) === JSON.stringify(item.check)) &&
    preparationRecipe(item.check) === preparationRecipe(failed))) return;
  const receipt = job.receipt ?? {};
  const proposals = checks.filter(check => !controllerCheck(check)).map(check => {
    if (preparationRecipe(check) !== preparationRecipe(failed)) return { check };
    return preparationBudgetProposal(check, receipt);
  });
  const registration = { command:'registerChecks',ownerRole:'developer',ownerId:task.developerId,
    args:{taskId:task.id,replace:true,reason:'按实测修订构建前置预算',checks:proposals.map(({check}) => {
      const {expectedOutput, ...recipe} = check;
      return expectedOutput ? check : recipe;
    })} };
  const nextAction = { command:'reviseSchedule',ownerRole:'controller',ownerId:task.dispatchedBy,
    args:{taskId:task.id,allowCheckRevision:true,preparationJobId:job.id,reason:'按原票构建前置实测调整检查预算'},
    before:preparationBefore(task,job),
    message:budgetRevisionHint, registration };
  if (proposals.some(proposal => proposal.exceedsMaximum))
    nextAction.budgetNote = "分类建议超出允许的检查预算时，拆分构建并重新核对检查配方";
  return nextAction;
}

function preparationBefore(task,job) {
  const before=[];
  if(job.state==='uncertain')before.push({command:'reconcileCheck',ownerRole:'controller',ownerId:task.dispatchedBy,
    args:{jobId:job.id,evidence:'填写构建前置已终止的实际核对依据'}});
  if(['assigned','rework'].includes(task.state))before.push({command:'yieldForSchedule',ownerRole:'developer',ownerId:task.developerId,
    args:{taskId:task.id,reason:'构建前置超时，停写并交回检查预算修订'}});
  if(['ready','trial'].includes(task.state))before.push({command:'rework',ownerRole:'controller',ownerId:task.dispatchedBy,
    args:{taskId:task.id,adjustScope:true,evidence:[job.check.id],reason:'重新收口超时检查后再恢复验收'}});
  return before;
}

export function preparationRecovery(state,task,job,receipt) {
  const timing=preparationTiming(job.check,receipt);
  const revision=preparationRevision(state,task,{...job,classification:'preparation-timeout',receipt});
  if(revision)return {classification:'preparation-timeout',error:budgetRevisionHint,hint:budgetRevisionHint,
    membersCanRetry:false,nextAction:revision,...timing};
  const writes=originalTaskWrites(task),root=state.projects.find(project=>project.id===task.projectId).root;
  let ownedDirty=[],ownershipError;
  try {
    const dirty=writes.length?readGit(root,['--literal-pathspecs','status','--porcelain=v1','-z','--no-renames','--untracked-files=all','--',...writes])
      .split('\0').filter(Boolean).map(row=>row.slice(3)):[];
    ownedDirty=includeIgnoredScopeWrites(root,task,{dirty}).dirty;
  }catch(error){ownershipError=error.message;}
  const nextAction=successorAction(state,task,ownedDirty,{requireAvailable:true});
  if(nextAction.blockedBy)return {classification:'preparation-timeout',error:receipt.reason??preparationTimeoutHint,
    hint:nextAction.message,membersCanRetry:false,nextAction,...timing};
  let exceedsMaximum=false;
  for(const [index,check] of (nextAction.args.tickets[0].verification?.checks??[]).entries()) {
    if(check.id!==job.check.id&&(!check.preSteps?.length||preparationRecipe(check)!==preparationRecipe(job.check)))continue;
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
  return {classification:'preparation-timeout',error:receipt.reason??preparationTimeoutHint,hint:preparationTimeoutHint,membersCanRetry:false,nextAction,...timing};
}

export function preparationActionView(state,job,task) {
  if(job.classification!=='preparation-timeout')return job.nextAction;
  const proposed=preparationRevision(state,task,job);
  if(proposed) return proposed;
  const saved=job.nextAction;
  const candidate=successorAction(state,task,[],{requireAvailable:true});
  if(candidate.blockedBy) return candidate;
  if(!saved||saved.command!=="dispatchPlan")return preparationRecovery(state,task,job,job.receipt??{}).nextAction;
  return {...saved,args:{...saved.args,tickets:saved.args.tickets.map(ticket=>({...ticket,developerId:candidate.args.tickets[0].developerId}))},before:(saved.before??[]).filter(action=>
    action.command==='reconcileCheck'?job.state==='uncertain':
      action.command==='yieldForSchedule'?['assigned','rework'].includes(task.state)&&!releasedTaskScope(task):
        action.command==='releaseSchedule'?!releasedTaskScope(task):true)};
}
