import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fingerprint, scopePaths, overlaps } from "./files.mjs";
import { withBuildCache } from "./build-cache.mjs";
import { resolveCheckCommand } from "./check-command.mjs";

export function preparationContract(check, writes, commandArgs) {
  const requiredArtifacts = scopePaths(check.requiredArtifacts ?? []);
  const preSteps = check.preSteps ?? [];
  if (!Array.isArray(preSteps) || preSteps.length > 8) throw Error("preSteps 须为最多 8 步的数组");
  const normalized = preSteps.map(step => {
    const argv = commandArgs(step.argv), outputs = scopePaths(step.outputs ?? []);
    if (!outputs.length || overlaps(outputs, [...writes, ...check.inputs])) throw Error("preSteps.outputs 须显式声明独立构建产物，不能覆盖 writes 或冻结 inputs");
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 3600000)) throw Error("preSteps.timeoutMs 无效");
    return { argv, outputs, timeoutMs: step.timeoutMs ?? check.timeoutMs };
  });
  return { requiredArtifacts: [...new Set([...requiredArtifacts, ...normalized.flatMap(step => step.outputs)])], preSteps: normalized };
}

export async function prepareCheck(root, check, { env = process.env, dataDir, projectId, preferredNode } = {}) {
  const started = Date.now(), steps = [];
  const files = [...new Set([...(check.preSteps ?? []).flatMap(step => step.outputs), ...(check.requiredArtifacts ?? [])])];
  const readArtifacts = () => files.map(file => {
    if (!existsSync(path.resolve(root, file))) throw Error("缺少构建产物 " + file);
    return { file, hash: fingerprint(root, [file], [], undefined, { eol: "raw" }) };
  });
  async function prepare() {
    for (const step of check.preSteps ?? []) {
      const remaining = Math.min(step.timeoutMs, check.timeoutMs - (Date.now() - started));
      if (remaining <= 0) throw Object.assign(Error("构建前置超过检查总时限"),{timedOut:true});
      const { executable, args, env: childEnv } = resolveCheckCommand(step.argv, env, preferredNode);
      const stepStarted=Date.now();
      const result = await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: root, env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, remaining);
        for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk.toString().slice(0, Math.max(0, 64000 - output.length)); });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", (exitCode, signal) => { clearTimeout(timer); resolve({ argv: step.argv, exitCode, signal, timedOut, output,elapsedMs:Date.now()-stepStarted }); });
      });
      steps.push(result);
      if (result.exitCode !== 0 || result.signal || result.timedOut) throw Object.assign(Error("构建前置失败，不能作为红证据"), { timedOut:result.timedOut });
    }
    return { steps, artifacts: readArtifacts(), cached: false, savedMs: 0 };
  }
  try {
    const result = await withBuildCache(root, check, { env, dataDir, projectId, started }, prepare, readArtifacts);
    return { ...result, elapsedMs: Date.now() - started };
  }catch(error){
    const timedOut=Boolean(error.timedOut||steps.some(step=>step.timedOut));
    throw Object.assign(error,{phase:'preparation',timedOut,preparation:{...error.preparation,steps,cached:false,savedMs:0,elapsedMs:Date.now()-started,timedOut}});
  }
}
export function artifactsIntact(root, preparation) {
  try { return (preparation?.artifacts ?? []).every(({ file, hash }) => fingerprint(root, [file], [], undefined, { eol: "raw" }) === hash); } catch { return false; }
}
