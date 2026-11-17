import { executionFacts } from './evidence-facts.mjs';
import { detectEnvironmentFailure } from './environment-failure.mjs';
export { evidenceKind } from './evidence-facts.mjs';

export function checkEvidenceFacts(check, receipt, output) {
  const facts = executionFacts(check,output), kind = facts.evidenceKind;
  const noStartupFailure = !receipt.launchError && !receipt.signal && !receipt.timedOut;
  const correction = receipt.environmentFailureReason === 'failed-before-tests' && noStartupFailure &&
    (kind === 'test' && facts.emptyTests || kind === 'probe' && facts.errorStackSeen &&
      !detectEnvironmentFailure(receipt,output,receipt.startedAt,check).environmentFailure)
    ? { environmentFailure:false,environmentFailureReason:null,matchedRule:null,reason:null,
      ...(receipt.classification==='environment-failed'&&{classification:null}) } : {};
  const base = { ...facts, ...correction, argv: [...check.argv] };
  if (kind !== 'test') return { ...base,
    caseReadback: 'not-applicable', evidenceReason: '该命令以目标 argv 与退出码证明执行，不解析测试用例' };
  const caseSeen = facts.testCaseSeen;
  return { ...base, caseReadback: caseSeen ? 'observed' : 'missing',
    evidenceReason: caseSeen ? null : facts.emptyTests ? 'no --grep match / zero tests：未执行匹配的测试用例' :
      'parser missed：输出未提供可核对的测试用例执行证据，请检查 reporter 和原日志' };
}
