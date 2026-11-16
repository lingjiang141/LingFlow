export function evidenceKind(check) {
  const argv = check.argv.map(value => String(value).trim().replaceAll('\\', '/').toLowerCase());
  if (argv.some(value => /(?:^|\/)tsc(?:\.(?:js|cjs|mjs|cmd|exe))?$/.test(value)) || argv.includes('--check') ||
      argv.some(value => /^(?:build(?::[\w-]+)?|typecheck|type-check|check:types)$/.test(value))) return 'compile';
  if (argv.some(value => /(?:^|\/)(?:eslint|biome|stylelint)(?:\/|$|\.)/.test(value)) || argv.includes('lint')) return 'lint';
  if (argv.includes('--test') || argv.some(value=>/^test(?::|$)/.test(value)) || argv.some(value =>
    /(?:playwright|vitest|jest|mocha|pytest)(?:\/|$|\.)/.test(value) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value))) return 'test';
  return 'probe';
}

export function checkEvidenceFacts(check, receipt, output) {
  const kind = evidenceKind(check);
  const base = { evidenceKind: kind, argv: [...check.argv] };
  if (kind !== 'test') return { ...base, testCountSeen: null, testCaseSeen: null,
    caseReadback: 'not-applicable', evidenceReason: '该命令以目标 argv 与退出码证明执行，不解析测试用例' };
  const plain = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const empty = /no tests? (?:found|matched)|no test files found|\b(?:running\s+)?0\s+tests?\b/im.test(plain);
  const caseSeen = !empty && Boolean(receipt.testCaseSeen ||
    /\b[1-9]\d*\s+(?:passed|failed)\b|^\s*(?:not )?ok\s+\d+\s+\S|^\s*(?:✓|✔|✘|✖|×)\s+\S/im.test(plain));
  return { ...base, ...(empty&&receipt.environmentFailureReason==='failed-before-tests'&&{
    environmentFailure:false,environmentFailureReason:null,reason:null}), testCaseSeen: caseSeen, caseReadback: caseSeen ? 'observed' : 'missing',
    evidenceReason: caseSeen ? null : empty ? 'no --grep match / zero tests：未执行匹配的测试用例' :
      'parser missed：输出未提供可核对的测试用例执行证据，请检查 reporter 和原日志' };
}
