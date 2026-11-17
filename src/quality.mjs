import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { classifySourceEdit, frozenSourceBytes, isRecordAppend, sourceFileFingerprint } from "./source-edit.mjs";
import { checkShape, invalidPlan, planSchema, unknownFields, violation } from "./plan-schema.mjs";
import { alignBrowserArgv, assertCheckOwnership, freezeBrowserChecks, INDEPENDENT_LIMIT_MS, normalizeBrowserArgv } from "./verification-policy.mjs";
import { ticketSourcePaths } from "./hive-plan.mjs";
import { coversPath, fingerprint, overlaps, ownershipFingerprints, scopePaths } from "./files.mjs";
import { commandProgress, gitCommandTimeout } from "./execution-policy.mjs";
import { ownershipPolicy } from "./ownership-policy.mjs";
import { preparationContract } from "./check-preparation.mjs";
import { probeSeparationIssues } from './probe-separation.mjs';

const stages = ["red", "green", "full", "regression", "independent", "controller"];
export const dimensions = ["requirements", "implementation", "system"];
export const verificationCodes = ["contract-invalid", "evidence-missing", "quality-failed"];

export function verify(value, code, message) {
  if (!value) throw Object.assign(Error(message), { verificationCode: code });
  return value;
}

function requireValue(value, message) {
  if (!value) throw Error(message);
  return value;
}

export function list(value, label, max = 40) {
  return requireValue(
    Array.isArray(value) && value.length <= max && value,
    label + "格式无效",
  );
}

export function key(value, label) {
  return requireValue(
    typeof value === "string" && /^[\w.-]{1,80}$/.test(value) && value,
    label + "必须是稳定编号",
  );
}

function note(value, label) {
  return requireValue(
    typeof value === "string" &&
      value.trim() &&
      value.length <= 8000 &&
      value.trim(),
    label + "不能为空或过长",
  );
}

export function commandArgs(value) {
  const argv = list(value, "检查命令", 32);
  requireValue(
    argv.length &&
      argv.every(
        (arg) =>
          typeof arg === "string" && arg.length <= 2048 && !arg.includes("\0"),
      ),
    "检查命令必须使用 argv 数组",
  );
  requireValue(
    ["node", "npm"].includes(argv[0]) ||
      (path.isAbsolute(argv[0]) && /\.(exe|com)$/i.test(argv[0])),
    "检查程序必须为 node、npm 或绝对 .exe/.com 路径",
  );
  return argv;
}

export function planSources(root, value, keepText = false) {
  requireValue(
    value && typeof value === "object",
    "请引用已确认的 spec、tickets、planned attempts",
  );
  const files = ticketSourcePaths(root, value);
  const fields = files ? ["spec", "attempts", ...files.map((_, index) => "ticket:" + index)] : ["spec", "tickets", "attempts"];
  return Object.fromEntries(
    fields.map((field) => {
      const sourceFile = field.startsWith("ticket:") ? files[Number(field.slice(7))] : value[field];
      try {
        const [file] = scopePaths([sourceFile]);
        const absolute = path.resolve(root, file);
        const stat = lstatSync(absolute);
        requireValue(
          stat.isFile() && stat.size <= 128 * 1024,
          "规划来源必须是 128 KiB 以内的项目文档",
        );
        const digest = fingerprint(root, [file]);
        const document = { file, digest };
        if (keepText) {
          document.text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
          requireValue(document.text.trim() && !document.text.includes("\0") && fingerprint(root, [file]) === digest,
            "规划文档必须是非空、稳定的 UTF-8 文本");
        }
        return [field, document];
      } catch (error) {
        throw Object.assign(Error(`sources.${field}（${typeof sourceFile === "string" ? JSON.stringify(sourceFile) : "未填写"}）：${error.message}。请填写存在的 UTF-8 项目相对文件，例如 {"${field}":"${field}.md"}。`, { cause: error }), { verificationCode: "contract-invalid" });
      }
    }),
  );
}

export function cumulativeCheck(input, members, root) {
  const argv = commandArgs(input.argv);
  assertCheckOwnership(root, { id: input.key, stage: "batch", argv });
  const inputs = scopePaths(input.inputs);
  const timeoutMs = input.timeoutMs ?? 300000;
  requireValue(
    inputs.length &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 100 &&
      timeoutMs <= 3600000,
    "累计检查须声明输入及有效超时",
  );
  const resources = list(input.resources ?? [], "累计检查资源").map((value) =>
    note(value, "资源").toLowerCase(),
  );
  const covers = list(input.covers, "累计检查覆盖").map((entry) => {
    const task = members.find((member) => member.ticketKey === entry?.ticket);
    const acceptance = list(entry?.acceptance, "累计验收条款");
    requireValue(
      task &&
        acceptance.length &&
        acceptance.every((id) =>
          task.verification.acceptance.some((ac) => ac.id === id),
        ),
      "累计检查须映射到成员票的真实验收条款",
    );
    return { taskId: task.id, acceptance };
  });
  requireValue(
    members.every((task) => covers.some((entry) => entry.taskId === task.id)),
    "累计检查须覆盖每张成员票",
  );
  return {
    id: key(input.key, "批次"),
    stage: "batch",
    ownershipPolicy: 1,
    argv,
    inputs,
    timeoutMs,
    resources,
    covers,
    expectedExit: 0,
    ...(input.failureOutput !== undefined && { failureOutput: note(input.failureOutput, "断言失败标记") }),
    expectedOutput:
      input.expectedOutput === undefined
        ? ""
        : note(input.expectedOutput, "预期输出"),
  };
}

export function readVerification(input, { root, writes, risk, warnings = [], prefix = "verification" }) {
  const issues = [];
  const add = (path, message, expected, remedy) => issues.push(violation(prefix + path, message, expected, remedy));
  const attempt = (path, expected, remedy, fn, fallback) => {
    try { return fn(); } catch (error) { add(path, error.message, expected, remedy); return fallback; }
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalidPlan([violation(prefix, "实施票必须提供冻结的 verification 检查方案", planSchema.tickets[0].verification,
      "填入验收条款、测试文件和可执行的检查后重新预检")]);
  unknownFields(input, ["acceptance","testWrites","checks","browserE2E"], prefix, warnings);
  const acceptance = attempt(".acceptance", planSchema.tickets[0].verification.acceptance, "补齐稳定 AC 编号和原票正文", () =>
    list(input.acceptance, "验收条款").map((ac) => ({id:key(ac?.id,"验收条款"),text:note(ac?.text,"验收条款")})), []);
  const acIds = new Set(acceptance.map((ac) => ac.id));
  if (!acIds.size || acIds.size !== acceptance.length) add(".acceptance","验收条款编号不能为空或重复",["AC-1"],"逐条补齐且去重");
  const testWrites = attempt(".testWrites", ["test/example.test.cjs"],"填写实际要改的测试文件",()=>scopePaths(input.testWrites ?? []),[]);
  if (!testWrites.length || testWrites.some((file)=>!coversPath(writes,file)))
    add(".testWrites","必须声明写入范围内的行为测试文件",["test/example.test.cjs"],"把必改测试加入 writes 与 testWrites；只读回归文件放入 inputs");
  const entries = attempt(".checks", [checkShape],"提交冻结检查数组",()=>list(input.checks,"检查方案",20),[]);
  const checks = [];
  for (const [index, check] of entries.entries()) {
    const at = ".checks[" + index + "]";
    const before = issues.length;
    unknownFields(check, ["id","stage","argv","inputs","covers","timeoutMs","expectedExit","expectedOutput","failureOutput","deriveRed","redExpectedOutput","redExpectedExit","preSteps","requiredArtifacts"], prefix+at, warnings);
    const id = attempt(at+".id",checkShape.id,"为检查分配唯一稳定编号",()=>key(check?.id,"检查"));
    const stage = check?.stage;
    if (!stages.includes(stage)) add(at+".stage","未知检查阶段",stages,"选择适用阶段");
    const argv = attempt(at+".argv",checkShape.argv,"使用参数数组，不用 shell 字符串",()=>commandArgs(normalizeBrowserArgv(check?.argv)),[]);
    const covers = attempt(at+".covers",stage==="regression"?[]:checkShape.covers,"引用现有 AC；regression 不计 AC 覆盖",()=>[...new Set(list(check?.covers ?? (stage==="regression"?[]:undefined),"检查覆盖"))],[]);
    if ((stage==="regression" ? covers.length : !covers.length || covers.some((ac)=>!acIds.has(ac))))
      add(at+".covers","检查必须关联已有验收条款；regression 的 covers 必须为空",stage==="regression"?[]:[...acIds],"补上真实覆盖的 AC，或将纯回归标成 regression");
    const inputs = attempt(at+".inputs",checkShape.inputs,"填写所有实际输入的项目相对路径",()=>scopePaths(check?.inputs),[]);
    if (!inputs.length) add(at+".inputs","检查必须声明实际输入",checkShape.inputs,"填写检查实际读取的路径");
    const controller = ["independent","controller"].includes(stage);
    const timeoutMs = check?.timeoutMs ?? (controller?15000:120000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs<100 || timeoutMs>3600000)
      add(at+".timeoutMs","检查超时须在 100ms 到 1 小时之间",120000,"填写有效毫秒值");
    else if (controller && timeoutMs>INDEPENDENT_LIMIT_MS)
      add(at+".timeoutMs","主控收口检查限低负载短探针：limit="+INDEPENDENT_LIMIT_MS+" actual="+timeoutMs,INDEPENDENT_LIMIT_MS,"将长验证移到开发 full/regression 或累计批次；主控保留短探针");
    const expectedExit = stage==="red" ? (check.expectedExit??1) : 0;
    const expectedOutput = check?.expectedOutput === undefined ? "" :
      attempt(at+".expectedOutput","AssertionError: expected behavior","填入对应断言的实际失败标记",()=>note(check.expectedOutput,"预期输出"),"");
    if (stage==="red" && (!Number.isInteger(expectedExit)||expectedExit<1||expectedExit>125||!expectedOutput))
      add(at+".expectedOutput","红阶段须指定预期失败退出码和失败输出",{expectedExit:1,expectedOutput:"AssertionError: expected behavior"},"用同一检查的真实反例，声明退出码和断言失败标记");
    const failureOutput = check?.failureOutput===undefined ? undefined :
      attempt(at+".failureOutput","AssertionError","填写可定位的断言失败标记",()=>note(check.failureOutput,"断言失败标记"));
    const preparation = attempt(at+".preSteps", {preSteps:[{argv:["npm","run","build"],outputs:["apps/web/dist"]}]}, "声明构建命令、独立产物路径和实际 inputs", () => preparationContract({ ...check, inputs, timeoutMs }, writes, commandArgs), {});
    if(preparation.preSteps?.length&&timeoutMs<300000)warnings.push({path:prefix+at+'.timeoutMs',
      message:'构建前置可能占满预算：preSteps 与实际检查共享 '+timeoutMs+'ms 总时限',
      timeoutMs,preStepBudgetMs:preparation.preSteps.reduce((sum,step)=>sum+step.timeoutMs,0),
      remedy:'按构建实测下限为新票预留至少三倍前置预算，并给每一步填写合理 timeoutMs；本提示不修改冻结检查。'});
    if (controller && preparation.preSteps?.length) add(at+".preSteps", "主控短探针不能执行构建前置", [], "将构建交开发检查");
    if (issues.length===before) checks.push({ id, stage, argv, covers, inputs, timeoutMs, expectedExit, expectedOutput, ...(failureOutput&&{failureOutput}), ...(preparation.requiredArtifacts?.length && preparation) });
  }
  alignBrowserArgv(checks, input.browserE2E, warnings, prefix, entries);
  for(const issue of probeSeparationIssues(checks))add('.checks.'+issue.checkId+'.'+issue.field,issue.message,
    {separateFrom:issue.developerCheckId},'使用实际独立、低负载且输入范围较小的探针；不复制开发 full/regression，缺证用 rework + evidence 回投责任成员');
  const recipe = (check) => JSON.stringify([check.argv,[...check.covers].sort(),check.inputs, check.preSteps ?? [], check.requiredArtifacts ?? []]);
  for (const green of checks.filter((c)=>c.stage==="green")) {
    const raw = entries.find((c)=>c?.id===green.id);
    if (!(raw?.deriveRed === true || raw?.redExpectedOutput !== undefined || green.failureOutput) ||
        checks.some((c)=>c.stage==="red"&&recipe(c)===recipe(green))) continue;
    const marker = raw.redExpectedOutput ?? green.failureOutput;
    const exit = raw.redExpectedExit ?? 1;
    if (typeof marker!=="string" || !marker.trim() || marker.length>8000 || !Number.isInteger(exit) || exit<1 || exit>125 || green.id.length>76) {
      add(".checks."+green.id+".deriveRed","无法安全派生 red：需要真实失败断言和非零退出码",{deriveRed:true,redExpectedExit:1,redExpectedOutput:"实际断言失败标记"},"从预期失败用例填写断言标记，或显式声明 red");
      continue;
    }
    checks.push({...green,id:green.id+"-red",stage:"red",expectedExit:exit,expectedOutput:marker.trim()});
    warnings.push({path:prefix+".checks."+green.id,message:"已派生 "+green.id+"-red；仍须真实执行并核对断言"});
  }
  if (new Set(checks.map((c)=>c.id)).size!==checks.length || checks.length>20)
    add(".checks","检查编号不能重复且最多 20 条","unique ids; <=20","重命名重复检查或合并相同职责");
  const red=checks.filter((c)=>c.stage==="red"), green=checks.filter((c)=>c.stage==="green");
  for (const [from,to,missing] of [[red,green,"green"],[green,red,"red"]]) {
    for(const c of from) {
      if(to.some((other)=>recipe(other)===recipe(c)))continue;
      const keys = ["argv","covers","inputs","preSteps","requiredArtifacts"];
      const values = JSON.parse(recipe(c));
      const nearest=to.map((other)=>({other,fields:JSON.parse(recipe(other)).map((v,i)=>JSON.stringify(v)===JSON.stringify(values[i])?null:keys[i]).filter(Boolean)}))
        .sort((a,b)=>a.fields.length-b.fields.length)[0];
      add(".checks."+c.id,"局部红绿必须成对；缺少 "+missing+(nearest?"（"+nearest.other.id+" 不同字段："+nearest.fields.join("、")+"）":""),
        {stage:missing,argv:c.argv,covers:c.covers,inputs:c.inputs}, missing==="red"?"在 green 声明 deriveRed:true 和 redExpectedOutput，或添加同键 red":"复制配对键添加 green，期望退出码为 0");
    }
  }
  if (!red.length && !green.length) add(".checks","缺少 red 和 green",checkShape,"按同一 argv、inputs、covers 添加红绿检查");
  const full = new Set(checks.filter((c)=>c.stage==="full").flatMap((c)=>c.covers));
  const uncovered = acceptance.filter((ac)=>!full.has(ac.id)).map((ac)=>ac.id);
  if (uncovered.length) add(".checks","完整检查未覆盖验收条款："+uncovered.join("、"),{stage:"full",covers:uncovered},"添加真实验证这些 AC 的 full 检查，保持原 AC");
  if (risk!=="high"&&!checks.some((c)=>c.stage==="independent")) add(".checks","免审实施票必须指定主控独立验收检查",{...checkShape,stage:"independent",timeoutMs:15000},"增加真实、低负载的独立探针");
  if (risk==="high"&&checks.some((c)=>c.stage==="independent")) add(".checks","高风险实施票走独立审查",{stage:"controller"},"如确需主控短探针，改用 controller");
  for (const check of checks) attempt(".checks."+check.id,check.stage==="regression"?{stage:"regression",covers:[]}:{...checkShape,timeoutMs:INDEPENDENT_LIMIT_MS},
    "主控仅用短探针；浏览器回归用 regression，证据检查绑定具名用例",()=>assertCheckOwnership(root,check));
  for (const [index, entry] of (Array.isArray(input.browserE2E) ? input.browserE2E : []).entries())
    unknownFields(entry, ["file","title","reason","covers"], prefix+".browserE2E["+index+"]", warnings);
  for (const [index, ac] of (Array.isArray(input.acceptance) ? input.acceptance : []).entries())
    unknownFields(ac, ["id","text"], prefix+".acceptance["+index+"]", warnings);
  const browserE2E=freezeBrowserChecks(root, input.browserE2E === undefined ? [] : input.browserE2E, checks, testWrites, acIds,
    (path,message,expected,remedy)=>add(path,message,expected,remedy));
  if(issues.length) throw invalidPlan(issues);
  return {acceptance,testWrites,checks,browserE2E};
}

export function evidenceJobs(ids, checks, label, acceptanceId) {
  const selected = Array.isArray(ids) && ids.length && ids.length <= checks.length &&
    ids.map((id) => checks.find((check) => check.checkId === id &&
      !["red", "regression"].includes(check.stage) && (!acceptanceId || check.covers.includes(acceptanceId))));
  verify(selected && selected.every(Boolean) && new Set(ids).size === ids.length,
    "evidence-missing", label + "须引用适用的已通过检查 checkIds");
  return selected.map(({ checkId, jobId }) => ({ checkId, jobId }));
}

export function threeDimensions(input, checks) {
  return Object.fromEntries(
    dimensions.map((name) => {
      const item = input?.[name];
      verify(
        ["pass", "issues", "unverified"].includes(item?.state),
        "evidence-missing",
        "请提供需求、实现和系统影响三维检查结果",
      );
      return [
        name,
        {
          state: item.state,
          evidence: verify(typeof item.evidence === "string" && item.evidence.trim() &&
            item.evidence.length <= 8000 && item.evidence.trim(), "evidence-missing", name + "证据不能为空或过长"),
          ...(checks && item.state === "pass" && { evidenceJobs: evidenceJobs(item.checkIds, checks, name) }),
        },
      ];
    }),
  );
}

export function readGit(root, args, encoding = "utf8") {
  try { return execFileSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: root,
      encoding,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: gitCommandTimeout(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  ); } catch (error) {
    if (error.code === "ETIMEDOUT") error.verificationCode = "ownership-timeout";
    throw error;
  }
}

export function committedFiles(root, base) {
  return new Set(readGit(root, ["ls-tree", "-r", "--name-only", "-z", base, "--"])
    .split("\0").filter(Boolean).map((file) => file.toLowerCase()));
}

export function candidateDiff(root, git, file, base = git.head) {
  const limit = 24000;
  const tracked = git.tracked.has(file.toLowerCase()) || (base !== git.head &&
    readGit(root, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", base, "--", file]).split("\0").includes(file));
  // HEAD is a verified full hash; literal pathspecs keep filename characters from selecting other files.
  const content = tracked
    ? readGit(root, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", base, "--", file])
    : readFileSync(path.resolve(root, file), "utf8");
  return { file, kind: tracked ? "diff" : "added", content: content.slice(0, limit), truncated: content.length > limit };
}

const ignoredSamples = new Map();
const gitList = ["ls-files", "-z", "--others", "--exclude-standard"];
const entries = (output) => output.split("\0").filter(Boolean);
function protectedOwnershipPaths(task) {
  return [...(task.writes ?? []), ...(task.reads ?? []), ...(task.contextReads ?? []),
    ...(task.verification?.testWrites ?? []), ...(task.verification?.checks?.flatMap((check) => check.inputs) ?? []),
    ...Object.values(task.sources ?? {}).map((source) => source.file)];
}
function reportIgnores(root, version, includedCount) {
  const previous = ignoredSamples.get(root);
  if (previous?.version === version && (!previous.at || Date.now() - previous.at < 30000))
    return previous.at ? { ignoredFiles: Math.max(0, previous.total - includedCount), ignoredSampleAt: previous.at } : { ignoredFiles: null };
  if (ignoredSamples.size >= 8 && !ignoredSamples.has(root)) ignoredSamples.delete(ignoredSamples.keys().next().value);
  const sample = { version };
  ignoredSamples.set(root, sample);
  setImmediate(() => execFile("git", ["--no-optional-locks", ...gitList], { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    if (ignoredSamples.get(root) !== sample) return;
    if (error) { ignoredSamples.delete(root); return; }
    sample.at = Date.now();
    sample.total = entries(stdout).length;
    console.info("LingFlow ownership inventory", JSON.stringify({ gitUntrackedFiles: sample.total, ignoredFiles: Math.max(0, sample.total - includedCount), sampledAt: sample.at }));
  }));
  return { ignoredFiles: null };
}

export function gitState(root, task, ignorePatterns) {
  const started = performance.now();
  if (task) commandProgress({ phase: "ownership-fingerprint", scannedFiles: 0 });
  if (realpathSync(root) !== root) throw Error("项目路径身份发生变化");
  const git = (args) => readGit(root, args);
  let top, head, indexFile;
  try {
    [top, head, indexFile] = git(["rev-parse", "--show-toplevel", "HEAD", "--git-path", "index"]).trimEnd().split(/\r?\n/);
    top = realpathSync(top);
  } catch (error) {
    if (error.verificationCode === "ownership-timeout") throw error;
    throw Error("实施票需要可读取的 Git 项目根目录");
  }
  requireValue(top === root, "实施票工作目录必须是 Git 项目根目录");
  requireValue(/^[0-9a-f]{40,64}$/.test(head), "实施票需要已有 Git 基线提交");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const indexEntries = git(["ls-files", "--stage", "-z"]);
  const index = createHash("sha256").update(indexEntries).digest("hex");
  const indexStat = statSync(path.resolve(root, indexFile), { bigint: true, throwIfNoEntry: false });
  const indexStamp = indexStat?.mtimeNs.toString() ?? "missing";
  const tracked = new Set(indexEntries.split("\0").filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf("\t") + 1).toLowerCase()));
  const filter = task && ownershipPolicy(ignorePatterns);
  const protectedPaths = task ? scopePaths(protectedOwnershipPaths(task)) : [];
  const dirty = entries(git([
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    filter ? "--untracked-files=no" : "--untracked-files=all",
  ]));
  let ownershipMetrics;
  if (filter) {
    const untracked = new Set(entries(git([...gitList, ...filter.patterns.map((rule) => "--exclude=" + rule)])));
    const restore = filter.patterns.length ? protectedPaths.filter((file) => filter.ignores(file) ||
      lstatSync(path.resolve(root, file), { throwIfNoEntry: false })?.isDirectory()) : [];
    if (restore.length)
      for (const file of entries(git(["--literal-pathspecs", ...gitList, "--", ...restore]))) untracked.add(file);
    for (const file of untracked) dirty.push("?? " + file);
    ownershipMetrics = { untrackedFiles: untracked.size, declaredPaths: protectedPaths.length,
      ...(filter.patterns.length ? reportIgnores(root, filter.version, untracked.size) : { ignoredFiles: 0 }),
      gitMs: Math.round(performance.now() - started) };
  }
  const indexClean = dirty.every((row) => [" ", "?"].includes(row[0]));
  const files = dirty
    .map((row) => {
      const status = row.slice(0, 2);
      verify(
        !status.includes("U") && !["AA", "DD"].includes(status),
        "contract-invalid",
        "Git 存在未解决冲突",
      );
      return scopePaths([row.slice(3)])[0];
    });
  return { head, branch, index, indexStamp, indexClean, dirty: files, tracked, shortStatus: dirty.map((row, i) => ({ status: row.slice(0, 2), file: files[i] })),
    filter, protectedPaths, ownershipMetrics };
}

export function changedFromBaseline(root, base) {
  return readGit(root, ["diff", "--name-only", "--no-renames", "-z", base, "--"])
    .split("\0").filter(Boolean).map((file) => scopePaths([file])[0]);
}

export function baselineDrift(root, task, git = gitState(root), protectedPaths = []) {
  const base = task.baseline;
  if (!base) return null;
  if (git.head === base.head && git.branch === base.branch && git.index === base.index) return null;
  let ancestor = git.head === base.head;
  let committedBetween = [];
  if (!ancestor) {
    try {
      ancestor = readGit(root, ["merge-base", "--is-ancestor", base.head, git.head]) === "";
    } catch (error) {
      if (error.status !== 1) throw Error("无法核对基线提交及其祖先关系", { cause: error });
    }
    committedBetween = readGit(root, ["diff", "--name-only", "--no-renames", "-z", base.head, git.head, "--"])
      .split("\0").filter(Boolean);
  }
  const conflicts = committedBetween.filter((file) => overlaps([file], protectedPaths));
  const gitBlocker = git.branch !== base.branch ? "Git 分支已改变" :
    !ancestor ? "原 HEAD 不是当前 HEAD 的祖先" :
    !git.indexClean || (git.head === base.head && git.index !== base.index) ? "暂存区与基线不一致" : null;
  const blockingCondition = gitBlocker ?? (conflicts.length ? "提交差异触及冻结范围：" + summarizePaths(conflicts) : null);
  return { from: base.head, to: git.head, committedBetween, conflicts, gitBlocker, blockingCondition };
}

export function summarizePaths(files) {
  return files.slice(0, 8).join("、") + (files.length > 8 ? "（共 " + files.length + " 项）" : "");
}

function committedSource(root, commit, file) {
  const entry = readGit(root, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", file]);
  if (!entry) return null;
  const match = /^100(?:644|755) blob ([a-f0-9]+)\t/.exec(entry);
  if (!match) throw Error("规划来源在 Git 中不是普通文件：" + file);
  return readGit(root, ["cat-file", "blob", match[1]], "buffer");
}

export function committedDirtyBaselinePaths(task, drift) {
  const committed = new Set(drift?.committedBetween ?? []);
  return (task.baseline?.other ?? []).filter(([file]) => committed.has(file)).map(([file]) => file);
}

export function recordedBaselineChanges(root, task, plan, git, drift) {
  if (!drift || drift.from === drift.to) return [];
  const committed = new Set(drift.committedBetween);
  const relevant = Object.entries(task.sources ?? {}).filter(([, source]) =>
    committed.has(source.file) && (Object.hasOwn(task.baseline.recordedDirtySources ?? {}, source.file) ||
      // Legacy rows did not record this explicitly: compare the old Git object to the frozen snapshot.
      (!task.baseline.recordedDirtySources && !task.baseline.other.some(([file]) => file === source.file) &&
        controlDocument(task, source.file))));
  const notes = [];
  for (const [name, source] of relevant) {
    if (notes.some((note) => note.file === source.file)) continue;
    const old = committedSource(root, drift.from, source.file);
    if (!task.baseline.recordedDirtySources && old && sourceFileFingerprint(source.file, old) === source.digest) continue;
    const previous = plan?.documents?.[name];
    const current = committedSource(root, git.head, source.file);
    const live = git.dirty.includes(source.file) ? null : current;
    const note = classifySourceEdit(source, previous?.text, live);
    let priorPreserved = !old || sourceFileFingerprint(source.file, old) === source.digest;
    if (!priorPreserved && old) {
      try {
        const oldText = new TextDecoder("utf-8", { fatal: true }).decode(old);
        priorPreserved = isRecordAppend(classifySourceEdit({ file: source.file, digest: sourceFileFingerprint(source.file, old) },
          oldText, frozenSourceBytes(source, previous?.text)));
      } catch { /* Invalid old UTF-8 cannot establish provenance. */ }
    }
    const admissionDigest = task.baseline.recordedDirtySources?.[source.file];
    const proven = (!task.baseline.recordedDirtySources || admissionDigest === source.digest) && priorPreserved && isRecordAppend(note) && controlDocument(task, source.file) &&
      fingerprint(root, [source.file]) === note.toDigest;
    notes.push({ file: source.file, fromDigest: source.digest, toDigest: note?.toDigest ?? null,
      ...(admissionDigest && { admissionDigest }),
      ...(old && { oldCommitDigest: sourceFileFingerprint(source.file, old) }),
      ...(note?.startLine && { startLine: note.startLine, appendedBytes: note.appendedBytes, firstAppendedHeading: note.firstAppendedHeading }),
      proven });
  }
  return notes;
}

function isUntrackedHiveOutput(task, file, untracked) {
  if (!untracked.has(file)) return false;
  if (!/^\.hive\/(?:build-cache\/[a-f0-9]{64}\.json|release\/[^/]+\.tar\.gz|workflow\/control\.sqlite(?:-wal|-shm)?)$/i.test(file)) return false;
  return !overlaps([file], protectedOwnershipPaths(task));
}

export function scopeBaseline(root, task, foreignWrites, git = gitState(root, task)) {
  const ownDirty = git.dirty.filter((file) => coversPath(task.writes, file));
  verify(
    ownDirty.every((file) => task.ownedDirty.includes(file)),
    "contract-invalid",
    "写入范围内存在未分配的已有改动",
  );
  const untracked = new Set(git.shortStatus.filter((row) => row.status === "??").map((row) => row.file));
  const inheritedHiveOutputs = git.dirty.filter((file) => isUntrackedHiveOutput(task, file, untracked));
  const ignored = new Set(inheritedHiveOutputs);
  const other = git.dirty.filter(
    (file) =>
      !ignored.has(file) &&
      !controlDocument(task, file) &&
      !coversPath([...task.writes, ...foreignWrites], file),
  );
  const batch = ownershipFingerprints(root, { ...git, ignoreVersion: git.filter?.version });
  const baseline = {
    head: git.head,
    branch: git.branch,
    index: git.index,
    ...(inheritedHiveOutputs.length && { inheritedHiveOutputs }),
    ...(git.indexClean && !ownDirty.length && { cleanWrites: [...task.writes] }),
    sources: fingerprint(root, task.writes, task.verification.testWrites),
    tests: fingerprint(root, task.verification.testWrites),
    recordedDirtySources: Object.fromEntries(git.dirty.filter((file) => controlDocument(task, file) &&
      Object.values(task.sources ?? {}).some((source) => source.file === file)).map((file) => [file, fingerprint(root, [file])])),
    other: other.map((file) => [file, batch.file(file)]),
  };
  finishOwnership(git, batch);
  return baseline;
}

export function assertScope(root, task, foreignWrites, git = gitState(root, task)) {
  const base = task.baseline;
  verify(
    base &&
      git.head === base.head &&
      git.branch === base.branch &&
      git.index === base.index,
    "contract-invalid", `Git HEAD、分支或暂存区已变化；请用 diagnoseTask ${JSON.stringify({ taskId: task.id })} 核对后续动作`,
  );
  assertOutsideScope(root, task, foreignWrites, git);
  return git;
}

export function assertOutsideScope(root, task, foreignWrites, git) {
  const base = task.baseline;
  const old = new Map(base.other);
  const untracked = new Set(git.shortStatus.filter((row) => row.status === "??").map((row) => row.file));
  const inheritedHiveOutputs = new Set(base.inheritedHiveOutputs ?? []);
  const relevant = new Set([...git.dirty, ...old.keys()]);
  const included = new Set(git.dirty);
  const batch = ownershipFingerprints(root, { ...git, ignoreVersion: git.filter?.version });
  try {
    for (const file of relevant) {
      if (coversPath(task.writes, file)) continue;
      if (!git.tracked.has(file.toLowerCase()) && !included.has(file) && git.filter?.ignores(file) && !overlaps([file], git.protectedPaths)) continue;
      if (controlDocument(task, file) || (inheritedHiveOutputs.has(file) && isUntrackedHiveOutput(task, file, untracked))) continue;
      if (!old.has(file) && coversPath(foreignWrites, file)) continue;
      if (batch.metrics.scannedFiles % 128 === 0) commandProgress({ scannedFiles: batch.metrics.scannedFiles });
      verify(
        old.get(file) === batch.file(file),
        "contract-invalid",
        `发现未归属的改动：${file}；请用 diagnoseTask ${JSON.stringify({ taskId: task.id })} 核对，停写后由主控确认归属并调整原票。`,
      );
    }
  } finally { finishOwnership(git, batch); }
}

function finishOwnership(git, batch) {
  const totals = Object.assign(git.ownershipMetrics ??= {}, batch.metrics, { fingerprintMs: Math.round(performance.now() - batch.started) });
  commandProgress({ phase: "ownership-fingerprint", scannedFiles: totals.scannedFiles });
  if (totals.invalidatedBy || totals.scannedFiles >= 1000)
    console.info("LingFlow ownership scan", JSON.stringify(totals));
}

export function planningSourceNotes(root, task, plan) {
  const notes = [];
  const seen = new Set();
  for (const [name, source] of Object.entries(task.sources ?? {})) {
    if (seen.has(source.file)) continue;
    seen.add(source.file);
    let bytes;
    const absolute = path.resolve(root, source.file);
    try {
      const stat = lstatSync(absolute);
      // Read only the original regular file under the project, never a replacement link.
      if (stat.isFile() && stat.size <= 256 * 1024 && realpathSync(absolute) === absolute)
        bytes = readFileSync(absolute);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
    const frozen = plan?.documents?.[name];
    const note = classifySourceEdit(source, frozen?.file === source.file ? frozen.text : undefined, bytes);
    if (note) notes.push({ ...note, nextAction: { command: "inspectPlan", args: { planId: task.planId, document: name } } });
  }
  return notes;
}

export function scopeNotes(root, task, owners, git, plan) {
  const notes = planningSourceNotes(root, task, plan);
  const before = new Map(task.baseline.other);
  for (const file of git.dirty) {
    if (coversPath(task.writes, file) || before.has(file)) continue;
    if (controlDocument(task, file)) continue;
    for (const owner of owners.filter(({ writes }) => coversPath(writes, file)))
      notes.push({ kind: "foreign-in-flight", file, taskId: owner.taskId, ticketKey: owner.ticketKey });
  }
  return notes;
}

function controlDocument(task, file) {
  const frozen = Object.values(task.sources ?? {}).some(
    (document) => document.file === file && /\.(md|markdown|txt|rst|adoc|json|ya?ml|toml)$/i.test(file),
  );
  const planning = /^\.lingflow\/planning\/.*\.(md|json|ya?ml)$/i.test(file);
  const protectedPaths = [
    ...task.writes,
    ...task.reads,
    ...task.verification.checks.flatMap((check) => check.inputs),
  ];
  return (frozen || planning) && !overlaps([file], protectedPaths);
}
