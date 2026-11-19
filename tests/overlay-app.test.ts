import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../apps/server/src/app.ts';
import {overlayPanels} from '../apps/web/src/lib/overlay-state.ts';
import type {StudioState} from '../apps/web/src/types.ts';
import {chaosSource} from './ingest-chaos-fixture.ts';

test('sample replay and Twitch waiting fallback panels remain visible before live chat',async()=>{
  const irc=chaosSource();
  const app=createApp({env:{COMICTOONS_TWITCH_ANON:'1'},logger:false,adapterFactory:()=>irc.adapter});
  try{
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});
    await app.inject({method:'POST',url:'/api/settings',payload:{approvalMode:false}});
    const sample=(await app.inject('/api/ingest/sample')).json<StudioState>();
    assert.ok(sample.panels.length>0,'exercise populated demo panels');
    assert.deepEqual(overlayPanels(sample.panels),sample.panels);
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
    const waiting=(await app.inject('/api/state')).json<StudioState>();
    assert.deepEqual(overlayPanels(waiting.panels),waiting.panels);
  }finally{await app.close();}
});

test('createApp changes the burst threshold from three users to two with typed momentConfig',async()=>{
  async function run(momentConfig?:NonNullable<Parameters<typeof createApp>[0]>['momentConfig']){
    const irc=chaosSource();
    const app=createApp({env:{COMICTOONS_TWITCH_ANON:'1'},logger:false,adapterFactory:()=>irc.adapter,now:irc.now,momentConfig});
    try{
      await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
      irc.welcome();
      irc.chat('warmup','The stream is live','viewer-warmup');irc.advance(500);
      // KEKW is a default keyword. Two distinct users repeat it within the default eight-second window.
      irc.chat('first','KEKW','viewer-a');irc.advance(500);
      irc.chat('second','KEKW','viewer-b');
      const state=(await app.inject('/api/state')).json<StudioState>();
      assert.equal(state.source?.received,3);
      assert.equal(state.approvalMode,true);
      assert.equal(state.panels.length,0,'approval keeps new moments off air');
      // Moment panels enter the review queue synchronously, before optional art upgrades finish.
      return state.pendingPanels.filter(panel=>panel.sfx==='SURGE!');
    }finally{await app.close();}
  }
  assert.equal((await run()).length,0,'default threshold needs three distinct users');
  const bursts=await run({burstMinUsers:2});
  assert.equal(bursts.length,1,'lowered threshold opens exactly one burst from identical chat');
  assert.match(bursts[0].caption,/2 viewers spam kekw/i);
});
