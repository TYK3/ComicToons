import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {IMAGE_MODELS,isOptOutCommand,type WatchRole,type WatchSnapshot,type ScenePage,type StreamEvent,type GenerationProvider,type AuthoredLettering} from '@comictoons/core';
import {ChatSource} from '../ingest/source.ts';
import {TwitchIrcAdapter,withAnonymousFallback,validChannel,type AdapterFactory} from '../ingest/irc.ts';
import {TwitchVideoCapture,CaptureError,type CaptureSource} from './capture.ts';
import {ReferenceGenerator,ProviderError,referenceFrameLimit,validateConfig,type ProviderConfig,type FrameInput} from './providers.ts';
import {referenceDefaults} from '../pipeline/credentials.ts';

interface Session {snapshot:WatchSnapshot;key?:ProviderConfig;keyExpires?:number;frames:FrameInput[];chat:ChatSource;capture:CaptureSource;timer?:ReturnType<typeof setTimeout>;deadline?:ReturnType<typeof setTimeout>;controller?:AbortController;epoch:number;busy:boolean;nextAnalysis:number;denied:Set<string>;retired:boolean;lastUsed:number;saving:Promise<void>}
export interface SceneOptions {captureFactory?:()=>CaptureSource;isLive?:(channel:string)=>Promise<boolean>;adapterFactory?:AdapterFactory;generator?:ReferenceGenerator;now?:()=>number;directory?:string;intervalMs?:number;analysisIntervalMs?:number;env?:Record<string,string|undefined>;onPage?:(page:ScenePage,snapshot:WatchSnapshot,image:Buffer)=>void|Promise<void>;onWithdraw?:(page:ScenePage)=>void}
export class SceneSessions {
  private sessions=new Map<string,Session>();readonly generator:ReferenceGenerator;
  readonly directory:string;private now:()=>number;private cleanup:ReturnType<typeof setInterval>;
  private defaultCursor=0;private appAttempts:number[]=[];
  constructor(private options:SceneOptions={}){
    this.generator=options.generator??new ReferenceGenerator();this.now=options.now??Date.now;this.directory=options.directory??resolve(import.meta.dirname,'../../../../artifacts/live-scenes');
    this.cleanup=setInterval(()=>{for(const [id,s] of this.sessions){this.expireKey(s);if(this.now()-s.lastUsed>3600000){void this.stop(id);s.key=undefined;this.sessions.delete(id);}}},60000);this.cleanup.unref();
  }
  get(id:string|undefined){let s=id?this.sessions.get(id):undefined;if(!s&&id)s=this.restore(id);if(s){s.lastUsed=this.now();this.expireKey(s);}return s;}
  private restore(id:string){
    if(!/^[a-f0-9-]{36}$/.test(id))return;
    try{const path=resolve(this.directory,id,'session.json');if(Date.now()-statSync(path).mtimeMs>3600000)return;
      const state=JSON.parse(readFileSync(path,'utf8')) as WatchSnapshot;if(state.id!==id||!['viewer','streamer'].includes(state.role)||!Array.isArray(state.frames)||state.frames.length>90||state.frames.some(f=>!/^[a-f0-9-]{36}$/.test(f.id)))return;
      const created=this.create(state.role),s=this.sessions.get(created.id)!;this.sessions.delete(created.id);
      s.snapshot={...state,state:'stopped',chatConnection:'stopped',generator:{...state.generator,configured:false,ownKey:false,checked:false,expiresAt:undefined}};
      s.frames=state.frames.map(frame=>({...frame,buffer:readFileSync(resolve(this.directory,id,`${frame.id}.jpg`))}));s.retired=true;
      for(const p of s.snapshot.pages)if(p.status==='drawing'||p.status==='reviewing'){p.status='failed';p.reason='The server restarted before generation completed.';}
      this.sessions.set(id,s);this.event(s,'restored','Captured evidence restored after restart. Provider keys were forgotten; select a generator to continue.');return s;
    }catch{return;}
  }
  async persist(s:Session){const json=JSON.stringify(this.snapshot(s));s.saving=s.saving.catch(()=>{}).then(async()=>{const dir=resolve(this.directory,s.snapshot.id);await mkdir(dir,{recursive:true});await writeFile(resolve(dir,'session.next.json'),json);await rename(resolve(dir,'session.next.json'),resolve(dir,'session.json'));});await s.saving;}
  create(role:WatchRole){
    for(const [id,s] of this.sessions)if(this.now()-s.lastUsed>3600000){void this.stop(id);this.sessions.delete(id);}
    if(this.sessions.size>=12)throw new Error('Too many sessions. Close an existing session first.');
    const id=randomUUID();const provider:GenerationProvider=this.defaultConfig()?.provider??'openai';
    const snapshot:WatchSnapshot={id,role,state:'idle',elapsed:0,chatConnection:'stopped',received:0,frames:[],chat:[],pages:[],events:[],generator:{provider,model:this.defaultConfig()?.model??IMAGE_MODELS[provider][0],configured:!!this.defaultConfig(),ownKey:false,checked:false,maxPages:3,used:0},analysisMode:'frames-and-chat',transcription:false};
    const s={} as Session;
    Object.assign(s,{snapshot,frames:[],capture:this.options.captureFactory?.()??new TwitchVideoCapture({isLive:this.options.isLive}),epoch:0,busy:false,nextAnalysis:0,denied:new Set(),retired:false,lastUsed:this.now(),saving:Promise.resolve()});
    s.chat=new ChatSource({change:source=>{s.snapshot.chatConnection=source.connection;},event:event=>this.receive(s,event)},this.options.adapterFactory??(channel=>new TwitchIrcAdapter({channel,authenticate:withAnonymousFallback(()=>undefined,true)})),this.now);
    this.sessions.set(id,s);return this.snapshot(s);
  }
  private defaultConfig(advance=false):ProviderConfig|undefined{
    const configs=referenceDefaults(this.options.env??process.env);if(!configs.length)return;
    const config=configs[this.defaultCursor%configs.length];if(advance)this.defaultCursor++;return config;
  }
  private expireKey(s:Session){if(s.keyExpires&&s.keyExpires<=this.now()){s.key=undefined;s.keyExpires=undefined;s.snapshot.generator.configured=false;s.snapshot.generator.ownKey=false;s.snapshot.generator.checked=false;this.event(s,'key-expired','Your image-provider key expired. No fallback was selected.');}}
  config(s:Session){this.expireKey(s);return s.snapshot.generator.configured?(s.snapshot.generator.ownKey?s.key:this.defaultConfig()):undefined;}
  configure(s:Session,input:{provider?:GenerationProvider;model?:string;key?:string;accountId?:string;useDefault?:boolean;maxPages?:number}){
    if(s.busy)throw new Error('Wait for the current generation before changing provider.');
    const limit=input.maxPages??s.snapshot.generator.maxPages;if(!Number.isInteger(limit)||limit<1||limit>5)throw new Error('Choose a page limit from 1 to 5.');
    if(input.useDefault){s.key=undefined;s.keyExpires=undefined;const config=this.defaultConfig();s.snapshot.generator={...s.snapshot.generator,provider:config?.provider??'openai',model:config?.model??'gpt-image-1.5',ownKey:false,configured:!!config,checked:false,maxPages:limit};}
    else{const config={provider:input.provider!,model:input.model!,key:input.provider==='source'?'local-source-frame-mode':input.key!,accountId:input.accountId};validateConfig(config);s.key=config;s.keyExpires=this.now()+3600000;s.snapshot.generator={...s.snapshot.generator,provider:config.provider,model:config.model,configured:true,ownKey:true,checked:false,expiresAt:s.keyExpires,maxPages:limit};}
    s.snapshot.generator.blocked=undefined;this.event(s,'provider','Generator settings updated. Keys are held in server memory only.');return this.snapshot(s);
  }
  async check(s:Session){const c=this.config(s);if(!c)throw new Error('No default image provider is configured. Enter your own key.');await this.generator.check(c);s.snapshot.generator.checked=true;this.event(s,'provider-check','Key and selected image model are accessible. This does not guarantee credits for generation.');return this.snapshot(s);}
  snapshot(s:Session):WatchSnapshot{this.expireKey(s);s.snapshot.elapsed=s.snapshot.startedAt?Math.max(0,Math.min(s.snapshot.endsAt??this.now(),this.now())-s.snapshot.startedAt)/1000:0;return structuredClone(s.snapshot);}
  event(s:Session,kind:string,detail:string){s.snapshot.events.push({at:this.now(),kind,detail});s.snapshot.events=s.snapshot.events.slice(-180);}
  private receive(s:Session,event:StreamEvent){
    if(s.retired)return;
    const removed=new Set<string>();
    if(event.withdraw==='message'&&event.targetId)removed.add(event.targetId);
    if(event.withdraw==='user'||isOptOutCommand(event.text??'',event)){const user=event.targetUser??event.user;if(user){s.denied.add(user);s.snapshot.chat.filter(q=>q.user===user).forEach(q=>removed.add(q.id));}}
    if(removed.size){s.snapshot.chat=s.snapshot.chat.filter(q=>!removed.has(q.id));for(const p of s.snapshot.pages)if(p.sourceChatIds.some(id=>removed.has(id))){p.status='withdrawn';p.reason='A source quote was withdrawn.';p.imageUrl=undefined;this.options.onWithdraw?.(p);}this.event(s,'privacy','Withdrawn chat and derived pages were removed.');return;}
    if(event.withdraw||event.type!=='chat'||!event.text||s.denied.has(event.user??'')||event.text.trim().startsWith('!'))return;
    s.snapshot.received++;s.snapshot.chat.push({id:event.id??randomUUID(),capturedAt:this.now(),text:event.text.slice(0,400),user:event.user??''});s.snapshot.chat=s.snapshot.chat.slice(-4000);
  }
  async start(s:Session,channel:string,duration=600,palette='festival'){
    if(!validChannel(channel))throw new Error('Enter a Twitch channel link or username.');
    if(!Number.isInteger(duration)||duration<60||duration>600)throw new Error('Capture sessions last between 1 and 10 minutes.');
    if([...this.sessions.values()].filter(x=>['running','connecting'].includes(x.snapshot.state)&&x!==s).length>=2)throw new Error('Two capture sessions are already running.');
    await this.stop(s.snapshot.id);s.epoch++;s.retired=false;s.controller=new AbortController();s.frames=[];s.denied.clear();s.nextAnalysis=0;
    s.snapshot={...s.snapshot,channel,state:'connecting',startedAt:undefined,endsAt:undefined,elapsed:0,received:0,frames:[],chat:[],pages:[],events:[],error:undefined,generator:{...s.snapshot.generator,used:0}};
    this.event(s,'start',`Opening #${channel}; ${duration}s capture requested.`);s.chat.start(channel);
    const epoch=s.epoch;
    void (async()=>{try{
      await s.capture.open(channel);if(s.epoch!==epoch)return;
      s.snapshot.state='running';s.snapshot.startedAt=this.now();s.snapshot.endsAt=this.now()+duration*1000;
      this.event(s,'playback','Playing video is available. Scene frames are captured from the video rectangle.');
      s.deadline=setTimeout(()=>void this.stop(s.snapshot.id),duration*1000);s.deadline.unref();await this.captureTick(s,epoch,palette);
    }catch(error){if(s.epoch===epoch){s.snapshot.error=error instanceof CaptureError?error.message:'Twitch video could not be opened. Offline, blocked or unsupported playback is not replaced by sample art.';this.event(s,'capture-error',s.snapshot.error);await this.stop(s.snapshot.id);s.snapshot.state='error';await this.persist(s);}}})();
    return this.snapshot(s);
  }
  private async captureTick(s:Session,epoch:number,palette:string){
    if(s.epoch!==epoch||s.snapshot.state!=='running')return;
    try{
      const {buffer,videoTime}=await s.capture.frame();if(s.epoch!==epoch)return;
      const id=randomUUID(),sha256=createHash('sha256').update(buffer).digest('hex');
      if(!s.frames.some(f=>f.sha256===sha256)){
        const file=`${id}.jpg`;await mkdir(resolve(this.directory,s.snapshot.id),{recursive:true});await writeFile(resolve(this.directory,s.snapshot.id,file),buffer);
        const frame:FrameInput={id,capturedAt:this.now(),videoTime,url:`/api/watch/files/${file}`,sha256,buffer};s.frames.push(frame);s.snapshot.frames.push({id,capturedAt:frame.capturedAt,videoTime,url:frame.url,sha256});
        await this.persist(s);
        this.event(s,'frame',`Frame ${s.frames.length} captured; video clock ${videoTime.toFixed(2)}s.`);
        if(s.frames.length>=4&&!s.busy&&!s.snapshot.generator.blocked&&this.now()>=s.nextAnalysis&&s.snapshot.generator.used<s.snapshot.generator.maxPages){
          if(this.config(s)){s.nextAnalysis=this.now()+(this.options.analysisIntervalMs??120000);void this.generate(s,palette,epoch).catch(()=>this.event(s,'generation-error','Generation could not start. Check provider settings.'));}
          else if(!s.snapshot.events.some(e=>e.kind==='key-needed'))this.event(s,'key-needed','Frames and chat are captured. Add an image-provider key to analyse and draw a page.');
        }
      }
    }catch(error){if(s.epoch===epoch){this.event(s,'capture-wait',error instanceof Error?error.message:'Waiting for the video.');if(error instanceof CaptureError&&error.code==='offline'){s.snapshot.error=error.message;await this.stop(s.snapshot.id);s.snapshot.state='error';await this.persist(s);}}}
    if(s.epoch===epoch&&s.snapshot.state==='running'){s.timer=setTimeout(()=>void this.captureTick(s,epoch,palette),this.options.intervalMs??10000);s.timer.unref();}
  }
  async generate(s:Session,palette='festival',epoch=s.epoch){
    if(s.snapshot.generator.blocked)throw new Error(s.snapshot.generator.blocked);
    if(s.busy)throw new Error('A page is already being generated.');
    if(s.snapshot.generator.used>=s.snapshot.generator.maxPages)throw new Error('This session reached its page limit.');
    let config=this.config(s);if(!config)throw new Error('Enter an image-provider key first.');
    if(s.controller?.signal.aborted)s.controller=new AbortController();
    const frames=s.frames.slice(-referenceFrameLimit(config));if(frames.length<4)throw new Error('Wait for four actual video frames.');
    if(!s.snapshot.generator.ownKey){
      this.appAttempts=this.appAttempts.filter(at=>at>this.now()-3600000);
      const raw=(this.options.env??process.env).IMAGE_BUDGET_PER_HOUR;
      const limit=raw?.trim()?Number(raw):12;
      if(!Number.isInteger(limit)||limit<0||this.appAttempts.length>=limit)throw new Error('The app image generation budget is unavailable or used for this hour. Use your own session key or try later.');
      config=this.defaultConfig(true)!;this.appAttempts.push(this.now());
    }
    const chat=s.snapshot.chat.filter(q=>q.capturedAt>=frames[0]!.capturedAt-15000&&q.capturedAt<=frames.at(-1)!.capturedAt+15000).slice(-80);
    const p:ScenePage={id:randomUUID(),createdAt:this.now(),status:'drawing',title:'Reviewing captured scene',reason:'',sourceFrameIds:frames.map(f=>f.id),sourceChatIds:chat.map(q=>q.id),provider:config.provider,model:config.model};
    const stale=()=>s.epoch!==epoch||p.status==='withdrawn';
    let stage:NonNullable<ScenePage['failureStage']>='analysis';
    s.snapshot.pages.push(p);s.busy=true;s.snapshot.generator.used++;this.event(s,'analysis','Analysing timestamped source frames and matching chat; speech transcription is unavailable.');
    try{
      const plan=await this.generator.analyse(config,frames,chat,s.controller?.signal);if(s.epoch!==epoch)return;
      if(p.status==='withdrawn')return;p.plan=plan;p.title=plan.title;p.reason=plan.reason;
      if(!plan.supported){p.status='held';this.event(s,'evidence-hold',plan.reason);return;}
      const allowed=new Set(plan.panels.flatMap(b=>b.chatIds));p.sourceChatIds=[...allowed];
      if(allowed.size&&s.snapshot.chat.every(q=>!allowed.has(q.id))){p.status='withdrawn';return;}
      this.event(s,'drawing',`${plan.highlight?'Highlight':'Observed recap'}: ${plan.reason}`);
      stage='drawing';
      const image=await this.generator.draw(config,plan,frames,chat,palette,s.controller?.signal);if(stale())return;
      await mkdir(resolve(this.directory,s.snapshot.id),{recursive:true});await writeFile(resolve(this.directory,s.snapshot.id,`${p.id}.image`),image);
      stage='review';p.status='reviewing';const review=await this.generator.review(config,image,plan,s.controller?.signal,frames);if(stale())return;
      p.reason=review.reason;
      if(!review.safe){p.status='held';this.event(s,'quality-hold',review.reason);return;}
      const file=`${p.id}.image`;await mkdir(resolve(this.directory,s.snapshot.id),{recursive:true});await writeFile(resolve(this.directory,s.snapshot.id,file),image);
      p.imageUrl=`/api/watch/files/${file}`;p.status='ready';this.event(s,'page-ready',config.provider==='source'?'Source-frame comic composed locally; inspect original frames and exact lettering in Studio before release.':'Face, action, lettering and source review passed. AI interpretation, not a verified transcript.');
      stage='publishing';await this.options.onPage?.(p,this.snapshot(s),image);
    }catch(error){if(s.epoch===epoch&&p.status!=='withdrawn'){p.status='failed';p.failureStage=stage;p.failureCode=error instanceof ProviderError?error.code:'local';p.reason=error instanceof Error?error.message:'Generation failed.';if(error instanceof ProviderError&&['402','429'].includes(error.code))s.snapshot.generator.blocked='Image generation is paused after a provider quota or credit failure. Update the generator settings to retry explicitly.';this.event(s,'generation-error',`${stage}: ${p.reason}`);}}
    finally{if(s.epoch===epoch){s.busy=false;await this.persist(s);}}
  }
  async revisePage(id:string,lettering:AuthoredLettering,palette='festival'){
    const s=[...this.sessions.values()].find(session=>session.snapshot.role==='streamer'&&session.snapshot.pages.some(page=>page.id===id));
    const p=s?.snapshot.pages.find(page=>page.id===id);
    if(!s||!p||p.status!=='ready'||!p.plan)throw new Error('Original captured page is no longer available for revision.');
    if(s.snapshot.generator.blocked)throw new Error(s.snapshot.generator.blocked);
    if(s.busy)throw new Error('Wait for the current image generation before revising this page.');
    if(!lettering.text.trim()||lettering.text.length>280)throw new Error('Use 1 to 280 characters for image lettering.');
    let config=this.config(s);if(!config||config.provider!==p.provider||config.model!==p.model)throw new Error('Select the original page’s provider and model before revising it.');
    if(s.snapshot.generator.used>=s.snapshot.generator.maxPages)throw new Error('This session reached its image attempt limit. Increase the limit to revise the page.');
    const frames=s.frames.filter(frame=>p.sourceFrameIds.includes(frame.id));if(frames.length<4)throw new Error('Original scene reference frames are unavailable.');
    const chat=s.snapshot.chat.filter(line=>p.sourceChatIds.includes(line.id));
    if(!s.snapshot.generator.ownKey){
      this.appAttempts=this.appAttempts.filter(at=>at>this.now()-3600000);const raw=(this.options.env??process.env).IMAGE_BUDGET_PER_HOUR;const limit=raw?.trim()?Number(raw):12;
      if(!Number.isInteger(limit)||limit<0||this.appAttempts.length>=limit)throw new Error('The app image generation budget is unavailable or used for this hour.');
      config=this.defaultConfig(true)!;this.appAttempts.push(this.now());
    }
    if(s.controller?.signal.aborted)s.controller=new AbortController();const epoch=s.epoch;
    const valid=()=>s.epoch===epoch&&p.status==='ready';s.busy=true;s.snapshot.generator.used++;
    this.event(s,'lettering-revision','Rendering revised in-picture commentary with original scene evidence.');
    try{
      const image=await this.generator.draw(config,p.plan,frames,chat,palette,s.controller?.signal,lettering);if(!valid())throw new Error('Page was stopped or withdrawn during revision.');
      const review=await this.generator.review(config,image,p.plan,s.controller?.signal,frames,lettering);if(!valid())throw new Error('Page was stopped or withdrawn during revision.');
      if(!review.safe)throw new Error(`Revised image held for quality: ${review.reason}`);
      const file=`${randomUUID()}.image`;await writeFile(resolve(this.directory,s.snapshot.id,file),image);if(!valid())throw new Error('Page was withdrawn during revision.');
      const before={imageFile:p.imageFile,imageUrl:p.imageUrl,authoredLettering:p.authoredLettering,reason:p.reason};
      Object.assign(p,{imageFile:file,imageUrl:`/api/watch/files/${file}`,authoredLettering:{...lettering},reason:review.reason});
      try{await this.options.onPage?.(p,this.snapshot(s),image);}catch(error){if(p.status==='ready')Object.assign(p,before);throw error;}
      this.event(s,'lettering-ready','Revised image passed source, face and exact-lettering review.');return p;
    }catch(error){if(error instanceof ProviderError&&['402','429'].includes(error.code))s.snapshot.generator.blocked='Image generation is paused after a provider quota or credit failure. Update generator settings to retry explicitly.';this.event(s,'lettering-failed','Revision failed; previous image retained.');throw error;}
    finally{if(s.epoch===epoch)s.busy=false;await this.persist(s);}
  }
  async file(s:Session,file:string){
    if(!/^[a-f0-9-]{36}\.(?:jpg|image)$/.test(file))throw new Error('File not found.');
    const id=file.split('.')[0];if(!s.snapshot.frames.some(f=>f.id===id)&&!s.snapshot.pages.some(p=>p.status==='ready'&&(p.imageFile??`${p.id}.image`)===file))throw new Error('File not found.');
    return readFile(resolve(this.directory,s.snapshot.id,file));
  }
  async stop(id:string){const s=this.sessions.get(id);if(!s)return;s.epoch++;s.retired=true;s.busy=false;s.controller?.abort();clearTimeout(s.timer);clearTimeout(s.deadline);s.chat.close();s.snapshot.chatConnection='stopped';if(s.snapshot.startedAt)s.snapshot.endsAt=Math.min(s.snapshot.endsAt??this.now(),this.now());if(s.snapshot.state!=='idle')s.snapshot.state='stopped';await s.capture.close();for(const p of s.snapshot.pages)if(['drawing','reviewing'].includes(p.status)){p.status='failed';p.reason='Session stopped before generation completed.';}this.event(s,'stop','Capture and chat stopped. Existing completed pages remain available.');await this.persist(s);}
  async close(){clearInterval(this.cleanup);await Promise.all([...this.sessions.keys()].map(id=>this.stop(id)));for(const s of this.sessions.values())s.key=undefined;this.sessions.clear();}
}
