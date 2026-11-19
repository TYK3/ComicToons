import assert from 'node:assert/strict';
import test from 'node:test';
import {eventBus} from '@comictoons/core';
import {ircChat,liveAppFixture} from './twitch-live-app-fixture.ts';

test('forward-compatible source signals fall back but never select EventSub without chat proof',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();
    eventBus.emit('twitch-connected',{source:'eventsub'});
    f.irc(ircChat('before-proof'));assert.equal((await f.state()).source.received,1);
    f.chat('before-proof');f.irc(ircChat('gap'));
    eventBus.emit('eventsub-state',{state:'reconnecting'});
    assert.equal((await f.state()).source.received,2);
    eventBus.emit('eventsub-state',{state:'subscribed'});
    f.irc(ircChat('still-irc'));assert.equal((await f.state()).source.received,3);
    f.chat('still-irc');f.irc(ircChat('next-gap'));
    eventBus.emit('twitch-disconnected',{source:'irc'});
    assert.equal((await f.state()).source.received,3);
    eventBus.emit('twitch-disconnected',{source:'eventsub'});
    assert.equal((await f.state()).source.received,4);
    await f.app.inject({method:'POST',url:'/api/twitch/disconnect'});
    f.chat('signed-out-ignored');f.irc(ircChat('signed-out-irc'));
    assert.equal((await f.state()).source.received,5);
  }finally{await f.close();}
});
