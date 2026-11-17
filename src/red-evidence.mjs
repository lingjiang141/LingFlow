import { detectEnvironmentFailure } from "./environment-failure.mjs";
import { createHash } from "node:crypto";
import { coversPath, fingerprint, overlaps } from "./files.mjs";
import { executionFacts } from './evidence-facts.mjs';

// Red proves behavior on the admitted implementation, not on the later green candidate.
// Test identity is checked separately so replacing assertions cannot launder a red result.
export function redEvidence(root, task, check, implementationBaseline = task.baseline.sources, version) {
  const excludedTestWrites = [...task.verification.testWrites];
  const redProofScope = task.writes.filter(file => !coversPath(excludedTestWrites, file));
  const inputs = check.inputs.filter(file => !overlaps([file], task.writes));
  const redTestProof = fingerprint(root, excludedTestWrites);
  // Keep the original digest when tests have not changed since admission.
  // Old persisted jobs without a version continue through the legacy verifier.
  version ??= task.baseline.tests === redTestProof || !excludedTestWrites.length ? 1 : 2;
  return {
    redProofVersion: version,
    redImplementationBaseline: implementationBaseline,
    redProofScope,
    excludedTestWrites,
    redProof: version === 1 ? fingerprint(root, [...excludedTestWrites, ...inputs]) : createHash("sha256").update(JSON.stringify([
      implementationBaseline, redProofScope, fingerprint(root, inputs),
    ])).digest("hex"),
    redTestProof,
  };
}

export function redFailure(check, output) {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const emptyOrBroken = /no tests? (?:found|matched)|no test files found|^\s*(?:tests?:?\s*)?0 tests?\b|cannot find module|module_not_found|syntaxerror:|referenceerror:|(?:test|hook|fixture) timeout|TimeoutError:|browserType\.launch:/im.test(plain);
  const facts = executionFacts(check,plain);
  const marker = facts.evidenceKind === 'probe' ? check.expectedOutput || check.failureOutput : check.failureOutput || check.expectedOutput;
  const failure = facts.assertionSeen || facts.evidenceKind === 'probe' && facts.errorStackSeen;
  return Boolean(marker && plain.includes(marker) && failure && !emptyOrBroken);
}

export function redReceiptValid(check, receipt, output) {
  return !receipt.environmentFailure && !receipt.launchError && !receipt.signal && !receipt.timedOut &&
    !detectEnvironmentFailure(receipt, output, receipt.startedAt, check).environmentFailure &&
    receipt.failureOutputSeen === true && !receipt.truncated &&
    Number.isInteger(receipt.exitCode) && receipt.exitCode > 0 && receipt.exitCode === (check.expectedExit ?? receipt.exitCode) && redFailure(check, output);
}
