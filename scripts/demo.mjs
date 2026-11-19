import {spawnNpm} from './demo-spawn.mjs';
import {resolveDemoPorts} from './demo-ports.mjs';
const {apiPort,webPort}=resolveDemoPorts();
console.log(`ComicToons keyless demo → http://localhost:${webPort}/`);
const children=[];
function launch(workspace,env=process.env){const child=spawnNpm(['run','dev','-w',workspace],{stdio:'inherit',env});children.push(child);child.on('exit',code=>{for(const other of children)if(other!==child)other.kill();process.exit(code??0);});return child;}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const child of children)child.kill(signal);});
launch('@comictoons/server');
let ready=false;
for(let attempt=0;attempt<100;attempt++){try{const result=await fetch(`http://127.0.0.1:${apiPort}/api/state`);if(result.ok){ready=true;break;}}catch{/* Server is still starting. */}await new Promise(resolve=>setTimeout(resolve,100));}
if(!ready){console.error('Server did not start within 10 seconds.');for(const child of children)child.kill();process.exit(1);}
launch('@comictoons/web',{...process.env,COMICTOONS_OPEN:'1'});
