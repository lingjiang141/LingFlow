import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { artifactsIntact } from "./check-preparation.mjs";
import { findRecord as find } from "./command-arguments.mjs";
import { coversPath, fingerprint, fingerprintEol, overlaps, scopePaths } from "./files.mjs";
import { checkWithoutBudgets } from "./preparation-budget.mjs";
import { assertFingerprintMode, candidateFingerprint, implementationScopeMatches, verify } from "./quality.mjs";
import { redEvidence, redReceiptValid, redSnapshotSpec, redSnapshotValid } from "./red-evidence.mjs";

export function hashCandidate(state, task) {
  if (task.verification) assertFingerprintMode(task);
  return candidateFingerprint(find(state.projects, task.projectId).root, task, fingerprintEol);
}

export function sameCheckRecipe(saved, current) {
  // Legacy check rows may omit empty optional fields. A defined contract must still match exactly.
  const normalize = check => Object.entries(check).filter(([, value]) => value != null && value !== "" &&
    !(Array.isArray(value) && !value.length)).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(normalize(saved)) === JSON.stringify(normalize(current));
}

export const leadCheck = (check) => ["independent", "controller"].includes(check.stage);

export function checkReference(check, job, task) {
  return { checkId: check.id, stage: check.stage, covers: check.covers, jobId: job.id, output: job.output,
    ...(task && job.taskId !== task.id && { redNotApplicable: true, upstreamTaskId: job.taskId }) };
}

export function evidenceBase(task) {
  // An approved clean forward rebind updates the Git gate, not the identity of unchanged evidence.
  return task.baseline.evidenceBase ?? [task.baseline.head, task.baseline.index];
}

export function checkInput(root, task, check) {
  assertFingerprintMode(task);
  return JSON.stringify([...evidenceBase(task),
    fingerprint(root, checkPaths(task, check), [], undefined, { rawPaths: task.verification.testWrites })]);
}

export function checkPaths(task, check) {
  return [...new Set([...task.writes, ...task.reads, ...check.inputs])];
}

function redProof(root, task, check) {
  return fingerprint(root, [...task.verification.testWrites, ...check.inputs.filter((file) => !overlaps([file], task.writes))],
    [], undefined, { rawPaths: task.verification.testWrites });
}

export function intactOutput(job) {
  try {
    return job.output && createHash("sha256").update(readFileSync(job.output)).digest("hex") === job.receipt?.outputHash;
  } catch {
    return false;
  }
}

export function checkContentMatches(job, input) {
  if (job.input === input) return true;
  try {
    const old = JSON.parse(job.input), current = JSON.parse(input);
    return Array.isArray(old) && old.length === 3 && old.every(value => typeof value === "string") &&
      old[2] === current[2];
  } catch { return false; }
}

export function invalidateCheckReceipts(state, task, checkIds) {
  if (!checkIds.length) return;
  for (const job of state.checkJobs)
    if (job.taskId === task.id && job.state === "passed" && checkIds.includes(job.check.id)) job.invalidated = true;
}

function checkArtifactsAvailable(state, root, job) {
  const preparation = job.receipt?.preparation;
  if (artifactsIntact(root, preparation)) return true;
  if (preparation?.artifactsVerified !== true) return false;
  // A later verified build can account for changed shared products. Keep
  // rejecting changes with no recorded producer, including manual edits.
  return preparation.artifacts.every(artifact => artifactsIntact(root, { artifacts: [artifact] }) ||
    state.checkJobs.some(later => later.id !== job.id && later.root === job.root && later.finishedAt > job.finishedAt &&
      later.state === "passed" && later.receipt?.preparation?.artifactsVerified === true &&
      later.check.preSteps?.some(step => coversPath(step.outputs, artifact.file)) &&
      later.receipt.preparation.artifacts.some(output => output.file === artifact.file && artifactsIntact(root, { artifacts: [output] }))));
}

export function validCheck(state, task, check, jobId) {
  assertFingerprintMode(task);
  if (task.redBaselinePending || !implementationScopeMatches(task, task.redBaseline ?? task.baseline)) return;
  const root = find(state.projects, task.projectId).root;
  const red = check.stage === "red";
  const snapshot = redSnapshotSpec(task, check);
  const existingDelivery = ["ready", "trial", "accepted", "waiting_review", "reviewing", "waiting_verification", "waiting_batch"].includes(task.state);
  const input = red ? redProof(root, task, check) : checkInput(root, task, check);
  return state.checkJobs.findLast((job) => job.taskId === task.id && (!jobId || job.id === jobId) &&
    job.check.id === check.id && (sameCheckRecipe(job.check, check) ||
      task.budgetReceiptIds?.includes(job.id) && sameCheckRecipe(checkWithoutBudgets(job.check), checkWithoutBudgets(check))) &&
    job.fingerprintEol === fingerprintEol && !job.invalidated &&
    job.state === "passed" && !job.receipt?.environmentFailure &&
    (!red || existingDelivery && !job.redSnapshot || redSnapshotValid(job, job.receipt, snapshot)) &&
    (red || checkArtifactsAvailable(state, root, job)) &&
    (red ? (job.redProofVersion === 2
      ? job.redProof === redEvidence(root, task, check, job.redImplementationBaseline, 2).redProof &&
        job.redTestProof === fingerprint(root, task.verification.testWrites, [], undefined, { eol: "raw" })
      : job.redProof === input) : checkContentMatches(job, input)) &&
    (!red || intactOutput(job) && redReceiptValid(check, job.receipt, readFileSync(job.output, "utf8"))) &&
    intactOutput(job));
}

export function upstreamRed(state, task, check, jobId) {
  if (check.stage !== "red" || !task.baseline || task.redBaselinePending ||
      !(task.redInheritedWrites ?? task.baseline.admissionOwnedDirty ?? task.ownedDirty ?? []).some(file =>
        coversPath(task.writes, file) && !coversPath(task.verification.testWrites, file))) return;
  const pair = task.verification.checks.find(green => green.stage === "green" && check.id === green.id + "-red" &&
    (check.derivedFrom === green.id || task.redContractVersion !== 2 && check.derivedFrom === undefined) &&
    JSON.stringify(green.argv) === JSON.stringify(check.argv));
  if (!pair) return;
  const upstreamIds = task.upstreamRedTaskId ? [task.upstreamRedTaskId] :
    [...(task.dependencies ?? []), ...state.tasks.filter(item => item.supersededBy === task.id).map(item => item.id)];
  if (!upstreamIds.length) return;
  const recipe = ({ id, derivedFrom, ...fields }) => fields;
  const root = find(state.projects, task.projectId).root;
  const testProof = fingerprint(root, task.verification.testWrites, [], undefined, { eol: "raw" });
  for (const upstreamId of upstreamIds) {
    const upstream = state.tasks.find(item => item.id === upstreamId && item.projectId === task.projectId && item.verification && item.baseline);
    if (!upstream || upstream.baseline.fingerprintEol !== fingerprintEol ||
        JSON.stringify(scopePaths(upstream.verification.testWrites)) !== JSON.stringify(scopePaths(task.verification.testWrites)) ||
        !(upstream.releasedScope?.writes ?? upstream.writes).length ||
        JSON.stringify(scopePaths(upstream.releasedScope?.writes ?? upstream.writes)) !== JSON.stringify(scopePaths(task.writes)) ||
        !check.covers.every(id => upstream.verification.acceptance.find(ac => ac.id === id)?.text ===
          task.verification.acceptance.find(ac => ac.id === id)?.text)) continue;
    const upstreamCheck = upstream.verification.checks.find(entry => entry.stage === "red" && sameCheckRecipe(recipe(entry), recipe(check)));
    if (!upstreamCheck) continue;
    const original = upstream.releasedScope?.writes ? { ...upstream, writes: upstream.releasedScope.writes } : upstream;
    const job = validCheck(state, original, upstreamCheck, jobId);
    if (job?.redTestProof === testProof && job.receipt.failureOutputSeen === true) return job;
  }
}

export function deliveryCheck(state, task, check, jobId) {
  return validCheck(state, task, check, jobId) ?? upstreamRed(state, task, check, jobId);
}

export function historicalCheck(state, task, check) {
  const proof = task.deliveryVerification?.checks.find(item => item.checkId === check.id);
  if (!proof) return;
  const job = state.checkJobs.find(item => item.id === proof.jobId);
  if (job && (job.taskId === task.id && sameCheckRecipe(job.check, check) ||
      check.stage === "red" && proof.upstreamTaskId === job.taskId && job.receipt?.failureOutputSeen === true) &&
      job.fingerprintEol === fingerprintEol &&
      job.state === "passed" && !job.invalidated && !job.receipt?.environmentFailure &&
      job.receipt?.outputHash === proof.outputHash && intactOutput(job)) return job;
}

export function recordDeliveryVerification(state, task, batchJob) {
  if (!task.deliveredManifest) return;
  try {
    const checks = assertDeliveryProof(state, task, true).map(({ checkId, jobId, upstreamTaskId }) => ({
      checkId, jobId, outputHash: find(state.checkJobs, jobId).receipt.outputHash,
      ...(upstreamTaskId && { upstreamTaskId }),
    }));
    task.deliveryVerification = { reportId: task.deliveredManifest.reportId, checks,
      ...(batchJob && { batch: { jobId: batchJob.id, outputHash: batchJob.receipt.outputHash } }) };
  } catch (error) {
    if (!["evidence-missing", "contract-invalid"].includes(error.verificationCode)) throw error;
  }
}

export function assertRoundDeliveryProof(state, task) {
  const report = task.reports.findLast(item => item.revision === task.revision && item.candidate === task.candidate);
  verify(report && report.id === task.deliveryVerification?.reportId, "evidence-missing", "缺少绑定本次修订和候选的冻结交付报告");
  verify(task.verification?.checks?.length, "evidence-missing", "缺少冻结检查契约");
  verify(Array.isArray(report.checks) && report.checks.every(reference =>
    task.verification.checks.some(check => check.id === reference?.checkId) &&
    task.deliveryVerification.checks?.some(proof => proof.checkId === reference?.checkId && proof.jobId === reference?.jobId)),
  "evidence-missing", "交付报告引用的检查与冻结回执不匹配");
  // Compare with the checks frozen at delivery, since subsequent tickets may have changed the inputs.
  for (const check of task.verification.checks) {
    const job = historicalCheck(state, task, check);
    verify(job?.projectId === task.projectId && (leadCheck(check) ||
      report.checks?.some(reference => reference.checkId === check.id && reference.jobId === job.id)),
    "evidence-missing", "冻结交付检查缺失、失败或已失效：" + check.id);
  }
}

export function assertDeliveryProof(state, task, final = false, historicalCommit) {
  verify(historicalCommit || hashCandidate(state, task) === task.candidate, "contract-invalid", "候选输入已变化，需重新交付");
  const report = task.reports.findLast((item) => item.revision === task.revision && item.candidate === task.candidate);
  const checks = [];
  for (const check of task.verification.checks) {
    if (leadCheck(check) && !final) continue;
    const job = historicalCommit ? historicalCheck(state, task, check) : leadCheck(check) ? validCheck(state, task, check) :
      report?.checks?.map(proof => proof?.jobId && deliveryCheck(state, task, check, proof.jobId)).find(Boolean);
    verify(job, "evidence-missing", "交付证据缺失、失效或已变化：" + check.id);
    checks.push(checkReference(check, job, task));
  }
  return checks;
}
