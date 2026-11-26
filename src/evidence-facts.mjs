function evidenceArgv(argv) {
  const args = argv.map(value => String(value).trim().replaceAll('\\', '/'));
  if (/^node(?:\.exe)?$/i.test(args[0]?.split('/').at(-1))) {
    // Inline source and arguments passed to it are data, not runner names.
    for (let i = 1; args[i]?.startsWith('-') && args[i] !== '--'; i++) {
      const option = args[i];
      if (/^(?:-[ep]|-pe|-ep|--eval(?:=|$)|--print(?:=|$))/.test(option)) return args.slice(0, i);
      if (['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions'].includes(option)) i++;
    }
  }
  return args;
}

export function evidenceKind(check = {}) {
  if (typeof check === 'string') return check;
  if (!check.argv) return check.evidenceKind ?? 'test';
  const argv = evidenceArgv(check.argv).map(value => value.toLowerCase());
  if (argv.some(value => /(?:^|\/)tsc(?:\.(?:js|cjs|mjs|cmd|exe))?$/.test(value)) || argv.includes('--check') ||
      argv.some(value => /^(?:build(?::[\w-]+)?|typecheck|type-check|check:types)$/.test(value))) return 'compile';
  if (argv.some(value => /(?:^|\/)(?:eslint|biome|stylelint)(?:\/|$|\.)/.test(value)) || argv.includes('lint')) return 'lint';
  if (argv.includes('--test') || argv.some(value=>/^test(?::|$)/.test(value)) || argv.some(value =>
    /(?:playwright|vitest|jest|mocha|pytest)(?:\/|$|\.)/.test(value) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value))) return 'test';
  return 'probe';
}

// Both environment detection and evidence readback use these output facts.
export function executionFacts(check, output = '') {
  const kind = evidenceKind(check);
  const plain = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const emptyTests = /no tests? (?:found|matched)|no test files found|\b(?:running\s+)?0\s+tests?\b/im.test(plain);
  const assertionSeen = /\bAssertionError\b|\bERR_ASSERTION\b|\bexpect\([^\n]*\)|^\s*(?:Expected|Received)\s*:/im.test(plain);
  const testCountSeen = /\bRunning\s+\d+\s+tests?\b|^\s*(?:#\s*)?(?:tests?|test suites?)\s*:?\s+\d+\b|^\s*#\s*Subtest:|^\s*\[\d+\/\d+\]/im.test(plain);
  const testCaseSeen = !emptyTests && (assertionSeen || /\bRunning\s+[1-9]\d*\s+tests?\b|^\s*(?:#\s*)?tests?\s*:?\s+[1-9]\d*\b|^\s*#\s*Subtest:|^\s*(?:[✓✔✘✖×]|(?:not )?ok\s+\d+)\s+\S|^\s*\[\d+\/\d+\]|\b[1-9]\d*\s+(?:passed|failed)\b/im.test(plain));
  const errorStackSeen = /^\s*(?:[\w.]*Error)(?:\s+\[[^\]]+\])?:[^\n]*(?:\n[^\n]*)*?\n\s+at\s+\S/m.test(plain);
  return { evidenceKind: kind, testCountSeen: kind === 'test' ? testCountSeen : null,
    testCaseSeen: kind === 'test' ? testCaseSeen : null, emptyTests, assertionSeen, errorStackSeen,
    compileErrorSeen: /\berror TS\d+\b|\bSyntaxError:/i.test(plain) };
}

export function redEvidenceRequirement(kind) {
  return kind === 'probe'
    ? '红探针需要预期非零退出码、expectedOutput 匹配，以及本进程 Error 错误栈（含 at）或 AssertionError；启动/依赖失败、超时和截断日志无效'
    : '红检查需要预期非零退出码、冻结失败标记和真实断言失败；空跑、环境失败和截断日志无效';
}
