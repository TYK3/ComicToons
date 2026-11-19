import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';

let files;
try{
  files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean);
}catch{
  // Source archives have no git index. Ignore generated output and dependency trees.
  const ignored=new Set(['.git','node_modules','artifacts','exports','dist','test-results','playwright-report']);
  const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    if(ignored.has(entry.name)||entry.isSymbolicLink())return [];
    const path=join(dir,entry.name);
    return entry.isDirectory()?walk(path):entry.isFile()?[path]:[];
  });
  files=walk('.');
}
const patterns=[/sk-[A-Za-z0-9_-]{32,}/,/AKIA[0-9A-Z]{16}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const bad=files.filter(f=>existsSync(f)&&lstatSync(f).isFile()&&!/\.(?:png|woff2?)$/i.test(f)&&patterns.some(p=>p.test(readFileSync(f,'utf8'))));
if(bad.length){console.error('Possible secrets:',bad);process.exit(1);}console.log('Secret scan passed');
