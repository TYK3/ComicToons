import type {EventBus,ComicToonsBusEvents} from '@comictoons/core';
import type {TwitchAuthProvider} from './types.ts';
import type {EventSubStatus,SocketFactory,SubscriptionCreator} from './messages.ts';
import {EventSubClient,type Timers} from './client.ts';
import {createSubscriptionCreator} from './subscribe.ts';
import {comicToonsSubscriptions} from './subscriptions.ts';
import {mapNotification} from './map.ts';

export interface EventSubBridgeOptions {
  auth:TwitchAuthProvider;
  bus:EventBus<ComicToonsBusEvents>;
  creator?:SubscriptionCreator;
  url?:string;
  helixUrl?:string;
  socketFactory?:SocketFactory;
  timers?:Timers;
  now?:()=>number;
  /** When the live session started (ms, same clock as now); `t` counts seconds from here. Defaults to bridge start. */
  startedAt?:number;
  fetch?:typeof fetch;
  welcomeTimeoutMs?:number;
  keepaliveGraceMs?:number;
  backoffMs?:(attempt:number)=>number;
  log?:(message:string)=>void;
}
export interface EventSubBridge { status():EventSubStatus&{signedIn:boolean}; stop():void }

/**
 * Real Twitch events onto the bus: every notification becomes a 'stream-event' (Studio's
 * MomentDetector and participation both listen there), stream.online becomes 'stream-online',
 * and the first subscribed session emits 'twitch-connected' once.
 */
export function startEventSubBridge(options:EventSubBridgeOptions):EventSubBridge {
  const now=options.now??(()=>Date.now());const started=options.startedAt??now();let connected=false;let signedIn=false;
  const client=new EventSubClient({
    url:options.url,socketFactory:options.socketFactory,timers:options.timers,now,
    welcomeTimeoutMs:options.welcomeTimeoutMs,keepaliveGraceMs:options.keepaliveGraceMs,backoffMs:options.backoffMs,log:options.log,
    creator:options.creator??createSubscriptionCreator({auth:options.auth,baseUrl:options.helixUrl,fetch:options.fetch,now}),
    subscriptions:async()=>{const auth=await options.auth.getAuth();signedIn=!!auth;return auth?comicToonsSubscriptions(auth.broadcasterId):[];},
    onNotification:(type,event,messageId)=>{
      const mapped=mapNotification(type,event,messageId,(now()-started)/1000);
      if(!mapped)return;
      if(mapped.kind==='stream-online')options.bus.emit('stream-online',mapped.payload);
      else if(mapped.kind==='stream-offline')options.bus.emit('stream-offline',mapped.payload);
      else options.bus.emit('stream-event',mapped.event);
    },
    onRevocation:revocation=>options.bus.emit('eventsub-revoked',revocation),
    onSubscribed:({first})=>{if(first&&!connected){connected=true;options.bus.emit('twitch-connected',{source:'eventsub'});}},
  });
  let stopped=false;
  void options.auth.getAuth().then(auth=>{signedIn=!!auth;if(auth&&!stopped)client.start();}).catch(()=>{signedIn=false;});
  return {status:()=>({...client.status(),signedIn}),stop:()=>{stopped=true;client.stop();}};
}
