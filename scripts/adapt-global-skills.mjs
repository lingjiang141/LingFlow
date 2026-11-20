import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const project = fileURLToPath(new URL('../', import.meta.url));
const core = new Set(['to-spec','to-tickets','to-planned-attempts','implement','implement-spec','code-review','handoff','controller']);
const hook = '本技能默认适配 LingFlow。先读[运行约定](../implement/references/harness-runtime.md)，按当前角色与冻结原票执行。';
const runtime = `# LingFlow 全局技能运行约定

默认工作流是 LingFlow。保留 /to-spec、/to-tickets、/to-planned-attempts 的旧调用名，内部依次读取同级技能即可，无需用户重复输入命令。

- 主控先用 lingflow_team context 恢复职责、guide 查询真实签名。从用户确认范围形成规格、票据和预定路线，经 approve 与 previewPlan 后用 dispatchPlan 登记；保持稳定 operationId，超时查 operation。
- 规划是待绑定路线，不是实施授权或完成证据。票面写明验收、真实读写、testWrites、inputs、共享资源及必要前置。已派原票按冻结版本执行，调整由主控沿原票登记。
- 写入票先在实现保持基线时取得真实断言失败，再执行同一冻结绿检查和完整检查。空跑、启动失败、依赖问题不充当红证据；environment-failed 沿同 checkId 修环境后重试。测试文件也是交付物时按冻结契约允许的测试先行路径执行。
- report/review 引用真实 checkIds、候选及 requirements/implementation/system 三维证据。高风险由独立审查者处理；免审票由主控执行冻结的独立验收。summarize 的 decision.testReview 在报告有测试变更时须为非空字符串，描述断言与覆盖核对。
- 交付、送达、检查通过、技术收口与用户验收分别核对。以真实回执为证据，不以口头自报替代验收。
- 有独立可执行责任就处理；无可执行事项立即结束回合，等 LingFlow 回投，不为等结果轮询、休眠或另建代等代理。仅处理原生团队责任；技能不自行创建宿主子代理、集成分支或合并流水线。
- 冲突先停写并 yieldForSchedule，再由主控 reviseSchedule；静默恢复与废票处理先 diagnoseTask，再按 guide 使用 resumeTask/supersede 等实际命令，保留历史和归属验证。
- 工具嵌套负载放 args（JSON 字符串或对象），写操作带稳定 operationId。参数以当前 guide/schema 为准，不编造字段。Codex 当前会话没有 LingFlow 工具时，可完成规划与只读核对，派发和入库交给已绑定的 DSH 主控；不用旧工作流命令替代。
- Git、试验隔离和外部发布依用户及项目授权执行，主控不能把规划、角色身份或技能当作额外授权。
`;
const checks = `# LingFlow 三维证据与问题处理

一次核对覆盖 requirements（原 AC 与目标）、implementation（实际差异、输入输出和状态）、system（直接回归、共享资源与并发）。使用 checkEvidence 读取程序回执；report/review 按 guide 填写各维结论、证据与真实 checkIds。

先区分 contract-invalid、environment-failed、evidence-missing 和可复现的 quality-failed。环境失败不算票面证据，证据缺失先补证据，真实反例写明触发、位置和影响。既有测试变更说明 testReview，不能削弱断言绕过验收。

阻塞沿原票 question 或 review 反馈，非阻塞与已接受缺陷引用项目已有记录。用户接受已知影响不等于修好，不覆盖原 AC 或冻结门槛。主控用 summarize 登记试用步骤，业务验收由用户作出。
`;
function hash(s) { return createHash('sha256').update(s).digest('hex'); }
function split(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) throw Error('Missing skill frontmatter');
  return { header: m[1].replaceAll('\r',''), body: text.slice(m[0].length).trim() };
}
function description(header) {
  const value = /^description:\s*(.*)$/m.exec(header)?.[1] ?? '';
  if (value.startsWith('"')) return JSON.parse(value);
  return value.replace(/^'|'$/g,'');
}
export function planGlobalSkills(roots, canonical = path.join(project,'skills')) {
  const plan = [];
  const put = (file, content) => {
    const before = existsSync(file) ? readFileSync(file) : null;
    const after = content.endsWith('\n') ? content : content+'\n';
    if (before?.toString('utf8') !== after) plan.push({file,before:before===null?null:hash(before),content:after});
  };
  for (const root of roots) {
    if (!existsSync(path.join(root,'implement/SKILL.md'))) throw Error('Not an installed engineering skills root: '+root);
    const names = readdirSync(canonical).filter(n=>n.startsWith('lingflow-')).map(n=>n.slice(9));
    for (const name of names) {
      const dest=path.join(root,name,'SKILL.md');
      if (!existsSync(dest) && name!=='controller') continue;
      const source=split(readFileSync(path.join(canonical,'lingflow-'+name,'SKILL.md'),'utf8'));
      const original=existsSync(dest)?split(readFileSync(dest,'utf8')):source;
      let header=original.header.replace(/^name:.*$/m,'name: '+name);
      header=header.replace(/^description:.*$/m,'description: '+JSON.stringify('LingFlow: '+(core.has(name)?description(source.header):description(original.header).replace(/^LingFlow: /,''))));
      let body;
      if(core.has(name)) {
        body=source.body.replaceAll('../lingflow-','../');
        if(name==='code-review') body+='\n\n没有绑定 LingFlow 原票的独立审查，按用户指定 Git 基点与有效规格只读核对同样三维，报告事实与未验证项；不伪造任务、候选或工具回执。';
        if(name==='to-spec' && existsSync(path.join(root,name,'references/full-spec.md'))) body+='\n\n需要详细结构时读取 [完整规格模板](references/full-spec.md) 或 [差异规格模板](references/diff-spec.md)，沿用已有有效规格及批准差异。';
      } else {
        body=original.body.replace(/^在 Hive 团队内使用时，先读[^\n]*\n*/m,'').replace(hook+'\n\n','');
        body=hook+'\n\n'+body;
        if(name==='tdd') body=body.replaceAll('In Hive, full','In LingFlow, full').replaceAll('authorized Hive execution contract','authorized LingFlow frozen verification contract');
      }
      put(dest,'---\n'+header+'\n---\n\n'+body+'\n');
      const ui=path.join(root,name,'agents/openai.yaml');
      if(existsSync(ui)) {
        let text=readFileSync(ui,'utf8').replace(/^(\s*display_name:)\s*"?(.*?)"?\r?$/m,(_,key,v)=>key+' '+JSON.stringify('LingFlow · '+v.replace(/^LingFlow · /,'')));
        if(core.has(name)) text=text.replace(/^(\s*short_description:).*$/m,(_,key)=>key+' '+JSON.stringify('LingFlow workflow: '+name));
        if(/\bHive\b/.test(text)) text=text.replace(/^(\s*default_prompt:).*$/m,(_,key)=>key+' '+JSON.stringify('Use $'+name+' with the LingFlow workflow.'));
        put(ui,text);
      }
    }
    put(path.join(root,'implement/references/harness-runtime.md'),runtime);
    put(path.join(root,'implement/references/lingflow-delivery.md'),runtime);
    put(path.join(root,'implement/references/hive-delivery.md'),'# 旧引用兼容入口\n\n当前执行规则在 [LingFlow 运行约定](lingflow-delivery.md)，沿原票与真实 guide 执行。');
    put(path.join(root,'implement/references/review-checks.md'),checks);
    for (const [alias,target] of Object.entries({'hive-ultra-grill':'grilling','hive-ultra-spec':'to-spec','hive-ultra-tickets':'to-tickets','hive-ultra-planned-attempts':'to-planned-attempts'})) {
      const file=path.join(root,alias,'SKILL.md');if(!existsSync(file))continue;
      const original=split(readFileSync(file,'utf8'));
      const header=original.header.replace(/^description:.*$/m,'description: '+JSON.stringify('LingFlow 旧名称兼容入口，使用 '+target+' 的统一流程。'));
      put(file,'---\n'+header+'\n---\n\n# 兼容旧调用名\n\n读取 ['+target+'](../'+target+'/SKILL.md) 完成本次工作。此入口不定义额外模式，不减免原票冻结的红绿、完整检查或独立验收。');
      const ref=path.join(root,alias,'references/ultra-planning.md');if(existsSync(ref))put(ref,runtime);
    }
  }
  return plan;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
  const roots=[args.includes('--codex-root')?value('--codex-root'):path.join(os.homedir(),'.codex/skills'),args.includes('--dsh-root')?value('--dsh-root'):path.join(os.homedir(),'.dsh/skills')].map(p=>path.resolve(p));
  const plan=planGlobalSkills([roots[0]]);
  if(!args.includes('--apply')) console.log(JSON.stringify({state:'preview',roots,changedFiles:plan.length,files:plan.map(p=>p.file)},null,2));
  else {
    if(process.platform!=='win32')throw Error('Verified ZIP backup requires Windows.');
    const archive=args.includes('--backup-zip')?value('--backup-zip'):null;
    if(!archive||!path.isAbsolute(archive))throw Error('--backup-zip requires a new absolute ZIP path.');
    for(const root of roots) {const rel=path.relative(root,archive);if(!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel))throw Error('Backup must be outside skills roots.');}
    const backupEnv={...process.env};delete backupEnv.PSModulePath;
    const backup=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/backup-global-skills.ps1'),'-CodexRoot',roots[0],'-DshRoot',roots[1],'-Archive',archive],{encoding:'utf8',windowsHide:true,env:backupEnv});
    if(backup.status!==0)throw Error('Backup failed; no skills changed. '+backup.stderr);
    for(const item of plan) if((existsSync(item.file)?hash(readFileSync(item.file)):null)!==item.before)throw Error('Concurrent skill edit; no skills changed: '+item.file);
    for(const item of plan) {mkdirSync(path.dirname(item.file),{recursive:true});writeFileSync(item.file,item.content,'utf8');}
    for(const item of plan)if(hash(readFileSync(item.file))!==hash(item.content))throw Error('Installation mismatch: '+item.file);
    console.log(JSON.stringify({state:'applied',backup:JSON.parse(backup.stdout.trim()),roots,changedFiles:plan.length,verified:true},null,2));
  }
}
