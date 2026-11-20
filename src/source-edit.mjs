import { createHash } from "node:crypto";

export function sourceFileFingerprint(file, bytes) {
  return createHash("sha256").update(file + "\0file\0").update(bytes).digest("hex");
}

export function classifySourceEdit(source, frozenText, current) {
  const before = source.digest;
  const after = current && sourceFileFingerprint(source.file, current);
  if (before === after) return null;
  const changed = { kind: "planning-source-changed", file: source.file, fromDigest: before, toDigest: after };
  if (!current || typeof frozenText !== "string" || !/\.(md|markdown)$/i.test(source.file)) return changed;
  const original = frozenSourceBytes(source, frozenText);
  if (!original || current.length <= original.length || !current.subarray(0, original.length).equals(original)) return changed;
  const suffix = current.subarray(original.length);
  let appended;
  try { appended = new TextDecoder("utf-8", { fatal: true }).decode(suffix); }
  catch { return changed; }
  const endsInLineBreak = original.at(-1) === 10;
  if ((!endsInLineBreak && !/^\r?\n/.test(appended)) || appended.includes("\0")) return changed;
  const startLine = 1 + (frozenText.match(/\n/g) ?? []).length + Number(!endsInLineBreak);
  const first = appended.split(/\r?\n/).find((line) => line.trim());
  const heading = /^#{1,6}[ \t]+/.test(first ?? "") ? first : undefined;
  return { ...changed, kind: "source-appended", appendedBytes: suffix.length, startLine,
    ...(heading && { firstAppendedHeading: heading.slice(0, 180) }) };
}

export function frozenSourceBytes(source, frozenText) {
  if (typeof frozenText !== "string") return;
  const plain = Buffer.from(frozenText, "utf8");
  // The frozen digest proves whether the original file included a UTF-8 BOM.
  return [plain, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain])]
    .find((bytes) => sourceFileFingerprint(source.file, bytes) === source.digest);
}

export function isRecordAppend(note, sourceKind) {
  return note?.kind === "source-appended" &&
    (/^#{2,6}[ \t]+(?:返工记录|实施记录|验收记录|进度记录|交付记录|变更记录|rework notes?|implementation notes?|validation notes?|progress notes?|handoff notes?)(?:\s|[：:(（-]|$)/i.test(note.firstAppendedHeading ?? "") ||
      sourceKind === "attempts" && /^#{2,6}[ \t]+本轮插入(?:\s|[：:(（-]|$)/.test(note.firstAppendedHeading ?? ""));
}
