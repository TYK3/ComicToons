import type {EventSubSocket,SubscriptionCreator} from '../apps/server/src/eventsub/messages.ts';
import type {Timers} from '../apps/server/src/eventsub/client.ts';
import type {TwitchAuthProvider} from '../apps/server/src/eventsub/types.ts';

// Hermetic EventSub fakes: no network, no real Twitch, no real time.
export class FakeClock implements Timers {
  now=1_000_000;
  private queue:{at:number;fn:()=>void;id:number}[]=[];private next=1;
  setTimeout(fn:()=>void,ms:number){const id=this.next++;this.queue.push({at:this.now+ms,fn,id});return id;}
  clearTimeout(handle:unknown){this.queue=this.queue.filter(entry=>entry.id!==handle);}
  advance(ms:number){
    const end=this.now+ms;
    for(;;){
      this.queue.sort((a,b)=>a.at-b.at||a.id-b.id);
      const due=this.queue[0];
      if(!due||due.at>end)break;
      this.queue.shift();this.now=due.at;due.fn();
    }
    this.now=end;
  }
  pending(){return this.queue.length;}
}

export class FakeSocket implements EventSubSocket {
  onmessage?:(text:string)=>void;onclose?:(code:number,reason:string)=>void;onerror?:(error:Error)=>void;
  closedWith?:number;
  constructor(readonly url:string){}
  close(code=1000){if(this.closedWith!==undefined)return;this.closedWith=code;}
  send(message:unknown){this.onmessage?.(JSON.stringify(message));}
  serverClose(code:number,reason=''){this.onclose?.(code,reason);}
}

export function socketFactory(){
  const sockets:FakeSocket[]=[];
  return {sockets,factory:(url:string)=>{const socket=new FakeSocket(url);sockets.push(socket);return socket;}};
}

let sequence=0;
const meta=(type:string,extra:Record<string,string>={})=>({message_id:`msg-${++sequence}`,message_type:type,message_timestamp:'2026-10-31T02:00:00.000000000Z',...extra});
export const welcome=(id:string,keepalive=10)=>({metadata:meta('session_welcome'),payload:{session:{id,status:'connected',connected_at:'2026-10-31T02:00:00Z',keepalive_timeout_seconds:keepalive,reconnect_url:null}}});
export const keepalive=()=>({metadata:meta('session_keepalive'),payload:{}});
export const reconnect=(id:string,url:string)=>({metadata:meta('session_reconnect'),payload:{session:{id,status:'reconnecting',keepalive_timeout_seconds:null,reconnect_url:url,connected_at:'2026-10-31T02:00:00Z'}}});
export const notification=(type:string,event:Record<string,unknown>,version='1',messageId?:string)=>({metadata:{...meta('notification',{subscription_type:type,subscription_version:version}),...(messageId?{message_id:messageId}:{})},payload:{subscription:{id:`sub-${type}`,status:'enabled',type,version,cost:0,condition:{broadcaster_user_id:'1337'},transport:{method:'websocket',session_id:'s'}},event}});
export const revocation=(type:string,status:string,version='1')=>({metadata:meta('revocation',{subscription_type:type,subscription_version:version}),payload:{subscription:{id:`sub-${type}`,status,type,version,cost:0,condition:{broadcaster_user_id:'1337'},transport:{method:'websocket',session_id:'s'}}}});

export function recordingCreator():SubscriptionCreator&{calls:{type:string;version:string;condition:Record<string,string>;sessionId:string}[]}{
  const calls:{type:string;version:string;condition:Record<string,string>;sessionId:string}[]=[];
  return {calls,async createEventSubSubscription(input){calls.push(input);return {id:`sub-${calls.length}`};}};
}

export const FAKE_TOKEN='tok-FAKE-never-logged-0001';
export function fakeAuth(options:{signedIn?:boolean}={}):TwitchAuthProvider&{refreshes:number;token:string}{
  const auth={refreshes:0,token:FAKE_TOKEN,
    async getAuth(){return options.signedIn===false?undefined:{clientId:'client-fake',accessToken:auth.token,broadcasterId:'1337',login:'cool_user'};},
    async refresh(){auth.refreshes+=1;auth.token=`${FAKE_TOKEN}-refreshed`;}};
  return auth;
}
export const flush=async(times=5)=>{for(let index=0;index<times;index++)await new Promise(resolve=>setImmediate(resolve));};
