import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redFailure } from "./red-evidence.mjs";
import { fingerprint } from "./files.mjs";
import { prepareCheck } from "./check-preparation.mjs";
import { detectEnvironmentFailure, environmentRetry } from "./environment-failure.mjs";
import { checkEvidenceFacts } from './check-evidence.mjs';

const directory = process.argv[2];
const job = JSON.parse(
  readFileSync(path.join(directory, "request.json"), "utf8"),
);
const startedAt = Date.now();
writeFileSync(
  path.join(directory, "running.json"),
  JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
  }),
  { flag: "wx" },
);

function saveResult(result, output = "") {
  result = { ...result, startedAt, finishedAt: Date.now() };
  result = { ...result, ...detectEnvironmentFailure(result, output, startedAt, job.check) };
  result = { ...result, ...checkEvidenceFacts(job.check,result,output) };
  if (result.environmentFailure) Object.assign(result, { failureOutputSeen: false, classification: "environment-failed", ...environmentRetry(job) });
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
    return fingerprint(job.root, job.files) === JSON.parse(job.input).at(-1);
  } catch {
    return false;
  }
}

if (!matchesInputs()) {
  saveResult({ stale: true });
  process.exit(0);
}

const [program, ...args] = job.check.argv;
let preparation;
try { preparation = await prepareCheck(job.root, job.check); }
catch (error) {
  saveResult({ exitCode: null, failureOutputSeen: false, expectedOutputSeen: false, preparation: error.preparation,
    preparationError: error.message, launchError: error.message }, error.message);
  process.exit(0);
}
if (!matchesInputs()) { saveResult({ stale: true, preparation }, "构建前置修改了冻结输入"); process.exit(0); }
const environment = { ...process.env, LINGFLOW_TEST_DATA_ROOT: directory };
if (program === "node" && job.electron) environment.ELECTRON_RUN_AS_NODE = "1";
else delete environment.ELECTRON_RUN_AS_NODE;
let executable = program === "node" ? process.execPath : program;
if (program === "npm") {
  const paths = [
    path.dirname(process.execPath),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ];
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const npmLocation = paths
    .filter(Boolean)
    .map((location) => ({
      executable: path.join(location, nodeName),
      cli: path.join(location, "node_modules", "npm", "bin", "npm-cli.js"),
    }))
    .find(
      (location) => existsSync(location.executable) && existsSync(location.cli),
    );
  if (!npmLocation) {
    saveResult({ launchError: "找不到 Node 安装目录中的 npm-cli.js" });
    process.exit(0);
  }
  executable = npmLocation.executable;
  args.unshift(npmLocation.cli);
}
const child = spawn(executable, args, {
  cwd: job.root,
  env: environment,
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
}, Math.max(1, job.check.timeoutMs - preparation.elapsedMs));
child.on("close", (exitCode, signal) => {
  clearTimeout(timer);
  saveResult(
    {
      exitCode,
      preparation,
      signal,
      timedOut,
      launchError,
      truncated,
      stale: !matchesInputs(),
      expectedOutputSeen:
        !job.check.expectedOutput || output.includes(job.check.expectedOutput),
      failureOutputSeen: job.check.stage === "red" ? exitCode === job.check.expectedExit && exitCode > 0 && redFailure(job.check, output) :
        Boolean(job.check.failureOutput && output.includes(job.check.failureOutput)),
    },
    output,
  );
});
