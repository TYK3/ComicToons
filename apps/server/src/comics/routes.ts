import {directorGuard} from '../director-access.ts';
import type {FastifyPluginAsync,onRequestHookHandler} from 'fastify';
import type {EventBus, ComicToonsBusEvents,ComicPanel} from '@comictoons/core';
import {buildBook,buildSeries} from '../../../../packages/core/src/manga.ts';
import {readEditionTitle,writeEditionTitle} from '../recaps.ts';
import type {Studio} from '../studio.ts';
export interface RouteContext { studio:Studio; eventBus:EventBus<ComicToonsBusEvents>; directorKey?:string; sse?:Partial<SseLimits>;guard?:onRequestHookHandler }
/** MEM-1a #1: per-client SSE write limits. Under `softBytes` queued a frame is written; above it one-off frames
 * (events, heartbeats) are skipped and only the newest state is held for 'drain'. A client is dropped when its
 * queue passes `hardBytes` or it has not drained for `stallMs`; its EventSource reconnects and gets full state. */
export interface SseLimits {softBytes:number;hardBytes:number;stallMs:number}
export const DEFAULT_SSE_LIMITS:SseLimits={softBytes:1024*1024,hardBytes:4*1024*1024,stallMs:30_000};
type SseResponse=Pick<import('node:http').ServerResponse,'write'|'destroy'|'on'|'writableLength'|'destroyed'|'writableEnded'>;
export function sseWriter(res:SseResponse,limits:Partial<SseLimits>={},now:()=>number=Date.now){
  const cap={...DEFAULT_SSE_LIMITS,...limits};
  let held:string|undefined;let behindSince:number|undefined;let skipped=0;
  const open=()=>!res.destroyed&&!res.writableEnded;
  const alive=()=>{
    if(!open())return false;
    if(res.writableLength>cap.hardBytes||(behindSince!==undefined&&now()-behindSince>=cap.stallMs)){held=undefined;res.destroy();return false;}
    return true;
  };
  const behind=()=>res.writableLength>cap.softBytes;
  const write=(frame:string)=>{if(!res.write(frame)&&behindSince===undefined)behindSince=now();alive();};
  res.on('drain',()=>{behindSince=undefined;if(held!==undefined&&open()&&!behind()){const frame=held;held=undefined;write(frame);}});
  return {
    /** Latest-wins frame (the full state): a newer one replaces any held one. */
    latest(frame:string){if(!alive())return;if(behind()){held=frame;skipped++;return;}held=undefined;write(frame);},
    /** One-off frame (bus events, heartbeats): skipped while the client is behind. */
    event(frame:string){if(!alive())return;if(behind()){skipped++;return;}write(frame);},
    get skipped(){return skipped;},
  };
}
export interface CatchupRequest {minutes?:number;reason?:'manual'|'command'|'raid';raider?:string;viewers?:number}
export function buildCatchup(panels:ComicPanel[],elapsed:number,channel:string,request:CatchupRequest={}){
  const minutes=request.minutes??20;
  const recent=panels.filter(p=>(p.at??0)>=elapsed-minutes*60&&(p.at??0)<=elapsed);
  const score=(p:ComicPanel)=>(/clutch|victor|comeback|saved|finish/i.test(p.caption)?10:0)+(p.voters??0);
  const chosen=[...recent].sort((a,b)=>score(b)-score(a)||(a.at??0)-(b.at??0)).slice(0,3).sort((a,b)=>(a.at??0)-(b.at??0));
  return {channel,minutes,panels:chosen,panelCount:chosen.length,approvedCount:recent.length,sample:chosen.some(p=>p.origin==='sample'),raidLine:request.reason==='raid'&&request.raider?`${request.raider} raided with ${request.viewers??0} viewers! Here’s what you missed.`:undefined};
}
// One summary for /api/catchup, /api/comics/events and the shared /api/events stream.
export function studioCatchup(studio:Studio,request:CatchupRequest={}){
  return buildCatchup(studio.state.panels.map(p=>({...p,origin:p.origin??(studio.state.fixtureId==='twitch'?'twitch':'sample')})),studio.state.elapsed,studio.state.source?.channel||studio.state.streamTitle,request);
}
export function catchupFromBus(studio:Studio,payload:unknown){
  const request=(payload??{}) as CatchupRequest;const minutes=request.minutes??20;
  if(!Number.isInteger(minutes)||minutes<1||minutes>1440)return undefined;
  return studioCatchup(studio,request);
}
export const comicsRoutes:FastifyPluginAsync<RouteContext> = async (app,{studio,eventBus,directorKey,sse,guard:providedGuard}) => {
  const guard=providedGuard??directorGuard(directorKey);
  const clients=new Map<import('node:http').ServerResponse,ReturnType<typeof sseWriter>>();
  const summary=(request:CatchupRequest)=>studioCatchup(studio,request);
  const unsubscribe=eventBus.on('catchup',payload=>{const data=catchupFromBus(studio,payload);if(!data)return;const frame=`event: catchup\ndata: ${JSON.stringify(data)}\n\n`;for(const writer of clients.values())writer.event(frame);});
  // Close HTTP streams before Fastify waits for active requests on shutdown.
  app.addHook('preClose',async()=>{for(const client of clients.keys())client.end();});
  const timers=new Set<ReturnType<typeof setInterval>>();
  app.addHook('onClose',async()=>{unsubscribe();for(const timer of timers)clearInterval(timer);for(const client of clients.keys())client.end();clients.clear();});
  app.get('/api/comics/status',async()=>({panels:studio.state.panels.length}));
  const properties={minutes:{type:'integer',minimum:1,maximum:1440},reason:{type:'string',enum:['manual','command','raid']},raider:{type:'string',pattern:'^[a-zA-Z0-9_]{1,25}$'},viewers:{type:'integer',minimum:0,maximum:10000000}};
  app.get('/api/catchup',{schema:{querystring:{type:'object',additionalProperties:false,properties:{minutes:properties.minutes}}}},async req=>summary(req.query as CatchupRequest));
  app.post('/api/catchup',{onRequest:guard,schema:{body:{type:'object',additionalProperties:false,properties}}},async req=>{const request=req.body as CatchupRequest;eventBus.emit('catchup',request);return summary(request);});
  app.get('/api/comics/events',async(req,reply)=>{reply.hijack();const res=reply.raw;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});const writer=sseWriter(res,sse);writer.event(': connected\n\n');clients.set(res,writer);const timer=setInterval(()=>writer.event(': heartbeat\n\n'),15000);timer.unref();timers.add(timer);req.raw.on('close',()=>{clearInterval(timer);timers.delete(timer);clients.delete(res);res.end();});});
  app.post('/api/comics/:id/title',{onRequest:guard,schema:{params:{type:'object',properties:{id:{type:'string',pattern:'^[a-z0-9-]+$'}},required:['id']},body:{type:'object',additionalProperties:false,properties:{title:{type:'string',minLength:1,maxLength:160}},required:['title']}}},async(req,reply)=>{const {id}=req.params as {id:string};const response=await app.inject({url:`/api/recaps/${id}`});if(response.statusCode!==200)return reply.code(response.statusCode).send(response.json());await writeEditionTitle(id,(req.body as {title:string}).title);return {saved:true};});
  // Read through the existing recap route so custom RecapStore directories and
  // immutable saved snapshots stay authoritative without a frozen app seam edit.
  for(const mode of ['book','series'] as const)app.get(`/api/${mode}/:id`,async(req,reply)=>{const {id}=req.params as {id:string};if(!/^[a-z0-9-]+$/.test(id))return reply.code(400).send({error:'Invalid issue address.'});const response=await app.inject({url:`/api/recaps/${id}`});if(response.statusCode!==200)return reply.code(response.statusCode).send(response.json());const snapshot=response.json();snapshot.panels=snapshot.panels.map((p:ComicPanel)=>({...p,origin:p.origin??(snapshot.fixtureId==='twitch'?'twitch':'sample')}));const title=await readEditionTitle(id)||snapshot.issueTitle||snapshot.streamTitle;return {...(mode==='book'?buildBook(snapshot.panels,{title}):buildSeries(snapshot.panels,{title})),id,sample:snapshot.panels.some((p:ComicPanel)=>p.origin==='sample')};});
};
