import assert from 'node:assert/strict';
import test from 'node:test';
import {parseTwitchChannel} from '../apps/web/src/ui/data/channel.ts';
import {ircChat,liveAppFixture} from './twitch-live-app-fixture.ts';
import {notification} from './eventsub-fakes.ts';

test('public channel input accepts usernames and Twitch channel links without following foreign links',()=>{
  for(const input of ['Some_Channel','@Some_Channel','#Some_Channel','https://www.twitch.tv/Some_Channel/?ref=share','twitch.tv/Some_Channel'])assert.equal(parseTwitchChannel(input),'some_channel');
  for(const input of ['', 'https://example.com/streamer','https://twitch.tv.evil.test/streamer','https://twitch.tv/videos/123','name with spaces','https://twitch.tv/@name','https://user@twitch.tv/streamer','https://www.twitch.tv/directory','https://twitch.tv/settings','https://twitch.tv/videos'])assert.throws(()=>parseTwitchChannel(input));
});

test('public channel keeps account events and participation out while IRC feeds the selected channel',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();f.chat('own-before-switch');
    assert.equal((await f.state()).source.received,1);
    const switched=await f.app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'other_streamer'}});
    assert.equal(switched.statusCode,200);
    f.chat('wrong-account');
    f.sockets.at(-1)!.send(notification('stream.offline',{broadcaster_user_id:'1337'}));
    f.irc(ircChat('other-chat','hello from the other channel'));
    const state=await f.state();
    assert.equal(state.source.channel,'other_streamer');assert.equal(state.source.received,1);assert.equal(state.source.active,'twitch');
    assert.notEqual(state.source.connection,'ended');
    assert.equal((await f.app.inject('/api/participation/status')).json().received,1,'only own pre-switch chat reached participation');
    f.irc(ircChat('other-command','!previously'));
    assert.equal((await f.app.inject('/api/participation/status')).json().received,1,'commands from another channel never reach streamer controls');
    const write=await f.app.inject({method:'POST',url:'/api/participation/polls',payload:{}});
    assert.equal(write.statusCode,409);assert.match(write.json().error,/own channel/);
    assert.equal(f.store.status().connected,true,'reading another channel preserves the sign-in');
    await f.app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'streamer'}});
    f.chat('own-after-switch');
    assert.equal((await f.state()).source.received,1,'own channel resumes EventSub without another sign-in');
  }finally{await f.close();}
});

test('channel-switch validation preserves the active reader on malformed requests',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();f.irc(ircChat('first'));
    for(const channel of ['not a channel','https://example.com/x',''])assert.equal((await f.app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel}})).statusCode,400);
    const source=(await f.state()).source;assert.equal(source.channel,'streamer');assert.equal(source.received,1);
  }finally{await f.close();}
});

test('fresh explicit channel read clears the previous session even for the same channel',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();f.irc(ircChat('old-session'));
    assert.equal((await f.state()).source.received,1);
    const previous=(await f.state()).pendingPanels.map((p:{id:string})=>p.id);
    const reset=await f.app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'streamer',fresh:true}});
    assert.equal(reset.statusCode,200);
    assert.equal(reset.json().source.received,0);
    f.irc(ircChat('new-session'));
    const state=await f.state();assert.equal(state.source.received,1);assert.deepEqual(state.panels,[]);
    assert.ok(state.pendingPanels.length>0);
    assert.ok(state.pendingPanels.every((p:{id:string;sources:string[]})=>!previous.includes(p.id)&&p.sources.includes('new-session')&&!p.sources.includes('old-session')));
  }finally{await f.close();}
});
