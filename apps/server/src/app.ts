import {withAnonymousFallback,anonymousChatEnabled,ircTransportFor,type IrcTransportFactory} from './ingest/irc.ts';
import {createHelixClient,createSignedInHelix,type HelixClientOptions} from './twitch-api/index.ts';
import {twitchEndpoints} from './env.ts';
import {randomUUID} from 'node:crypto';
import type {TwitchAuthProvider} from './eventsub/types.ts';
import {authenticatedIrcFactory} from './ingest/source.ts';
import {createAppTokenAuth,createClipWatch} from './ingest/clips.ts';
import type {FastifyServerOptions} from 'fastify';
import {TwitchTokenStore,type TokenStoreOptions} from './twitch/token-store.ts';
import {directorAccess,directorGuard,readDirectorKey} from './director-access.ts';
import Fastify from 'fastify';
import {fixtures,eventBus} from '@comictoons/core';
import {writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {Studio} from './studio.ts';
import type {MomentConfig} from './pipeline/moments.ts';
import {renderExport} from './export.ts';
import type {MangaTheme} from '@comictoons/core';
import type {AdapterFactory} from './ingest/irc.ts';
import {RecapStore,recapSignature,chooseLook} from './recaps.ts';
import {twitchRoutes} from './twitch/routes.ts';
import {catchupFromBus,comicsRoutes,sseWriter,type SseLimits} from './comics/routes.ts';
import {participationRoutes,createMockHelix,type ParticipationPluginOptions} from './participation/routes.ts';
import {importRoutes} from './import/routes.ts';
import {ImportResults} from './import/results.ts';
import {seriesRoutes} from './series/routes.ts';
import {ChannelSeriesStore} from './series/store.ts';
const root=resolve(import.meta.dirname,'../../..');
const validId=(id:string)=>/^[a-z0-9-]+$/.test(id);
// HYPE-SPLASH: participation/predictions.ts:58 emits { level, at } when a hype train begins. Only that shape goes to the overlay.
const hypeSplashFromBus=(payload:unknown):{level:number;at:number}|undefined=>{
  const value=payload as {level?:unknown;at?:unknown}|null;
  if(!value||typeof value.level!=='number'||!Number.isInteger(value.level)||value.level<1||typeof value.at!=='number'||!Number.isFinite(value.at))return undefined;
  return {level:value.level,at:value.at};
};
const panelId={type:'string',minLength:1,maxLength:100};
// The 4 current Looks plus legacy ids still accepted on input; resolveMangaTheme/chooseLook turn
// every legacy id into festival. A value outside this list is still a 400.
const LOOK_ENUM=['festival','sunset','lagoon','blossom','ink','noir','pop'];
export function createApp(options:{adapterFactory?:AdapterFactory;ircTransport?:IrcTransportFactory;now?:()=>number;momentConfig?:Partial<MomentConfig>;recapDirectory?:string;env?:Record<string,string|undefined>;twitchStore?:TwitchTokenStore;twitch?:TokenStoreOptions;logger?:FastifyServerOptions['logger'];sse?:Partial<SseLimits>;helix?:Pick<HelixClientOptions,'fetch'|'sleep'>;eventSub?:ParticipationPluginOptions['eventSub'];eventsHeartbeatMs?:number}={}){
  const endpoints=twitchEndpoints(options.env);
  const directorKey=readDirectorKey(options.env);const guard=directorGuard(directorKey);
  const auth=options.twitchStore??new TwitchTokenStore({env:options.env,now:options.now,baseUrl:endpoints.authBaseUrl,...options.twitch});
  const helix=createSignedInHelix({auth,real:createHelixClient({auth,baseUrl:endpoints.helixBaseUrl,...options.helix}),fallback:createMockHelix()});
  const app=Fastify({logger:options.logger??(process.env.NODE_ENV!=='test')});const studio=new Studio({...options,managedChatSource:true,adapterFactory:options.adapterFactory??authenticatedIrcFactory(withAnonymousFallback(()=>auth.ircSnapshot(),anonymousChatEnabled(options.env??process.env)),options.ircTransport??(options.env?ircTransportFor(options.env):undefined))});const exportDirectory=options.recapDirectory??resolve(root,'exports');const recaps=new RecapStore(exportDirectory);
  const publicationId=randomUUID();let publicationSequence=0;
  studio.ingest.setEventPublisher(event=>{
    const canonical=event.id?event:{...event,id:`ingest-${publicationId}-${++publicationSequence}`};
    eventBus.emit('stream-event',canonical);return canonical;
  });
  let authReady=false,wasConnected=false,eventSubPermitted=false,closed=false,handoverGeneration=0;
  // `ended`: EventSub chat is gone until a new sign-in (LIVE-FIX-1), so the source leaves Live at once.
  const fallback=(ended=false)=>studio.ingest.setEventSubChat(false,ended);
  // The real bridge uses this input bus; chat reaches the shared bus only after admission.
  const bridgeBus:typeof eventBus={...eventBus,emit(channel,payload){
    if(channel==='stream-event'){
      if(!eventSubPermitted||!auth.status().connected)return;
      const event=payload as import('@comictoons/core').StreamEvent;
      if(event.type==='chat'){
        if(studio.ingest.state.requested!=='twitch')return;
        if(!event.withdraw)studio.ingest.setEventSubChat(true);
        studio.ingest.acceptEventSub(event);return;
      }
      if(event.type==='raid'&&studio.ingest.state.requested==='twitch'){studio.ingest.acceptEventSubRaid(event);return;}
    }
    eventBus.emit(channel,payload);
  }};
  const publishAuth=()=>{
    const connected=auth.status().connected,was=wasConnected;
    if(authReady&&connected&&!wasConnected){const provider:TwitchAuthProvider=auth;eventBus.emit('twitch-auth',{auth:provider,helix});}
    if(authReady)wasConnected=connected;
    if(!connected){
      eventSubPermitted=false;handoverGeneration++;fallback(true);
      // A lost sign-in looks lost: the participation plugin stops the EventSub bridge and reports signed-out.
      if(authReady&&was){const provider:TwitchAuthProvider=auth;eventBus.emit('twitch-signed-out',{auth:provider,reason:auth.status().reason});}
    }
  };
  const offAuth=auth.onChange(publishAuth);
  // Plugins must register their hand-over listeners before a pre-connected store is announced.
  app.addHook('onReady',async()=>{authReady=true;publishAuth();});
  const offSources=[
    eventBus.on('twitch-auth',payload=>{
      handoverGeneration++;fallback();
      eventSubPermitted=(payload as {auth?:TwitchAuthProvider}|undefined)?.auth===auth&&auth.status().connected;
    }),
    // T3 announces its first batch even when chat failed: re-arm proof, never select chat here.
    eventBus.on('twitch-connected',payload=>{if((payload as {source?:string}|undefined)?.source==='eventsub'&&auth.status().connected)eventSubPermitted=true;}),
    eventBus.on('twitch-disconnected',payload=>{if((payload as {source?:string}|undefined)?.source==='eventsub'){eventSubPermitted=false;fallback();}}),
    eventBus.on('eventsub-state',payload=>{
      const subscribed=(payload as {state?:string}|undefined)?.state==='subscribed';
      eventSubPermitted=subscribed&&auth.status().connected;if(!subscribed)fallback();
    }),
    eventBus.on('eventsub-revoked',payload=>{
      const revocation=payload as {type?:string;status?:string}|undefined;
      if(revocation?.type==='channel.chat.message'){eventSubPermitted=false;fallback(true);}
      // Withdrawn access: check the token now rather than at the next Helix call or the hourly validate.
      if(revocation?.status==='authorization_revoked'&&auth.status().connected)void auth.validate();
    }),
  ];
  // T3 exposes status but has no loss signal. Read it without changing the bridge.
  const reconcileEventSub=async()=>{
    if(closed||!authReady||!auth.status().connected)return;
    const generation=handoverGeneration;
    try{
      const response=await app.inject('/api/participation/eventsub');
      if(closed||generation!==handoverGeneration||!auth.status().connected||response.statusCode!==200)return;
      const status=response.json() as {state?:string;subscribed?:string[]};
      if(status.state!=='subscribed'||!status.subscribed?.includes('channel.chat.message'))fallback();
      // A readable successful batch re-arms proof after a reconnect, without selecting chat yet.
      if(status.state==='subscribed')eventSubPermitted=!!status.subscribed?.includes('channel.chat.message');
    }catch{/* A closing app has no further source transitions to reconcile. */}
  };
  let overlayHidden=false;
  let latestSaved=recaps.latest();
  const withSavedIssue=async(state:typeof studio.state)=>{
    const saved=await latestSaved;
    const captions=(panels:typeof state.panels)=>JSON.stringify(panels.map(panel=>[panel.id,panel.caption]));
    // MEM-1a #2: the saved issue does not change between saves, so its captions are stringified once.
    const savedJson=()=>{let json=savedCaptions.get(saved!);if(json===undefined){json=captions(saved!.panels);savedCaptions.set(saved!,json);}return json;};
    return {...state,overlayHidden,latestRecapUrl:saved?.recapUrl,savedIssueDiffers:!!saved&&state.panels.length>0&&captions(state.panels)!==savedJson()};
  };
  const savedCaptions=new WeakMap<object,string>();
  // MEM-1a #2: one state signature per tick, shared by every /api/events client (it was stringified per client).
  type StateClient={last:string;writer:ReturnType<typeof sseWriter>};
  const stateClients=new Set<StateClient>();
  const stateSignature=async()=>JSON.stringify(await withSavedIssue(studio.state));
  let broadcasting=false;
  const broadcastState=async()=>{
    if(broadcasting||!stateClients.size)return;
    broadcasting=true;
    try{const signature=await stateSignature();const frame=`event: state\ndata: ${signature}\n\n`;for(const client of stateClients){if(client.last===signature)continue;client.last=signature;client.writer.latest(frame);}}
    finally{broadcasting=false;}
  };
  const stateTimer=setInterval(()=>{void broadcastState().catch(()=>{});},500);stateTimer.unref();
  // CLIP-WATCH-1: Get Clips with an app token while a signed-in session is Live; stream.offline stops it.
  const clipWatch=createClipWatch({client:{auth:createAppTokenAuth({clientId:auth.config.clientId,clientSecret:auth.config.clientSecret,authBaseUrl:endpoints.authBaseUrl,fetch:options.helix?.fetch}),baseUrl:endpoints.helixBaseUrl,fetch:options.helix?.fetch},
    broadcaster:async()=>(await auth.getAuth())?.broadcasterId,bus:eventBus,emit:event=>eventBus.emit('stream-event',event),log:line=>app.log.info(line)});
  // A test that injects its own sign-in transport but no Helix fetch never polls, so it cannot reach Twitch.
  const clipWatchAllowed=!(options.twitchStore||options.twitch?.fetchImpl)||!!options.helix?.fetch;
  const syncClipWatch=()=>clipWatch.sync(clipWatchAllowed&&!closed&&auth.status().connected&&studio.state.status==='live'&&studio.state.source?.active==='twitch'&&!studio.state.source?.simulated);
  const timer=setInterval(()=>{studio.tick();void reconcileEventSub();syncClipWatch();},500);timer.unref();
  const sseClients=new Set<()=>void>();
  // End event streams before Fastify waits for in-flight requests, or close() hangs on open SSE clients.
  app.addHook('preClose',async()=>{for(const close of [...sseClients])close();sseClients.clear();});
  app.addHook('onClose',async()=>{closed=true;clearInterval(timer);clearInterval(stateTimer);stateClients.clear();clipWatch.close();offAuth();for(const off of offSources)off();auth.close();studio.close();for(const close of [...sseClients])close();sseClients.clear();});
  // Protect participation routes at the app boundary without changing their owner's plugin.
  app.addHook('onRequest',async(req,reply)=>{
    let path:string;
    try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/\/+/g,'/').toLowerCase().replace(/\/$/,'');}
    catch{return reply.code(400).send({error:'Invalid request path.'});}
    const participation=path==='/api/participation'||path.startsWith('/api/participation/');
    if(participation&&(!['GET','HEAD','OPTIONS'].includes(req.method)||(['GET','HEAD'].includes(req.method)&&path==='/api/participation/director'))){
      const access=directorAccess(req,directorKey);
      if(!access.ok)return reply.code(access.status).send({error:access.error});
    }
  });
  app.register(twitchRoutes,{store:auth,directorKey,env:options.env,now:options.now,getBroadcasterType:()=>helix.getBroadcasterType()});
  app.register(comicsRoutes,{studio,eventBus,directorKey,sse:options.sse});
  // IMPORT-1: Twitch link -> comic (app token, read-only Helix), and the channel's manga series.
  const importResults=new ImportResults();
  app.register(importRoutes,{studio,client:{auth:createAppTokenAuth({clientId:auth.config.clientId,clientSecret:auth.config.clientSecret,authBaseUrl:endpoints.authBaseUrl,fetch:options.helix?.fetch}),baseUrl:endpoints.helixBaseUrl,fetch:options.helix?.fetch},results:importResults,guard,env:options.env});
  app.register(seriesRoutes,{store:new ChannelSeriesStore(resolve(root,'artifacts/series')),results:importResults,guard});
  app.register(participationRoutes,{studio,eventBus:bridgeBus,env:options.env,eventSub:{url:endpoints.eventSubUrl,helixUrl:endpoints.helixBaseUrl,...options.eventSub}});
  app.get('/art/generated/:file',async(req,reply)=>{const {file}=req.params as {file:string};if(!/^panel-[a-z0-9-]+\.(?:webp|png)$/.test(file))return reply.code(404).send({error:'Art not found.'});let image:Buffer;try{image=await readFile(resolve(root,'fixtures/art/generated',file));}catch{return reply.code(404).send({error:'Art not found.'});}
    // Read before setting the image content type, so a missing file is a plain JSON 404 (it used to fall through to the global 409).
    return reply.header('Cache-Control','public, max-age=86400').type(file.endsWith('.png')?'image/png':'image/webp').send(image);});
  app.get('/api/state',async()=>{await reconcileEventSub();return withSavedIssue(studio.tick());});
  // Alongside /api/state polling: pushes the same state shape on change, plus stream and catch-up bus events.
  app.get('/api/events',async(req,reply)=>{
    reply.hijack();
    const res=reply.raw;
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive'});
    // MEM-1a #1: every write goes through the backpressure-aware writer (comics/routes.ts sseWriter).
    const writer=sseWriter(res,options.sse);
    const send=(event:string,data:unknown)=>writer.event(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const client:StateClient={last:await stateSignature(),writer};
    writer.latest(`event: state\ndata: ${client.last}\n\n`);
    stateClients.add(client);
    // Lets useEventStream's watchdog tell "idle but connected" apart from "the upstream died but the
    // proxy kept the socket open" (see reports/2026-10-31-keys-1.md Part 2): a comment line every
    // eventsHeartbeatMs, well inside the client's silence budget.
    const heartbeat=setInterval(()=>writer.event(': hb\n\n'),options.eventsHeartbeatMs??10000);heartbeat.unref();
    const unsubscribe=eventBus.on('stream-event',event=>send('stream-event',event));
    const unsubscribeRevoked=eventBus.on('eventsub-revoked',payload=>send('eventsub-revoked',payload));
    const unsubscribeCatchup=eventBus.on('catchup',payload=>{const data=catchupFromBus(studio,payload);if(data)send('catchup',data);});
    const unsubscribeHype=eventBus.on('hype-splash',payload=>{const data=hypeSplashFromBus(payload);if(data)send('hype-splash',data);});
    const close=()=>{stateClients.delete(client);clearInterval(heartbeat);unsubscribe();unsubscribeCatchup();unsubscribeHype();unsubscribeRevoked();sseClients.delete(close);try{res.end();}catch{/* already closed */}};
    sseClients.add(close);
    req.raw.on('close',close);
  });
  app.get('/api/ingest/sample',async()=>withSavedIssue(studio.sampleSnapshot()));
  app.post('/api/ingest',{onRequest:guard,preValidation:async(req,reply)=>{
    if(req.body&&typeof req.body==='object'&&Object.keys(req.body).some(key=>key!=='mode'&&key!=='channel'))return reply.code(400).send({error:'Only a source mode and public channel name are accepted.'});
  },schema:{body:{type:'object',additionalProperties:false,properties:{mode:{type:'string',enum:['sample','twitch']},channel:{type:'string',pattern:'^[a-zA-Z0-9_]{1,25}$'}},required:['mode']}}},async req=>{
    const body=req.body as {mode:'sample'|'twitch';channel?:string};
    return studio.useSource(body.mode,body.channel?.toLowerCase()||auth.config.channel||auth.status().login);
  });
  app.get('/api/fixtures',async()=>fixtures.map(({id,streamTitle,duration})=>({id,streamTitle,duration})));
  app.post('/api/replay',{onRequest:guard,schema:{body:{type:'object',additionalProperties:false,properties:{fixtureId:{type:'string',enum:fixtures.map(f=>f.id)},speed:{type:'number',enum:[1,10,60]},style:{type:'string',enum:['risograph','noir']}},required:['fixtureId']}}},async req=>{if(studio.state.status==='exporting')throw new Error('Please wait while your issue is being exported.');const body=req.body as {fixtureId:string;speed?:number;style?:string};return studio.replay(body.fixtureId,body.speed,body.style);});
  app.post('/api/settings',{onRequest:guard,schema:{body:{type:'object',additionalProperties:false,properties:{speed:{type:'number',enum:[1,10,60]},approvalMode:{type:'boolean'},mangaTheme:{type:'string',enum:LOOK_ENUM}}}}},async req=>studio.settings(req.body as {speed?:number;approvalMode?:boolean;mangaTheme?:MangaTheme}));
  for(const kind of ['approve','reject'] as const)app.post(`/api/${kind}`,{onRequest:guard,preValidation:async req=>{if(req.body==null)req.body={};},schema:{body:{type:'object',additionalProperties:false,properties:{panelId,all:{type:'boolean',const:true}}}}},async(req,reply)=>{const body=req.body as {panelId?:string;all?:boolean};if(!body.panelId&&body.all!==true)return reply.code(400).send({error:`Choose a panel or ${kind} all.`});return studio.moderate(kind,body.panelId,body.all===true);});
  app.post('/api/undo',{onRequest:guard,schema:{body:{type:'object',additionalProperties:false,properties:{token:{type:'string',maxLength:100}},required:['token']}}},async req=>studio.undo((req.body as {token:string}).token));
  app.post('/api/caption',{onRequest:guard,schema:{body:{type:'object',additionalProperties:false,properties:{panelId,caption:{type:'string',minLength:1,maxLength:280}},required:['panelId','caption']}}},async req=>{const body=req.body as {panelId:string;caption:string};return studio.caption(body.panelId,body.caption);});
  app.post('/api/hide',{onRequest:guard,schema:{body:{type:'object',additionalProperties:false,required:['hidden'],properties:{hidden:{type:'boolean'}}}}},async req=>{overlayHidden=(req.body as {hidden:boolean}).hidden;return withSavedIssue(studio.state);});
  app.post('/api/stop',{onRequest:guard},async()=>studio.stop());
  app.get('/api/recaps/:id',async(req,reply)=>{
    const {id}=req.params as {id:string};if(!validId(id))return reply.code(400).send({error:'Invalid issue address.'});
    let snapshot;try{snapshot=await recaps.read(id);}catch{return reply.code(404).send({error:'This issue could not be found. Try returning to the studio.'});}
    const {look}=req.query as {look?:string};if(look===undefined)return snapshot;
    // An explicit ?look= previews the issue in that Look without revising the saved recap.
    try{return {...snapshot,mangaTheme:chooseLook(snapshot,look)};}catch{return reply.code(400).send({error:'Unknown Look.'});}
  });
  const exportOptions={onRequest:guard,preValidation:async(req:import('fastify').FastifyRequest)=>{if(req.body==null)req.body={};},schema:{body:{type:'object',additionalProperties:false,properties:{look:{type:'string',enum:LOOK_ENUM}}}}};
  app.post('/api/recaps',exportOptions,async(req,reply)=>{
    if(studio.state.status==='exporting')return reply.code(409).send({error:'Your issue is already being exported.'});
    if(!studio.state.panels.length)return reply.code(409).send({error:'Approve at least one panel before saving the recap.'});
    try{
      const {snapshot}=await recaps.save(studio.state,req.body as {look?:MangaTheme});
      studio.state.recapUrl=snapshot.recapUrl;latestSaved=Promise.resolve(structuredClone(snapshot));
      if(recapSignature(studio.state)===recapSignature(snapshot))Object.assign(studio.state,{shareUrl:snapshot.shareUrl,pageUrls:snapshot.pageUrls});
      return snapshot;
    }catch(error){app.log.error(error);return reply.code(500).send({error:'The recap could not be saved. Your approved panels are safe.'});}
  });
  app.get('/exports/:id/:file',async(req,reply)=>{const {id,file}=req.params as {id:string;file:string};const mime:Record<string,string>={'share.png':'image/png','index.html':'text/html','FONT-LICENSES.txt':'text/plain'};const kind=mime[file]??(/^page-[1-9][0-9]{0,2}\.png$/.test(file)?'image/png':undefined);if(!validId(id)||!kind)return reply.code(404).send({error:'Export not found.'});try{return reply.type(kind).send(await readFile(resolve(exportDirectory,id,file)));}catch{return reply.code(404).send({error:'Export not found.'});}});
  app.post('/api/end',exportOptions,async(req,reply)=>{
    if(studio.state.status==='exporting')return reply.code(409).send({error:'Your issue is already being exported.'});
    if(!studio.state.panels.length)return reply.code(409).send({error:'Approve at least one panel before ending the stream.'});
    const previousStatus=studio.state.status;studio.state.status='exporting';
    try{
      const {snapshot,id,directory:dir}=await recaps.save(studio.state,req.body as {look?:MangaTheme});
      studio.state.recapUrl=snapshot.recapUrl;latestSaved=Promise.resolve(structuredClone(snapshot));
      const {html,shareHtml,fontLicenses}=await renderExport(snapshot);const browser=await chromium.launch({headless:true});
      try{const page=await browser.newPage({viewport:{width:1080,height:1350},deviceScaleFactor:1});await page.setContent(shareHtml);await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});await page.screenshot({path:resolve(dir,'share.png'),fullPage:true});snapshot.pageUrls=[];const pages=page.locator('.manga-page');for(let index=0;index<await pages.count();index++){const file=`page-${index+1}.png`;await pages.nth(index).screenshot({path:resolve(dir,file)});snapshot.pageUrls.push(`/exports/${id}/${file}`);}}finally{await browser.close();}
      snapshot.status='ended';snapshot.recapUrl=`/recap/${id}`;snapshot.shareUrl=`/exports/${id}/share.png`;
      await Promise.all([writeFile(resolve(dir,'index.html'),html),recaps.write(id,snapshot),writeFile(resolve(dir,'FONT-LICENSES.txt'),fontLicenses)]);
      latestSaved=Promise.resolve(structuredClone(snapshot));
      // Panic hide during export must stay hidden; the saved issue remains available.
      if(studio.state.status==='exporting')Object.assign(studio.state,{status:'ended',recapUrl:snapshot.recapUrl,shareUrl:snapshot.shareUrl,pageUrls:snapshot.pageUrls});
      return {recapUrl:snapshot.recapUrl,shareUrl:snapshot.shareUrl,pageUrls:snapshot.pageUrls};
    }catch(error){if(studio.state.status==='exporting')studio.state.status=previousStatus;app.log.error(error);return reply.code(500).send({error:'We could not export your issue. Your approved panels are safe. Check Chromium is installed and try again.'});}
  });
  app.setErrorHandler((error,_req,reply)=>{const detail=error as {validation?:unknown;message?:string};return reply.code(detail.validation?400:409).send({error:detail.validation?'Check the submitted settings and try again.':detail.message??'That change could not be completed.'});});
  return app;
}
