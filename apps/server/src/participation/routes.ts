import { readProductEnv } from '../../../../packages/core/src/env.mjs';
import type {FastifyPluginAsync,onRequestHookHandler} from 'fastify';
import {isOptOutCommand,type EventBus,type ComicToonsBusEvents,type StreamEvent} from '@comictoons/core';
import type {Studio} from '../studio.ts';
import {CatchupTriggers,OptOutLedger,isModerator,parseCommand,unsettledCameoRedemption,type ChatSender,type ParticipationEvent,type StudioLike} from './commands.ts';
import {CaptionPolls,type HelixPolls} from './polls.ts';
import {InkMeRewards,PanelBudget,type HelixRewards} from './rewards.ts';
import {HypeAndPredictions,type HelixPredictions,type PredictionView} from './predictions.ts';
import {DirectorDesk} from './director.ts';
import {InkChatRequests} from './ink-chat.ts';
import type {TwitchAuthProvider} from '../eventsub/types.ts';
import {startEventSubBridge,type EventSubBridge,type EventSubBridgeOptions} from '../eventsub/bridge.ts';
import type {EventSubStatus} from '../eventsub/messages.ts';

export interface RouteContext { studio:Studio; eventBus:EventBus<ComicToonsBusEvents> }

/** Every S4 feature has its own env flag. All default off except the !noink acknowledgement (see report). */
export interface ParticipationFlags { polls:boolean; twitchPolls:boolean; inkMe:boolean; catchup:boolean; hype:boolean; director:boolean; noink:boolean; botReplies:boolean }
export const FLAG_ENV:Record<keyof ParticipationFlags,{name:string;default:boolean}> = {
  polls:{name:'COMICTOONS_FLAG_POLLS',default:false},
  twitchPolls:{name:'COMICTOONS_FLAG_TWITCH_POLLS',default:false},
  inkMe:{name:'COMICTOONS_FLAG_INK_ME',default:false},
  catchup:{name:'COMICTOONS_FLAG_CATCHUP',default:false},
  hype:{name:'COMICTOONS_FLAG_HYPE',default:false},
  director:{name:'COMICTOONS_FLAG_DIRECTOR',default:false},
  noink:{name:'COMICTOONS_FLAG_NOINK',default:true},
  botReplies:{name:'COMICTOONS_FLAG_BOT_REPLIES',default:false},
};
export function readParticipationFlags(env:Record<string,string|undefined>=process.env):ParticipationFlags {
  const read=(key:keyof ParticipationFlags)=>{const value=readProductEnv(FLAG_ENV[key].name, env)?.trim();if(!value)return FLAG_ENV[key].default;return /^(1|true|on|yes)$/i.test(value);};
  return Object.fromEntries((Object.keys(FLAG_ENV) as (keyof ParticipationFlags)[]).map(key=>[key,read(key)])) as unknown as ParticipationFlags;
}
export function budgetPerHour(env:Record<string,string|undefined>=process.env):number {
  // A blank value (IMAGE_BUDGET_PER_HOUR= as copied from .env.example) reads as unset, never as 0.
  const set=(raw:string|undefined)=>raw?.trim()?raw.trim():undefined;
  const value=Number(set(readProductEnv('COMICTOONS_PANEL_BUDGET_PER_HOUR', env))??set(env.IMAGE_BUDGET_PER_HOUR)??12);
  return Number.isInteger(value)&&value>=0&&value<=600?value:12;
}

/** The Helix calls S4 needs. S1 owns the real client (twitch/helix.ts); until it lands S4 runs on the mock below. */
/**
 * End-of-life calls (T3b adds them to rewards.ts / predictions.ts as optional members with these exact
 * shapes; declared here too so the routes and the mock work with or without that slice).
 */
export interface HelixEndCalls {
  deleteCustomReward?(input:{rewardId:string}):Promise<void>;
  endPrediction?(input:{id:string;status:'RESOLVED'|'CANCELED'|'LOCKED';winningOutcomeId?:string}):Promise<void>;
}
export interface ParticipationHelix extends HelixPolls, HelixRewards, HelixPredictions, ChatSender, HelixEndCalls {}
export type MockHelixCall = {method:string;input:unknown};
/** In-memory Helix: no network. `affiliate:false` answers like Twitch does for a non-Affiliate channel. */
export function createMockHelix(options:{affiliate?:boolean}={}):ParticipationHelix&{calls:MockHelixCall[]} {
  const calls:MockHelixCall[]=[];let sequence=0;
  const gate=(method:string,input:unknown)=>{calls.push({method,input});if(options.affiliate===false)throw new Error('403: The broadcaster is not a partner or affiliate.');};
  return {calls,
    async createPoll(input){gate('createPoll',input);return {id:`mock-poll-${++sequence}`};},
    async createCustomReward(input){gate('createCustomReward',input);return {id:`mock-reward-${++sequence}`};},
    async updateRedemptionStatus(input){gate('updateRedemptionStatus',input);},
    async createPrediction(input){gate('createPrediction',input);const id=`mock-prediction-${++sequence}`;return {id,outcomes:input.outcomes.map((outcome,index)=>({id:`${id}-o${index+1}`,title:outcome.title}))};},
    async sendChatMessage(input){calls.push({method:'sendChatMessage',input});},
    async deleteCustomReward(input){gate('deleteCustomReward',input);},
    async endPrediction(input){gate('endPrediction',input);},
  };
}

/** 'missing': signed in to Twitch (EventSub live) but no real Helix client was handed over. */
export type HelixMode = 'twitch'|'mock'|'missing'|'none';
export const HELIX_MISSING_MESSAGE='Signed in to Twitch, but the live Twitch client is missing, so Ink me, Twitch polls and predictions are off.';
export interface ParticipationOptions { studio:StudioLike; bus:EventBus<ComicToonsBusEvents>; flags?:ParticipationFlags; helix?:ParticipationHelix|null; helixMode?:HelixMode; now?:()=>number; budgetPerHour?:number; log?:(message:string)=>void }

/** Wires the S4 features to the bus. Each handler runs only when its flag is on. */
export class Participation {
  readonly flags:ParticipationFlags; readonly optOuts=new OptOutLedger(); readonly budget:PanelBudget;
  readonly polls:CaptionPolls; readonly rewards:InkMeRewards; readonly catchup:CatchupTriggers; readonly hype:HypeAndPredictions; readonly director:DirectorDesk; readonly inkChat:InkChatRequests;
  received=0;
  private unsubscribe:(()=>void)[]=[];
  private recent=new Map<string,string>();
  private helix:ParticipationHelix|null;
  private helixMode:HelixMode;
  private helixSlots:{helix?:unknown}[]=[];
  constructor(private options:ParticipationOptions) {
    const now=options.now??(()=>Date.now());
    this.flags=options.flags??readParticipationFlags();
    this.budget=new PanelBudget(options.budgetPerHour??budgetPerHour(),now);
    const helix=options.helix??null;
    this.helix=helix;this.helixMode=helix?(options.helixMode??'mock'):'none';
    // Kept so useHelix() can swap the client the features call (they read deps.helix per call).
    const pollDeps={studio:options.studio,optOuts:this.optOuts,bus:options.bus,now,budget:this.budget,helix,useHelix:this.flags.twitchPolls};
    const rewardDeps={log:options.log,studio:options.studio,optOuts:this.optOuts,bus:options.bus,now,budget:this.budget,helix,recentLine:(user?:string)=>user?this.recent.get(user):undefined};
    const hypeDeps={studio:options.studio,bus:options.bus,now,helix,usePredictions:true};
    this.helixSlots=[pollDeps,rewardDeps,hypeDeps];
    this.polls=new CaptionPolls(pollDeps);
    this.rewards=new InkMeRewards(rewardDeps);
    this.catchup=new CatchupTriggers({bus:options.bus,optOuts:this.optOuts,now,reply:(message,parentId)=>this.reply(message,parentId)});
    this.hype=new HypeAndPredictions(hypeDeps);
    this.director=new DirectorDesk({studio:options.studio,now});
    // Ink me without channel points: on only while Twitch refuses the reward (not an Affiliate or Partner).
    this.inkChat=new InkChatRequests({studio:options.studio,optOuts:this.optOuts,bus:options.bus,now,budget:this.budget,active:()=>this.rewards.status==='unavailable',decisions:()=>this.director.log,recentLine:rewardDeps.recentLine});
    this.optOuts.onOptOut((user,name)=>{this.polls.forgetUser(user,name);if(user)this.recent.delete(user);void this.rewards.forgetUser(user,name);this.inkChat.forgetUser(user,name);});
    this.unsubscribe.push(options.bus.on('stream-event',event=>{void this.handle(event).catch(error=>options.log?.(`participation: ${error instanceof Error?error.message:String(error)}`));}));
    // S1 emits this once the broadcaster has connected (REQUEST 2): the reward is created then.
    this.unsubscribe.push(options.bus.on('twitch-connected',()=>{if(this.flags.inkMe)void this.rewards.connect();}));
    this.unsubscribe.push(options.bus.on('stream-online',()=>{this.rewards.newStream();this.inkChat.newStream();}));
    this.unsubscribe.push(options.bus.on('stream-offline',()=>{void this.rewards.cancelPending();}));
  }
  /** Injection point for a Helix client (T3b's real one once signed in; the mock otherwise). */
  useHelix(helix:ParticipationHelix|null,mode:HelixMode=helix?'twitch':'none'){
    const changed=mode!==this.helixMode;
    this.helix=helix;this.helixMode=helix?mode:(mode==='missing'?'missing':'none');
    for(const slot of this.helixSlots)slot.helix=helix;
    // A reward made on another client (e.g. the mock before sign-in) is not the channel's reward.
    if(changed&&this.rewards.status!=='creating'&&this.rewards.offReason!=='refund-failed'){
      this.rewards.status='idle';this.rewards.rewardId=undefined;this.rewards.error=undefined;
      // T3b's public offReason (not-affiliate, check-failed, ...) belongs to the old client too.
      const rewards=this.rewards as InkMeRewards&{offReason?:unknown};if(rewards.offReason!==undefined)rewards.offReason=undefined;
    }
  }
  get helixKind():HelixMode{return this.helixMode;}
  private reply(message:string,parentId?:string){
    if(!this.flags.botReplies||!this.helix)return;
    void this.helix.sendChatMessage({message,replyParentMessageId:parentId}).catch(()=>{});
  }
  /** `!ink no` rejected an Ink me cameo: cancel its redemption so the viewer's points are refunded. */
  private async settleRejectedCameo(panelId:string){
    const entry=unsettledCameoRedemption(this.rewards.redemptions,panelId);
    if(!entry)return;
    try{
      const settle=(this.rewards as {settleDecided?:()=>Promise<void>}).settleDecided;
      if(settle)await settle.call(this.rewards);
      else await this.rewards.resolve(entry.id,'cancel');
    }catch{/* the rewards module records a note on its own */}
  }
  async handle(raw:StreamEvent):Promise<void> {
    this.received+=1;
    const event=raw as ParticipationEvent;
    if(event.type==='chat'&&!event.withdraw){
      const command=parseCommand(event.text);
      // !noink is always honoured, whatever the flags say.
      if(isOptOutCommand(event.text,{moderator:isModerator(event)})){this.optOuts.add(event.user,event.name);if(this.flags.noink)this.reply('Opt-out noted. You will not be drawn or quoted.',event.id);return;}
      if(!command){if(!this.optOuts.has(event.user,event.name)){this.polls.noteChat(event);if(event.user&&event.text)this.recent.set(event.user,event.text);if(this.recent.size>2000)this.recent.delete(this.recent.keys().next().value!);}return;}
      if(command.kind==='vote'&&this.flags.polls){this.polls.vote(event,command.choice);return;}
      if(command.kind==='previously'&&this.flags.catchup){this.catchup.command(event);return;}
      if(command.kind==='ink-optin'&&this.flags.inkMe){this.inkChat.request(event);return;}
      if((command.kind==='ink-approve'||command.kind==='ink-reject')&&this.flags.director){
        const named=this.optOuts.has(event.user,event.name)?{...event,name:'a moderator'}:event;
        const result=this.director.chat(named,command.kind==='ink-approve'?'approve':'reject',this.flags.inkMe?this.inkChat.waiting():undefined);
        // A rejected cameo refunds the viewer who redeemed it; 'panelId' only exists when the director actually acted.
        if(command.kind==='ink-reject'&&this.flags.inkMe&&'panelId' in result)await this.settleRejectedCameo(result.panelId);
      }
      return;
    }
    // Prediction updates arrive as 'hype' (begin, resolved end) or 'moment' (progress, lock); see eventsub/map.ts.
    if(event.prediction){if(this.flags.hype)this.hype.onPrediction(event);return;}
    if(event.type==='raid'&&this.flags.catchup){this.catchup.raid(event);return;}
    if(event.type==='poll'&&this.flags.polls){this.polls.onTwitchPoll(event);return;}
    if(event.type==='redemption'&&this.flags.inkMe){await this.rewards.onRedemption(event);return;}
    if(this.flags.hype&&(event.type==='hype'||event.type==='hype_train_begin'||event.type==='hype_train_end')){
      await this.hype.onHype(event);
    }
  }
  tick(){
    if(this.flags.polls)this.polls.tick();
    if(this.flags.inkMe){this.rewards.tick();this.inkChat.tick();}
    if(this.flags.hype)this.hype.observe();
  }
  status(){
    return {received:this.received,flags:this.flags,helix:this.helixMode,budget:this.budget.view(),
      poll:this.flags.polls?(this.polls.view()??null):null,lastPollResult:this.flags.polls?(this.polls.lastResult??null):null,
      reward:this.flags.inkMe?this.rewardView():null,
      inkChat:this.flags.inkMe?this.inkChat.view():null,
      catchups:this.flags.catchup?this.catchup.history.slice(0,3):[],
      hype:this.flags.hype?this.hype.view():null,
      director:this.flags.director?{log:this.director.log.slice(0,5)}:null,
      optedOut:this.optOuts.size};
  }
  close(){for(const stop of this.unsubscribe)stop();this.unsubscribe=[];}
  /** The reward view, saying plainly when the real client is missing rather than "not connected". */
  rewardView(){
    const view=this.rewards.view();
    return this.helixMode==='missing'?{...view,status:view.status==='ready'?view.status:'unavailable' as const,error:HELIX_MISSING_MESSAGE}:view;
  }
  /** Ink me off: T3b's rewards.disable() when present, otherwise Delete Custom Reward on the current client. */
  async disableRewards():Promise<void>{
    const rewards=this.rewards as InkMeRewards&{disable?:()=>Promise<void>};
    if(typeof rewards.disable==='function'){await rewards.disable();return;}
    const id=rewards.rewardId;rewards.status='idle';rewards.error=undefined;
    if(!id)return;
    if(!this.helix?.deleteCustomReward){rewards.rewardId=undefined;return;}
    try{await this.helix.deleteCustomReward({rewardId:id});rewards.rewardId=undefined;}
    catch(error){rewards.error=`The Ink me reward could not be removed from Twitch (${error instanceof Error?error.message:'unknown error'}). Delete it on Twitch or try again.`;}
  }
  /** The open (ACTIVE or LOCKED) prediction, or a ParticipationInputError. */
  openPrediction():PredictionView{
    const prediction=this.hype.prediction;
    if(!prediction||(prediction.status!=='ACTIVE'&&prediction.status!=='LOCKED'))throw new ParticipationInputError(409,'No prediction is open.');
    return prediction;
  }
  /** End Prediction RESOLVED, then the punchline. The winner must be one of the prediction's outcomes. */
  async resolvePrediction(winningOutcomeId:string):Promise<PredictionView>{
    const prediction=this.openPrediction();
    if(!prediction.outcomes.some(outcome=>outcome.id===winningOutcomeId))throw new ParticipationInputError(400,'That outcome is not part of the prediction.');
    const hype=this.hype as HypeAndPredictions&{resolvePrediction?:(id:string)=>Promise<PredictionView>};
    if(typeof hype.resolvePrediction==='function')return hype.resolvePrediction(winningOutcomeId);
    await this.helix?.endPrediction?.({id:prediction.id,status:'RESOLVED',winningOutcomeId});
    this.hype.onPrediction({t:0,type:'hype',prediction:{id:prediction.id,status:'RESOLVED',winningOutcomeId,outcomes:prediction.outcomes.map(({id,title,users})=>({id,title,users}))}} as ParticipationEvent);
    return this.hype.prediction!;
  }
  /** End Prediction CANCELED: Twitch refunds every viewer. */
  async cancelPrediction():Promise<PredictionView>{
    const prediction=this.openPrediction();
    const hype=this.hype as HypeAndPredictions&{cancelPrediction?:()=>Promise<PredictionView>};
    if(typeof hype.cancelPrediction==='function')return hype.cancelPrediction();
    await this.helix?.endPrediction?.({id:prediction.id,status:'CANCELED'});
    prediction.status='CANCELED';
    return prediction;
  }
}

/** The live-link status safe for any reader: no session id; failures keep only type and fixed text. */
export function publicEventSubStatus(status:EventSubStatus&{signedIn:boolean}){
  const {sessionId:_sessionId,...rest}=status;void _sessionId;
  return {...rest,failed:rest.failed.map(({type,error})=>({type,error}))};
}

/** A request the engine refuses before any Helix call: 400 bad input, 409 wrong state. */
export class ParticipationInputError extends Error {
  constructor(readonly status:400|409,message:string){super(message);this.name='ParticipationInputError';}
}

const panelIdSchema={type:'string',minLength:1,maxLength:120};
// Mock phase: the plugin runs on the in-memory Helix. Tests may pass their own options.
/**
 * Live Twitch hand-over. Pass `twitchAuth` (and optionally a signed-in `helix`) as plugin options, or
 * emit 'twitch-auth' on the bus with the same payload; either starts the EventSub bridge, which puts
 * real events on the bus. Without either, nothing connects and the mock Helix stays in place.
 */
export interface TwitchHandover { auth?:TwitchAuthProvider; helix?:ParticipationHelix|null }
/**
 * `writeGuard`: the director-key check. At this base no guard exists in this plugin or in app.ts (the
 * server only listens on 127.0.0.1); the later app.ts boundary guards every non-GET/HEAD/OPTIONS
 * request under /api/participation/ plus GET/HEAD /api/participation/director. Passing the same
 * onRequest handler here applies exactly that rule inside this plugin, before body parsing.
 */
export interface ParticipationPluginOptions { participation?:Partial<ParticipationOptions>; env?:Record<string,string|undefined>; twitchAuth?:TwitchAuthProvider; eventSub?:Partial<Omit<EventSubBridgeOptions,'auth'|'bus'>>; writeGuard?:onRequestHookHandler }
/** The boundary rule: participation writes, plus the pending director desk read. */
export function isGuardedParticipationRequest(method:string,url:string):boolean {
  const path=url.split('?')[0]!;
  if(path!=='/api/participation'&&!path.startsWith('/api/participation/'))return false;
  if(!['GET','HEAD','OPTIONS'].includes(method))return true;
  return (method==='GET'||method==='HEAD')&&path==='/api/participation/director';
}

export const participationRoutes:FastifyPluginAsync<RouteContext&ParticipationPluginOptions> = async (app,{studio,eventBus,participation:overrides,env=process.env,twitchAuth,eventSub,writeGuard}) => {
  // An async guard (like the app's directorGuard) answers 401/403 itself and returns the reply.
  if(writeGuard)app.addHook('onRequest',async function(req,reply){
    if(!isGuardedParticipationRequest(req.method,req.url))return;
    return (writeGuard as (this:unknown,...args:Parameters<onRequestHookHandler>)=>unknown).call(this,req,reply,()=>{});
  });
  const flags=overrides?.flags??readParticipationFlags(env);
  const engine=new Participation({studio,bus:eventBus,flags,helix:overrides?.helix===undefined?createMockHelix():overrides.helix,helixMode:overrides?.helixMode,now:overrides?.now,budgetPerHour:overrides?.budgetPerHour??budgetPerHour(env),log:message=>app.log.warn(message)});
  const timer=setInterval(()=>engine.tick(),500);timer.unref();
  let bridge:EventSubBridge|undefined,bridgeAuth:TwitchAuthProvider|undefined;
  /** What GET /api/participation/eventsub reports after the sign-in was lost and the bridge stopped. */
  let signedOut:(EventSubStatus&{signedIn:boolean})|undefined;
  const live=(handover:TwitchHandover)=>{
    if(handover.helix!==undefined)engine.useHelix(handover.helix,handover.helix?'twitch':'none');
    if(!handover.auth)return;
    // Signed in without a real client: never let the in-memory mock pose as the channel (verdict-t3 flag 2).
    if(handover.helix===undefined&&engine.helixKind!=='twitch')engine.useHelix(null,'missing');
    bridge?.stop();signedOut=undefined;bridgeAuth=handover.auth;
    bridge=startEventSubBridge({auth:handover.auth,bus:eventBus,log:message=>app.log.warn(message),...eventSub});
  };
  const offHandover=eventBus.on('twitch-auth',payload=>live((payload??{}) as TwitchHandover));
  // The sign-in behind the running bridge was lost: stop it, so the Studio no longer reads Connected.
  const offSignedOut=eventBus.on('twitch-signed-out',payload=>{
    if(!bridge||(payload as {auth?:TwitchAuthProvider}|undefined)?.auth!==bridgeAuth)return;
    const last=bridge.status();bridge.stop();bridge=undefined;bridgeAuth=undefined;
    signedOut={state:'stopped',signedIn:false,subscribed:[],failed:[],revoked:last.revoked,reconnects:last.reconnects,notifications:last.notifications,lastError:'Twitch sign-in ended; sign in to Twitch again.'};
  });
  if(twitchAuth)live({auth:twitchAuth});
  app.addHook('onClose',async()=>{clearInterval(timer);offHandover();offSignedOut();bridge?.stop();bridge=undefined;engine.close();});
  const off=(reply:{code:(status:number)=>{send:(body:unknown)=>unknown}},flag:string)=>reply.code(404).send({error:`This feature is switched off. Set ${flag}=1 to turn it on.`});
  const fail=(reply:{code:(status:number)=>{send:(body:unknown)=>unknown}},error:unknown)=>reply.code(error instanceof ParticipationInputError?error.status:409).send({error:error instanceof Error?error.message:'That change could not be completed.'});
  // These actions take no input; a non-empty JSON body is a client mistake, not something to ignore.
  const noBody=(body:unknown)=>body!==undefined&&body!==null&&!(typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===0);
  const badBody=(reply:{code:(status:number)=>{send:(body:unknown)=>unknown}})=>reply.code(400).send({error:'This action takes no body.'});

  app.get('/api/participation/status',async()=>engine.status());
  // Live link state for the studio: never carries tokens.
  // Public read: the WebSocket session id is dropped and errors are fixed ComicToons text (verdict-t3 flag 4).
  app.get('/api/participation/eventsub',async()=>publicEventSubStatus(bridge?bridge.status():signedOut??{state:'idle',signedIn:false,subscribed:[],failed:[],revoked:[],reconnects:0,notifications:0}));
  app.post('/api/participation/polls',{schema:{body:{type:'object',additionalProperties:false,properties:{panelId:panelIdSchema,duration:{type:'integer',minimum:15,maximum:1800}}}}},async(req,reply)=>{
    if(!flags.polls)return off(reply,FLAG_ENV.polls.name);
    try{return await engine.polls.start((req.body??{}) as {panelId?:string;duration?:number});}catch(error){return fail(reply,error);}
  });
  app.post('/api/participation/polls/end',async(_req,reply)=>{
    if(!flags.polls)return off(reply,FLAG_ENV.polls.name);
    const result=engine.polls.finish();return result??reply.code(409).send({error:'No vote is running.'});
  });
  app.post('/api/participation/rewards/connect',async(_req,reply)=>{
    if(!flags.inkMe)return off(reply,FLAG_ENV.inkMe.name);
    // LIVE-FIX-1b: the press re-checks the sign-in even when the reward is already ready.
    await engine.rewards.connect({recheck:true});return engine.rewards.view();
  });
  // Ink me off (T3b R2): deletes the reward on Twitch; never throws (a failed delete keeps the id and says so).
  app.post('/api/participation/rewards/disconnect',async(req,reply)=>{
    if(!flags.inkMe)return off(reply,FLAG_ENV.inkMe.name);
    if(noBody(req.body))return badBody(reply);
    await engine.disableRewards();return engine.rewards.view();
  });
  // Prediction controls (T3b R2): resolve with one of the open prediction's outcome ids, or cancel (refund).
  app.post('/api/participation/predictions/start',async(req,reply)=>{
    if(!flags.hype)return off(reply,FLAG_ENV.hype.name);
    if(noBody(req.body))return badBody(reply);
    try{return await engine.hype.startPrediction();}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'Prediction unavailable.'});}
  });
  app.post('/api/participation/predictions/resolve',{schema:{body:{type:'object',additionalProperties:false,required:['outcomeId'],properties:{outcomeId:{type:'string',minLength:1,maxLength:120}}}}},async(req,reply)=>{
    if(!flags.hype)return off(reply,FLAG_ENV.hype.name);
    try{return await engine.resolvePrediction((req.body as {outcomeId:string}).outcomeId);}catch(error){return fail(reply,error);}
  });
  app.post('/api/participation/predictions/cancel',async(req,reply)=>{
    if(!flags.hype)return off(reply,FLAG_ENV.hype.name);
    if(noBody(req.body))return badBody(reply);
    try{return await engine.cancelPrediction();}catch(error){return fail(reply,error);}
  });
  app.post('/api/participation/redemptions/:id',{schema:{params:{type:'object',properties:{id:{type:'string',minLength:1,maxLength:120}}},body:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['fulfil','cancel']}}}}},async(req,reply)=>{
    if(!flags.inkMe)return off(reply,FLAG_ENV.inkMe.name);
    const {id}=req.params as {id:string};const {action}=req.body as {action:'fulfil'|'cancel'};
    try{return await engine.rewards.resolve(id,action);}catch(error){return fail(reply,error);}
  });
  app.post('/api/participation/catchup',async(_req,reply)=>{
    if(!flags.catchup)return off(reply,FLAG_ENV.catchup.name);
    return engine.catchup.streamer();
  });
  app.get('/api/participation/director',async()=>({enabled:flags.director,...(flags.director?engine.director.view():{pending:[],pendingCount:0,approvedCount:0,log:[]})}));
  app.post('/api/participation/director/:action',{schema:{params:{type:'object',properties:{action:{type:'string',enum:['approve','reject']}}},body:{type:'object',additionalProperties:false,required:['panelId'],properties:{panelId:panelIdSchema}}}},async(req,reply)=>{
    if(!flags.director)return off(reply,FLAG_ENV.director.name);
    const {action}=req.params as {action:'approve'|'reject'};const {panelId}=req.body as {panelId:string};
    try{return engine.director.phone(action,panelId);}catch(error){return fail(reply,error);}
  });
  // Mock phase only: lets a demo or screenshot push a fake Twitch event onto the bus. Off unless asked for.
  if(readProductEnv('COMICTOONS_PARTICIPATION_MOCK', env)==='1'){
    app.post('/api/participation/mock-event',{schema:{body:{type:'object',required:['type'],properties:{type:{type:'string',enum:['chat','raid','poll','redemption','hype','hype_train_begin','hype_train_end']}}}}},async req=>{eventBus.emit('stream-event',{t:0,...(req.body as object)} as StreamEvent);return {ok:true};});
    app.post('/api/participation/mock-connect',async()=>{eventBus.emit('twitch-connected',{});return {ok:true};});
  }
};
