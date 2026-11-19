import assert from 'node:assert/strict';
import test from 'node:test';
import {flush,notification} from './eventsub-fakes.ts';
import {liveAppFixture} from './twitch-live-app-fixture.ts';
import {chatSourceChip} from '../apps/web/src/ui/screens/studio/live.ts';
import type {ChatSourceState} from '@comictoons/core';

// STREAM-END-1 (QA finding): on EventSub stream.offline the studio never left Live. The
// fix moves the session out of Live without losing the issue: drafting stops, the approved panels
// and the manga export stay exactly as they are, and the chat chip stops reading Live.
test('STREAM-END-1: stream.offline leaves Live, stops drafting, keeps approved panels and the manga export, and the chip no longer reads Live',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();
    f.chat('live-1');await flush();
    let state=await f.state();
    assert.equal(state.source.active,'twitch');assert.equal(state.source.connection,'live');
    assert.equal(chatSourceChip(state.source as ChatSourceState),'Live chat');
    assert.ok(state.pendingPanels.length,'the live chat line drafted a panel');
    assert.equal((await f.app.inject({method:'POST',url:'/api/approve',payload:{all:true}})).statusCode,200);
    state=await f.state();
    assert.equal(state.panels.length,1,'one panel is approved before the stream ends');

    // Drive stream.offline through the real EventSub bridge: subscribe, map and bus, no real network.
    f.sockets.at(-1)!.send(notification('stream.offline',{broadcaster_user_id:'1337'}));
    await flush();
    state=await f.state();
    assert.notEqual(state.source.connection,'live',`still reports ${state.source.connection} after stream.offline`);
    assert.equal(state.status,'stream-ended','/api/state status reads stream-ended while the stream is offline');
    assert.equal(state.panels.length,1,'the approved panel is kept');
    assert.equal(state.pendingPanels.length,0);
    assert.notEqual(chatSourceChip(state.source as ChatSourceState),'Live chat','the chip no longer reads Live');
    assert.equal(chatSourceChip(state.source as ChatSourceState),'Stream ended');

    // Drafting stops: a chat line that lingers on the old EventSub transport after stream.offline
    // must not open a new panel, and must not resurrect the stale Live indicator either.
    f.chat('after-offline');await flush();
    state=await f.state();
    assert.equal(state.pendingPanels.length,0,'no new panel drafts after stream.offline');
    assert.notEqual(state.source.connection,'live','lingering chat does not bring Live back');
    assert.equal(chatSourceChip(state.source as ChatSourceState),'Stream ended');

    // The manga export stays available: the approved panel can still be bound into a recap.
    const recap=await f.app.inject({method:'POST',url:'/api/recaps',payload:{}});
    assert.equal(recap.statusCode,200,'the manga export still works after stream.offline');
    assert.match(recap.json().recapUrl,/^\/recap\//);

    // A later stream.online (next broadcast) clears the ended flag; a fresh chat line goes live again.
    f.sockets.at(-1)!.send(notification('stream.online',{id:'s2',broadcaster_user_id:'1337',started_at:'2026-10-31T03:00:00Z'}));
    await flush();
    f.chat('live-2');await flush();
    state=await f.state();
    assert.equal(state.source.connection,'live','a new stream.online lets a fresh chat line go live again');
    // STREAM-END-1 r1 (QA check 3): /api/state must not contradict itself once the next broadcast starts.
    assert.equal(state.status,'live','CHECK 3: /api/state status is restored to live after stream.online');
  }finally{await f.close();}
});
