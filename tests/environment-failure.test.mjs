import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/evidence-fixture.mjs';
import { detectEnvironmentFailure } from '../src/environment-failure.mjs';
import { redReceiptValid } from '../src/red-evidence.mjs';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

test('webServer startup failure is an environment failure and cannot qualify as red', async t => {
  const f = await fixture(t);
  f.put(f.testFile, "console.error('Process from config.webServer was not able to start');process.exitCode=1;");
  const job = await f.run('red');
  assert.equal(job.classification, 'environment-failed');
  assert.equal(job.state, 'failed');
  assert.equal(job.membersCanRetry, true);
  assert.equal(job.environmentFailure, true);
  assert.equal(job.receipt.failureOutputSeen, false);
  assert.equal(job.receipt.classification, 'environment-failed');
  assert.equal(job.receipt.membersCanRetry, true);
  assert.match(job.reason, /webServer/);
  assert.match(job.hint, /先跑 npm run build/);
  assert.equal(job.nextAction.args.checkId, 'red');
  assert.deepEqual(job.nextAction.argv, job.check.argv);
  assert.deepEqual(job.nextAction.inputs, job.check.inputs);
  assert.equal(f.call('Dev', 'checkStatus', { jobId: job.id }).environmentFailure, true);
  assert.equal(f.call('Dev', 'inspect', { taskId: f.taskId }).environmentFailure, true);
  const diagnosis = f.call('Lead', 'diagnoseTask', { taskId: f.taskId });
  assert.equal(diagnosis.classification, 'environment-failed');
  assert.equal(diagnosis.nextAction.command, 'check');
  assert.throws(() => f.call('Dev', 'check', { taskId: f.taskId, checkId: 'green' }), /预期失败/);
});

test('environment signatures distinguish startup from tests already running', () => {
  const receipt = { exitCode: 1, startedAt: 10000, finishedAt: 15000 };
  for (const [output, code] of [
    ['Process from config.webServer was not able to start', 'webserver-start-failed'],
    ['You installed esbuild for another platform', 'esbuild-platform-mismatch'],
    ['Cannot find module "missing"', 'module-missing-before-tests'],
    ['Error: listen EADDRINUSE 127.0.0.1:3000', 'webserver-port-or-connection'],
    ['Error: connect ECONNREFUSED 127.0.0.1:3000', 'webserver-port-or-connection'],
  ]) {
    const result = detectEnvironmentFailure(receipt, output);
    assert.equal(result.environmentFailure, true); assert.equal(result.environmentFailureReason, code);
  }
  assert.equal(detectEnvironmentFailure({ launchError: 'spawn ENOENT' }).environmentFailureReason, 'launch-error');
  assert.equal(detectEnvironmentFailure(receipt, 'Running 1 test\nCannot find module inside running test\nAssertionError').environmentFailure, false);
  assert.equal(detectEnvironmentFailure(receipt, 'Running 1 test\nECONNREFUSED in request assertion\nAssertionError').environmentFailure, false);
});

test('fast no-test failures are environment failures; real assertions and passing quiet scripts retain their meaning', () => {
  const failed = { exitCode: 1, startedAt: 10000, finishedAt: 10100 };
  assert.equal(detectEnvironmentFailure(failed, '').environmentFailureReason, 'failed-before-tests');
  assert.equal(detectEnvironmentFailure({ ...failed, finishedAt: 12000 }, '').environmentFailure, false);
  assert.equal(detectEnvironmentFailure(failed, 'AssertionError [ERR_ASSERTION]: Expected values to be equal').environmentFailure, false);
  assert.equal(detectEnvironmentFailure(failed, 'Running 1 test\nfailed').environmentFailure, false);
  assert.equal(detectEnvironmentFailure({ ...failed, exitCode: 0 }, '').environmentFailure, false);
  assert.equal(detectEnvironmentFailure({ ...failed, exitCode: 0, expectedOutputSeen: false }, 'behavior confirmed').environmentFailure, false);
  const setupAssertion = 'Process from config.webServer was not able to start\nAssertionError [ERR_ASSERTION]: configuration failed';
  assert.equal(redReceiptValid({ expectedOutput: 'AssertionError' }, { failureOutputSeen: true, exitCode: 1 }, setupAssertion), false);
});

test('environment diagnostics never override frozen input drift or grant red evidence', async t => {
  const f = await fixture(t);
  f.put(f.testFile, "console.error('Process from config.webServer was not able to start');process.exit(1)");
  const queued = f.call('Dev', 'check', { taskId: f.taskId, checkId: 'red', async: true });
  const job = f.wf.claimCheck(queued.jobId);
  assert.ok(job);
  f.put('implementation.cjs', "module.exports='changed during check';");
  const output = 'Process from config.webServer was not able to start';
  const file = path.join(f.dir, 'simulated-worker-output.txt');
  writeFileSync(file, output);
  f.wf.finishCheck(job.id, { id: job.id, exitCode: 1, startedAt: job.startedAt, finishedAt: job.startedAt + 100,
    expectedOutputSeen: false, failureOutputSeen: false, outputHash: createHash('sha256').update(output).digest('hex') }, file);
  const finished = f.call('Dev', 'checkStatus', { jobId: job.id });
  assert.equal(finished.environmentFailure, true);
  assert.equal(finished.state, 'stale');
  assert.equal(finished.classification, 'contract-invalid');
  assert.throws(() => f.call('Dev', 'check', { taskId: f.taskId, checkId: 'green' }), /预期失败/);
});

test('same frozen check can retry red and green after environment repair, without counting failed attempts as evidence', async t => {
  const f = await fixture(t);
  const variable = 'LINGFLOW_ENVIRONMENT_FAILURE_FIXTURE';
  const previous = process.env[variable];
  t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  f.put(f.testFile, `if(process.env.${variable}==='1'){console.error('Process from config.webServer was not able to start');process.exit(1)};require('node:assert/strict').equal(require('../implementation.cjs'),'new');`);
  const contract = JSON.stringify(f.store.read().tasks[0].verification);
  process.env[variable] = '1';
  const badRed = await f.run('red');
  assert.equal(badRed.classification, 'environment-failed');
  process.env[variable] = '0';
  const red = await f.run('red');
  assert.equal(red.state, 'passed'); assert.equal(red.environmentFailure, false);
  f.put('implementation.cjs', "module.exports='broken';");
  const assertion = await f.run('green');
  assert.equal(assertion.state, 'failed'); assert.equal(assertion.environmentFailure, false);
  assert.ok(['quality-failed', 'evidence-missing'].includes(assertion.classification));
  f.put('implementation.cjs', "module.exports='new';");
  process.env[variable] = '1';
  const badGreen = await f.run('green');
  assert.equal(badGreen.classification, 'environment-failed'); assert.equal(badGreen.membersCanRetry, true);
  process.env[variable] = '0';
  assert.equal((await f.run('green')).state, 'passed');
  assert.equal((await f.run('full')).state, 'passed');
  assert.equal(f.call('Dev', 'inspect', { taskId: f.taskId }).environmentFailure, false);
  assert.deepEqual(badGreen.check.argv, f.store.read().tasks[0].verification.checks.find(check => check.id === 'green').argv);
  assert.equal(JSON.stringify(f.store.read().tasks[0].verification), contract);
});
