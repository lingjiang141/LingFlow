import { coversPath } from './files.mjs';
import { normalizeBrowserArgv } from './verification-policy.mjs';
import path from 'node:path';

const developerStages=new Set(['red','green','full','regression']);
function signature(argv) {
  const args=normalizeBrowserArgv(argv).map(value=>String(value).trim().replaceAll('\\','/'));
  const program=args[0].split('/').at(-1).replace(/\.(exe|cmd)$/i,'').toLowerCase();
  const rest=args.slice(1).filter(arg=>!['--no-warnings','--trace-warnings','--enable-source-maps'].includes(arg));
  if(program==='node'&&rest[0]&&!rest[0].startsWith('-'))rest[0]=path.posix.normalize(rest[0]);
  // node -e programs are distinct probes; reject process wrappers separately.
  // File runners retain their principal argument, so appending flags cannot
  // disguise the same developer entry point as an independent probe.
  return JSON.stringify([program,...rest.slice(0,program==='npm'||['-e','--eval','-p','--print'].includes(rest[0])?2:1)]);
}
export function probeSeparationIssues(checks) {
  const issues=[];
  for(const probe of checks.filter(check=>['independent','controller'].includes(check.stage))) {
    const duplicate=checks.find(check=>developerStages.has(check.stage)&&signature(check.argv)===signature(probe.argv));
    const replica=checks.find(check=>check.stage==='full'&&check.inputs.length>0&&
      check.inputs.every(file=>coversPath(probe.inputs,file))&&check.covers.every(ac=>probe.covers.includes(ac)));
    if(duplicate||replica)issues.push({checkId:probe.id,developerCheckId:(duplicate??replica).id,
      field:duplicate?'argv':'inputs',message:'主控探针不得复用开发检查的命令或覆盖完整 full 输入及 covers；该验证属于开发 full/regression，请回投原票而不是用收口探针重跑。'});
  }
  return issues;
}
