import assert from 'node:assert/strict';
import {eventBus,type StreamEvent} from '@comictoons/core';
import {createApp} from '../apps/server/src/app.ts';
import {TwitchTokenStore} from '../apps/server/src/twitch/token-store.ts';
import type {AdapterFactory,ChatAdapter} from '../apps/server/src/ingest/irc.ts';
import {FakeClock,flush,notification,socketFactory,welcome} from './eventsub-fakes.ts';

export async function liveAppFixture(options:{scene?:NonNullable<Parameters<typeof createApp>[0]>['scene'];helix?:NonNullable<Parameters<typeof createApp>[0]>['helix'];failChat?:boolean;adapterFactory?:AdapterFactory;env?:Record<string,string>}={}) {
  const clock=new FakeClock();const {sockets,factory}=socketFactory();
  const env={TWITCH_CLIENT_ID:'live-test-client',TWITCH_CLIENT_SECRET:'live-test-secret'};
  const identityFetch=(async(input:string|URL|Request)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://identity.invalid');
    return Response.json(url.pathname==='/oauth2/token'
      ?{access_token:'live-test-access',refresh_token:'live-test-refresh'}
      :{client_id:env.TWITCH_CLIENT_ID,login:'streamer',user_id:'1337',scopes:['chat:read','user:read:chat'],expires_in:7200});
  }) as typeof fetch;
  const store=new TwitchTokenStore({env,now:()=>clock.now,baseUrl:'https://identity.invalid',fetchImpl:identityFetch});
  const subscriptions:string[]=[];
  const helixFetch=(async(input:string|URL|Request,init?:RequestInit)=>{
    assert.equal(String(input),'https://subscriptions.invalid/eventsub/subscriptions');
    const request=JSON.parse(String(init?.body)) as {type:string};subscriptions.push(request.type);
    return options.failChat&&request.type==='channel.chat.message'
      ?Response.json({message:'Mock chat permission denied'},{status:403})
      :Response.json({data:[{id:`subscription-${subscriptions.length}`}]},{status:202});
  }) as typeof fetch;
  let callbacks:Parameters<ChatAdapter['start']>[0]|undefined,handovers=0;
  const off=eventBus.on('twitch-auth',()=>{handovers++;});
  const app=createApp({scene:options.scene,helix:options.helix,env:options.env??{},logger:false,now:()=>clock.now,twitchStore:store,
    adapterFactory:options.adapterFactory??(()=>({start(next){callbacks=next;},stop(){}})),
    eventSub:{socketFactory:factory,timers:clock,now:()=>clock.now,fetch:helixFetch,helixUrl:'https://subscriptions.invalid',backoffMs:()=>1000}});
  await app.ready();
  return {app,store,clock,sockets,subscriptions,get handovers(){return handovers;},
    irc(event:StreamEvent){assert.ok(callbacks);callbacks.event(event);},
    async startIRC(){assert.equal((await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'streamer'}})).statusCode,200);},
    async signIn(){
      const state=new URL((await app.inject('/auth/twitch/login')).headers.location!).searchParams.get('state');
      assert.equal((await app.inject(`/auth/twitch/callback?state=${state}&code=live-test-code`)).statusCode,302);
      await flush();
    },
    async welcome(){sockets.at(-1)!.send(welcome(`session-${sockets.length}`));await flush();},
    chat(id:string,text=`line ${id}`){sockets.at(-1)!.send(notification('channel.chat.message',{
      message_id:id,chatter_user_id:'viewer',chatter_user_name:'Viewer',message:{text},badges:[],
    }));},
    async state(){return (await app.inject('/api/state')).json();},
    async close(){await app.close();off();},
  };
}
export const ircChat=(id:string,text=`line ${id}`):StreamEvent=>({id,t:1,type:'chat',user:'viewer',text});
