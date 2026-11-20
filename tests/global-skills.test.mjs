import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planGlobalSkills} from '../scripts/adapt-global-skills.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));
test('global adaptation preserves invocation policy and domain guidance, replacing native workflow contracts',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'lingflow-skills-'));
  try {
    const root=path.join(dir,'skills');
    for(const name of ['implement','to-spec','tdd','hive-ultra-spec']){
      mkdirSync(path.join(root,name),{recursive:true});
      writeFileSync(path.join(root,name,'SKILL.md'),'---\nname: '+name+'\ndescription: "Original skill"\ndisable-model-invocation: true\n---\n\nDomain knowledge stays. In Hive, full verifies behavior. An authorized Hive execution contract.\n');
    }
    const original=readFileSync(path.join(root,'to-spec/SKILL.md'),'utf8');
    const plan=planGlobalSkills([root]);
    assert.equal(readFileSync(path.join(root,'to-spec/SKILL.md'),'utf8'),original);
    const spec=plan.find(p=>p.file===path.join(root,'to-spec/SKILL.md')).content;
    assert.match(spec,/name: to-spec/);assert.match(spec,/disable-model-invocation: true/);
    assert.doesNotMatch(spec,/Hive|lingflow-to-tickets/);assert.match(spec,/LingFlow/);
    const tdd=plan.find(p=>p.file===path.join(root,'tdd/SKILL.md')).content;
    assert.match(tdd,/Domain knowledge stays/);assert.match(tdd,/LingFlow frozen verification contract/);
    const alias=plan.find(p=>p.file===path.join(root,'hive-ultra-spec/SKILL.md')).content;
    assert.match(alias,/\.\.\/to-spec\/SKILL.md/);assert.match(alias,/不减免/);
    const runtime=plan.find(p=>p.file.endsWith('harness-runtime.md')).content;
    for(const value of ['dispatchPlan','operationId','environment-failed','decision.testReview','立即结束回合'])assert.ok(runtime.includes(value));
    assert.ok(plan.some(p=>p.file===path.join(root,'controller/SKILL.md')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('Windows apply requires a fresh verified ZIP and never overwrites a prior backup',{skip:process.platform!=='win32'},()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'lingflow-skills-zip-'));
  try {
    const roots=['codex','dsh'].map(name=>path.join(dir,name));
    for(const root of roots){mkdirSync(path.join(root,'implement'),{recursive:true});writeFileSync(path.join(root,'implement/SKILL.md'),'---\nname: implement\ndescription: original\n---\n\nOriginal payload\n');}
    const zip=path.join(dir,'backup.zip'),script=path.join(project,'scripts/adapt-global-skills.mjs');
    const args=[script,'--codex-root',roots[0],'--dsh-root',roots[1],'--backup-zip',zip,'--apply'];
    const run=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,run.stderr);assert.ok(existsSync(zip));
    assert.equal(JSON.parse(run.stdout).backup.files,2);
    assert.match(readFileSync(path.join(roots[0],'implement/SKILL.md'),'utf8'),/LingFlow/);
    assert.match(readFileSync(path.join(roots[1],'implement/SKILL.md'),'utf8'),/Original payload/);
    const before=readFileSync(zip);
    const repeat=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});
    assert.notEqual(repeat.status,0);assert.deepEqual(readFileSync(zip),before);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
