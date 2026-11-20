import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { scopePaths } from "./files.mjs";
import { invalidPlan, violation } from "./plan-schema.mjs";

const ticketId = /^#\s+(?:票(?:面)?\s*|Ticket\s+)?([A-Z][\w]*-\d+)(?=[\s:：]|$)\s*[:：]?\s*(.*)$/im;
const codeSpans = (value) => [...value.matchAll(/`([^`\r\n]+)`/g)].map((m) => m[1]);
const filePath = (value) => /^[\p{L}\p{N}_.@ -]+(?:\/[\p{L}\p{N}_.@ -]+)+\.[\w]+$/u.test(value);
const normalize = (values) => scopePaths(values);

export function ticketSourcePaths(root, sources) {
  if (sources.ticketsDir === undefined && typeof sources.tickets === "string") return null;
  if (sources.ticketsDir !== undefined && sources.tickets !== undefined)
    throw Error("sources.tickets 和 sources.ticketsDir 只能选一种");
  let files = sources.tickets;
  if (sources.ticketsDir !== undefined) {
    const [directory] = normalize([sources.ticketsDir]);
    const absolute = path.resolve(root, directory);
    if (!lstatSync(absolute).isDirectory() || realpathSync(absolute) !== absolute)
      throw Error("sources.ticketsDir 必须是项目内的普通目录");
    files = readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => directory + "/" + entry.name);
  }
  if (!Array.isArray(files) || !files.length || files.length > 30 || !files.every((file) => typeof file === "string" && /\.md$/i.test(file)))
    throw Error("sources.tickets 须为 1–30 个 Markdown 路径，或改用 sources.ticketsDir");
  return normalize(files);
}

export function splitHiveTickets(document) {
  return document.text.split(/(?=^#\s+(?:票(?:面)?\s*|Ticket\s+)?[A-Z][\w]*-\d+(?=[\s:：]|$))/m)
    .filter((text) => ticketId.test(text)).map((text) => ({ ...document, text }));
}

export function parseHiveTicket(document, { exists = () => false } = {}) {
  const match = ticketId.exec(document.text);
  if (!match) return null;
  const sections = new Map();
  for (const section of document.text.split(/^##\s+/m).slice(1)) {
    const end = section.indexOf("\n");
    if (end >= 0) sections.set(section.slice(0, end).trim(), section.slice(end + 1).trimEnd());
  }
  const ownership = sections.get("依赖与归属") ?? "";
  const acSection = sections.get("需求与 AC") ?? "";
  const acceptance = [...acSection.matchAll(/^[ \t]*(?:[-*][ \t]+)?\*\*(AC-?\d+)\b([^*]*)\*\*[ \t]*[:：]?[ \t]*([\s\S]*?)(?=^[ \t]*(?:(?:[-*][ \t]+)?\*\*AC-?\d+\b|>|\x60{3}|~{3})|(?![\s\S]))/gm)]
    .map((m) => ({ id: m[1], text: (m[2].trim() + " " + m[3].trim()).trim() }));
  const route = sections.get("Planned attempt 01") ?? [...sections].find(([name]) => /^Planned attempt\s+\d+$/i.test(name))?.[1] ?? "";
  const field = (name) => route.match(new RegExp("^\\*\\*" + name + ":\\*\\*\\s*(.+)$", "m"))?.[1];
  const availability = codeSpans(document.text).filter(filePath);
  const writeLines = ownership.split(/(?=^\s*[-*]\s+)/m)
    .filter((line) => /^\s*[-*]\s*(?:归属[^：:]*|写集|测试)[:：]/.test(line))
    .map((line) => line.split(/[；;]\s*|\n\s*(?=若|仅)/)[0]);
  const unresolved = [];
  const writes = normalize(writeLines.flatMap((line) => codeSpans(line).flatMap((ref) => {
    if (filePath(ref)) return [ref];
    if (!/^\d{3}$|^[\w.-]+\.[\w]+$/.test(ref)) return [];
    const mentioned = [...new Set(availability.filter((file) => file.endsWith("/" + ref) || file.split("/").at(-1)?.startsWith(ref + "-")))];
    if (mentioned.length === 1) return mentioned;
    if (mentioned.length > 1) { unresolved.push(ref); return []; }
    const siblings = codeSpans(line).filter(filePath).map((file) => file.slice(0, file.lastIndexOf("/") + 1) + ref)
      .filter(exists);
    const narrow = [...new Set([...siblings, ...["apps/server/src/", "apps/web/src/"].map((dir) => dir + ref).filter(exists)])];
    if (narrow.length === 1) return narrow;
    unresolved.push(ref);
    return [];
  })));
  const readRefs = ownership.split(/(?=^\s*[-*]\s+)/m)
    .filter((line) => /^\s*[-*]\s*(?:只读|读集|读取)[:：]/.test(line))
    .flatMap((line) => codeSpans(line));
  const reads = normalize(readRefs.filter(filePath));
  const unresolvedReads = readRefs.filter((ref) => !filePath(ref));
  const prerequisites = ownership.split("\n").find((line) => /^\s*[-*]\s*前置[:：]\s*(?!无)/.test(line) && !/前置[:：]\s*无/.test(line));
  const after = [...new Set(prerequisites?.match(/[A-Z][\w]*-\d+/g) ?? [])].filter((ticket) => !/^AC-?\d+$/.test(ticket)).map((ticket) => ({ ticket, stage: "verified" }));
  const resourceLine = ownership.split("\n").find(line => /^\s*[-*]\s*共享资源[:：]/.test(line));
  const resources = resourceLine && codeSpans(resourceLine);
  const riskPattern = /(?:等级|风险)(?:\*\*)?[:：]\s*(?:\*\*)?(low|medium|high|低[-–—]中|低|中|高)(?![a-z])/i;
  const riskLine = sections.get("riskAssessment")?.split("\n").find((line) => riskPattern.test(line));
  const level = riskLine?.match(riskPattern)?.[1]?.toLowerCase();
  const risk = ({ 低: "low", 中: "medium", 高: "high" })[level] ?? (level?.startsWith("低") ? "medium" : level);
  const browserE2E = acceptance.flatMap((ac) => {
    if (!/浏览器|Playwright/i.test(ac.text)) return [];
    const refs = codeSpans(ac.text);
    const file = refs.find((ref) => filePath(ref) && /\.(?:spec|test)\.[jt]sx?$/.test(ref));
    const title = refs.find((ref) => ref.startsWith(match[1] + " "));
    return file && title ? [{ file, title, reason: "票面 " + ac.id + " 要求验证真实浏览器行为", covers: [ac.id] }] : [];
  });
  return { key: match[1], title: match[2], writes, reads, unresolved, unresolvedReads, acceptance, after, risk, resources,
    attempts: route, riskReason: riskLine?.replace(/^\s*[-*]\s*/,""), brief: field("Objective"), stopConditions: field("Stop conditions"), browserE2E };
}
export function substituteTicket(input, inferred, warnings, prefix) {
  if (!inferred) return input;
  const merged = { ...input };
  for (const name of ["writes", "reads"]) {
    if (input[name] === undefined || input[name] === "from-ticket" || (name === "writes" && !input.readOnly && Array.isArray(input.writes) && !input.writes.length)) {
      const unresolved = name === "writes" ? inferred.unresolved : inferred.unresolvedReads;
      if (unresolved.length)
        throw invalidPlan([violation(prefix + "." + name, "票面路径不能唯一解析：" + unresolved.join("、"), ["app/file.ts"], "在派发参数明确补充经核实的项目相对路径，不改原票")]);
      merged[name] = inferred[name];
      warnings.push({ path: prefix + "." + name, message: "已从票面派生", value: merged[name] });
    } else if ((inferred[name].length || (name==="writes" ? inferred.unresolved.length : inferred.unresolvedReads.length)) && JSON.stringify(scopePaths(input[name])) !== JSON.stringify(inferred[name])) {
      const actual = scopePaths(input[name]);
      const difference = [
        ...inferred[name].filter(file => !actual.includes(file)).map(file => ({ file, kind: "显式未声明" })),
        ...actual.filter(file => !inferred[name].includes(file)).map(file => ({ file, kind: "显式多声明", detail: "票面未声明" })),
      ];
      warnings.push({ path: prefix + "." + name, message: "显式范围与票面派生不同，使用显式值；主控须核对差异", derived: inferred[name], actual, difference });
    }
  }
  for (const name of ["title", "brief", "stopConditions", "risk", "riskReason", "after", "resources"])
    if (merged[name] === undefined && inferred[name] !== undefined) merged[name] = inferred[name];
  merged.description ??= inferred.attempts || inferred.title;
  const rank = ["low","medium","high"];
  if (inferred.risk && rank.includes(merged.risk) && rank.indexOf(inferred.risk) > rank.indexOf(merged.risk)) {
    merged.risk=inferred.risk;
    warnings.push({path:prefix+".risk",message:"已保留票面更高风险及原有质量门槛",value:merged.risk});
  }
  const verification = { ...merged.verification };
  if (!merged.readOnly) {
    verification.acceptance ??= inferred.acceptance;
    verification.testWrites ??= inferred.writes.filter((file) => /\.(?:test|spec|cy)\.[cm]?[jt]sx?$/.test(file));
    if (inferred.acceptance.length) {
      if (Array.isArray(verification.acceptance)) {
        verification.acceptance = verification.acceptance.map((ac) => {
          const original = inferred.acceptance.find(({id})=>id===ac?.id);
          if (original && original.text!==ac.text) warnings.push({path:prefix+".verification.acceptance."+ac.id,message:"验收正文与票面不同，保留原票正文"});
          return original ?? ac;
        });
        const missing = inferred.acceptance.filter(({ id }) => !verification.acceptance.some((ac) => ac?.id === id));
        if (missing.length) {
          verification.acceptance = [...verification.acceptance, ...missing];
          warnings.push({path:prefix+".verification.acceptance",message:"已保留派发参数漏列的票面 AC；仍须提供 full 覆盖", value:missing.map((ac)=>ac.id)});
        }
      }
    }
    verification.browserE2E ??= inferred.browserE2E;
    merged.verification = verification;
  }
  return merged;
}
