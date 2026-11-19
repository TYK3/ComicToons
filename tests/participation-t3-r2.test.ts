import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify,{type FastifyReply,type FastifyRequest} from 'fastify';
import {createEventBus,type ComicPanel,type ComicToonsBusEvents} from '../packages/core/src/index.ts';
import type {ParticipationEvent,StudioLike} from '../apps/server/src/participation/commands.ts';
import {HELIX_MISSING_MESSAGE,Participation,createMockHelix,isGuardedParticipationRequest,participationRoutes,type ParticipationFlags} from '../apps/server/src/participation/routes.ts';
import type {Studio} from '../apps/server/src/studio.ts';
import {startEventSubBridge} from '../apps/server/src/eventsub/bridge.ts';
import {mapNotification} from '../apps/server/src/eventsub/map.ts';
import {comicToonsSubscriptions} from '../apps/server/src/eventsub/subscriptions.ts';
import type {SubscriptionCreator} from '../apps/server/src/eventsub/messages.ts';
import {FAKE_TOKEN,FakeClock,fakeAuth,flush,notification,recordingCreator,revocation,socketFactory,welcome} from './eventsub-fakes.ts';

// t3-r2: T3b's R2 routes (Ink me off, prediction resolve/cancel) behind the director guard, useHelix
// clearing offReason, and verdict-t3 flags 2-5. No network, no Twitch.
const ALL_ON:ParticipationFlags={polls:true,twitchPolls:true,inkMe:true,catchup:true,hype:true,director:true,noink:true,botReplies:false};
const KEY='test-director-key-r2';
const UNAUTHORISED={error:'Enter the director key to use this page.'};
const REMOTE={error:'Studio writes from another device need a key. Set COMICTOONS_DIRECTOR_KEY and restart ComicToons.'};

/** The director-key contract (director-key-contract.md): key → 401 when wrong or missing; no key → loopback only, else 403. */
function contractGuard(key:string|undefined){
  const loopback=(address:string)=>{const ip=address.toLowerCase().replace(/^::ffff:/,'');return ip==='::1'||/^127\./.test(ip);};
  return async (req:FastifyRequest,reply:FastifyReply)=>{
    if(key){if(req.headers['x-comictoons-director-key']===key)return;return reply.code(401).send(UNAUTHORISED);}
    const forwarded=String(req.headers['x-forwarded-for']??'').split(',').map(hop=>hop.trim()).filter(Boolean);
    if(loopback(req.socket.remoteAddress??'')&&forwarded.every(loopback))return;
    return reply.code(403).send(REMOTE);
  };
}
function fakeStudio():StudioLike{return {state:{panels:[] as ComicPanel[],pendingPanels:[] as ComicPanel[],elapsed:0,approvalMode:true},moderate(){},caption(){}};}
async function mount(options:{key?:string;guard?:boolean;flags?:Partial<ParticipationFlags>}={}){
  const bus=createEventBus<ComicToonsBusEvents>();const helix=createMockHelix();const app=Fastify();
  await app.register(participationRoutes,{studio:fakeStudio() as unknown as Studio,eventBus:bus,env:{},participation:{flags:{...ALL_ON,...options.flags},helix},...(options.guard===false?{}:{writeGuard:contractGuard(options.key)})});
  await app.ready();
  const post=(url:string,body?:unknown,headers:Record<string,string>={},remoteAddress?:string)=>app.inject({method:'POST',url,headers,...(body===undefined?{}:{payload:body as object}),...(remoteAddress?{remoteAddress}:{})});
  return {app,bus,helix,post,withKey:{'x-comictoons-director-key':KEY}};
}
const methods=(helix:ReturnType<typeof createMockHelix>,name:string)=>helix.calls.filter(call=>call.method===name);
async function openPrediction(m:Awaited<ReturnType<typeof mount>>){
  m.bus.emit('stream-event',{t:0,type:'hype_train_begin',level:1});await flush();
  const status=(await m.app.inject({method:'GET',url:'/api/participation/status'})).json();
  return status.hype.prediction as {id:string;outcomes:{id:string;title:string}[]};
}

test('t3-r2 rewards/disconnect: 401 without the key, 403 from another device, bad body 400, success deletes the reward on the Helix', async () => {
  const m=await mount({key:KEY});
  const denied=await m.post('/api/participation/rewards/disconnect');
  assert.equal(denied.statusCode,401);assert.deepEqual(denied.json(),UNAUTHORISED);
  assert.equal((await m.post('/api/participation/rewards/disconnect',{},{'x-comictoons-director-key':'wrong'})).statusCode,401);
  assert.equal(methods(m.helix,'deleteCustomReward').length,0,'the guard runs before the handler');
  const remote=await mount();
  const blocked=await remote.post('/api/participation/rewards/disconnect',undefined,{},'192.168.1.20');
  assert.equal(blocked.statusCode,403);assert.deepEqual(blocked.json(),REMOTE);
  await remote.app.close();
  assert.equal((await m.post('/api/participation/rewards/connect',undefined,m.withKey)).json().status,'ready');
  assert.equal(methods(m.helix,'createCustomReward').length,1);
  const bad=await m.post('/api/participation/rewards/disconnect',{rewardId:'x'},m.withKey);
  assert.equal(bad.statusCode,400,'no body fields are accepted');
  const done=await m.post('/api/participation/rewards/disconnect',undefined,m.withKey);
  assert.equal(done.statusCode,200);assert.equal(done.json().status,'idle');
  assert.deepEqual(methods(m.helix,'deleteCustomReward').map(call=>call.input),[{rewardId:'mock-reward-1'}]);
  const again=await m.post('/api/participation/rewards/disconnect',undefined,m.withKey);
  assert.equal(again.statusCode,200);assert.equal(methods(m.helix,'deleteCustomReward').length,1,'nothing left to delete');
  await m.app.close();
  const off=await mount({key:KEY,flags:{inkMe:false}});
  assert.equal((await off.post('/api/participation/rewards/disconnect',undefined,off.withKey)).statusCode,404);
  await off.app.close();
});

test('t3-r2 predictions/resolve: 401/403 first, schema and outcome validation, success sends End Prediction RESOLVED and letters the punchline', async () => {
  const m=await mount({key:KEY});
  assert.equal((await m.post('/api/participation/predictions/resolve',{outcomeId:'x'})).statusCode,401);
  const remote=await mount();
  assert.equal((await remote.post('/api/participation/predictions/resolve',{outcomeId:'x'},{},'10.0.0.7')).statusCode,403);
  await remote.app.close();
  assert.equal((await m.post('/api/participation/predictions/resolve',{outcomeId:'x'},m.withKey)).statusCode,409,'no prediction open');
  const prediction=await openPrediction(m);
  assert.equal((await m.post('/api/participation/predictions/resolve',{},m.withKey)).statusCode,400,'outcomeId is required');
  assert.equal((await m.post('/api/participation/predictions/resolve',{outcomeId:''},m.withKey)).statusCode,400);
  assert.equal((await m.post('/api/participation/predictions/resolve',{outcomeId:'o'.repeat(121)},m.withKey)).statusCode,400,'over 120 characters');
  assert.equal((await m.post('/api/participation/predictions/resolve',{outcomeId:{id:prediction.outcomes[0]!.id}},m.withKey)).statusCode,400,'must be a string');
  const foreign=await m.post('/api/participation/predictions/resolve',{outcomeId:'another-prediction-o1'},m.withKey);
  assert.equal(foreign.statusCode,400);assert.equal(foreign.json().error,'That outcome is not part of the prediction.');
  assert.equal(methods(m.helix,'endPrediction').length,0,'invalid input never reaches Twitch');
  const done=await m.post('/api/participation/predictions/resolve',{outcomeId:prediction.outcomes[0]!.id},m.withKey);
  assert.equal(done.statusCode,200);assert.equal(done.json().status,'RESOLVED');assert.equal(done.json().winner,'Yes');
  assert.deepEqual(methods(m.helix,'endPrediction').map(call=>call.input),[{id:prediction.id,status:'RESOLVED',winningOutcomeId:prediction.outcomes[0]!.id}]);
  assert.match((await m.app.inject({method:'GET',url:'/api/participation/status'})).json().hype.punchline.text,/THEY MADE IT/);
  assert.equal((await m.post('/api/participation/predictions/resolve',{outcomeId:prediction.outcomes[0]!.id},m.withKey)).statusCode,409,'already resolved');
  await m.app.close();
});

test('t3-r2 predictions/cancel: 401/403 first, bad body 400, success sends End Prediction CANCELED; nothing open is 409', async () => {
  const m=await mount({key:KEY});
  assert.equal((await m.post('/api/participation/predictions/cancel')).statusCode,401);
  const remote=await mount();
  assert.equal((await remote.post('/api/participation/predictions/cancel',undefined,{'x-forwarded-for':'203.0.113.9'})).statusCode,403,'a non-loopback forwarded hop is not local');
  await remote.app.close();
  assert.equal((await m.post('/api/participation/predictions/cancel',undefined,m.withKey)).statusCode,409);
  const prediction=await openPrediction(m);
  assert.equal((await m.post('/api/participation/predictions/cancel',{why:'x'},m.withKey)).statusCode,400);
  const done=await m.post('/api/participation/predictions/cancel',undefined,m.withKey);
  assert.equal(done.statusCode,200);assert.equal(done.json().status,'CANCELED');
  assert.deepEqual(methods(m.helix,'endPrediction').map(call=>call.input),[{id:prediction.id,status:'CANCELED'}]);
  assert.equal((await m.post('/api/participation/predictions/cancel',undefined,m.withKey)).statusCode,409,'already canceled');
  await m.app.close();
});

test('t3-r2 guard scope: same rule as the app boundary; reads stay public; with no guard passed the base behaviour is unchanged', async () => {
  for(const [method,url,guarded] of [['POST','/api/participation/rewards/disconnect',true],['POST','/api/participation/predictions/resolve',true],['POST','/api/participation/predictions/cancel',true],['POST','/api/participation/polls',true],['GET','/api/participation/director',true],['HEAD','/api/participation/director',true],['GET','/api/participation/status',false],['GET','/api/participation/eventsub',false],['OPTIONS','/api/participation/polls',false],['POST','/api/state',false]] as const)
    assert.equal(isGuardedParticipationRequest(method,url),guarded,`${method} ${url}`);
  const m=await mount({key:KEY});
  assert.equal((await m.app.inject({method:'GET',url:'/api/participation/status'})).statusCode,200);
  assert.equal((await m.app.inject({method:'GET',url:'/api/participation/director'})).statusCode,401);
  await m.app.close();
  const open=await mount({guard:false});
  assert.equal((await open.post('/api/participation/predictions/cancel',undefined,{},'192.168.1.20')).statusCode,409,'no guard at this base: only the 127.0.0.1 listener protects it');
  await open.app.close();
});

test('t3-r2 useHelix clears rewards.offReason along with status, rewardId and error', async () => {
  const engine=new Participation({studio:fakeStudio(),bus:createEventBus<ComicToonsBusEvents>(),flags:ALL_ON,helix:createMockHelix(),now:()=>0});
  const rewards=engine.rewards as typeof engine.rewards&{offReason?:string};
  rewards.status='unavailable';rewards.error='Ink me needs an Affiliate or Partner channel';rewards.offReason='not-affiliate';
  engine.useHelix(createMockHelix(),'twitch');
  assert.equal(rewards.offReason,undefined);assert.equal(rewards.status,'idle');assert.equal(rewards.error,undefined);
  engine.close();
});

test('t3-r2 verdict-t3 flag 2: a twitch-auth hand-over without a Helix client says the real client is missing; the mock never shows Ink me ready', async () => {
  const {sockets,factory}=socketFactory();const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();const mock=createMockHelix();
  const app=Fastify();
  await app.register(participationRoutes,{studio:fakeStudio() as unknown as Studio,eventBus:bus,env:{},participation:{flags:ALL_ON,helix:mock},eventSub:{socketFactory:factory,timers:clock,creator:recordingCreator(),now:()=>clock.now}});
  await app.ready();
  bus.emit('twitch-auth',{auth:fakeAuth()});await flush();
  sockets[0]!.send(welcome('s1'));await flush();await flush();
  const status=(await app.inject({method:'GET',url:'/api/participation/status'})).json();
  assert.equal(status.helix,'missing');
  assert.equal(status.reward.status,'unavailable');assert.equal(status.reward.error,HELIX_MISSING_MESSAGE);
  assert.equal(methods(mock,'createCustomReward').length,0,'twitch-connected did not create a reward on the mock');
  bus.emit('twitch-auth',{helix:createMockHelix()});await flush();
  assert.equal((await app.inject({method:'GET',url:'/api/participation/status'})).json().helix,'twitch','a later hand-over with a client fixes it');
  await app.close();
});

test('t3-r2 verdict-t3 flag 3: raid edge cases match the IRC raid path (t5) and core: Anonymous crew, dropped bad counts, t in seconds >= 0', () => {
  const raid=(event:Record<string,unknown>,t=4)=>mapNotification('channel.raid',{to_broadcaster_user_id:'1337',...event},'m1',t);
  assert.deepEqual(raid({from_broadcaster_user_name:'Cool_User',viewers:9001}),{kind:'stream-event',event:{id:'m1',t:4,type:'raid',from:'Cool_User',viewers:9001}});
  for(const from of ['','   ','<img src=x onerror=1>',undefined])
    assert.equal((raid({from_broadcaster_user_name:from,viewers:3}) as {event:{from:string}}).event.from,'Anonymous crew',`from ${JSON.stringify(from)}`);
  assert.equal((raid({from_broadcaster_user_name:'',from_broadcaster_user_login:'cool_user',viewers:3}) as {event:{from:string}}).event.from,'cool_user','login is the fallback, like msg-param-login');
  for(const viewers of [undefined,null,'lots',-1,1.5,Number.NaN,1e10,'12a'])
    assert.equal(raid({from_broadcaster_user_name:'X',viewers}),null,`viewers ${String(viewers)} drops the raid`);
  assert.equal((raid({from_broadcaster_user_name:'X',viewers:'15'}) as {event:{viewers:number}}).event.viewers,15);
  assert.equal((raid({from_broadcaster_user_name:'X',viewers:0}) as {event:{viewers:number}}).event.viewers,0);
  assert.equal((raid({from_broadcaster_user_name:'X',viewers:2},-3) as {event:{t:number}}).event.t,0);
  assert.equal((raid({from_broadcaster_user_name:'X',viewers:2},Number.NaN) as {event:{t:number}}).event.t,0);
});

test('t3-r2 verdict-t3 flag 3: the bridge stamps t as seconds since the session start it is given', async () => {
  const {sockets,factory}=socketFactory();const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();
  const events:{t:number;viewers?:number}[]=[];bus.on('stream-event',event=>events.push(event as {t:number}));
  const bridge=startEventSubBridge({auth:fakeAuth(),bus,socketFactory:factory,timers:clock,now:()=>clock.now,creator:recordingCreator(),startedAt:clock.now-2500});
  await flush();sockets[0]!.send(welcome('s1'));await flush();
  clock.advance(1500);
  sockets[0]!.send(notification('channel.raid',{from_broadcaster_user_name:'',viewers:7}));
  sockets[0]!.send(notification('channel.raid',{from_broadcaster_user_name:'Y',viewers:'many'}));
  assert.deepEqual(events.map(({t,viewers})=>({t,viewers})),[{t:4,viewers:7}]);
  bridge.stop();
});

test('t3-r2 verdict-t3 flag 4 (chose: strip): GET /api/participation/eventsub has no session id and no Twitch error or close text', async () => {
  const {sockets,factory}=socketFactory();const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();
  const twitchText='Twitch-side wording that echoes '+FAKE_TOKEN;
  const fetch=(async()=>new Response(JSON.stringify({error:'Bad Request',status:400,message:twitchText}),{status:400,headers:{'content-type':'application/json'}})) as typeof globalThis.fetch;
  const app=Fastify();
  await app.register(participationRoutes,{studio:fakeStudio() as unknown as Studio,eventBus:bus,env:{},participation:{flags:ALL_ON},twitchAuth:fakeAuth(),eventSub:{socketFactory:factory,timers:clock,fetch,now:()=>clock.now,backoffMs:()=>1000}});
  await flush();
  sockets[0]!.send(welcome('secret-session-id-42'));await flush(20);
  let body=(await app.inject({method:'GET',url:'/api/participation/eventsub'})).body;
  assert.ok(body.includes('"failed":[{'),'failures are still listed by type');
  assert.match(body,/Twitch refused the subscription \(400\)\./);
  for(const leak of ['secret-session-id-42','sessionId','Twitch-side wording',FAKE_TOKEN])assert.equal(body.includes(leak),false,leak);
  sockets[0]!.serverClose(4003,'Twitch close reason text');
  body=(await app.inject({method:'GET',url:'/api/participation/eventsub'})).body;
  assert.match(body,/EventSub closed the connection \(4003\)\./);
  assert.equal(body.includes('Twitch close reason text'),false);
  await app.close();
});

test('t3-r2 verdict-t3 flag 5: after authorization_revoked the state is revoked, not subscribed, until Twitch accepts a subscription again', async () => {
  const {sockets,factory}=socketFactory();const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();
  let refuse=false;const inner=recordingCreator();
  const creator:SubscriptionCreator={async createEventSubSubscription(input){if(refuse)throw new Error('Twitch sign-in expired; sign in again.');return inner.createEventSubSubscription(input);}};
  const revoked:unknown[]=[];bus.on('eventsub-revoked',payload=>revoked.push(payload));
  const bridge=startEventSubBridge({auth:fakeAuth(),bus,socketFactory:factory,timers:clock,now:()=>clock.now,creator,backoffMs:()=>1000});
  await flush();sockets[0]!.send(welcome('s1'));await flush();
  assert.equal(bridge.status().state,'subscribed');
  sockets[0]!.send(revocation('channel.cheer','user_removed'));
  assert.equal(bridge.status().state,'subscribed','other revocation reasons leave the link up');
  sockets[0]!.send(revocation('channel.raid','authorization_revoked'));
  assert.equal(bridge.status().state,'revoked');assert.match(bridge.status().lastError!,/sign in to Twitch again/);
  assert.equal(revoked.length,2);
  refuse=true;sockets[0]!.serverClose(4003);clock.advance(1000);
  sockets[1]!.send(welcome('s2'));await flush(10);
  assert.equal(bridge.status().state,'revoked','resubscribing without a new sign-in does not hide it');
  refuse=false;sockets[1]!.serverClose(4003);clock.advance(1000);
  sockets[2]!.send(welcome('s3'));await flush(10);
  assert.equal(bridge.status().state,'subscribed','accepted again after a new sign-in');
  bridge.stop();
});

/** Like fakeStudio, but moderate('reject', id) actually drops the panel, the way the real Studio does. */
function cameoStudio():StudioLike{
  const state={panels:[] as ComicPanel[],pendingPanels:[] as ComicPanel[],elapsed:0,approvalMode:true};
  return {state,moderate(kind,panelId){if(kind==='reject')state.pendingPanels=state.pendingPanels.filter(panel=>panel.id!==panelId);},caption(){}};
}

test('t3-r2 \'!ink no\' from a moderator rejects that viewer\'s pending cameo and refunds the redemption; nobody is opted out', async () => {
  const clock=1_000_000;
  const bus=createEventBus<ComicToonsBusEvents>();
  const studio=cameoStudio();
  const helix=createMockHelix();
  const engine=new Participation({studio,bus,flags:ALL_ON,helix,now:()=>clock});
  bus.emit('twitch-connected',{});await flush();
  const rewardId=engine.rewards.rewardId!;
  bus.emit('stream-event',{t:0,type:'redemption',user:'cool_viewer',name:'cool_viewer',redemption:{id:'r1',rewardId,userLogin:'cool_viewer'}} as ParticipationEvent);
  await flush();
  const cameoPanelId=engine.rewards.redemptions[0]!.panelId!;
  assert.ok(studio.state.pendingPanels.some(panel=>panel.id===cameoPanelId),'the cameo was drafted into the review queue');
  bus.emit('stream-event',{t:0,type:'chat',user:'mod1',name:'mod1',text:'!ink no',moderator:true} as ParticipationEvent);
  await flush();
  assert.equal(studio.state.pendingPanels.some(panel=>panel.id===cameoPanelId),false,'the cameo panel was rejected');
  assert.deepEqual(helix.calls.at(-1),{method:'updateRedemptionStatus',input:{rewardId,redemptionIds:['r1'],status:'CANCELED'}});
  assert.equal(engine.rewards.redemptions[0]!.status,'canceled');
  assert.equal(engine.optOuts.has('cool_viewer'),false);
  assert.equal(engine.optOuts.has('mod1'),false);

  // A non-moderator '!ink no' is ignored by the director, so nothing is settled.
  const bus2=createEventBus<ComicToonsBusEvents>();
  const studio2=cameoStudio();
  const helix2=createMockHelix();
  const engine2=new Participation({studio:studio2,bus:bus2,flags:ALL_ON,helix:helix2,now:()=>clock});
  bus2.emit('twitch-connected',{});await flush();
  const rewardId2=engine2.rewards.rewardId!;
  bus2.emit('stream-event',{t:0,type:'redemption',user:'cool_viewer',name:'cool_viewer',redemption:{id:'r2',rewardId:rewardId2,userLogin:'cool_viewer'}} as ParticipationEvent);
  await flush();
  const cameoPanelId2=engine2.rewards.redemptions[0]!.panelId!;
  bus2.emit('stream-event',{t:0,type:'chat',user:'viewer2',name:'viewer2',text:'!ink no'} as ParticipationEvent);
  await flush();
  assert.equal(helix2.calls.some(call=>call.method==='updateRedemptionStatus'),false,'non-mods never trigger a refund');
  assert.ok(studio2.state.pendingPanels.some(panel=>panel.id===cameoPanelId2),'the panel is still pending');
});

test('t3-r2 R5 stream.offline v1 is subscribed with broadcaster_user_id and no scopes', () => {
  const list=comicToonsSubscriptions('1337');
  const byType=Object.fromEntries(list.map(entry=>[entry.type,entry]));
  assert.deepEqual(byType['stream.offline']!,{type:'stream.offline',version:'1',condition:{broadcaster_user_id:'1337'},scopes:[]});
});

test('t3-r2 R5 map stream.offline: becomes a stream-offline signal, not a StreamEvent', () => {
  assert.deepEqual(mapNotification('stream.offline',{broadcaster_user_id:'1337'},'m-1',0),{kind:'stream-offline',payload:{broadcasterId:'1337'}});
});

test('t3-r2 R5 bridge emits stream-offline on the bus and no stream-event', async () => {
  const {sockets,factory}=socketFactory();const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();
  const events:unknown[]=[];const offline:unknown[]=[];
  bus.on('stream-event',event=>events.push(event));bus.on('stream-offline',payload=>offline.push(payload));
  const bridge=startEventSubBridge({auth:fakeAuth(),bus,socketFactory:factory,timers:clock,now:()=>clock.now,creator:recordingCreator(),backoffMs:()=>1000});
  await flush();
  sockets[0]!.send(welcome('s1'));await flush();
  sockets[0]!.send(notification('stream.offline',{broadcaster_user_id:'1337'}));
  assert.deepEqual(offline,[{broadcasterId:'1337'}]);
  assert.equal(events.length,0,'stream.offline is not a stream-event');
  bridge.stop();
});
