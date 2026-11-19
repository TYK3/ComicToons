import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {createEventBus,type ComicPanel,type ComicToonsBusEvents,type EventBus} from '../packages/core/src/index.ts';
import type {StudioLike} from '../apps/server/src/participation/commands.ts';
import {Participation,createMockHelix,participationRoutes,type ParticipationFlags} from '../apps/server/src/participation/routes.ts';
import {startEventSubBridge} from '../apps/server/src/eventsub/bridge.ts';
import type {Studio} from '../apps/server/src/studio.ts';
import {FAKE_TOKEN,FakeClock,fakeAuth,flush,notification,recordingCreator,socketFactory,welcome} from './eventsub-fakes.ts';

// T3: real EventSub notifications (from fake sockets) drive participation. No network, no Twitch.
const ALL_ON:ParticipationFlags={polls:true,twitchPolls:true,inkMe:true,catchup:true,hype:true,director:true,noink:true,botReplies:true};
function panel(id:string,dialogue:string[]=[]):ComicPanel{return {id,caption:`Panel ${id}`,dialogue,scene:'scene',characters:[],mood:'calm',altText:'alt',imageUrl:'/art/x.png',at:0};}
function fakeStudio():StudioLike&{log:string[]}{
  const log:string[]=[];
  const studio={log,state:{panels:[] as ComicPanel[],pendingPanels:[] as ComicPanel[],elapsed:0,approvalMode:true},
    moderate(kind:'approve'|'reject',panelId?:string){const chosen=studio.state.pendingPanels.find(entry=>entry.id===panelId);if(!chosen)throw new Error('no such panel');studio.state.pendingPanels=studio.state.pendingPanels.filter(entry=>entry!==chosen);if(kind==='approve')studio.state.panels.push(chosen);log.push(`${kind}:${panelId}`);},
    caption(panelId:string,caption:string){const target=studio.state.pendingPanels.find(entry=>entry.id===panelId);if(!target)throw new Error('gone');target.caption=caption;log.push(`caption:${panelId}:${caption}`);}};
  return studio;
}
function live(flags:Partial<ParticipationFlags>={}){
  const clock=new FakeClock();const bus:EventBus<ComicToonsBusEvents>=createEventBus<ComicToonsBusEvents>();const studio=fakeStudio();
  const helix=createMockHelix();
  const engine=new Participation({studio,bus,flags:{...ALL_ON,...flags},helix,now:()=>clock.now,budgetPerHour:12});
  const {sockets,factory}=socketFactory();
  const bridge=startEventSubBridge({auth:fakeAuth(),bus,socketFactory:factory,timers:clock,now:()=>clock.now,creator:recordingCreator(),backoffMs:()=>1000});
  const seen:{channel:string;payload:unknown}[]=[];
  for(const channel of ['catchup','poll-started','poll-result','cameo','hype-splash','punchline'])bus.on(channel,payload=>seen.push({channel,payload}));
  let n=0;
  const send=(type:string,event:Record<string,unknown>,version='1')=>sockets.at(-1)!.send(notification(type,event,version));
  const chat=(user:string,text:string,badges:string[]=[])=>send('channel.chat.message',{chatter_user_id:user,chatter_user_login:user,chatter_user_name:user,message_id:`chat-${user}-${++n}`,message:{text},badges:badges.map(set_id=>({set_id,id:'1',info:''}))});
  const ready=async()=>{await flush();sockets[0]!.send(welcome('s1'));await flush();};
  return {clock,bus,studio,helix,engine,bridge,sockets,seen,send,chat,ready};
}

test('participation T3 P0-8: live EventSub chat !1/!2 votes reach the caption poll', async () => {
  const l=live({twitchPolls:false});await l.ready();
  l.studio.state.pendingPanels.push(panel('p1'));
  l.chat('ann','the dragon ate the map');l.chat('bob','roll for initiative');l.chat('cy','who brought snacks');
  await flush();
  const poll=await l.engine.polls.start({panelId:'p1',duration:30});
  assert.equal(poll.mode,'chat');
  l.chat('v1','!1');l.chat('v2','!2');l.chat('v3','!2');await flush();
  assert.equal(l.engine.polls.view()!.total,3);
  assert.deepEqual(l.engine.polls.view()!.choices.map(choice=>choice.votes),[0,1,2].map(index=>[1,2,0][index]));
  l.bridge.stop();l.engine.close();
});

test('participation T3 P0-8: live !previously, moderator !ink yes, and !noink/!optout keep working', async () => {
  const l=live();await l.ready();
  l.chat('ann','!previously');await flush();
  assert.equal(l.seen.filter(entry=>entry.channel==='catchup').length,1);
  l.studio.state.pendingPanels.push(panel('p9'));
  l.chat('pleb','!ink yes');await flush();
  assert.deepEqual(l.studio.log,[],'a viewer cannot approve');
  l.chat('mod','!ink yes',['moderator']);await flush();
  assert.deepEqual(l.studio.log,['approve:p9'],'the moderator badge from EventSub counts');
  l.chat('dan','!noink');l.chat('eve','!optout');await flush();
  assert.ok(l.engine.optOuts.has('dan')&&l.engine.optOuts.has('eve'));
  assert.equal(l.helix.calls.filter(call=>call.method==='sendChatMessage'&&/Opt-out noted/.test((call.input as {message:string}).message)).length,2,'opt-outs acknowledged (bot replies on)');
  l.bridge.stop();l.engine.close();
});

test('participation T3 P0-5: a live raid notification triggers the raid catch-up', async () => {
  const l=live();await l.ready();
  l.send('channel.raid',{from_broadcaster_user_name:'MoonlightCrew',to_broadcaster_user_id:'1337',viewers:42});await flush();
  const catchup=l.seen.find(entry=>entry.channel==='catchup')!.payload as {reason:string;raider?:string;viewers?:number};
  assert.equal(catchup.reason,'raid');assert.equal(catchup.raider,'MoonlightCrew');assert.equal(catchup.viewers,42);
  l.bridge.stop();l.engine.close();
});

test('participation T3 P0-5/P0-7: twitch-connected from the first session creates Ink me, and a live redemption drafts a cameo', async () => {
  const l=live();await l.ready();await flush();
  assert.equal(l.engine.rewards.status,'ready','reward created on the injected Helix when the live link came up');
  assert.equal(l.helix.calls.filter(call=>call.method==='createCustomReward').length,1);
  l.send('channel.channel_points_custom_reward_redemption.add',{id:'r1',user_id:'9001',user_login:'cooler_user',user_name:'Cooler_User',user_input:'',status:'unfulfilled',reward:{id:l.engine.rewards.rewardId,title:'Ink me',cost:500}});
  await flush();
  assert.equal(l.engine.rewards.redemptions[0]!.status,'drafted');
  assert.equal(l.seen.filter(entry=>entry.channel==='cameo').length,1);
  l.bridge.stop();l.engine.close();
});

test('participation T3 N8: stream.online from EventSub emits stream-online and resets "1 per viewer per stream"', async () => {
  const l=live();await l.ready();await flush();
  const online:unknown[]=[];l.bus.on('stream-online',payload=>online.push(payload));
  const redeem=(id:string)=>l.send('channel.channel_points_custom_reward_redemption.add',{id,user_id:'9001',user_login:'cooler_user',user_name:'Cooler_User',status:'unfulfilled',reward:{id:l.engine.rewards.rewardId}});
  redeem('r1');await flush();
  l.clock.advance(301_000);redeem('r2');await flush();
  assert.equal(l.engine.rewards.redemptions[0]!.note,'Refunded: 1 per viewer per stream.');
  l.send('stream.online',{id:'s',broadcaster_user_id:'1337',type:'live',started_at:'2026-10-31T02:00:00Z'});
  assert.equal(online.length,1);
  l.clock.advance(301_000);redeem('r3');await flush();
  assert.equal(l.engine.rewards.redemptions[0]!.status,'drafted','a new stream lets the same viewer redeem again');
  l.bridge.stop();l.engine.close();
});

test('participation T3 P0-5: live channel.poll.progress/end update and settle a Twitch poll', async () => {
  const l=live();await l.ready();
  l.studio.state.pendingPanels.push(panel('p1'));
  l.chat('ann','the dragon ate the map');l.chat('bob','roll for initiative');await flush();
  const poll=await l.engine.polls.start({panelId:'p1',duration:30});
  assert.equal(poll.mode,'twitch');
  const choices=(votes:number[])=>poll.choices.map((choice,index)=>({id:`c${index}`,title:choice.title,votes:votes[index]}));
  l.send('channel.poll.progress',{id:poll.id,title:poll.question,choices:choices([1,4])});await flush();
  assert.equal(l.engine.polls.view()!.total,5);
  l.send('channel.poll.end',{id:poll.id,title:poll.question,choices:choices([2,7]),status:'completed'});await flush();
  assert.equal(l.engine.polls.lastResult!.outcome,'applied');
  assert.equal(l.engine.polls.lastResult!.caption,poll.choices[1]!.caption,'the choice with the most Twitch votes wins');
  l.bridge.stop();l.engine.close();
});

test('participation T3 N8/P0-5: hype train begin opens a prediction; live prediction progress and end letter the punchline', async () => {
  const l=live();await l.ready();
  l.send('channel.hype_train.begin',{id:'h',level:2,total:100},'2');await flush();
  assert.equal(l.engine.hype.hype!.level,2);
  const prediction=l.engine.hype.prediction!;assert.ok(prediction,'prediction created on the Helix');
  const outcomes=(users:number[])=>prediction.outcomes.map((outcome,index)=>({id:outcome.id,title:outcome.title,users:users[index]}));
  l.send('channel.prediction.progress',{id:prediction.id,title:prediction.title,outcomes:outcomes([3,1])});await flush();
  assert.deepEqual(l.engine.hype.prediction!.outcomes.map(outcome=>outcome.users),[3,1]);
  l.send('channel.prediction.lock',{id:prediction.id,title:prediction.title,outcomes:outcomes([3,1])});await flush();
  assert.equal(l.engine.hype.prediction!.status,'LOCKED');
  l.send('channel.prediction.end',{id:prediction.id,title:prediction.title,outcomes:outcomes([3,1]),winning_outcome_id:prediction.outcomes[0]!.id,status:'resolved'});await flush();
  assert.equal(l.engine.hype.prediction!.status,'RESOLVED');
  assert.equal(l.engine.hype.punchline!.text,'THEY MADE IT! 3 called it.');
  l.studio.state.pendingPanels.push(panel('next'));l.engine.tick();
  assert.equal(l.engine.hype.punchline!.panelId,'next');
  l.bridge.stop();l.engine.close();
});

test('participation T3 P0-6 injection: useHelix swaps the client every feature calls, and status reports it', async () => {
  const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();const studio=fakeStudio();
  const mock=createMockHelix();const engine=new Participation({studio,bus,flags:ALL_ON,helix:mock,now:()=>clock.now,budgetPerHour:12});
  assert.equal(engine.status().helix,'mock');
  await engine.rewards.connect();assert.equal(engine.rewards.rewardId!.startsWith('mock-reward'),true);
  const signedIn=createMockHelix();engine.useHelix(signedIn,'twitch');
  assert.equal(engine.status().helix,'twitch');
  assert.equal(engine.rewards.status,'idle','a mock reward is not the channel reward once signed in');
  await engine.rewards.connect();
  assert.equal(signedIn.calls.filter(call=>call.method==='createCustomReward').length,1);
  bus.emit('stream-event',{t:0,type:'hype_train_begin',level:1});await flush();
  assert.equal(signedIn.calls.filter(call=>call.method==='createPrediction').length,1);
  engine.useHelix(null);assert.equal(engine.status().helix,'none');
  engine.close();
});

test('participation T3 routes: twitchAuth plugin option starts EventSub; status routes never carry the token; not signed in stays idle', async () => {
  const {sockets,factory}=socketFactory();const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();
  const app=Fastify();
  await app.register(participationRoutes,{studio:fakeStudio() as unknown as Studio,eventBus:bus,env:{},participation:{flags:ALL_ON},twitchAuth:fakeAuth(),eventSub:{socketFactory:factory,timers:clock,creator:recordingCreator(),now:()=>clock.now}});
  await flush();
  sockets[0]!.send(welcome('s1'));await flush();
  const eventsub=await app.inject({method:'GET',url:'/api/participation/eventsub'});
  assert.equal(eventsub.json().state,'subscribed');assert.equal(eventsub.json().signedIn,true);
  assert.equal(eventsub.body.includes(FAKE_TOKEN),false);
  const status=await app.inject({method:'GET',url:'/api/participation/status'});
  assert.equal(status.json().helix,'missing','signed in without a real Helix: the mock no longer stands in');
  assert.equal(status.json().reward.status,'unavailable');
  await app.close();
  assert.equal(sockets[0]!.closedWith,1000,'closing the app closes the live socket');
  const quiet=Fastify();
  await quiet.register(participationRoutes,{studio:fakeStudio() as unknown as Studio,eventBus:createEventBus<ComicToonsBusEvents>(),env:{}});
  assert.equal((await quiet.inject({method:'GET',url:'/api/participation/eventsub'})).json().state,'idle');
  await quiet.close();
});

test('participation T3 routes: a twitch-auth bus hand-over attaches the signed-in Helix and starts EventSub', async () => {
  const {sockets,factory}=socketFactory();const clock=new FakeClock();const bus=createEventBus<ComicToonsBusEvents>();
  const app=Fastify();
  await app.register(participationRoutes,{studio:fakeStudio() as unknown as Studio,eventBus:bus,env:{},participation:{flags:ALL_ON},eventSub:{socketFactory:factory,timers:clock,creator:recordingCreator(),now:()=>clock.now}});
  await app.ready();
  const real=createMockHelix();
  bus.emit('twitch-auth',{auth:fakeAuth(),helix:real});await flush();
  assert.equal(sockets.length,1);
  sockets[0]!.send(welcome('s1'));await flush();await flush();
  assert.equal((await app.inject({method:'GET',url:'/api/participation/status'})).json().helix,'twitch');
  assert.equal(real.calls.filter(call=>call.method==='createCustomReward').length,1,'Ink me created live on the signed-in client');
  await app.close();
});
