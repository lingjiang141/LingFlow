import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redFailure } from "./red-evidence.mjs";
import { fingerprint } from "./files.mjs";
import { artifactsIntact, prepareCheck } from "./check-preparation.mjs";
import { detectEnvironmentFailure, environmentRetry } from "./environment-failure.mjs";
import { checkEvidenceFacts } from './check-evidence.mjs';
import { preparationTimeoutHint } from './preparation-budget.mjs';
import { prepareRedSnapshot } from "./red-snapshot.mjs";
import { preferredCheckNode, resolveCheckCommand } from "./check-command.mjs";

const directory = process.argv[2];
const job = JSON.parse(
  readFileSync(path.join(directory, "request.json"), "utf8"),
);
const startedAt = Date.now();
const deadline = startedAt + job.check.timeoutMs;
let snapshot;
writeFileSync(
  path.join(directory, "running.json"),
  JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
  }),
  { flag: "wx" },
);

function saveResult(result, output = "") {
  if (job.redSnapshot) {
    let inputsIntact = false, worktreeCleanAfter = false;
    if (snapshot) {
      try {
        inputsIntact = snapshot.inputsIntact();
        worktreeCleanAfter = matchesInputs() && snapshot.statusIntact();
      } catch { /* Unreadable evidence cannot be accepted. */ }
      try { snapshot.cleanup(); }
      catch (error) {
        result.launchError = "隔离目录清理失败：" + error.message;
        inputsIntact = false;
      }
    }
    const verdict = result.timedOut ? "red-timeout" : result.launchError ?
      result.phase === "preparation" ? "preparation-failed" : "launch-failed" : !snapshot ? "snapshot-unavailable" :
      !inputsIntact || !worktreeCleanAfter ? "snapshot-changed" :
      result.exitCode === 0 ? "baseline-passed" :
      !result.truncated && result.failureOutputSeen && result.expectedOutputSeen ? "valid" : "assertion-unverified";
    result.redProofDiagnostics = {
      mode: "auto-revert", baselineHead: job.redSnapshot.head,
      ...(snapshot && { implementationFingerprint: job.redSnapshot.sources,
        redObservedImplementation: snapshot.observed, restoredFiles: snapshot.restoredFiles }),
      ...(result.phase && { phase: result.phase }),
      inputsIntact, worktreeCleanAfter, verdict,
    };
  }
  result = { ...result, startedAt, finishedAt: Date.now() };
  result = { ...result, ...detectEnvironmentFailure(result, output, startedAt, job.check) };
  result = { ...result, ...checkEvidenceFacts(job.check,result,output) };
  if (result.environmentFailure) Object.assign(result, { failureOutputSeen: false, classification: result.environmentFailureReason==='preparation-timeout'?'preparation-timeout':"environment-failed",
    ...(result.environmentFailureReason==='preparation-timeout'?{hint:preparationTimeoutHint,membersCanRetry:false,
      nextAction:{command:'checkStatus',args:{jobId:job.id},message:'读取重建承接票的完整 dispatchPlan 参数'}}:environmentRetry(job)) });
  writeFileSync(path.join(directory, "output.txt"), output, "utf8");
  const temporary = path.join(directory, "result.tmp");
  const outputHash = createHash("sha256").update(output, "utf8").digest("hex");
  writeFileSync(
    temporary,
    JSON.stringify({
      ...result,
      outputHash,
      id: job.id,
      finishedAt: result.finishedAt,
    }),
    "utf8",
  );
  renameSync(temporary, path.join(directory, "result.json"));
}

function matchesInputs() {
  try {
    return fingerprint(job.root, job.files, [], undefined, { eol: job.fingerprintEol ?? "raw", rawPaths: job.rawPaths }) === JSON.parse(job.input).at(-1);
  } catch {
    return false;
  }
}

if (!matchesInputs()) {
  saveResult({ stale: true });
  process.exit(0);
}

const program = job.check.argv[0];
const preferredNode = preferredCheckNode(job.check.argv);
const preparationEnv = { ...process.env, LINGFLOW_TEST_DATA_ROOT: directory };
const preflight = steps => {
  for (const step of steps) {
    if (step.argv[0] === "npm") resolveCheckCommand(step.argv, preparationEnv, preferredNode);
  }
};
let preparation;
let executionRoot = job.root;
try {
  if (job.redSnapshot) {
    preflight([job.check, ...(job.check.preSteps ?? [])]);
    snapshot = prepareRedSnapshot(job, deadline, preflight);
    executionRoot = snapshot.root;
  }
  const timeoutMs = job.redSnapshot ? Math.max(1, deadline - Date.now()) : job.check.timeoutMs;
  const preSteps = snapshot?.workspaceBuilds.length ? [...snapshot.workspaceBuilds, ...(job.check.preSteps ?? [])] : job.check.preSteps;
  preparation = await prepareCheck(executionRoot, { ...job.check, timeoutMs, preSteps }, snapshot
    ? { env: preparationEnv, preferredNode }
    : { preferredNode, projectId: job.projectId, dataDir: path.dirname(path.dirname(directory)) });
}
catch (error) {
  saveResult({ exitCode: null, failureOutputSeen: false, expectedOutputSeen: false, preparation: error.preparation,
    preparationError: error.message, launchError: error.message, phase: error.phase ?? "preparation",
    ...(error.code === "npm-runtime-missing" && { launchErrorCode: error.code }),
    timedOut: Boolean(error.timedOut || error.code === "ETIMEDOUT") }, error.message);
  process.exit(0);
}
if (!matchesInputs() || !artifactsIntact(executionRoot, preparation) || snapshot && !snapshot.inputsIntact()) {
  saveResult({ stale: true, preparation }, "检查启动前冻结输入或构建产物已变化"); process.exit(0);
}
const environment = { ...process.env, LINGFLOW_TEST_DATA_ROOT: directory };
if (program === "node" && job.electron) environment.ELECTRON_RUN_AS_NODE = "1";
else delete environment.ELECTRON_RUN_AS_NODE;
let command;
try { command = resolveCheckCommand(job.check.argv, environment, preferredNode); }
catch (error) {
  saveResult({ launchError: error.message, launchErrorCode: error.code, phase: "launch" }, error.message);
  process.exit(0);
}
const { executable, args, env } = command;
const child = spawn(executable, args, {
  cwd: executionRoot,
  env,
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let truncated = false;
let timedOut = false;
let launchError = null;
const maxOutput = 256 * 1024;
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    if (output.length + chunk.length > maxOutput) truncated = true;
    output += chunk.slice(0, Math.max(0, maxOutput - output.length));
  });
}
child.on("error", (error) => {
  launchError = error.message;
});
const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, Math.max(1, snapshot ? deadline - Date.now() : job.check.timeoutMs - preparation.elapsedMs));
child.on("close", (exitCode, signal) => {
  clearTimeout(timer);
  const artifactsVerified = artifactsIntact(executionRoot, preparation);
  saveResult(
    {
      exitCode,
      preparation: { ...preparation, ...(artifactsVerified && { artifactsVerified: true }) },
      signal,
      timedOut,
      launchError,
      truncated,
      stale: !matchesInputs() || !artifactsVerified,
      expectedOutputSeen:
        !job.check.expectedOutput || output.includes(job.check.expectedOutput),
      failureOutputSeen: job.check.stage === "red" ? exitCode === job.check.expectedExit && exitCode > 0 && redFailure(job.check, output) :
        Boolean(job.check.failureOutput && output.includes(job.check.failureOutput)),
    },
    output,
  );
});
