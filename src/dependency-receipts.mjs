import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobIdentity = job => [job.id, job.input, job.revision, job.check, job.receipt, job.redProof, job.redTestProof];
export function dependencyReceipt(predecessor, jobs, at = Date.now()) {
  return { taskId: predecessor.id, revision: predecessor.revision, candidate: predecessor.candidate,
    at, verification: digest(predecessor.verification),
    jobs: jobs.map(job => ({ id: job.id, digest: digest(jobIdentity(job)) })) };
}

// A downstream admission consumes a verified historical result. Later edits in
// a shared file do not erase that admission; rework or lost receipts do.
export function dependencyReceiptValid(receipt, predecessor, jobs, intactOutput) {
  return Boolean(receipt && receipt.taskId === predecessor.id && receipt.revision === predecessor.revision &&
    receipt.candidate === predecessor.candidate && receipt.verification === digest(predecessor.verification) &&
    receipt.jobs.every(proof => {
      const job = jobs.find(job => job.id === proof.id);
      return job?.state === 'passed' && proof.digest === digest(jobIdentity(job)) && intactOutput(job);
    }));
}

export function recoverAdmittedDependency(task, predecessor, jobs, intactOutput) {
  const admitted=task.admittedAt;
  if(!admitted||!task.dependencies.includes(predecessor.id)||task.dependencyStages?.[predecessor.id]==='accepted'||
      (task.scheduleHistory??[]).some(record=>record.previous?.dependencies&&!record.previous.dependencies.includes(predecessor.id))) return null;
  const report=predecessor.reports?.findLast(report=>report.revision===predecessor.revision&&report.candidate===predecessor.candidate&&report.at<=admitted);
  if(!report||!predecessor.verification) return null;
  if(predecessor.risk==='high'&&!predecessor.reviews?.some(review=>review.verdict==='pass'&&review.candidate===predecessor.candidate&&
    (review.revision===undefined||review.revision===predecessor.revision)&&review.at<=admitted))return null;
  const proofs=[];
  for(const check of predecessor.verification.checks) {
    const job=jobs.findLast(job=>job.taskId===predecessor.id&&job.check.id===check.id&&job.state==='passed'&&job.revision===predecessor.revision&&
      job.finishedAt<=admitted&&!job.receipt?.environmentFailure&&intactOutput(job)&&
      (['independent','controller'].includes(check.stage)||report.checks?.some(proof=>proof.jobId===job.id)));
    if(!job)return null;proofs.push(job);
  }
  if(predecessor.batchId) {
    const job=jobs.find(job=>job.id===predecessor.batchReceiptId&&job.state==='passed'&&job.finishedAt<=admitted&&intactOutput(job));
    if(!job)return null;proofs.push(job);
  }
  return {...dependencyReceipt(predecessor,proofs,admitted),recoveredFrom:'historical-admission'};
}
