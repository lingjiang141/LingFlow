import test from "node:test";
import assert from "node:assert/strict";
import { executionFacts } from "../src/evidence-facts.mjs";

test("Node inline source and its arguments do not determine the evidence kind", () => {
  const source = "require('node:fs').readFileSync('vitest.config.ts')";
  for (const argv of [
    ["node", "-e", source],
    ["node", "--no-warnings", "--eval", source, "--test", "subject.test.ts"],
    ["C:/Tools/node.exe", "--eval=" + source],
    ["node", "-p", source],
  ]) {
    const result = executionFacts({ argv, stage: "independent" }, "ok");
    assert.equal(result.evidenceKind, "probe");
    assert.equal(result.testCaseSeen, null);
  }
});

test("explicit runners still require case evidence even at independent stage", () => {
  for (const argv of [
    ["node", "node_modules/vitest/vitest.mjs", "run", "x.test.ts"],
    ["node", "--test", "x.test.mjs", "-e", "argument"],
  ]) {
    const check = { argv, stage: "independent" };
    const empty = executionFacts(check, "ok");
    assert.equal(empty.evidenceKind, "test");
    assert.equal(empty.testCaseSeen, false);
    assert.equal(executionFacts(check, "# tests 1").testCaseSeen, true);
  }
});
