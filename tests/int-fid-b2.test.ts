import assert from 'node:assert/strict';
import test from 'node:test';
import {eventBus} from '@comictoons/core';
import {Studio} from '../apps/server/src/studio.ts';
import {createApp} from '../apps/server/src/app.ts';
import type {ChatAdapter} from '../apps/server/src/ingest/irc.ts';
import {createDirectAdapter} from '../scripts/s2-replay-core.ts';

test('INT-FID-B2-STANDALONE: unmanaged Studio retains connected and disconnected bus liveness',()=>{
  const studio=new Studio({managedChatSource:false});
  try{
    eventBus.emit('twitch-connected',{source:'eventsub',channel:'approved_test'});
    assert.equal(studio.state.source?.active,'twitch');
    eventBus.emit('stream-event',{id:'raid',t:1,type:'raid',from:'SyntheticCrew',viewers:10});
    assert.equal(studio.state.pendingPanels.filter(panel=>panel.sfx==='RAID!').length,1);
    eventBus.emit('twitch-disconnected',{source:'eventsub'});
    assert.equal(studio.state.source?.active,'sample');
  }finally{studio.close();}
});

test('INT-FID-B2-MANAGED: app ChatSource alone drives liveness and admitted bus moments',async()=>{
  let callbacks:Parameters<ChatAdapter['start']>[0]|undefined;
  const app=createApp({env:{},logger:false,adapterFactory:()=>({start(next){callbacks=next;},stop(){}})});
  try{
    await app.ready();eventBus.emit('twitch-connected',{source:'eventsub'});
    assert.equal((await app.inject('/api/state')).json().source.active,'sample');
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
    assert.ok(callbacks);callbacks.event({id:'live',t:1,type:'chat',user:'synthetic-user',text:'live anchor'});
    eventBus.emit('stream-event',{id:'raid-managed',t:2,type:'raid',from:'SyntheticCrew',viewers:10});
    const state=(await app.inject('/api/state')).json();
    assert.equal(state.source.active,'twitch');assert.equal(state.source.received,1);
    assert.equal(state.pendingPanels.filter((panel:{sfx?:string})=>panel.sfx==='RAID!').length,1);
    callbacks.status('unreachable');
    assert.equal((await app.inject('/api/state')).json().source.active,'sample');
  }finally{await app.close();}
});

test('INT-FID-B2-IDLESS: user clears withdraw id-less chat by user text and time without opting out',()=>{
  const direct=createDirectAdapter();let clock=0;
  const studio=new Studio({adapterFactory:()=>direct.adapter,now:()=>clock});
  try{
    studio.useSource('twitch','approved_test');
    for(const t of [1,61]){clock=t*1000;direct.push({t,type:'chat',user:'target',text:'same legacy text'});}
    clock=62_000;direct.push({t:62,type:'chat',user:'other',text:'other stays'});
    eventBus.emit('stream-event',{t:63,type:'chat',withdraw:'user',targetUser:'target'});
    const held=studio as unknown as {liveDrafts:Map<string,unknown>;momentDrafts:Map<string,unknown>};
    assert.doesNotMatch(JSON.stringify({drafts:[...held.liveDrafts],moments:[...held.momentDrafts],state:studio.state}),/same legacy text/);
    assert.match(JSON.stringify(studio.state),/other stays/);
    clock=70_000;direct.push({t:70,type:'chat',user:'target',text:'later is eligible'});
    assert.match(JSON.stringify(studio.state),/later is eligible/);
  }finally{studio.close();}
});
