import assert from 'node:assert/strict';
import test from 'node:test';
import {eventBus} from '@comictoons/core';
import {flush,revocation} from './eventsub-fakes.ts';
import {ircChat,liveAppFixture} from './twitch-live-app-fixture.ts';

test('real bridge hand-over starts once; IRC is primary until first EventSub chat proves delivery',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();f.irc(ircChat('before-signin'));f.irc(ircChat('before-signin'));
    assert.equal((await f.state()).source.received,1);assert.equal(f.sockets.length,0);
    await f.signIn();assert.equal(f.handovers,1);assert.equal(f.sockets.length,1);
    await f.welcome();f.irc(ircChat('irc-first'));
    assert.equal((await f.state()).source.received,2,'connected batch alone must not buffer IRC');
    f.chat('irc-first');f.chat('eventsub-first');f.irc(ircChat('eventsub-first'));
    assert.equal((await f.state()).source.received,3);
    f.irc(ircChat('irc-only-gap'));
    assert.equal((await f.state()).source.received,3,'IRC-only data is now standby');
    await f.store.refresh();assert.equal(f.handovers,1);assert.equal(f.sockets.length,1);
  }finally{await f.close();}
});

test('real bridge chat subscription 403 leaves IRC active with no dropped IRC messages',async()=>{
  const f=await liveAppFixture({failChat:true});
  try{
    await f.startIRC();await f.signIn();await f.welcome();
    const status=(await f.app.inject('/api/participation/eventsub')).json();
    assert.ok(status.failed.some((entry:{type:string})=>entry.type==='channel.chat.message'));
    for(const id of ['one','two','three'])f.irc(ircChat(id));
    assert.equal((await f.state()).source.received,3);
    assert.equal(f.handovers,1);assert.equal(f.sockets.length,1);
  }finally{await f.close();}
});

test('real bridge revocation flushes standby once without replaying EventSub overlaps',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();
    f.chat('shared');f.irc(ircChat('shared'));f.irc(ircChat('gap'));
    assert.equal((await f.state()).source.received,1);
    f.sockets[0].send(revocation('channel.chat.message','authorization_revoked'));
    assert.equal((await f.state()).source.received,2);
    f.irc(ircChat('gap'));f.irc(ircChat('after-revoke'));
    assert.equal((await f.state()).source.received,3);
  }finally{await f.close();}
});

test('sign-out falls back to IRC and rejects late bridge chat; reconnect has exactly one new hand-over',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();
    f.chat('shared');f.irc(ircChat('shared'));f.irc(ircChat('gap'));
    await f.app.inject({method:'POST',url:'/api/twitch/disconnect'});
    assert.equal((await f.state()).source.received,2);
    f.chat('late-after-signout');f.irc(ircChat('irc-after-signout'));
    assert.equal((await f.state()).source.received,3);
    const before=(await f.state()).pendingPanels;
    f.chat('late-again');assert.deepEqual((await f.state()).pendingPanels,before,'late chat never reaches Studio');
    await f.signIn();assert.equal(f.handovers,2);assert.equal(f.sockets.length,2);
    await f.welcome();f.chat('irc-after-signout');
    assert.equal((await f.state()).source.received,3);
    f.chat('new-session');f.irc(ircChat('new-session'));
    assert.equal((await f.state()).source.received,4);
  }finally{await f.close();}
});

test('read-only real bridge status detects socket loss and recovery without selecting from connected alone',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();f.chat('shared');f.irc(ircChat('gap'));
    f.sockets[0].serverClose(4000);assert.equal((await f.state()).source.received,2);
    f.clock.advance(1000);await flush();await f.welcome();
    f.irc(ircChat('reconnecting-irc'));assert.equal((await f.state()).source.received,3);
    f.chat('reconnecting-irc');f.irc(ircChat('standby-again'));
    assert.equal((await f.state()).source.received,3);
    eventBus.emit('twitch-disconnected',{source:'eventsub'});
    assert.equal((await f.state()).source.received,4);
  }finally{await f.close();}
});


test('an explicit new auth hand-over restarts one bridge and returns to IRC until fresh chat proof',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();f.chat('shared');f.irc(ircChat('gap'));
    eventBus.emit('twitch-auth',{auth:f.store});await flush();
    assert.equal(f.sockets.length,2);assert.equal(f.handovers,2);
    assert.equal((await f.state()).source.received,2);
    await f.welcome();f.irc(ircChat('new-irc'));assert.equal((await f.state()).source.received,3);
    f.chat('new-irc');f.irc(ircChat('new-gap'));assert.equal((await f.state()).source.received,3);
  }finally{await f.close();}
});


test('a real EventSub opt-out chat proves delivery without incrementing ordinary chat received',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();f.chat('privacy-proof','!noink');
    f.irc({...ircChat('other-user-gap'),user:'other-viewer'});
    assert.equal((await f.state()).source.received,0,'the first actual chat notification selects standby even when it is a privacy command');
    f.store.disconnect();assert.equal((await f.state()).source.received,1);
  }finally{await f.close();}
});
