import {mkdtemp,mkdir,cp,rm} from 'node:fs/promises';
import {statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const npmCli=process.env.npm_execpath;
if(!npmCli)throw new Error('npm_execpath is missing; run this check via npm run fresh-clone.');
if(!isAbsolute(npmCli)||!statSync(npmCli).isFile())throw new Error('npm_execpath must be an absolute existing npm CLI file.');
const temp=await mkdtemp(join(tmpdir(),'comictoons-clean-'));
try {
  await mkdir(join(temp,'artifacts','tmp'),{recursive:true});
  for(const file of ['package.json','package-lock.json','tsconfig.json','apps','packages','fixtures'])await cp(file,join(temp,file),{recursive:true,filter:source=>!source.split('/').some(part=>['node_modules','dist'].includes(part))});
  execFileSync(process.execPath,[npmCli,'ci','--offline','--ignore-scripts','--no-audit'],{cwd:temp,stdio:'inherit'});
  execFileSync(process.execPath,[npmCli,'run','build'],{cwd:temp,stdio:'inherit'});
  console.log('Clean-directory lockfile installation and build passed.');
} finally { await rm(temp,{recursive:true,force:true}); }
