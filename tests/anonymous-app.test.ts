import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../apps/server/src/app.ts';
import type {IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';
import {TwitchTokenStore} from '../apps/server/src/twitch/token-store.ts';
import {socketFactory,recordingCreator,FakeClock} from './eventsub-fakes.ts';

for(const mode of ['off','anonymous','signed-in'] as const)test(`app default IRC factory selects ${mode} credentials without network`,async()=>{
  const frames:string[]=[];let handlers:Parameters<IrcTransportFactory>[0]|undefined;
  const env={COMICTOONS_TWITCH_ANON:mode==='off'?'0':'1'};
  const store=new TwitchTokenStore({env:{TWITCH_CLIENT_ID:'test-id',TWITCH_CLIENT_SECRET:'test-secret'},fetchImpl:(async(input:string|URL|Request)=>Response.json(String(input).endsWith('/token')
    ?{access_token:'test_read_access',refresh_token:'test_refresh'}
    :{client_id:'test-id',login:'real_login',user_id:'123',scopes:['chat:read'],expires_in:3600})) as typeof fetch});
  if(mode==='signed-in')await store.connect('test-code');
  const sockets=socketFactory();
  const app=createApp({env,twitchStore:store,logger:false,eventSub:{socketFactory:sockets.factory,creator:recordingCreator(),timers:new FakeClock()},ircTransport:next=>{
    handlers=next;return {write(frame){frames.push(frame);},close(){}};
  }});
  try{
    const response=await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
    assert.equal(response.statusCode,200);
    if(mode==='off'){assert.equal(handlers,undefined);assert.equal(response.json().source.connection,'unauthenticated');return;}
    assert.ok(handlers);handlers.open();
    if(mode==='anonymous'){
      assert.match(frames.find(frame=>frame.startsWith('NICK'))??'',/^NICK justinfan\d+\r\n$/);
      assert.ok(!frames.some(frame=>frame.startsWith('PASS')));
    }else assert.deepEqual(frames.slice(0,2),['PASS oauth:test_read_access\r\n','NICK real_login\r\n']);
    handlers.data(':tmi.twitch.tv 001 ignored :Welcome\r\nPING :tmi.twitch.tv\r\n');
    assert.ok(!frames.some(frame=>/^(PRIVMSG|WHISPER)/.test(frame)));
    if(mode==='anonymous'){
      await app.inject({method:'POST',url:'/api/twitch/disconnect'});
      assert.equal((await app.inject('/api/state')).json().source.requested,'twitch');
    }
  }finally{await app.close();}
});

test('IRC override remains loopback-only even with remote override opt-in',()=>{
  assert.throws(()=>createApp({env:{COMICTOONS_TWITCH_IRC_URL:'irc://remote.invalid:6667',COMICTOONS_TWITCH_ALLOW_REMOTE_OVERRIDES:'1'},logger:false}),/Invalid COMICTOONS_TWITCH_IRC_URL/);
});
