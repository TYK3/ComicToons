import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../apps/server/src/app.ts';

/** A tiny loopback IRC fake standing in for Twitch via COMICTOONS_TWITCH_IRC_URL,
 * so the production wiring (app.ts -> source.ts -> irc.ts) runs end to end. */
function startFakeIrc():Promise<{port:number;close():Promise<void>}> {
  return new Promise((resolvePromise,reject)=>{
    const server=createServer(socket=>{
      let buffered='';
      socket.on('data',chunk=>{
        buffered+=chunk.toString('utf8');
        let end:number;
        while((end=buffered.indexOf('\r\n'))>=0){
          const line=buffered.slice(0,end);buffered=buffered.slice(end+2);
          if(line.startsWith('NICK ')){const nick=line.slice(5);socket.write(`:tmi.twitch.tv 001 ${nick} :Welcome, GLHF!\r\n`);}
          else if(line.startsWith('JOIN ')){
            const channel=line.slice(5);
            socket.write(`@id=anon-wire-1;user-id=42;display-name=Viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG ${channel} :hello from the fake\r\n`);
          }
        }
      });
    });
    server.on('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      if(!address||typeof address==='string'){reject(new Error('fake IRC server has no port'));return;}
      resolvePromise({port:address.port,close:()=>new Promise(done=>server.close(()=>done()))});
    });
  });
}

test('APP-ANON-WIRING: with COMICTOONS_TWITCH_ANON=1 and no signed-in token, the production chat source reaches live with real anonymous IRC chat',async()=>{
  const fake=await startFakeIrc();
  // ircEndpoint() reads real process.env by design (irc.ts, not piped through createApp's env option).
  const previousAnon=process.env.COMICTOONS_TWITCH_ANON,previousUrl=process.env.COMICTOONS_TWITCH_IRC_URL;
  process.env.COMICTOONS_TWITCH_ANON='1';process.env.COMICTOONS_TWITCH_IRC_URL=`irc://127.0.0.1:${fake.port}`;
  const app=createApp({logger:false});
  try{
    const started=await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
    assert.equal(started.statusCode,200);
    let source:{active?:string;connection?:string;reason?:string;simulated?:boolean;received?:number}|undefined;
    for(let attempt=0;attempt<60;attempt++){
      source=(await app.inject('/api/state')).json().source;
      if(source?.active==='twitch'&&(source?.received??0)>=1)break;
      await delay(50);
    }
    assert.equal(source?.active,'twitch','the source must leave Sample Data once anonymous chat is flowing');
    assert.equal(source?.connection,'live');
    assert.equal(source?.simulated,false);
    assert.ok((source?.received??0)>=1,'at least one real anonymous chat line must be admitted');
    assert.notEqual(source?.reason,'unauthenticated');
  } finally {
    await app.close();
    await fake.close();
    if(previousAnon===undefined)delete process.env.COMICTOONS_TWITCH_ANON;else process.env.COMICTOONS_TWITCH_ANON=previousAnon;
    if(previousUrl===undefined)delete process.env.COMICTOONS_TWITCH_IRC_URL;else process.env.COMICTOONS_TWITCH_IRC_URL=previousUrl;
  }
});

test('APP-ANON-GUARD: disabled anonymous mode never dials, and a signed-in session never uses justinfan',async()=>{
  const {TwitchTokenStore}=await import('../apps/server/src/twitch/token-store.ts');
  const {socketFactory,recordingCreator,FakeClock}=await import('./eventsub-fakes.ts');
  for(const signedIn of [false,true]){
    const frames:string[]=[];
    let handlers:Parameters<NonNullable<Parameters<typeof createApp>[0]>['ircTransport']&object>[0]|undefined;
    const store=new TwitchTokenStore({env:{COMICTOONS_TWITCH_CLIENT_ID:'fake-client',COMICTOONS_TWITCH_CLIENT_SECRET:'fake-secret'},fetchImpl:async input=>Response.json(String(input).endsWith('/token')
      ?{access_token:'fake-access',refresh_token:'fake-refresh'}
      :{client_id:'fake-client',user_id:'123',login:'test_account',scopes:['chat:read'],expires_in:3600})});
    if(signedIn)await store.connect('fake-code');
    const sockets=socketFactory();
    const app=createApp({logger:false,env:{COMICTOONS_TWITCH_ANON:signedIn?'1':'0'},twitchStore:store,
      eventSub:{socketFactory:sockets.factory,creator:recordingCreator(),timers:new FakeClock()},
      ircTransport:next=>{handlers=next;return {write(frame){frames.push(frame);},close(){}};}});
    try{
      const response=await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
      assert.equal(response.statusCode,200);
      if(!signedIn){assert.equal(handlers,undefined);assert.equal(response.json().source.connection,'unauthenticated');}
      else{assert.ok(handlers);handlers.open();assert.deepEqual(frames.slice(0,2),['PASS oauth:fake-access\r\n','NICK test_account\r\n']);}
      assert.equal(frames.some(frame=>frame.includes('justinfan')),false);
    }finally{await app.close();}
  }
});
