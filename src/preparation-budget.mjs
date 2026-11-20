export const preparationTimeoutHint='按构建实测耗时提高 timeoutMs 后重建承接票；原票冻结检查保持不变，主控不得自行构建或改写冻结预算。';

export function preparationTiming(check, receipt = {}) {
  const steps = receipt.preparation?.steps ?? [];
  const step = steps.findIndex(item => item.timedOut);
  const frozenBudgetMs = step >= 0 ? check.preSteps?.[step]?.timeoutMs ?? check.timeoutMs : check.timeoutMs;
  const measuredMs = step >= 0 ? steps[step].elapsedMs : receipt.preparation?.elapsedMs;
  if (!Number.isFinite(measuredMs) || !Number.isFinite(frozenBudgetMs)) return {};
  return { budgetScope: step >= 0 ? "step" : "total", ...(step >= 0 && { stepIndex: step }),
    measuredMs, frozenBudgetMs, shortfallMs: Math.max(0, measuredMs - frozenBudgetMs),
    suggestedTimeoutMs: Math.ceil(measuredMs * 1.3) };
}

export function checkWithoutBudgets(check) {
  const { timeoutMs, preSteps, ...recipe } = check;
  return preSteps ? { ...recipe, preSteps: preSteps.map(({ timeoutMs, ...step }) => step) } : recipe;
}

export function isPreparationTimeout(receipt,check) {
  const preparation=receipt?.preparation;
  return Boolean(preparation?.timedOut || receipt?.timedOut && (receipt.phase==='preparation' ||
    Number.isFinite(preparation?.elapsedMs)&&check?.timeoutMs>0&&preparation.elapsedMs>=check.timeoutMs*0.8));
}

// A proposal for a successor contract, never a mutation of the original check.
// A timed-out step only supplies a lower bound, so reserve headroom for it and
// three times the aggregate step budget for preparation plus actual checking.
export function preparationBudgetProposal(check,receipt) {
  const next=structuredClone(check);
  for(const [index,step] of (next.preSteps??[]).entries()) {
    const observed=receipt.preparation?.steps?.[index];
    if(observed?.timedOut)step.timeoutMs=Math.min(3600000,Math.max((step.timeoutMs??check.timeoutMs)+1,Math.ceil((observed.elapsedMs??0)*1.3)));
  }
  const stepBudget=(next.preSteps??[]).reduce((sum,step)=>sum+(step.timeoutMs??check.timeoutMs),0);
  const estimatedMinimumMs=Math.ceil(Math.max(300000,3*stepBudget,3*(receipt.preparation?.elapsedMs??0),check.timeoutMs+1000)/1000)*1000;
  next.timeoutMs=Math.min(3600000,estimatedMinimumMs);
  return {check:next,estimatedMinimumMs,exceedsMaximum:estimatedMinimumMs>3600000};
}
