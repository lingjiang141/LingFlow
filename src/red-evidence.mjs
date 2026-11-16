import { detectEnvironmentFailure } from "./environment-failure.mjs";
import { createHash } from "node:crypto";
import { coversPath, fingerprint, overlaps } from "./files.mjs";

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
  const emptyOrBroken = /no tests? (?:found|matched)|^\s*(?:tests?:?\s*)?0 tests?\b|cannot find module|module_not_found|syntaxerror:|referenceerror:|(?:test|hook|fixture) timeout|TimeoutError:|browserType\.launch:/im.test(plain);
  const assertion = /\bAssertionError\b|\bERR_ASSERTION\b|\bexpect\([^\n]*\)|^\s*(?:Expected|Received)\s*:/im.test(plain);
  const marker = check.failureOutput || check.expectedOutput;
  return Boolean(marker && plain.includes(marker) && assertion && !emptyOrBroken);
}

export function redReceiptValid(check, receipt, output) {
  return !receipt.environmentFailure && !detectEnvironmentFailure(receipt, output).environmentFailure &&
    receipt.failureOutputSeen === true && !receipt.truncated &&
    Number.isInteger(receipt.exitCode) && receipt.exitCode > 0 && redFailure(check, output);
}
