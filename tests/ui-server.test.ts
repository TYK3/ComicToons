import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../apps/server/src/app.ts';

test('panic hide is guarded and hides both overlay clients without clearing approved panels',async()=>{
  const app=createApp({env:{},logger:false});
  try{
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});
    await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const before=(await app.inject('/api/state')).json();
    assert.ok(before.panels.length);
    assert.equal((await app.inject({method:'POST',url:'/api/hide',remoteAddress:'192.168.1.20',payload:{hidden:true}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/hide',payload:{hidden:'yes'}})).statusCode,400);
    for(const hidden of [true,false]){
      const response=await app.inject({method:'POST',url:'/api/hide',payload:{hidden}});
      assert.equal(response.statusCode,200);
      assert.equal(response.json().overlayHidden,hidden);
      const state=(await app.inject('/api/state')).json();
      assert.equal(state.overlayHidden,hidden);
      assert.deepEqual(state.panels,before.panels);
      assert.deepEqual(state.pendingPanels,before.pendingPanels);
    }
  }finally{await app.close();}
  const keyed=createApp({env:{COMICTOONS_DIRECTOR_KEY:'fake-key'},logger:false});
  try{assert.equal((await keyed.inject({method:'POST',url:'/api/hide',payload:{hidden:true}})).statusCode,401);}
  finally{await keyed.close();}
});

test('Twitch status reads broadcaster type through injected Helix, caches it and exposes only public scope metadata',async()=>{
  const {TwitchTokenStore}=await import('../apps/server/src/twitch/token-store.ts');
  const {FakeClock,socketFactory}=await import('./eventsub-fakes.ts');
  const {TWITCH_SCOPES}=await import('../apps/server/src/twitch/config.ts');
  for(const broadcasterType of ['','affiliate','partner']){
    const clock=new FakeClock(),sockets=socketFactory();
    const env={COMICTOONS_TWITCH_CLIENT_ID:'fake-client',COMICTOONS_TWITCH_CLIENT_SECRET:'fake-secret',COMICTOONS_FLAG_BOT_REPLIES:'1'};
    const store=new TwitchTokenStore({env,fetchImpl:async input=>Response.json(String(input).includes('/token')?{access_token:'fake-access',refresh_token:'fake-refresh'}:{client_id:'fake-client',user_id:'1234',login:'streamer',scopes:[...TWITCH_SCOPES],expires_in:7200})});
    await store.connect('fake-code');
    let calls=0;
    const app=createApp({env:{COMICTOONS_TWITCH_HELIX_BASE_URL:'http://127.0.0.1:4102/helix'},logger:false,twitchStore:store,
      eventSub:{socketFactory:sockets.factory,timers:clock},
      helix:{fetch:async input=>{calls++;assert.equal(new URL(String(input)).origin,'http://127.0.0.1:4102');return Response.json({data:[{id:'1234',login:'streamer',display_name:'Streamer',broadcaster_type:broadcasterType}]});}}});
    try{
      for(let i=0;i<2;i++){
        const response=await app.inject('/api/twitch/status'),body=response.json();
        assert.equal(body.broadcaster_type,broadcasterType);
        assert.deepEqual(body.requestedScopes,[...TWITCH_SCOPES,'user:write:chat']);
        for(const key of Object.keys(body))assert.doesNotMatch(key,/token|refresh|secret|code|authorization/i);
        assert.doesNotMatch(response.body,/fake-access|fake-refresh|fake-secret|fake-code/);
      }
      assert.equal(calls,1);
      store.disconnect();
      assert.equal((await app.inject('/api/twitch/status')).json().broadcaster_type,null);
    }finally{await app.close();}
  }
});

test('manual predictions are guarded and feature-gated, start once and can restart after cancel without a fake hype event',async()=>{
  const app=createApp({env:{COMICTOONS_FLAG_HYPE:'1'},logger:false});
  const post=(url:string,payload?:object,remoteAddress?:string)=>app.inject({method:'POST',url,payload,remoteAddress});
  try{
    const url='/api/participation/predictions/start';
    assert.equal((await post(url,{},'192.168.1.20')).statusCode,403);
    assert.equal((await post(url,{title:'not accepted'})).statusCode,400);
    const first=await post(url,{});
    assert.equal(first.statusCode,200);
    assert.equal(first.json().status,'ACTIVE');
    assert.equal(first.json().title,'Will they make it?');
    assert.equal((await post(url,{})).statusCode,409);
    const status=(await app.inject('/api/participation/status')).json();
    assert.equal(status.hype.hype,undefined,'manual starts never invent a hype train');
    assert.equal((await post('/api/participation/predictions/cancel',{})).statusCode,200);
    assert.equal((await post(url,{})).statusCode,200);
  }finally{await app.close();}
  const off=createApp({env:{},logger:false});
  try{assert.equal((await off.inject({method:'POST',url:'/api/participation/predictions/start',payload:{}})).statusCode,404);}
  finally{await off.close();}
});
