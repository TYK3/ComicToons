import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {FastifyInstance,FastifyRequest,onRequestHookHandler} from 'fastify';
import type {ScenePage,WatchSnapshot,WatchRole} from '@comictoons/core';
import {SceneSessions,type SceneOptions} from './sessions.ts';
import {imageMime} from './providers.ts';
const COOKIE='comictoons_watch';
const present=(state:WatchSnapshot):WatchSnapshot=>({...state,id:createHash('sha256').update(state.id).digest('hex').slice(0,16)});
export function sceneCookie(req:Pick<FastifyRequest,'headers'>){const value=req.headers.cookie?.split(';').map(c=>c.trim()).find(c=>c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);return value&&/^[a-f0-9-]{36}$/.test(value)?value:undefined;}
export function installSceneRoutes(app:FastifyInstance,options:SceneOptions&{guard:onRequestHookHandler;owner:()=>string|undefined;onStart?:(channel:string)=>void;onReadyPage?:(page:ScenePage,state:WatchSnapshot,url:string)=>void}){
  const publicDirectory=resolve(options.directory??resolve(import.meta.dirname,'../../../../artifacts/live-scenes'),'published');
  const published=new Map<string,ScenePage>();
  const sessions=new SceneSessions({...options,onPage:async(page,state,image)=>{
    if(state.role!=='streamer')return;
    const session=sessions.get(state.id);if(!session)return;
    await mkdir(publicDirectory,{recursive:true});await writeFile(resolve(publicDirectory,page.id),image);published.set(page.id,page);
    options.onReadyPage?.(page,state,`/art/scenes/${page.id}${page.imageFile?`?v=${page.imageFile.split('.')[0]}`:''}`);
  }});
  const current=(req:FastifyRequest)=>{const s=sessions.get(sceneCookie(req));if(!s)throw new Error('Choose Streamer or Viewer to open a session.');return s;};
  app.addHook('onRequest',async(req,reply)=>{
    const s=sessions.get(sceneCookie(req));if(!s)return;
    const path=new URL(req.url,'http://localhost').pathname.toLowerCase();
    if(s.snapshot.role==='viewer'&&path.startsWith('/api/')&&!path.startsWith('/api/watch/')&&path!=='/api/watch')return reply.code(403).send({error:'Viewer sessions cannot access broadcaster data or controls.'});
  });
  app.post('/api/watch/session',{onRequest:options.guard,schema:{body:{type:'object',additionalProperties:false,required:['role'],properties:{role:{enum:['streamer','viewer']}}}}},async(req,reply)=>{
    const old=sessions.get(sceneCookie(req));const role=(req.body as {role:WatchRole}).role;
    if(old&&old.snapshot.role===role)return present(sessions.snapshot(old));
    if(old)await sessions.stop(old.snapshot.id);
    const state=sessions.create(role);reply.header('Set-Cookie',`${COOKIE}=${state.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);return present(state);
  });
  app.get('/api/watch',async(req,reply)=>{const id=sceneCookie(req),s=sessions.get(id);if(!s)return reply.code(404).send({error:'No viewing session is open.'});return reply.header('Cache-Control','no-store').header('Set-Cookie',`${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`).send(present(sessions.snapshot(s)));});
  app.post('/api/watch/generator',{onRequest:options.guard,schema:{body:{type:'object',additionalProperties:false,properties:{provider:{enum:['openai','gemini','pollinations','cloudflare','source']},model:{type:'string',maxLength:80},key:{type:'string',minLength:12,maxLength:512},accountId:{type:'string',pattern:'^[a-fA-F0-9]{32}$'},useDefault:{type:'boolean'},maxPages:{type:'integer',minimum:1,maximum:5}}}}},async req=>present(sessions.configure(current(req),req.body as Parameters<SceneSessions['configure']>[1])));
  app.post('/api/watch/generator/check',{onRequest:options.guard},async req=>present(await sessions.check(current(req))));
  app.post('/api/watch/start',{onRequest:options.guard,schema:{body:{type:'object',additionalProperties:false,required:['channel'],properties:{channel:{type:'string',pattern:'^[a-z0-9_]{1,25}$'},duration:{type:'integer',minimum:60,maximum:600},palette:{enum:['festival','sunset','lagoon','blossom']}}}}},async(req,reply)=>{
    const s=current(req),body=req.body as {channel:string;duration?:number;palette?:string};
    if(s.snapshot.role==='streamer'&&body.channel!==options.owner())return reply.code(403).send({error:'Streamer capture requires your own connected Twitch channel. Use Viewer for someone else’s stream.'});
    if(s.snapshot.role==='streamer')options.onStart?.(body.channel);
    return present(await sessions.start(s,body.channel,body.duration,body.palette));
  });
  app.addHook('preValidation',async(req,reply)=>{const s=sessions.get(sceneCookie(req));if(s?.snapshot.role==='streamer'&&req.method==='POST'&&req.url.split('?')[0]==='/api/ingest'){const body=req.body as {mode?:string;channel?:string;chatOnly?:boolean}|undefined;if(body?.mode==='twitch'&&body.chatOnly!==true&&(!options.owner()||body.channel&&body.channel!==options.owner()))return reply.code(403).send({error:'Streamer mode can read only your own connected channel. Choose Viewer for other streams.'});}});
  app.post('/api/watch/stop',{onRequest:options.guard},async req=>{const s=current(req);await sessions.stop(s.snapshot.id);return present(sessions.snapshot(s));});
  app.post('/api/watch/generator/preview',{onRequest:options.guard,schema:{body:{type:'object',additionalProperties:false,properties:{palette:{enum:['festival','sunset','lagoon','blossom']}}}}},async req=>{const s=current(req);await sessions.generate(s,(req.body as {palette?:string}|undefined)?.palette);return present(sessions.snapshot(s));});
  app.get('/api/watch/files/:file',async(req,reply)=>{try{const image=await sessions.file(current(req),(req.params as {file:string}).file);return reply.header('Cache-Control','no-store').type(imageMime(image)??'application/octet-stream').send(image);}catch{return reply.code(404).send({error:'File not found in this session.'});}});
  app.get('/api/watch/report',async(req,reply)=>{const state=present(sessions.snapshot(current(req)));reply.header('Cache-Control','no-store');return {...state,chat:state.chat.map(line=>({id:line.id,capturedAt:line.capturedAt,text:line.text})),qa:{session:'Real source capture; inspect playback events and timestamps',audio:'No speech transcription; chat is attributed separately',image:'Only images passing automatic source/face/lettering review appear',role:state.role==='viewer'?'No broadcaster controls exposed':'Owner-only capture; pages wait in Studio review'},reportId:randomUUID()};});
  app.get('/art/scenes/:id',async(req,reply)=>{const id=(req.params as {id:string}).id;if(!/^[a-f0-9-]{36}$/.test(id)||published.get(id)?.status!=='ready')return reply.code(404).send({error:'Image not found.'});try{const image=await readFile(resolve(publicDirectory,id));return reply.type(imageMime(image)??'application/octet-stream').send(image);}catch{return reply.code(404).send({error:'Image not found.'});}});
  app.addHook('onClose',async()=>sessions.close());return sessions;
}
