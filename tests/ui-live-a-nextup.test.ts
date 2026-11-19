import assert from 'node:assert/strict';
import test from 'node:test';
import {createEventBus,type ComicPanel,type ComicToonsBusEvents,type StreamEvent} from '../packages/core/src/index.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {Participation,createMockHelix} from '../apps/server/src/participation/routes.ts';
import {createApp} from '../apps/server/src/app.ts';
import {createDirectAdapter} from '../scripts/s2-replay-core.ts';

// UI-LIVE-A contract: GET /api/state carries `nextUp`, the panel a mod's `!ink yes` (or the A key) approves next.
// Sample data only: an in-memory Helix that refuses channel points (a normal channel), no network, no real Twitch.

const waitingPanel=(id:string,at:number):ComicPanel=>({id,origin:'sample',caption:`Sample ${id}`,storyCaption:`Sample ${id}`,dialogue:[],scene:'Sample scene.',altText:'Sample scene.',
  characters:[],mood:'playful',imageUrl:'/art/generated/panel-01-stream-start.webp',at} as ComicPanel);

function nonAffiliateStudio(){
  const direct=createDirectAdapter();let clock=1_000_000;
  const studio=new Studio({adapterFactory:()=>direct.adapter,now:()=>clock});
  const bus=createEventBus<ComicToonsBusEvents>();
  const engine=new Participation({studio,bus,helix:createMockHelix({affiliate:false}),budgetPerHour:12,now:()=>clock,
    flags:{polls:false,twitchPolls:false,inkMe:true,catchup:false,hype:false,director:true,noink:true,botReplies:false}});
  let n=0;
  const chat=async(name:string,text:string,moderator=false)=>{bus.emit('stream-event',{id:`uila-${++n}`,t:0,type:'chat',user:`${name}-id`,name,text,moderator} as StreamEvent);await new Promise(resolve=>setImmediate(resolve));};
  const advance=(ms:number)=>{clock+=ms;};
  return {studio,engine,bus,chat,advance,close:()=>studio.close()};
}

test('UI-LIVE-A-NEXTUP-1: nextUp equals the panel that a mod\'s !ink yes approves (cameo waiting behind older panels)',async()=>{
  const {studio,engine,bus,chat,advance,close}=nonAffiliateStudio();
  try{
    bus.emit('twitch-connected',{} as never);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(engine.status().reward?.status,'unavailable','the Sample channel is not an Affiliate, so !ink is the path');
    studio.state.pendingPanels.push(waitingPanel('sample-old-1',10),waitingPanel('sample-old-2',20));
    studio.state.elapsed=300;
    assert.equal(studio.tick().nextUp,'sample-old-1','with no cameo waiting, the oldest panel is next');
    await chat('sample_viewer_a','!ink');
    const cameo=engine.status().inkChat?.requests[0]?.panelId;
    assert.ok(cameo,'the !ink request drafted a cameo panel');
    const before=JSON.parse(JSON.stringify(studio.tick())) as {nextUp:string|null};
    assert.equal(before.nextUp,cameo,'GET /api/state names the cameo, not the oldest panel');
    await chat('sample_mod','!ink yes',true);
    const approved=engine.director.log[0];
    assert.equal(approved?.action,'approve');
    assert.equal(approved?.panelId,before.nextUp,'!ink yes approved exactly the panel nextUp named');
    assert.ok(studio.state.panels.some(panel=>panel.id===before.nextUp));
    assert.equal(studio.tick().nextUp,'sample-old-1','after the cameo, the oldest waiting panel is next again');
    advance(5000);
    await chat('sample_mod','!ink yes',true);
    assert.equal(engine.director.log[0]?.panelId,'sample-old-1','and !ink yes approves that one');
    assert.equal(studio.tick().nextUp,'sample-old-2');
    advance(5000);
    await chat('sample_mod','!ink no',true);
    assert.equal(engine.director.log[0]?.action,'reject');
    assert.equal(studio.tick().nextUp,null,'nothing waiting: nextUp is null');
  }finally{close();}
});

test('UI-LIVE-A-NEXTUP-2: GET /api/state includes nextUp (null when idle, the oldest waiting panel otherwise)',async()=>{
  const app=createApp({env:{},logger:false});
  try{
    const idle=(await app.inject({method:'GET',url:'/api/state'})).json() as {nextUp?:string|null};
    assert.ok('nextUp' in idle,'nextUp is part of the state contract');
    assert.equal(idle.nextUp,null);
    const replay=await app.inject({method:'POST',url:'/api/replay',payload:{fixtureId:'tabletop-night',speed:60}});
    assert.equal(replay.statusCode,200);
    const state=(await app.inject({method:'GET',url:'/api/state'})).json() as {nextUp?:string|null;pendingPanels:{id:string}[]};
    assert.ok(state.pendingPanels.length>=1);
    assert.equal(state.nextUp,state.pendingPanels[0]!.id);
    const approve=(await app.inject({method:'POST',url:'/api/approve',payload:{panelId:state.nextUp}})).json() as {nextUp?:string|null;pendingPanels:{id:string}[]};
    assert.equal(approve.nextUp,approve.pendingPanels[0]?.id??null,'the approve response never names the panel it just approved');
  }finally{await app.close();}
});
