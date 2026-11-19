import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import type {FastifyInstance} from 'fastify';

const root=resolve(import.meta.dirname,'../../..');
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.ico':'image/x-icon'};
async function asset(directory:string,path:string){
  const decoded=decodeURIComponent(path);if(decoded.split(/[\\/]/).some(part=>part.startsWith('.')))throw new Error('Not a public asset.');
  const target=resolve(directory,decoded.replace(/^[/\\]+/,''));if(!target.startsWith(directory+sep)||!mime[extname(target)])throw new Error('Not a public asset.');
  return {bytes:await readFile(target),type:mime[extname(target)]!};
}
export function installWebAssets(app:FastifyInstance,env:Record<string,string|undefined>=process.env){
  // Serve local QA references through the API in development as well as the built app.
  app.get('/qa/*',async(req,reply)=>{try{const file=await asset(resolve(root,'apps/web/public'),new URL(req.url,'http://localhost').pathname);return reply.header('Cache-Control','no-store').type(file.type).send(file.bytes);}catch{return reply.code(404).send({error:'QA asset not found.'});}});
  if(env.COMICTOONS_SERVE_WEB!=='1')return;
  app.get('/*',async(req,reply)=>{try{let path=new URL(req.url,'http://localhost').pathname;if(path==='/')path='/index.html';const file=await asset(resolve(root,'apps/web/dist'),path);return reply.type(file.type).send(file.bytes);}catch{return reply.code(404).send({error:'Page not found.'});}});
}
