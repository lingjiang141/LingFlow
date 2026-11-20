import { createHash } from "node:crypto";
import { coversPath, fingerprintEol, overlaps, scopePaths } from "./files.mjs";
import { candidateFingerprint, candidateTreeFingerprint, readGit, verify } from "./quality.mjs";

const requireProof = (condition, message) => verify(condition, "contract-invalid", message);
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--no-indent-heuristic",
  "--diff-algorithm=myers", "--inter-hunk-context=0", "--unified=0", "--full-index"];

// Git reports an empty range at a boundary between lines. Represent boundaries
// and lines at separate coordinates so deletions and insertions also conflict.
function interval(start, count) {
  start = Number(start);
  count = count === undefined ? 1 : Number(count);
  return count ? [start * 2 - 1, (start + count - 1) * 2 - 1] : [start * 2, start * 2];
}

function ranges(patch, side) {
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map(match => interval(match[side], match[side + 1]));
}

export function proveCommitPartition(root, task, peer, git, { base, committed = false }) {
  const target = committed ? git.head : "--cached";
  const diff = (between, options, files = []) =>
    readGit(root, ["--literal-pathspecs", "diff", ...diffOptions, ...options, ...between, "--", ...files]);
  const selected = committed ? [base, target] : [target, base];
  const changes = diff(selected, ["--name-status", "-z"]).split("\0").filter(Boolean);
  const paths = scopePaths(changes.filter((_, i) => i % 2 === 1));
  requireProof(paths.length && paths.every(file => coversPath(task.writes, file)), "拟入库的路径须全部属于已验收票的冻结写集");
  const shared = paths.filter(file => coversPath(peer.writes, file));
  requireProof(shared.length, "当前暂存或提交没有两票共享的写入路径");
  const remaining = committed ? [git.head] : [];
  const bytes = new Map();
  if (task.candidateScope !== 2) {
    for (const [i, file] of changes.entries()) {
      if (i % 2 === 0 || changes[i - 1] === "D") continue;
      const entry = committed ? readGit(root, ["--literal-pathspecs", "ls-tree", "-z", git.head, "--", file]) :
        readGit(root, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", file]);
      requireProof(/^100(?:644|755) /.test(entry), "选定的候选路径须为普通文件：" + file);
      const object = committed ? git.head + ":" + file : ":0:" + file;
      bytes.set(file, readGit(root, ["cat-file", "blob", object], "buffer"));
    }
  }
  for (const file of shared) {
    const acceptedPatch = diff(selected, [], [file]);
    const peerPatch = diff(remaining, [], [file]);
    for (const patch of [acceptedPatch, peerPatch])
      requireProof(/^index [a-f0-9]+\.\.[a-f0-9]+ 100(?:644|755)\r?$/m.test(patch),
        "共享路径必须是模式未变化的普通文本文件：" + file);
    const acceptedRanges = ranges(acceptedPatch, 3);
    const peerRanges = ranges(peerPatch, 1);
    requireProof(acceptedRanges.length && peerRanges.length && !acceptedRanges.some(([left, right]) =>
      peerRanges.some(([from, to]) => from <= right && left <= to)), "共享路径的暂存与剩余 hunk 重叠或无法核对：" + file);
  }
  const unstaged = diff(remaining, ["--name-only", "-z"]).split("\0").filter(Boolean);
  requireProof(unstaged.every(file => !coversPath(task.writes, file) || shared.includes(file)),
    "已验收票仍有未纳入暂存的写集改动");
  requireProof(git.shortStatus.every(({ status, file }) => status !== "??" || !coversPath(task.writes, file)),
    "已验收票写集仍含未入库文件");
  const selectedCandidate = task.candidateScope === 2 ? candidateTreeFingerprint(root, task, committed ? git.head : undefined) :
    candidateFingerprint(root, task, fingerprintEol, bytes);
  requireProof(selectedCandidate === task.candidate,
    "选定的 hunk 无法完整重建已验收候选");
  const patch = diff(selected, ["--binary"]);
  requireProof(!/^(?:old|new) mode /m.test(patch), "部分提交不支持同时改变文件模式");
  const peerWorkspace = candidateFingerprint(root, peer);
  const proof = createHash("sha256").update(JSON.stringify([
    base, task.id, task.candidate, peer.id, peer.revision, peer.scheduleVersion ?? 0,
    patch, peerWorkspace,
  ])).digest("hex");
  return { paths, shared, proof, peerWorkspace };
}
