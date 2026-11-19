import assert from 'node:assert/strict';
import test from 'node:test';
import {createEventBus,type ComicPanel,type ComicToonsBusEvents,type EventBus} from '@comictoons/core';
import type {StudioLike,ParticipationEvent} from '../apps/server/src/participation/commands.ts';
import {Participation,createMockHelix,type ParticipationFlags} from '../apps/server/src/participation/routes.ts';
import {chaosSource} from './ingest-chaos-fixture.ts';
import {liveAppFixture} from './twitch-live-app-fixture.ts';

// T12: Ink me on a channel that is not an Affiliate or Partner (broadcaster_type ''). Twitch refuses
// the channel-points reward, so viewers ask with `!ink` in chat and a mod or the broadcaster answers
// with `!ink yes` / `!ink no`. IRC fake and in-memory Helix only: no network, no real Twitch.
const ON:ParticipationFlags={polls:false,twitchPolls:false,inkMe:true,catchup:false,hype:false,director:true,noink:true,botReplies:false};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const privmsg=(id:string,login:string,text:string,tags='mod=0')=>`@id=${id};user-id=${login}-id;display-name=${login[0]!.toUpperCase()}${login.slice(1)};${tags} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #approved_test :${text}\r\n`;

async function nonAffiliateApp(){
  const irc=chaosSource();
  const calls:string[]=[];
  const f=await liveAppFixture({adapterFactory:()=>irc.adapter,env:{COMICTOONS_FLAG_INK_ME:'1',COMICTOONS_FLAG_DIRECTOR:'1'},helix:{fetch:async input=>{
    const path=new URL(String(input)).pathname;calls.push(path);
    assert.equal(path,'/helix/users','a non-Affiliate never creates a channel-points reward');
    return Response.json({data:[{id:'1337',login:'streamer',display_name:'Streamer',broadcaster_type:''}]});
  }}});
  await f.startIRC();irc.welcome();irc.feed(privmsg('warm','moss','Chat establishes liveness.'));
  await f.signIn();await f.welcome();await flush();await flush();
  const status=async()=>(await f.app.inject('/api/participation/status')).json();
  return {irc,f,calls,status};
}

test('INK-FB-1: non-Affiliate requests queue honestly and a mod cannot release placeholder art',async()=>{
  const {irc,f,calls,status}=await nonAffiliateApp();
  try{
    const before=await status();
    assert.equal(before.reward.status,'unavailable','Twitch refused the reward');
    assert.match(before.reward.error,/Affiliate or Partner/i);
    assert.deepEqual(calls,['/helix/users'],'the real client checks channel eligibility before any reward creation');
    assert.equal(before.inkChat?.active,true,'the !ink chat fallback is on');
    irc.feed(privmsg('ask-1','juniper','!ink'));await flush();
    let state=await f.state();
    const cameo=state.pendingPanels.find((panel:ComicPanel)=>panel.cameo==='juniper');
    assert.ok(cameo,'viewer !ink drafted a cameo into the review queue');
    assert.equal(cameo.caption,'Ink request from Juniper');
    assert.ok(cameo.releaseBlocked);
    assert.equal(state.panels.length,0,'nothing reaches the overlay without review');
    const queued=(await status()).inkChat.requests;
    assert.deepEqual(queued.map((entry:{name:string;status:string})=>[entry.name,entry.status]),[['Juniper','drafted']]);
    irc.feed(privmsg('fake-yes','orbit','!ink yes'));await flush();
    state=await f.state();
    assert.ok(state.pendingPanels.some((panel:ComicPanel)=>panel.id===cameo.id),'a viewer cannot approve');
    assert.ok(!state.pendingPanels.concat(state.panels).some((panel:ComicPanel)=>panel.dialogue.some(line=>/^!ink/i.test(line))),'an !ink command is never quoted in a panel');
    irc.feed(privmsg('mod-yes','moss','!ink yes','mod=1'));await flush();
    state=await f.state();
    assert.deepEqual(state.panels,[],'a moderator cannot release library art as a completed cameo');
    assert.ok(state.pendingPanels.some((panel:ComicPanel)=>panel.id===cameo.id));
    assert.ok(!state.pendingPanels.some((panel:ComicPanel)=>panel.dialogue.some(line=>/^!ink/i.test(line))),'the mod command did not open a quoted panel');
    const after=await status();
    assert.equal(after.inkChat.requests[0].status,'drafted');
    assert.equal(after.optedOut,0);
  }finally{await f.close();}
});

test('INK-FB-2: the broadcaster !ink no rejects the cameo and never opts anyone out',async()=>{
  const {irc,f,status}=await nonAffiliateApp();
  try{
    irc.feed(privmsg('ask-2','juniper','!ink'));await flush();
    const cameo=(await f.state()).pendingPanels.find((panel:ComicPanel)=>panel.cameo==='juniper');
    assert.ok(cameo);
    irc.feed(privmsg('own-no','streamer','!ink no','badges=broadcaster/1;mod=0'));await flush();
    const state=await f.state();
    assert.ok(!state.pendingPanels.concat(state.panels).some((panel:ComicPanel)=>panel.id===cameo.id),'the cameo was rejected');
    const after=await status();
    assert.equal(after.inkChat.requests[0].status,'rejected');
    assert.equal(after.optedOut,0,'!ink no is not !noink');
    // The broadcaster and the viewer can both still be quoted after the rejection.
    irc.feed(privmsg('own-line','streamer','Next round is on me.','badges=broadcaster/1;mod=0'));
    irc.feed(privmsg('viewer-line','juniper','Worth a try.'));await flush();
    const lines=(await f.state()).pendingPanels.flatMap((panel:ComicPanel)=>panel.dialogue);
    assert.ok(lines.includes('Next round is on me.'));
    assert.ok(lines.includes('Worth a try.'));
  }finally{await f.close();}
});

function fakeStudio():StudioLike{
  const studio={state:{panels:[] as ComicPanel[],pendingPanels:[] as ComicPanel[],elapsed:0,approvalMode:true},
    moderate(kind:'approve'|'reject',panelId?:string){const chosen=studio.state.pendingPanels.find(entry=>entry.id===panelId);if(!chosen)throw new Error('no such panel');studio.state.pendingPanels=studio.state.pendingPanels.filter(entry=>entry!==chosen);if(kind==='approve')studio.state.panels.push(chosen);},
    caption(){}};
  return studio;
}
async function engine(options:{affiliate?:boolean;budget?:number;flags?:Partial<ParticipationFlags>}={}){
  let clock=1_000_000;
  const bus:EventBus<ComicToonsBusEvents>=createEventBus<ComicToonsBusEvents>();const studio=fakeStudio();
  const helix=createMockHelix({affiliate:options.affiliate??false});
  const p=new Participation({studio,bus,flags:{...ON,...options.flags},helix,now:()=>clock,budgetPerHour:options.budget??12});
  const cameos:unknown[]=[];bus.on('cameo',payload=>cameos.push(payload));
  bus.emit('twitch-connected',{});await flush();
  let n=0;
  const chat=async(user:string,text:string,extra:Partial<ParticipationEvent>={})=>{bus.emit('stream-event',{id:`m${++n}`,t:0,type:'chat',user:`${user}-id`,name:user,text,...extra} as ParticipationEvent);await flush();};
  return {p,studio,helix,cameos,chat,advance:(ms:number)=>{clock+=ms;}};
}
const requests=(p:Participation)=>p.status().inkChat!.requests.map(entry=>`${entry.name}:${entry.status}`);

test('INK-FB-3: one cameo per viewer per stream, a 5-minute global cooldown, and opted-out viewers are never drawn',async()=>{
  const {p,studio,chat,advance,cameos}=await engine();
  await chat('Juniper','!ink');
  await chat('Juniper','!ink');
  assert.equal(studio.state.pendingPanels.length,1,'a repeat !ink is ignored');
  await chat('Orbit','!ink');
  assert.equal(studio.state.pendingPanels.length,1,'the cooldown holds the next viewer');
  assert.match(p.status().inkChat!.note??'',/cooldown/i);
  advance(5*60_000);
  await chat('Juniper','!ink');
  assert.equal(studio.state.pendingPanels.length,1,'still one per viewer per stream after the cooldown');
  await chat('Orbit','!ink');
  assert.equal(studio.state.pendingPanels.length,2);
  await chat('Moss','!noink');advance(5*60_000);
  await chat('Moss','!ink');
  assert.equal(studio.state.pendingPanels.length,2,'an opt-out is sticky: a later !ink does not draw them');
  assert.deepEqual(requests(p),['Orbit:drafted','Juniper:drafted']);
  assert.equal(cameos.length,2);
  p.rewards.newStream();p.inkChat.newStream();advance(5*60_000);
  await chat('Juniper','!ink');
  assert.equal(studio.state.pendingPanels.length,3,'a new stream resets the per-viewer limit');
});

test('INK-FB-4: !noink after asking removes the cameo; a used-up budget waits, then drafts on tick',async()=>{
  const {p,studio,chat,advance}=await engine({budget:1});
  await chat('Juniper','!ink');
  assert.equal(studio.state.pendingPanels.length,1);
  await chat('Juniper','!noink');
  assert.equal(studio.state.pendingPanels.length,0,'the cameo leaves the review queue');
  assert.deepEqual(requests(p),['Opted-out viewer:withdrawn']);
  advance(5*60_000);
  await chat('Orbit','!ink');
  assert.equal(studio.state.pendingPanels.length,0,'budget used up: waiting, not lost');
  assert.deepEqual(requests(p)[0],'Orbit:queued');
  advance(3_600_000);p.tick();
  assert.equal(studio.state.pendingPanels.length,1);
  assert.deepEqual(requests(p)[0],'Orbit:drafted');
});

test('INK-FB-5: the chat fallback stays off when the reward exists, and when Ink me is switched off',async()=>{
  const affiliate=await engine({affiliate:true});
  assert.equal(affiliate.p.rewards.status,'ready');
  await affiliate.chat('Juniper','!ink');
  assert.equal(affiliate.studio.state.pendingPanels.length,0,'Affiliates use channel points, not !ink');
  assert.equal(affiliate.p.status().inkChat!.active,false);
  const off=await engine({flags:{inkMe:false}});
  await off.chat('Juniper','!ink');
  assert.equal(off.studio.state.pendingPanels.length,0);
  assert.equal(off.p.status().inkChat,null);
});

test('INK-FB-6: a mod !ink yes approves only when the director flag is on, and !ink no never opts the mod out',async()=>{
  const {p,studio,chat}=await engine({flags:{director:false}});
  await chat('Juniper','!ink');
  await chat('Moss','!ink yes',{moderator:true});
  assert.equal(studio.state.panels.length,0,'director mode off: chat cannot approve');
  const on=await engine();
  await on.chat('Juniper','!ink');
  await on.chat('Moss','!ink no',{moderator:true});
  assert.equal(on.studio.state.pendingPanels.length,0);
  assert.equal(on.p.optOuts.has('Moss-id','Moss'),false);
  assert.deepEqual(requests(on.p),['Juniper:rejected']);
  void p;
});

test('INK-FB-7: !ink yes and !ink no are commands, never chat lines quoted in a draft panel',async()=>{
  const {irc,f}=await nonAffiliateApp();
  try{
    irc.feed(privmsg('mod-yes-7','moss','!ink yes','mod=1'));
    irc.feed(privmsg('own-no-7','streamer','!INK no','badges=broadcaster/1;mod=0'));
    irc.feed(privmsg('line-7','juniper','That was close.'));await flush();
    const state=await f.state();
    const lines=state.pendingPanels.concat(state.panels).flatMap((panel:ComicPanel)=>panel.dialogue);
    assert.ok(lines.includes('That was close.'),'ordinary chat is still drafted');
    assert.deepEqual(lines.filter((line:string)=>/^!ink/i.test(line)),[]);
  }finally{await f.close();}
});

test('INT-FID-T12-MOCK-403: mock Helix hand-over preserves the passed non-Affiliate chat fallback',async()=>{
  const {default:Fastify}=await import('fastify');
  const {Studio}=await import('../apps/server/src/studio.ts');
  const {participationRoutes}=await import('../apps/server/src/participation/routes.ts');
  const bus=createEventBus<ComicToonsBusEvents>(),studio=new Studio(),helix=createMockHelix({affiliate:false});
  const app=Fastify();
  await app.register(participationRoutes,{studio,eventBus:bus,env:{COMICTOONS_FLAG_INK_ME:'1',COMICTOONS_FLAG_DIRECTOR:'1'}});
  try{
    await app.ready();
    bus.emit('twitch-auth',{helix});bus.emit('twitch-connected',{});await flush();
    const before=(await app.inject('/api/participation/status')).json();
    assert.equal(before.reward.status,'unavailable');
    assert.match(before.reward.error,/partner or affiliate/i);
    assert.ok(helix.calls.some(call=>call.method==='createCustomReward'),'mock 403 follows the original reward-create path');
    bus.emit('stream-event',{id:'mock-request',t:1,type:'chat',user:'mock-user',name:'TestViewer',text:'!ink'});await flush();
    const queued=(await app.inject('/api/participation/status')).json().inkChat.requests;
    assert.equal(queued.length,1);assert.equal(queued[0].status,'drafted');
    bus.emit('stream-event',{id:'mock-approval',t:2,type:'chat',user:'mock-mod',name:'TestModerator',text:'!ink yes',moderator:true});await flush();
    assert.equal(studio.state.panels.length,0);
    assert.ok(studio.state.pendingPanels[0]?.releaseBlocked);
    assert.equal((await app.inject('/api/participation/status')).json().inkChat.requests[0].status,'drafted');
  }finally{await app.close();studio.close();}
});
