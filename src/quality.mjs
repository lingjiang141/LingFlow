import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { classifySourceEdit, frozenSourceBytes, isRecordAppend, sourceFileFingerprint } from "./source-edit.mjs";
import { planningDiff, readSpecVersion, specImpact, planningDecisionOptions } from "./spec-revision.mjs";
import { checkShape, invalidPlan, planSchema, unknownFields, violation } from "./plan-schema.mjs";
import { alignBrowserArgv, assertCheckOwnership, freezeBrowserChecks, INDEPENDENT_LIMIT_MS, normalizeBrowserArgv } from "./verification-policy.mjs";
import { splitHiveTickets, ticketSourcePaths } from "./hive-plan.mjs";
import { coversPath, fingerprint, fingerprintEntries, fingerprintEol, implementationFingerprint, implementationTreeFingerprint, normalizeEol, overlaps, ownershipFingerprints, scopePaths } from "./files.mjs";
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
        const digest = fingerprint(root, [file], [], undefined, { eol: "raw" });
        const document = { file, digest };
        if (keepText) {
          document.text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
          requireValue(document.text.trim() && !document.text.includes("\0") && fingerprint(root, [file], [], undefined, { eol: "raw" }) === digest,
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

export function readVerification(input, { root, writes, risk, warnings = [], prefix = "verification", developerChecksPending = false }) {
  const issues = [];
  const add = (path, message, expected, remedy, replacement) =>
    issues.push(violation(prefix + path, message, expected, remedy, replacement));
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
  const entries = attempt(".checks", [checkShape],"提交冻结检查数组",()=>list(input.checks ?? (developerChecksPending ? [] : undefined),"检查方案",20),[]);
  const checks = [];
  for (const [index, check] of entries.entries()) {
    const at = ".checks[" + index + "]";
    const before = issues.length;
    unknownFields(check, ["id","stage","argv","inputs","covers","timeoutMs","expectedExit","expectedOutput","failureOutput","deriveRed","redExpectedOutput","redExpectedExit","preSteps","requiredArtifacts","resources"], prefix+at, warnings);
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
    if (developerChecksPending && !controller)
      add(at+".stage", "开发登记模式只允许在派发时冻结主控探针", ["independent","controller"], "开发接票后用 registerChecks 登记自己的检查");
    const timeoutMs = check?.timeoutMs ?? (controller?15000:120000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs<100 || timeoutMs>3600000)
      add(at+".timeoutMs","检查超时须在 100ms 到 1 小时之间",120000,"填写有效毫秒值",
        { path: prefix+at+".timeoutMs", value: controller ? 15000 : 120000 });
    else if (controller && timeoutMs>INDEPENDENT_LIMIT_MS)
      add(at+".timeoutMs","主控收口检查限低负载短探针：limit="+INDEPENDENT_LIMIT_MS+" actual="+timeoutMs,INDEPENDENT_LIMIT_MS,"将长验证移到开发 full/regression 或累计批次；主控保留短探针",
        { path: prefix+at+".timeoutMs", value: INDEPENDENT_LIMIT_MS });
    const expectedExit = stage==="red" ? (check.expectedExit??1) : 0;
    const expectedOutput = check?.expectedOutput === undefined ? "" :
      attempt(at+".expectedOutput","AssertionError: expected behavior","填入对应断言的实际失败标记",()=>note(check.expectedOutput,"预期输出"),"");
    if (stage==="red" && (!Number.isInteger(expectedExit)||expectedExit<1||expectedExit>125||!expectedOutput))
      add(at+".expectedOutput","红阶段须指定预期失败退出码和失败输出",{expectedExit:1,expectedOutput:"AssertionError: expected behavior"},"用同一检查的真实反例，声明退出码和断言失败标记");
    const failureOutput = check?.failureOutput===undefined ? undefined :
      attempt(at+".failureOutput","AssertionError","填写可定位的断言失败标记",()=>note(check.failureOutput,"断言失败标记"));
    const preparation = attempt(at+".preSteps", {preSteps:[{argv:["npm","run","build"],outputs:["apps/web/dist"]}]}, "声明构建命令、独立产物路径和实际 inputs", () => preparationContract({ ...check, inputs, timeoutMs }, writes, commandArgs), {});
    const resources = attempt(at+".resources", ["port:4174"], "声明作业运行期间独占的端口、数据库或其他资源", () =>
      [...new Set(list(check?.resources ?? [], "作业共享资源", 20).map(resource => note(resource, "作业资源").toLowerCase()))].sort(), []);
    if(preparation.preSteps?.length&&timeoutMs<300000)warnings.push({path:prefix+at+'.timeoutMs',
      message:'构建前置可能占满预算：preSteps 与实际检查共享 '+timeoutMs+'ms 总时限',
      timeoutMs,preStepBudgetMs:preparation.preSteps.reduce((sum,step)=>sum+step.timeoutMs,0),
      remedy:'按构建实测下限为新票预留至少三倍前置预算，并给每一步填写合理 timeoutMs；本提示不修改冻结检查。'});
    if (controller && preparation.preSteps?.length) add(at+".preSteps", "主控短探针不能执行构建前置", [], "将构建交开发检查");
    if (issues.length===before) checks.push({ id, stage, argv, covers, inputs, timeoutMs, expectedExit, expectedOutput,
      ...(resources.length && { resources }), ...(failureOutput&&{failureOutput}), ...(preparation.requiredArtifacts?.length && preparation) });
  }
  alignBrowserArgv(checks, input.browserE2E, warnings, prefix, entries);
  for(const issue of probeSeparationIssues(checks))add('.checks.'+issue.checkId+'.'+issue.field,issue.message,
    {separateFrom:issue.developerCheckId},'使用实际独立、低负载且输入范围较小的探针；不复制开发 full/regression，缺证用 rework + evidence 回投责任成员');
  const recipe = (check) => JSON.stringify([check.argv,[...check.covers].sort(),check.inputs, check.preSteps ?? [], check.requiredArtifacts ?? [], check.resources ?? []]);
  for (const green of checks.filter((c)=>c.stage==="green")) {
    const raw = entries.find((c)=>c?.id===green.id);
    if (!(raw?.deriveRed === true || raw?.redExpectedOutput !== undefined || green.failureOutput) ||
        checks.some((c)=>c.stage==="red"&&recipe(c)===recipe(green))) continue;
    const marker = raw.redExpectedOutput ?? green.failureOutput ?? (green.expectedOutput || undefined);
    const exit = raw.redExpectedExit ?? 1;
    if (typeof marker!=="string" || !marker.trim() || marker.length>8000 || !Number.isInteger(exit) || exit<1 || exit>125 || green.id.length>76) {
      add(".checks."+green.id+".deriveRed", typeof marker !== "string" || !marker.trim()
        ? "本案缺少 failureOutput 声明。派生红须从 redExpectedOutput、green.failureOutput 或 green.expectedOutput 提供真实失败标记"
        : "无法安全派生 red：失败标记、退出码或派生编号无效",
      {deriveRed:true,redExpectedExit:1,redExpectedOutput:"实际断言失败标记"},"填写预期失败用例的真实断言标记，或显式声明 red");
      continue;
    }
    checks.push({...green,id:green.id+"-red",derivedFrom:green.id,stage:"red",expectedExit:exit,expectedOutput:marker.trim(),failureOutput:marker.trim()});
    warnings.push({path:prefix+".checks."+green.id,message:"已派生 "+green.id+"-red；仍须真实执行并核对断言"});
  }
  if (new Set(checks.map((c)=>c.id)).size!==checks.length || checks.length>20)
    add(".checks","检查编号不能重复且最多 20 条","unique ids; <=20","重命名重复检查或合并相同职责");
  const red=checks.filter((c)=>c.stage==="red"), green=checks.filter((c)=>c.stage==="green");
  for (const [from,to,missing] of [[red,green,"green"],[green,red,"red"]]) {
    for(const c of from) {
      if(to.some((other)=>recipe(other)===recipe(c)))continue;
      const keys = ["argv","covers","inputs","preSteps","requiredArtifacts","resources"];
      const values = JSON.parse(recipe(c));
      const nearest=to.map((other)=>({other,fields:JSON.parse(recipe(other)).map((v,i)=>JSON.stringify(v)===JSON.stringify(values[i])?null:keys[i]).filter(Boolean)}))
        .sort((a,b)=>a.fields.length-b.fields.length)[0];
      add(".checks."+c.id,"局部红绿必须成对；缺少 "+missing+(nearest?"（"+nearest.other.id+" 不同字段："+nearest.fields.join("、")+"）":""),
        {stage:missing,argv:c.argv,covers:c.covers,inputs:c.inputs}, missing==="red"?"在 green 声明 deriveRed:true 和 redExpectedOutput，或添加同键 red":"复制配对键添加 green，期望退出码为 0");
    }
  }
  if (!developerChecksPending && !red.length && !green.length) add(".checks","缺少 red 和 green",checkShape,"按同一 argv、inputs、covers 添加红绿检查");
  const full = new Set(checks.filter((c)=>c.stage==="full").flatMap((c)=>c.covers));
  const uncovered = acceptance.filter((ac)=>!full.has(ac.id)).map((ac)=>ac.id);
  if (!developerChecksPending && uncovered.length) add(".checks","完整检查未覆盖验收条款："+uncovered.join("、"),{stage:"full",covers:uncovered},"添加真实验证这些 AC 的 full 检查，保持原 AC");
  if (risk!=="high"&&!checks.some((c)=>c.stage==="independent")) add(".checks","免审实施票必须指定主控独立验收检查",{...checkShape,stage:"independent",timeoutMs:15000},"增加真实、低负载的独立探针");
  if (risk==="high"&&checks.some((c)=>c.stage==="independent")) add(".checks","高风险实施票走独立审查",{stage:"controller"},"如确需主控短探针，改用 controller");
  for (const check of checks) attempt(".checks."+check.id,check.stage==="regression"?{stage:"regression",covers:[]}:{...checkShape,timeoutMs:INDEPENDENT_LIMIT_MS},
    "主控仅用短探针；浏览器回归用 regression，证据检查绑定具名用例",()=>assertCheckOwnership(root,check));
  for (const [index, entry] of (Array.isArray(input.browserE2E) ? input.browserE2E : []).entries())
    unknownFields(entry, ["file","title","reason","covers"], prefix+".browserE2E["+index+"]", warnings);
  for (const [index, ac] of (Array.isArray(input.acceptance) ? input.acceptance : []).entries())
    unknownFields(ac, ["id","text"], prefix+".acceptance["+index+"]", warnings);
  const browserE2E=freezeBrowserChecks(root, input.browserE2E === undefined ? [] : input.browserE2E, checks, testWrites, acIds,
    (path,message,expected,remedy,replacement)=>{
      const index = replacement ? entries.findIndex(entry => entry?.id === replacement.checkId) : -1;
      add(path,message,expected,remedy,index < 0 ? undefined :
        { path: prefix + ".checks[" + index + "]." + replacement.field, value: replacement.value });
    }, developerChecksPending);
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

export function readGit(root, args, encoding = "utf8", input) {
  try { return execFileSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: root,
      encoding,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: gitCommandTimeout(),
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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

export function implementationAtCommit(root, task, head) {
  const proof = implementationSnapshotAtCommit(root, task, head);
  return proof && implementationFingerprint(root, task).sources === proof.sources ? proof : null;
}

export function implementationSnapshotAtCommit(root, task, head) {
  if (!task.writes.length || !/^[a-f0-9]{40,64}$/.test(head)) return null;
  try {
    const readEntry = committedImplementationReader(root, task.writes, head, fingerprintEol);
    return implementationTreeFingerprint(task, fingerprintEol, readEntry);
  } catch (error) {
    if (error.verificationCode === "ownership-timeout") throw error;
    return null;
  }
}

function committedImplementationReader(root, writes, head, eol, sourceFiles = {}) {
  const readEntry = gitTreeReader(root, writes, head);
  return file => {
    const entry = readEntry(file);
    const expected = sourceFiles[file];
    if (Buffer.isBuffer(entry) && eol === "raw" && expected && createHash("sha256").update(entry).digest("hex") !== expected) {
      // A different checkout EOL is usable only when the exact recorded bytes can be proven.
      const content = entry.toString("latin1");
      for (const eol of ["\n", "\r\n"]) {
        const restored = Buffer.from(content.replace(/\r?\n/g, eol), "latin1");
        if (createHash("sha256").update(restored).digest("hex") === expected) return restored;
      }
    }
    return entry;
  };
}

// Omit head to read the actual index, including files absent from the worktree.
function gitTreeReader(root, writes, head) {
  const entries = new Map();
  const paths = scopePaths(writes);
  const tree = paths.length ? readGit(root, ["--literal-pathspecs", ...(head
    ? ["ls-tree", "-r", "-z", head] : ["ls-files", "--stage", "-z"]), "--", ...paths]) : "";
  for (const row of tree.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const file = row.slice(tab + 1);
    const parts = file.split("/");
    let parent = "";
    while (parts.length > 1) {
      const child = parts.shift();
      parent += child;
      const names = entries.get(parent) ?? new Set();
      names.add(parts[0]);
      entries.set(parent, names);
      parent += "/";
    }
    const metadata = row.slice(0, tab);
    entries.set(file, (head ? /^100(?:644|755) blob ([a-f0-9]+)$/ : /^100(?:644|755) ([a-f0-9]+) 0$/).exec(metadata)?.[1] ?? false);
  }
  return file => {
    const entry = entries.get(file);
    if (entry instanceof Set) return [...entry];
    if (entry === undefined) return null;
    if (entry === false) throw Error("Git 范围内存在非普通文件或未解决冲突：" + file);
    if (Buffer.isBuffer(entry)) return entry;
    const bytes = readGit(root, ["cat-file", "blob", entry], "buffer");
    entries.set(file, bytes);
    return bytes;
  };
}

export function implementationScopeMatches(task, snapshot) {
  const paths = scopePaths(task.writes).filter(file => !coversPath(task.verification.testWrites, file));
  if (snapshot.writes) {
    const recorded = scopePaths(snapshot.writes).filter(file => !coversPath(task.verification.testWrites, file));
    return JSON.stringify(recorded) === JSON.stringify(paths);
  }
  if (!snapshot.sourceFiles) return true;
  return paths.every(file => Object.hasOwn(snapshot.sourceFiles, file)) &&
    Object.keys(snapshot.sourceFiles).every(file => coversPath(paths, file));
}

export function projectImplementationBaseline(root, task, nextWrites, previous) {
  const head = previous.sourcesHead ?? previous.head;
  if (!/^[a-f0-9]{40,64}$/.test(head)) return null;
  const writeSets = previous.writes ? [previous.writes] : [task.writes, task.baseline.admissionWrites,
    ...(task.scheduleHistory ?? []).map(entry => entry.previous?.writes)].filter(Boolean);
  const unique = [...new Map(writeSets.map(writes => [JSON.stringify(scopePaths(writes)), writes])).values()];
  const eol = task.baseline.fingerprintEol ?? "raw";
  try {
    const readEntry = committedImplementationReader(root, [...nextWrites, ...unique.flat()], head, eol, previous.sourceFiles);
    for (const writes of unique) {
      if (implementationTreeFingerprint({ ...task, writes }, eol, readEntry).sources !== previous.sources) continue;
      const newPaths = nextWrites.filter(file => !coversPath(writes, file));
      const admitted = [task.baseline, ...(task.scheduleHistory ?? []).map(entry => entry.previous?.baseline)]
        .filter(base => base && (base.sourcesHead ?? base.head) === head && base.sources === previous.sources);
      if (admitted.some(base => overlaps(newPaths, [...(base.other ?? []).map(([file]) => file), ...(base.excludedPeerDirty ?? [])]))) continue;
      return { head, writes: [...nextWrites], ...implementationTreeFingerprint({ ...task, writes: nextWrites }, eol, readEntry) };
    }
  } catch (error) {
    if (error.verificationCode === "ownership-timeout") throw error;
  }
  return null;
}

export function convertImplementationBaseline(root, task, previous, oldEol) {
  if (implementationFingerprint(root, task, oldEol).sources === previous.sources)
    return implementationFingerprint(root, task);
  if (!/^[a-f0-9]{40,64}$/.test(previous.head)) return null;
  const readEntry = committedImplementationReader(root, task.writes, previous.head, oldEol, previous.sourceFiles);
  return implementationTreeFingerprint(task, oldEol, readEntry).sources === previous.sources
    ? implementationTreeFingerprint(task, fingerprintEol, readEntry) : null;
}

export function convertOutsideBaseline(root, task, git) {
  const batch = ownershipFingerprints(root, { ...git, ignoreVersion: git.filter?.version });
  return task.baseline.other.map(([file]) => [file, batch.file(file)]);
}

export function candidateDiff(root, git, file, base = git.head, end) {
  const limit = 24000;
  const tracked = end || git.tracked.has(file.toLowerCase()) || (base !== git.head &&
    readGit(root, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", base, "--", file]).split("\0").includes(file));
  // HEAD is a verified full hash; literal pathspecs keep filename characters from selecting other files.
  const content = tracked
    ? readGit(root, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", base, ...(end ? [end] : []), "--", file])
    : readFileSync(path.resolve(root, file), "utf8");
  return { file, kind: tracked ? "diff" : "added", content: content.slice(0, limit), truncated: content.length > limit };
}

const ignoredSamples = new Map();
const gitList = ["ls-files", "-z", "--others", "--exclude-standard"];
const entries = (output) => output.split("\0").filter(Boolean);
function protectedOwnershipPaths(task) {
  return [...(task.writes ?? []), ...(task.reads ?? []), ...(task.contextReads ?? []),
    ...(task.verification?.testWrites ?? []), ...(task.verification?.checks?.flatMap((check) => check.inputs) ?? []),
    ...Object.values(task.sources ?? {}).map(source => source.file)];
}
const livePlanningSource = name => name === "spec" || name === "attempts";
function reportIgnores(root, { version, patterns }, includedCount) {
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
    console.info("LingFlow ownership inventory", JSON.stringify({ gitUntrackedFiles: sample.total,
      ignoredFiles: Math.max(0, sample.total - includedCount), patterns: patterns.length, sampledAt: sample.at }));
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
  let ignoredOutside;
  let ownershipIgnoreDetails;
  if (filter) {
    const gitVisible = entries(git(gitList));
    const extraIgnored = gitVisible.filter(file => filter.ignores(file) && !coversPath(protectedPaths, file));
    const excluded = new Set(extraIgnored);
    const visible = gitVisible.filter(file => !excluded.has(file));
    const untracked = new Set(visible);
    const declaredGitIgnored = protectedPaths.length
      ? entries(git(["--literal-pathspecs", ...gitList, "--ignored", "--", ...protectedPaths])) : [];
    for (const file of declaredGitIgnored) untracked.add(file);
    // Historical outside entries can predate the repository's present ignore rules.
    const previous = (task.baseline?.other ?? []).map(([file]) => file)
      .filter(file => !tracked.has(file.toLowerCase()) && !untracked.has(file) && !coversPath(protectedPaths, file));
    if (previous.length) {
      try {
        ignoredOutside = new Set(entries(readGit(root, ["check-ignore", "-z", "--stdin"], "utf8", previous.join("\0") + "\0")));
      } catch (error) {
        if (error.status !== 1) throw error;
      }
    }
    ownershipIgnoreDetails = { suppressedHistoricalGit: [...(ignoredOutside ?? [])].slice(0, 20),
      suppressedByLingFlow: extraIgnored.slice(0, 20), declaredGitIgnored: declaredGitIgnored.slice(0, 20) };
    for (const file of untracked) dirty.push("?? " + file);
    ownershipMetrics = { untrackedFiles: untracked.size, declaredPaths: protectedPaths.length,
      ...(filter.patterns.length ? reportIgnores(root, filter, visible.length) : { ignoredFiles: 0 }),
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
    filter, protectedPaths, ignoredOutside, ownershipIgnoreDetails, ownershipMetrics };
}

export function changedFromBaseline(root, base) {
  return readGit(root, ["diff", "--name-only", "--no-renames", "-z", base, "--"])
    .split("\0").filter(Boolean).map((file) => scopePaths([file])[0]);
}

const candidatePaths = task => task.candidateScope === 2 ? [...task.writes, ...(task.verification?.testWrites ?? [])] : [
  ...task.writes, ...(task.reads ?? []), ...(task.verification?.checks.flatMap(check => check.inputs) ?? []),
];

export function candidateFingerprint(root, task, eol = fingerprintEol, fileBytes) {
  if (task.candidateScope === 2) return snapshotFingerprint(candidateFiles(root, task, eol));
  return fingerprint(root, candidatePaths(task), [], undefined, { eol, rawPaths: task.verification?.testWrites, fileBytes });
}

export function candidateFiles(root, task, eol = fingerprintEol) {
  const fileDigests = Object.create(null);
  fingerprint(root, candidatePaths(task), [], undefined, { eol, rawPaths: task.verification.testWrites, fileDigests });
  return fileDigests;
}

export function snapshotFingerprint(files) {
  return createHash("sha256").update(JSON.stringify(Object.keys(files).sort().map(file => [file, files[file]]))).digest("hex");
}

export function candidateTreeFingerprint(root, task, head, expectedFiles = task.deliveredManifest?.files) {
  const paths = candidatePaths(task);
  const fileDigests = Object.create(null);
  const readEntry = gitTreeReader(root, paths, head);
  fingerprintEntries(paths, [], undefined, { eol: fingerprintEol, rawPaths: task.verification.testWrites, fileDigests },
    file => candidateGitBytes(root, file, readEntry(file), expectedFiles,
      coversPath(task.verification.testWrites, file)));
  return snapshotFingerprint(fileDigests);
}

function candidateGitBytes(root, file, bytes, expectedFiles, raw) {
  const expected = expectedFiles?.[file];
  const hash = contents => createHash("sha256").update(contents).digest("hex");
  if (!raw || fingerprintEol === "raw" || !expected || !Buffer.isBuffer(bytes) ||
      bytes.includes(0) || hash(bytes) === expected) return bytes;
  // Test receipts still identify exact worktree bytes. Reconstruct those bytes from
  // the blob only when the recorded digest proves an EOL-only difference.
  const lf = normalizeEol(bytes);
  const crlf = Buffer.from(lf.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
  for (const variant of [lf, crlf]) {
    if (hash(variant) === expected) return variant;
  }
  let live;
  fingerprint(root, [file], [], undefined, { eol: "raw", onFileBytes: (_file, contents) => { live = contents; } });
  return live && hash(live) === expected && normalizeEol(live).equals(lf) ? live : bytes;
}

function deliveredSnapshot(task) {
  if (task.candidateScope !== 2 || !task.candidate) return;
  const snapshot = task.deliveredManifest;
  verify(snapshot?.files && snapshot.revision === task.revision && snapshotFingerprint(snapshot.files) === task.candidate &&
    task.reports.some(report => report.id === snapshot.reportId && report.revision === task.revision &&
      report.candidate === task.candidate && report.manifest?.head === snapshot.head),
    "contract-invalid", "候选交付快照缺失或与原候选不一致");
  return snapshot;
}

function historicalDelivery(root, task, snapshot, git, current) {
  if (task.deliveryVerification?.reportId !== snapshot.reportId ||
      !["ready", "trial", "accepted"].includes(task.pausedFrom ?? task.state) || git.head === snapshot.head ||
      git.dirty.some(file => overlaps(candidatePaths(task), [file]))) return;
  try {
    readGit(root, ["merge-base", "--is-ancestor", snapshot.head, git.head]);
  } catch (error) {
    if (error.status === 1) return;
    throw error;
  }
  if (candidateTreeFingerprint(root, task, git.head, candidateFiles(root, task)) !== current) return;
  const history = readGit(root, ["--literal-pathspecs", "log", "--first-parent", "--full-history", "--reverse", "--format=%H",
    `${snapshot.head}..${git.head}`, "--", ...candidatePaths(task)]).trim().split(/\s+/).filter(Boolean);
  return [snapshot.head, ...history].find(commit => commit !== git.head && candidateTreeFingerprint(root, task, commit) === task.candidate);
}

function equivalentCommitPaths(root, task, git, conflicts) {
  const paths = candidatePaths(task);
  const rawPaths = task.verification.testWrites;
  return conflicts.every(file => {
    if (!coversPath(paths, file) || git.dirty.some(dirty => dirty.toLowerCase() === file.toLowerCase())) return false;
    const blob = committedSource(root, git.head, file, { allowUnsupported: true });
    const bytes = candidateGitBytes(root, file, blob, task.deliveredManifest?.files, coversPath(rawPaths, file));
    if (bytes === undefined) return false;
    if (!bytes) return !lstatSync(path.join(root, file), { throwIfNoEntry: false });
    const eol = coversPath(rawPaths, file) ? "raw" : fingerprintEol;
    const expected = sourceFileFingerprint(file, eol === "normalize" ? normalizeEol(bytes) : bytes);
    return fingerprint(root, [file], [], undefined, { eol }) === expected;
  });
}

export function protectsAdmittedWrites(task) {
  const baseline = task.baseline;
  const sorted = paths => scopePaths(paths).map(file => file.toLowerCase()).sort();
  const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  const inherited = baseline.admissionOwnedDirty ?? task.ownedDirty ?? [];
  if (baseline.admissionWrites && !same(baseline.admissionWrites, task.writes)) return false;
  if (!inherited.every(file => coversPath(task.writes, file))) return false;
  if (!baseline.cleanWrites) {
    // Old baselines omitted the whole clean write set when any admitted path was dirty.
    return inherited.length > 0 && !(task.scheduleHistory ?? []).some(({ previous }) =>
      previous?.writes && (!previous.baseline || previous.baseline.head === baseline.head) && !same(previous.writes, task.writes));
  }
  const writeSet = new Set(sorted(task.writes));
  return same([...baseline.cleanWrites, ...inherited.filter(file => writeSet.has(file.toLowerCase()))], task.writes);
}

export function baselineDrift(root, task, git = gitState(root), protectedPaths = [], { compareCandidate = false } = {}) {
  const base = task.baseline;
  if (!base) return null;
  const snapshot = compareCandidate && base.fingerprintEol === fingerprintEol && deliveredSnapshot(task);
  const current = snapshot && candidateFingerprint(root, task);
  if (git.head === base.head && git.branch !== "HEAD" && git.branch === base.branch && git.index === base.index && git.indexClean &&
      (!snapshot || current === task.candidate)) return null;
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
  const conflicts = committedBetween.filter((file) => !livePlanningFile(task, file) &&
    overlaps([file], snapshot ? candidatePaths(task) : protectedPaths));
  const staged = (git.shortStatus ?? []).filter(({ status, file }) => ![" ", "?"].includes(status[0]) &&
    !livePlanningFile(task, file) && overlaps([file], protectedPaths)).map(({ file }) => file);
  const gitBlocker = git.branch !== base.branch || git.branch === "HEAD" ? "Git 分支已改变或处于游离 HEAD" :
    !ancestor ? "原 HEAD 不是当前 HEAD 的祖先" :
    staged.length ? "暂存区与基线不一致，涉及冻结路径：" + summarizePaths(staged) : null;
  const assessCandidate = compareCandidate && !gitBlocker && conflicts.length && task.candidate &&
    task.verification && base.fingerprintEol === fingerprintEol;
  const historicalCommit = snapshot && !gitBlocker && current !== task.candidate
    ? historicalDelivery(root, task, snapshot, git, current) : undefined;
  const contentDrift = Boolean(snapshot ? current !== task.candidate && !historicalCommit :
    assessCandidate && candidateFingerprint(root, task) !== task.candidate);
  const candidateEquivalent = Boolean(assessCandidate && !contentDrift && !historicalCommit && equivalentCommitPaths(root, task, git, conflicts));
  const blockingCondition = gitBlocker ?? (snapshot && contentDrift && !conflicts.length ? "候选输入已变化，不能使用旧候选" :
    conflicts.length && !candidateEquivalent && !historicalCommit
      ? (contentDrift ? "已交付候选内容已变，不能使用旧候选；" :
        assessCandidate ? "尚未证明提交与工作区的原候选字节等价；" : "") + "提交差异触及冻结范围：" + summarizePaths(conflicts) : null);
  const inherited = base.admissionOwnedDirty ?? task.ownedDirty ?? [];
  const inheritedConflicts = conflicts.filter(file => inherited.some(path => file.toLowerCase() === path.toLowerCase()));
  return { from: base.head, to: git.head, committedBetween, conflicts, inheritedConflicts, gitBlocker, blockingCondition,
    contentDrift, candidateEquivalent, ...(historicalCommit && { historicalCommit }),
    historyAdvance: base.head !== git.head && !blockingCondition };

}

export function summarizePaths(files) {
  return files.slice(0, 8).join("、") + (files.length > 8 ? "（共 " + files.length + " 项）" : "");
}

function committedSource(root, commit, file, { allowUnsupported = false } = {}) {
  const entry = readGit(root, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", file]);
  if (!entry) return null;
  const match = /^100(?:644|755) blob ([a-f0-9]+)\t/.exec(entry);
  if (!match) {
    if (allowUnsupported) return undefined;
    throw Error("规划来源在 Git 中不是普通文件：" + file);
  }
  return readGit(root, ["cat-file", "blob", match[1]], "buffer");
}

// Only Git-confirmed, clean paths outside the frozen implementation and inputs are retired.
export function committedOutsideBaseline(root, task, drift, git, protectedPaths = []) {
  const base = task.baseline;
  if (!base?.other?.length || drift?.gitBlocker) return [];
  const committed = new Set(drift?.committedBetween ?? []);
  const dirty = new Set(git.dirty.map(file => file.toLowerCase()));
  const protectedScope = [...protectedOwnershipPaths(task), ...protectedPaths];
  const candidates = base.other.filter(([file]) => !dirty.has(file.toLowerCase()) && !overlaps([file], protectedScope));
  if (!candidates.length) return [];
  // A history advance may already have moved base.head past the commit. Only use an
  // ancestor and a path which actually changed, never a foreign ownership claim alone.
  const historical = new Map();
  for (const [file, digest] of candidates) {
    if (committed.has(file)) continue;
    const origin = base.sourcesHead ?? task.scheduleHistory?.findLast(({ previous }) =>
      previous?.baseline?.head !== base.head &&
      previous?.baseline?.other?.some(([name, old]) => name === file && old === digest))?.previous.baseline.head;
    if (!origin || origin === base.head) continue;
    if (!historical.has(origin)) historical.set(origin, new Set());
    historical.get(origin).add(file);
  }
  for (const [origin, files] of historical) {
    try {
      readGit(root, ["merge-base", "--is-ancestor", origin, base.head]);
      for (const file of readGit(root, ["diff", "--name-only", "--no-renames", "-z", origin, git.head, "--"]).split("\0"))
        if (files.has(file)) committed.add(file);
    } catch (error) { if (error.status !== 1) throw error; }
  }
  // Read the commit tree once even when an old ticket has thousands of outside entries.
  const tree = new Map();
  for (const row of readGit(root, ["ls-tree", "-r", "-z", git.head]).split("\0")) {
    const tab = row.indexOf("\t");
    if (tab >= 0) tree.set(row.slice(tab + 1), row.slice(0, tab));
  }
  return candidates.filter(([file]) => {
    if (!committed.has(file) && !git.tracked.has(file.toLowerCase())) return false;
    const entry = tree.get(file);
    if (!entry) return committed.has(file) && !lstatSync(path.join(root, file), { throwIfNoEntry: false });
    const blob = /^100(?:644|755) blob ([a-f0-9]+)$/.exec(entry)?.[1];
    if (!blob || !git.tracked.has(file.toLowerCase())) return false;
    let matches = false;
    const oid = bytes => createHash(blob.length === 64 ? "sha256" : "sha1")
      .update("blob " + bytes.length + "\0").update(bytes).digest("hex");
    fingerprint(root, [file], [], undefined, { eol: "raw", onFileBytes(relative, bytes) {
      if (relative !== file) return;
      const normalized = normalizeEol(bytes);
      matches = oid(bytes) === blob || oid(normalized) === blob;
      if (!matches) matches = normalized.equals(normalizeEol(readGit(root, ["cat-file", "blob", blob], "buffer")));
    } });
    return matches;
  });
}

export function recordedBaselineChanges(root, task, plan, git, drift) {
  if (!drift || drift.from === drift.to) return [];
  const committed = new Set(drift.committedBetween);
  const relevant = Object.entries(task.sources ?? {}).filter(([name, source]) =>
    !livePlanningSource(name) &&
    committed.has(source.file) && (Object.hasOwn(task.baseline.recordedDirtySources ?? {}, source.file) ||
      // Legacy rows did not record this explicitly: compare the old Git object to the frozen snapshot.
      (!task.baseline.recordedDirtySources && !task.baseline.other.some(([file]) => file === source.file) &&
        controlDocument(task, source.file))));
  const documents = Object.values(plan?.documents ?? {});
  const notes = [];
  for (const [name, source] of relevant) {
    if (notes.some((note) => note.file === source.file)) continue;
    const old = committedSource(root, drift.from, source.file);
    if (!task.baseline.recordedDirtySources && old && sourceFileFingerprint(source.file, old) === source.digest) continue;
    const previous = documents.find(document => document.file === source.file && document.digest === source.digest) ??
      plan?.documents?.[name];
    const frozen = frozenSourceBytes(source, previous?.text);
    const current = committedSource(root, git.head, source.file);
    verify(current, "contract-invalid", "当前提交缺少已冻结的规划来源：" + source.file);
    const toDigest = sourceFileFingerprint(source.file, current);
    const clean = !overlaps([source.file], git.dirty);
    let unchangedProof;
    if (clean && toDigest === source.digest) unchangedProof = "exact";
    else if (clean && (task.baseline.fingerprintEol ?? fingerprintEol) === "normalize" &&
        frozen && normalizeEol(current).equals(normalizeEol(frozen))) unchangedProof = "eol";
    const note = clean && !unchangedProof ? classifySourceEdit(source, previous?.text, current) : null;
    let priorPreserved = !old || sourceFileFingerprint(source.file, old) === source.digest;
    if (!priorPreserved && old) {
      try {
        const oldText = new TextDecoder("utf-8", { fatal: true }).decode(old);
        priorPreserved = isRecordAppend(classifySourceEdit({ file: source.file, digest: sourceFileFingerprint(source.file, old) },
          oldText, frozen), name);
      } catch { /* Invalid old UTF-8 cannot establish provenance. */ }
    }
    const admissionDigest = task.baseline.recordedDirtySources?.[source.file];
    const proven = clean && (!task.baseline.recordedDirtySources || admissionDigest === source.digest) &&
      priorPreserved && controlDocument(task, source.file) && Boolean(unchangedProof ||
        isRecordAppend(note, name) && fingerprint(root, [source.file], [], undefined, { eol: "raw" }) === toDigest);
    notes.push({ file: source.file, fromDigest: source.digest, toDigest,
      ...(unchangedProof && { unchangedProof }),
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

export function unownedWriteError(task, ownDirty) {
  const owned = task.ownedDirty ?? [];
  const unownedWrites = ownDirty.filter(file => !owned.includes(file));
  if (!unownedWrites.length) return null;
  const nextAction = { command: "reviseSchedule", ownerRole: "controller",
    args: { taskId: task.id, ownedDirty: [...new Set([...owned, ...unownedWrites])], reason: "已逐项核对写集内已有改动的来源和承接归属" } };
  return Object.assign(Error("写入范围内存在未分配的已有改动：" + summarizePaths(unownedWrites) +
    "；核对归属后用 reviseSchedule {ownedDirty:[...]} 登记承接，保留实际文件。"),
    { verificationCode: "contract-invalid", unownedWrites, nextAction });
}

export function scopeBaseline(root, task, foreignWrites, git = gitState(root, task)) {
  verify(!(git.shortStatus ?? []).some(({ status, file }) => ![" ", "?"].includes(status[0]) &&
    overlaps([file], protectedOwnershipPaths(task)) && !livePlanningFile(task, file)),
    "contract-invalid", "暂存区包含已冻结路径，先核对暂存归属");
  const origin = `票 ${task.ticketKey ?? task.id}`;
  const ownDirty = git.dirty.filter((file) => coversPath(task.writes, file, `${origin}.writes`, `${origin}.git.dirty`));
  const unowned = unownedWriteError(task, ownDirty);
  if (unowned) throw unowned;
  const untracked = new Set(git.shortStatus.filter((row) => row.status === "??").map((row) => row.file));
  const inheritedHiveOutputs = git.dirty.filter((file) => isUntrackedHiveOutput(task, file, untracked));
  const ignored = new Set(inheritedHiveOutputs);
  const excludedPeerDirty = git.dirty.filter(file => !coversPath(task.writes, file) && coversPath(foreignWrites, file));
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
    ...(excludedPeerDirty.length && { excludedPeerDirty }),
    admissionWrites: [...task.writes],
    admissionOwnedDirty: ownDirty,
    cleanWrites: task.writes.filter(file => !ownDirty.includes(file)),
    fingerprintEol,
    ...implementationFingerprint(root, task),
    tests: fingerprint(root, task.verification.testWrites, [], undefined, { eol: "raw" }),
    recordedDirtySources: Object.fromEntries(git.dirty.filter((file) => controlDocument(task, file) &&
      Object.values(task.sources ?? {}).some((source) => source.file === file)).map((file) => [file, fingerprint(root, [file], [], undefined, { eol: "raw" })])),
    other: other.map((file) => [file, batch.file(file)]),
  };
  finishOwnership(git, batch);
  return baseline;
}

export function assertFingerprintMode(task) {
  if (task.baseline?.fingerprintEol === fingerprintEol) return;
  const old = task.baseline?.fingerprintEol ?? "raw（旧基线未记录）";
  const args = { taskId: task.id, refreshBaseline: true, reason: "确认并续接指纹口径" };
  const nextAction = { command: "reviseSchedule", args };
  const message = `指纹口径已从 ${old} 切换为 ${fingerprintEol}，请主控对该票执行 reviseSchedule {refreshBaseline:true} 一次性续接；活动票先停写交回。`;
  throw Object.assign(Error(message), { verificationCode: "contract-invalid", nextAction,
    violations: [{ path: "baseline.fingerprintEol", message, expected: fingerprintEol, actual: old, remedy: nextAction }] });
}

export function assertScope(root, task, foreignWrites, git = gitState(root, task), protectedPaths = []) {
  assertFrozenTicket(root, task, git);
  assertFingerprintMode(task);
  const drift = baselineDrift(root, task, git, [...task.writes, ...(task.reads ?? []),
    ...(task.verification?.checks.flatMap(check => [...check.inputs, ...(check.requiredArtifacts ?? [])]) ?? []), ...protectedPaths],
    { compareCandidate: true });
  if (drift?.blockingCondition) throw Object.assign(
    Error(`Git 基线与冻结范围不一致：${drift.blockingCondition}`),
    { verificationCode: "contract-invalid", drift },
  );
  assertOutsideScope(root, task, foreignWrites, git, committedOutsideBaseline(root, task, drift, git, protectedPaths));
  return Object.assign(git, { drift });
}

export function assertOutsideScope(root, task, foreignWrites, git, pruned = []) {
  const base = task.baseline;
  const origin = `票 ${task.ticketKey ?? task.id}`;
  const old = new Map(base.other);
  for (const [file] of pruned) old.delete(file);
  const untracked = new Set(git.shortStatus.filter((row) => row.status === "??").map((row) => row.file));
  const inheritedHiveOutputs = new Set(base.inheritedHiveOutputs ?? []);
  const relevant = new Set([...git.dirty, ...old.keys()]);
  const included = new Set(git.dirty);
  const batch = ownershipFingerprints(root, { ...git, ignoreVersion: git.filter?.version, eol: base.fingerprintEol ?? "raw" });
  try {
    for (const file of relevant) {
      const fileOrigin = included.has(file) ? "git.dirty" : "baseline.other 的路径";
      if (coversPath(task.writes, file, `${origin}.writes`, `${origin}.${fileOrigin}`)) continue;
      if (!git.tracked.has(file.toLowerCase()) && !included.has(file) &&
          (git.ignoredOutside?.has(file) || git.filter?.ignores(file)) && !overlaps([file], git.protectedPaths)) continue;
      if (controlDocument(task, file) || (inheritedHiveOutputs.has(file) && isUntrackedHiveOutput(task, file, untracked))) continue;
      if (!old.has(file) && coversPath(foreignWrites, file)) continue;
      if (batch.metrics.scannedFiles % 128 === 0) commandProgress({ scannedFiles: batch.metrics.scannedFiles });
      const confirmed = old.has(file) && Object.hasOwn(base.confirmedForeignDirty ?? {}, file)
        ? base.confirmedForeignDirty[file] : undefined;
      const current = confirmed
        ? fingerprint(root, [file], [], undefined, { eol: "raw" })
        : batch.file(file);
      if ((confirmed ?? old.get(file)) !== current)
        throw Object.assign(Error(
        `发现未归属的改动：${file}；请用 diagnoseTask ${JSON.stringify({ taskId: task.id })} 核对，停写后由主控确认归属并调整原票。`,
        ), { verificationCode: "contract-invalid", outsideFile: file });
    }
  } finally { finishOwnership(git, batch); }
}

function finishOwnership(git, batch) {
  const totals = Object.assign(git.ownershipMetrics ??= {}, batch.metrics, { fingerprintMs: Math.round(performance.now() - batch.started) });
  commandProgress({ phase: "ownership-fingerprint", scannedFiles: totals.scannedFiles });
  if (totals.invalidatedBy || totals.scannedFiles >= 1000)
    console.info("LingFlow ownership scan", JSON.stringify(totals));
}

function currentPlanningBytes(root, source) {
  const absolute = path.resolve(root, source.file);
  try {
    const stat = lstatSync(absolute);
    if (stat.isFile() && stat.size <= 256 * 1024 && realpathSync(absolute) === absolute)
      return readFileSync(absolute);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY"].includes(error.code)) throw error;
  }
  return null;
}

function planningText(bytes) {
  if (!bytes) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

export function inspectPlanningDocument(root, document) {
  const bytes = currentPlanningBytes(root, document);
  const currentDigest = bytes && sourceFileFingerprint(document.file, bytes);
  const frozenBytes = frozenSourceBytes(document, document.text);
  const restoreText = frozenBytes?.toString("utf8");
  return { ...document, currentDigest, diffAgainst: "dispatch", ...(restoreText !== undefined && restoreText !== document.text && { restoreText }),
    diff: currentDigest === document.digest ? { status: "unchanged" } : planningDiff(document.text, planningText(bytes)) };
}

export function ticketSourceObservation(root, task, git, observedDigest) {
  const source = task.sources?.tickets;
  if (!source) return;
  const bytes = observedDigest === undefined ? currentPlanningBytes(root, source) : null;
  const staged = git?.shortStatus?.some(({ status, file }) => ![" ", "?"].includes(status[0]) && overlaps([source.file], [file]));
  const reviewed = task.ticketSourceReview;
  const expected = reviewed?.file === source.file && reviewed?.frozenDigest === source.digest ? reviewed.digest : source.digest;
  return { source, digest: observedDigest !== undefined ? observedDigest : bytes ? sourceFileFingerprint(source.file, bytes) : null,
    expected, staged: Boolean(staged) };
}

export const ticketSourceReviewStates = ["queued", "paused", "assigned", "rework", "waiting_verification",
  "waiting_review", "reviewing", "waiting_batch", "changes_requested", "ready", "trial"];

export function assertFrozenTicket(root, task, git) {
  const live = ticketSourceObservation(root, task, git);
  if (!live || !live.staged && live.digest === live.expected) return;
  const { source, digest, staged } = live;
  const inspect = { command: "inspectPlan", args: { planId: task.planId, document: source.file, taskId: task.id } };
  const refresh = digest && !staged ? { command: "reviseSchedule", args: { taskId: task.id,
    reason: "已核对当前票面，仅对账文档字节，按冻结验收和检查继续", refreshSourceDigest: true, expectedSourceDigest: digest, writes: task.writes },
    ownerRole: "controller" } : null;
  const nextAction = refresh && ticketSourceReviewStates.includes(task.state) ? refresh : inspect;
  const replacement = planningDecisionOptions(task).find(option => option.choice === "replace-ticket");
  const message = `冻结票面已变化：${source.file}。用 inspectPlan 查看派发正文、冻结摘要、上次对账摘要和当前摘要。` +
    `派发摘要 ${source.digest}，门禁期望 ${live.expected}，当前摘要 ${digest ?? "无法读取"}。` +
    (staged ? "票面在暂存区，先由主控核对暂存归属，门禁当前无法对账。" :
      "恢复派发正文后重新诊断。若核对后保留当前文档，expectedSourceDigest 使用诊断给出的当前摘要，每次编辑后需重新获取。") +
    ` 下一步执行 ${nextAction.command} ${JSON.stringify(nextAction.args)}。已派票继续依照原验收和检查，新 AC 或检查契约须另派后继票。`;
  throw Object.assign(Error(message + (replacement ? ` ${replacement.instruction} ${JSON.stringify(replacement)}` : "")), {
    verificationCode: "contract-invalid", nextAction,
    violations: [{ path: "sources.tickets", message, frozenDigest: source.digest, expectedDigest: live.expected, liveDigest: digest,
      remedy: { nextAction, inspect, replacement } }],
  });
}

export function planningSourceNotes(root, task, plan) {
  const notes = [];
  const documents = Object.values(plan?.documents ?? {});
  const ticket = task.sources?.tickets;
  const frozenTicket = ticket && documents.find(doc => doc.file === ticket.file && doc.digest === ticket.digest);
  const ticketSections = frozenTicket ? splitHiveTickets(frozenTicket) : [];
  const ticketText = ticketSections.length
    ? ticketSections.find(section => /^#\s+(?:票(?:面)?\s*|Ticket\s+)?([A-Z][\w]*-\d+)/i.exec(section.text)?.[1] === task.ticketKey)?.text
    : frozenTicket?.text;
  for (const [name, source] of Object.entries(task.sources ?? {})) {
    const bytes = currentPlanningBytes(root, source);
    const frozen = documents.find(doc => doc.file === source.file && doc.digest === source.digest);
    const note = classifySourceEdit(source, frozen?.text, bytes);
    if (!note) continue;
    const current = name === "spec" ? planningText(bytes) : null;
    const impact = name === "spec" && specImpact(frozen?.text, current, task, ticketText);
    notes.push({ ...note,
      ...(name === "spec" && { specVersion: { dispatched: task.specVersion ?? plan?.specVersion ?? null, current: readSpecVersion(current) } }),
      ...(impact && { impact }),
      nextAction: { command: "inspectPlan", args: { planId: task.planId, document: source.file } },
    });
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
    (document) => overlaps([document.file], [file]) && /\.(md|markdown|txt|rst|adoc|json|ya?ml|toml)$/i.test(file),
  );
  const planning = /^\.lingflow\/planning\/.*\.(md|json|ya?ml)$/i.test(file);
  const protectedPaths = [
    ...(task.writes ?? []),
    ...(task.reads ?? []),
    ...(task.verification?.checks.flatMap((check) => [...check.inputs, ...(check.requiredArtifacts ?? [])]) ?? []),
  ];
  return (frozen || planning) && !overlaps([file], protectedPaths);
}

function livePlanningFile(task, file) {
  return !coversPath(task.writes, file) && controlDocument(task, file) &&
    !overlaps([file], task.sources?.tickets ? [task.sources.tickets.file] : []) &&
    Object.entries(task.sources ?? {}).some(([name, source]) => livePlanningSource(name) && overlaps([file], [source.file]));
}
