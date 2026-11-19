import {execFileSync} from 'node:child_process';
import {readFile,readdir,stat,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {loadEnv} from '../apps/server/src/env.ts';
loadEnv();
const root=process.cwd();
const secrets=Object.entries(process.env).filter(([name,value])=>/(?:API_KEY|API_TOKEN|CLIENT_SECRET|BOT_TOKEN)(?:_\d+)?$/.test(name)&&value&&value.length>=12);
try{const privateStream=JSON.parse(await readFile(resolve('artifacts/tmp/qa-broadcast/private-stream.json'),'utf8')) as {streamKey?:string};if(privateStream.streamKey&&privateStream.streamKey.length>=12)secrets.push(['QA_STREAM_KEY',privateStream.streamKey]);}catch{/* Optional local broadcast setup; never print its value. */}
const candidates=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
async function walk(path:string):Promise<string[]>{try{const entries=await readdir(path,{withFileTypes:true});return (await Promise.all(entries.filter(e=>!e.isSymbolicLink()).map(e=>e.isDirectory()?walk(resolve(path,e.name)):Promise.resolve([relative(root,resolve(path,e.name))])))).flat();}catch{return [];}}
const files=[...new Set([...candidates,...await walk(resolve('apps/web/dist'))])];const findings:{file:string;variable:string}[]=[];let checked=0;
for(const file of files){const path=resolve(file);try{if(!(await stat(path)).isFile())continue;const bytes=await readFile(path);checked++;for(const [variable,value] of secrets)if(bytes.includes(Buffer.from(value!)))findings.push({file,variable});}catch{/* deleted tracked files */}}
await mkdir('artifacts/qa/own-stream',{recursive:true});await writeFile('artifacts/qa/own-stream/public-secret-scan.json',JSON.stringify({at:new Date().toISOString(),checkedFiles:checked,configuredSecretCount:secrets.length,findings},null,2));
console.log(JSON.stringify({checkedFiles:checked,configuredSecretCount:secrets.length,findings}));if(findings.length)process.exitCode=1;
