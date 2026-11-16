import test from "node:test";
import assert from "node:assert/strict";
import { classifySourceEdit, sourceFileFingerprint } from "../src/source-edit.mjs";

test("planning append classification proves the entire original byte prefix", () => {
  const file = "docs/spec.md";
  const frozen = "原验收条款\r\n";
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(frozen)]);
  const source = { file, digest: sourceFileFingerprint(file, bytes) };
  const suffix = Buffer.from("## 返工记录\n保留原文\n");
  assert.deepEqual(classifySourceEdit(source, frozen, Buffer.concat([bytes, suffix])), {
    kind: "source-appended", file, fromDigest: source.digest,
    toDigest: sourceFileFingerprint(file, Buffer.concat([bytes, suffix])),
    startLine: 2, appendedBytes: suffix.length, firstAppendedHeading: "## 返工记录",
  });
  assert.equal(classifySourceEdit(source, frozen, bytes), null);
  assert.equal(classifySourceEdit(source, frozen, Buffer.from("改动原验收条款\r\n## 记录\n")).kind,
    "planning-source-changed");
  assert.equal(classifySourceEdit(source, "not the frozen text", Buffer.concat([bytes, suffix])).kind,
    "planning-source-changed");
  assert.equal(classifySourceEdit(source, frozen, null).kind, "planning-source-changed");
});

test("a line boundary is required and structured non-Markdown is never append-only", () => {
  for (const [file, original, appended, expected] of [
    ["tickets.md", "AC1", "## 备注", "planning-source-changed"],
    ["tickets.md", "AC1", "\r\n## 备注", "source-appended"],
    ["tickets.json", "{}", "\n{}", "planning-source-changed"],
  ]) {
    const source = { file, digest: sourceFileFingerprint(file, Buffer.from(original)) };
    assert.equal(classifySourceEdit(source, original, Buffer.from(original + appended)).kind, expected);
  }
});

test("only an initial record heading qualifies for dirty baseline adoption", async () => {
  const { isRecordAppend } = await import("../src/source-edit.mjs");
  const file = "planning notes.md";
  const frozen = "AC1\n";
  const source = { file, digest: sourceFileFingerprint(file, Buffer.from(frozen)) };
  for (const [suffix, expected] of [
    ["\n## 返工记录\n已记录\n", true],
    ["\n## 新验收条款\n", false],
    ["\n先修改 AC2\n## 返工记录\n", false],
  ]) assert.equal(isRecordAppend(classifySourceEdit(source, frozen, Buffer.from(frozen + suffix))), expected);
});
