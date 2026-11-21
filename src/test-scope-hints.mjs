import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { coversPath } from "./files.mjs";
import { readGit } from "./quality.mjs";

const testPath = /(?:^|\/)(?:__tests__|tests?|e2e|specs?)\/.*\.[cm]?[jt]sx?$|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const change = /(?:从|由|from)\s*(\d{3}|["'`][^"'`\r\n]{1,40}["'`])\s*(?:改为|变为|调整为|变成|到|to)\s*(\d{3}|["'`][^"'`\r\n]{1,40}["'`])/gi;
const removed = /(?:不再|禁止)[^。；\r\n]{0,24}?(?:返回|使用|包含)\s*(\d{3}|["'`][^"'`\r\n]{1,40}["'`])/g;
const terms = { 导出: "export", 下载: "download", 评分: "rater", 登录: "login", 提交: "submit", 权限: "permission", 访问: "access" };
const genericStems = new Set(["test", "spec", "index", "app", "main", "api", "server", "web", "client", "route", "routes"]);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function relatedTestWarnings(root, task) {
  const acceptance = task.verification?.acceptance?.map(item => item.text).join("\n") ?? "";
  const transitions = [...acceptance.matchAll(change)];
  const old = [...new Set([...transitions.filter(([, a, b]) => a !== b), ...acceptance.matchAll(removed)].map(([, a]) => a))];
  if (!old.length) return [];
  const hints = new Set([
    ...Object.entries(terms).filter(([term]) => acceptance.includes(term)).map(([, hint]) => hint),
    ...task.writes.flatMap(file => file.split("/").at(-1).split(/[^a-z]+/i))
      .map(term => term.toLowerCase()).filter(term => term.length >= 4 && !genericStems.has(term)),
  ]);
  const assertsOld = new RegExp("\\b(?:toBe|toEqual|toStrictEqual|toContain|toContainEqual)\\s*\\(\\s*(?:" +
    old.map(value => /^\d+$/.test(value) ? value + "(?!\\d)" : "[\"'`]" + escape(value.slice(1, -1)) + "[\"'`]").join("|") +
    ")\\s*(?=[),])");
  try {
    const base = realpathSync(root);
    const candidates = readGit(root, ["ls-files", "-z"]).split("\0")
      .filter(file => testPath.test(file) && !coversPath(task.writes, file));
    const matchesHint = value => [...hints].some(term => value.toLowerCase().includes(term));
    candidates.sort((a, b) => Number(matchesHint(b)) - Number(matchesHint(a)));
    const hits = [];
    for (const file of candidates.slice(0, 500)) {
      const full = resolve(base, file);
      try {
        const stat = lstatSync(full);
        if (!stat.isFile() || stat.size > 256 * 1024 || realpathSync(full) !== full) continue;
        const lines = readFileSync(full, "utf8").split(/\r?\n/);
        const index = lines.findIndex((line, offset) => assertsOld.test(line) &&
          (!hints.size || matchesHint(file) || matchesHint(lines.slice(Math.max(0, offset - 5), offset + 3).join("\n"))));
        if (index >= 0) hits.push({ file, line: index + 1 });
        if (hits.length === 12) break;
      } catch { /* Deleted, inaccessible or redirected files cannot supply hints. */ }
    }
    return hits;
  } catch { return []; }
}
