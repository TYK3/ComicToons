import { readProductEnv } from '../../packages/core/src/env.mjs';
import { defineConfig,type ViteDevServer,type PreviewServer } from 'vite';
import {classicEntryUrl} from './entries';
import {fileURLToPath} from 'node:url';
const webPort=Number(readProductEnv('COMICTOONS_WEB_PORT') ?? '4173');
const apiPort=Number(readProductEnv('COMICTOONS_API_PORT') ?? '3001');
for (const [name, port] of [['COMICTOONS_WEB_PORT', webPort], ['COMICTOONS_API_PORT', apiPort]] as const) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
}
const classicEntry=(server:ViteDevServer|PreviewServer)=>{server.middlewares.use((req,_res,next)=>{if(req.url){try{const path=decodeURIComponent(req.url.split('?')[0]!).replace(/\\/g,'/');const qa=/^(?:\/qa\/|.*\/apps\/web\/public\/qa\/)(.*)$/.exec(path);if(qa)req.url=`/qa/${qa[1]}`;}catch{/* Vite handles malformed addresses. */}}const url=req.url&&classicEntryUrl(req.url);if(url)req.url=url;next();});};
const apiTarget=`http://127.0.0.1:${apiPort}`;
export default defineConfig({plugins:[{name:'classic-entry',configureServer:classicEntry,configurePreviewServer:classicEntry}],build:{rollupOptions:{input:{classic:fileURLToPath(new URL('./classic.html',import.meta.url)),main:fileURLToPath(new URL('./index.html',import.meta.url)),ui:fileURLToPath(new URL('./ui.html',import.meta.url))}}},server:{host:readProductEnv('COMICTOONS_WEB_EXPOSE')==='1'?'0.0.0.0':'127.0.0.1',port:webPort,strictPort:true,open:readProductEnv('COMICTOONS_OPEN') !== '0' && !process.env.CI ? '/' : false,proxy:{'/qa':{target:apiTarget,xfwd:true},'/auth':{target:apiTarget,xfwd:true},'/api':{target:apiTarget,xfwd:true},'/exports':{target:apiTarget,xfwd:true},'/art':{target:apiTarget,xfwd:true}}}});
