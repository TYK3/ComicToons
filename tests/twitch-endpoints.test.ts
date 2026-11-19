import assert from 'node:assert/strict';
import test from 'node:test';
import {twitchEndpoints} from '../apps/server/src/env.ts';
import {createApp} from '../apps/server/src/app.ts';
import {TwitchOAuth} from '../apps/server/src/twitch/oauth.ts';
import {twitchConfig} from '../apps/server/src/twitch/config.ts';
import {FakeClock,socketFactory,welcome,flush} from './eventsub-fakes.ts';

test('override validation rejects remote targets and malformed protocols without echoing values',()=>{
  assert.equal(twitchEndpoints({}).authBaseUrl,undefined);
  for(const name of ['AUTH_BASE_URL','HELIX_BASE_URL','EVENTSUB_WS_URL','IRC_URL']){
    const key=`COMICTOONS_TWITCH_${name}`;
    assert.throws(()=>createApp({env:{[key]:'https://private.invalid/sensitive'},logger:false}),error=>error instanceof Error&&error.message===`Invalid ${key}`);
  }
  assert.equal(twitchEndpoints({COMICTOONS_TWITCH_AUTH_BASE_URL:'https://remote.invalid/oauth2',COMICTOONS_TWITCH_ALLOW_REMOTE_OVERRIDES:'1'}).authBaseUrl,'https://remote.invalid');
  assert.equal(twitchEndpoints({COMICTOONS_TWITCH_IRC_URL:'irc://[::1]:4102'}).ircUrl,'irc://[::1]:4102');
});

test('configured OAuth and real EventSub bridge hit only injected override hosts',async()=>{
  for(const suffix of ['', '/oauth2']){
    const calls:string[]=[],clock=new FakeClock(),sockets=socketFactory();
    const env={COMICTOONS_TWITCH_CLIENT_ID:'test-id',COMICTOONS_TWITCH_CLIENT_SECRET:'test-secret',COMICTOONS_TWITCH_AUTH_BASE_URL:`http://127.0.0.1:4102${suffix}`,COMICTOONS_TWITCH_HELIX_BASE_URL:'http://127.0.0.1:4103/helix',COMICTOONS_TWITCH_EVENTSUB_WS_URL:'ws://127.0.0.1:4104/ws'};
    const fakeFetch=(async(input:string|URL|Request)=>{
      const url=new URL(String(input));calls.push(url.href);
      assert.ok(['http://127.0.0.1:4102','http://127.0.0.1:4103'].includes(url.origin));
      if(url.pathname.endsWith('/token'))return Response.json({access_token:'test-access',refresh_token:'test-refresh'});
      if(url.pathname.endsWith('/validate'))return Response.json({client_id:'test-id',login:'streamer',user_id:'123',scopes:['chat:read'],expires_in:3600});
      return Response.json({data:[{id:'test-sub'}]},{status:202});
    }) as typeof fetch;
    const app=createApp({env,logger:false,twitch:{fetchImpl:fakeFetch},eventSub:{fetch:fakeFetch,socketFactory:sockets.factory,timers:clock}});
    try{
      const login=await app.inject('/auth/twitch/login');const target=new URL(login.headers.location!);
      assert.equal(target.origin,'http://127.0.0.1:4102');assert.equal(target.pathname,'/oauth2/authorize');
      await app.inject(`/auth/twitch/callback?state=${target.searchParams.get('state')}&code=test-code`);await flush();
      assert.equal(sockets.sockets[0].url,'ws://127.0.0.1:4104/ws');sockets.sockets[0].send(welcome('test-session'));await flush();
      assert.ok(calls.includes('http://127.0.0.1:4102/oauth2/token'));
      assert.ok(calls.includes('http://127.0.0.1:4102/oauth2/validate'));
      assert.ok(calls.includes('http://127.0.0.1:4103/helix/eventsub/subscriptions'));
      const client=new TwitchOAuth(twitchConfig(env),{baseUrl:env.COMICTOONS_TWITCH_AUTH_BASE_URL,fetchImpl:fakeFetch});
      await client.refresh('test-refresh');
    }finally{await app.close();}
  }
});
