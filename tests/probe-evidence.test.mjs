import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fixture} from './helpers/evidence-fixture.mjs';
import {detectEnvironmentFailure} from '../src/environment-failure.mjs';
import {checkEvidenceFacts} from '../src/check-evidence.mjs';
import {redReceiptValid} from '../src/red-evidence.mjs';
import {browserCheckArgv} from '../src/verification-policy.mjs';

const marker='missing R36-10 e2e case';
const title='R36-10 creates a child department under a parent and assigns a head from another department';
const argv=['node','-e',`const fs=require('fs');const t=fs.readFileSync('e2e/organization.spec.ts','utf8');if(!t.includes('${title}')) throw new Error('${marker}');console.log('r36-10 e2e seam present')`];
test('A: actual fast node seam probe is valid red without AssertionError',async t=>{
  const file='e2e/organization.spec.ts';
  const checks=['red','green','full'].map(stage=>({id:stage,stage,argv:stage==='full'?browserCheckArgv({file,title}):argv,
    inputs:[file,'implementation.cjs'],covers:['AC1'],...(stage==='red'&&{expectedOutput:marker})}));
  const f=await fixture(t,marker,{checks,testFile:file,browserE2E:[{file,title,reason:'Verify the named browser case',covers:['AC1']}]});
  f.put(f.testFile,'// Existing cases, missing the new case');
  const red=await f.run('red');
  assert.equal(red.receipt.evidenceKind,'probe');
  assert.equal(red.receipt.expectedOutputSeen,true);
  assert.equal(red.receipt.failureOutputSeen,true);
  assert.equal(red.environmentFailure,false);
  assert.equal(red.state,'passed');assert.equal(red.redEvidenceValid,true);
  const state=f.store.read(),task=state.tasks.find(x=>x.id===f.taskId),check=task.verification.checks.find(x=>x.id==='red');
  assert.ok(f.wf.validCheck(state,task,check));
  assert.notEqual(red.classification,'environment-failed');
  console.log(JSON.stringify({case:'A',exitCode:red.receipt.exitCode,evidenceKind:red.receipt.evidenceKind,elapsedMs:red.receipt.elapsedMs,failureOutputSeen:red.receipt.failureOutputSeen,environmentFailure:red.environmentFailure,state:red.state,validRed:true}));
});
test('a real probe red unlocks unchanged frozen green and full after implementation repair',async t=>{
  const argv=['node','-e',`if(require('./implementation.cjs')!=='new')throw new Error('missing behavior');console.log('behavior present')`];
  const f=await fixture(t,'missing behavior',{argv});f.put(f.testFile,'// unchanged contract input');
  assert.equal((await f.run('red')).state,'passed');
  const broken=await f.run('green');assert.equal(broken.classification,'quality-failed');assert.equal(broken.environmentFailure,false);
  f.put('implementation.cjs',"module.exports='new';");
  assert.equal((await f.run('green')).state,'passed');assert.equal((await f.run('full')).state,'passed');
});
test('B/D: missing packages remain environment failures, test startup/no-match semantics remain separate',()=>{
  const run=spawnSync(process.execPath,['-e',"require('lingflow-f23-package-does-not-exist')"],{encoding:'utf8',windowsHide:true});
  const receipt={exitCode:run.status,startedAt:1000,finishedAt:1155,evidenceKind:'probe'};
  const bad=detectEnvironmentFailure(receipt,run.stderr);
  assert.equal(bad.environmentFailureReason,'module-missing-before-tests');
  assert.equal(bad.matchedRule,'module-missing-before-tests');assert.equal(bad.evidenceKind,'probe');
  assert.equal(redReceiptValid({argv:['node','-e',"require('missing')"],expectedExit:1,expectedOutput:'Cannot find module'},
    {...receipt,failureOutputSeen:true},run.stderr),false);
  const quick=detectEnvironmentFailure({...receipt,evidenceKind:'test'},'vitest could not initialize');
  assert.equal(quick.environmentFailureReason,'failed-before-tests');
  const empty=checkEvidenceFacts({argv:['npm','test']},{...quick,...receipt,evidenceKind:'test'},'No tests found.');
  assert.equal(empty.environmentFailure,false);assert.equal(empty.testCaseSeen,false);
  console.log(JSON.stringify({case:'B/D',missing:bad.environmentFailureReason,testStartup:quick.environmentFailureReason,noMatch:empty.testCaseSeen}));
});
test('C: compile errors classify as quality while compile dependencies remain environment failures',async t=>{
  const f=await fixture(t),check={id:'compile',stage:'green',argv:['node','node_modules/typescript/bin/tsc'],inputs:[],expectedExit:0};
  for(const [output,wanted]of [['src/a.ts(1,1): error TS2345: incompatible types','quality-failed'],['SyntaxError: Unexpected token','quality-failed'],["Error: Cannot find module 'typescript'",'environment-failed']]){
    const file=path.join(f.dir,'compile.txt');writeFileSync(file,output);
    const receipt={id:'compile-job',exitCode:2,startedAt:1000,finishedAt:1155,outputHash:createHash('sha256').update(output).digest('hex')};
    const result={state:'failed',receipt,output:file};
    f.wf.classifyCheck({id:receipt.id,taskId:f.taskId,check},result);
    assert.equal(result.classification,wanted,output);
    if(wanted==='environment-failed'){assert.equal(result.evidenceKind,'compile');assert.ok(result.matchedRule);assert.equal(result.elapsedMs,155);}
    // Actions problem matchers treat compiler-shaped negative fixtures as real errors.
    const signature=output.includes('TS2345')?'TS2345':output.includes('SyntaxError')?'compile-syntax':'missing-dependency';
    console.log(JSON.stringify({case:'C',signature,classification:result.classification,matchedRule:result.matchedRule}));
  }
});
test('probe receipts require an expected nonzero exit, expected output and real error stack, and share facts',()=>{
  const check={argv:['node','-e','throw new Error("missing seam")'],expectedExit:1,expectedOutput:'missing seam'};
  const output='Error: missing seam\n    at [eval]:1:7\n    at runScriptInThisContext (node:internal/vm:209:10)';
  const receipt={exitCode:1,startedAt:1000,finishedAt:1155,failureOutputSeen:true,evidenceKind:'probe'};
  assert.equal(redReceiptValid(check,receipt,output),true);
  for(const bad of [{...receipt,exitCode:2},{...receipt,signal:'SIGTERM'},{...receipt,timedOut:true},{...receipt,launchError:'spawn ENOENT'},{...receipt,truncated:true}])assert.equal(redReceiptValid(check,bad,output),false);
  assert.equal(redReceiptValid(check,receipt,'missing seam'),false);
  assert.equal(redReceiptValid(check,receipt,output.replaceAll('missing seam','other error')),false);
  const env=detectEnvironmentFailure(receipt,output),facts=checkEvidenceFacts(check,receipt,output);
  assert.equal(env.testCaseSeen,facts.testCaseSeen);assert.equal(facts.testCaseSeen,null);
  const corrected=checkEvidenceFacts(check,{...receipt,environmentFailure:true,environmentFailureReason:'failed-before-tests'},output);
  assert.equal(corrected.environmentFailure,false);
  assert.equal(checkEvidenceFacts(check,{...receipt,environmentFailure:true,environmentFailureReason:'failed-before-tests',launchError:'ENOENT'},output).environmentFailure,undefined);
  const dependency="Error: Cannot find module 'missing seam'\n    at [eval]:1:7";
  assert.equal(checkEvidenceFacts(check,{...receipt,environmentFailure:true,environmentFailureReason:'failed-before-tests'},dependency).environmentFailure,undefined);
});
