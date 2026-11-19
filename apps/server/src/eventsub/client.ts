import {connectWebSocket} from './socket.ts';
import type {EventSubMessage,EventSubSocket,EventSubStatus,Revocation,SocketFactory,SubscriptionCreator,SubscriptionRequest} from './messages.ts';

// Follows https://dev.twitch.tv/docs/eventsub/handling-websocket-events/ (checked 31 Oct 2026):
// subscribe within 10 s of the welcome; if nothing (notification or keepalive) arrives for
// keepalive_timeout_seconds, assume the link is lost, reconnect and resubscribe; on
// session_reconnect open reconnect_url as is and keep the old socket until the new welcome.
export const EVENTSUB_URL='wss://eventsub.wss.twitch.tv/ws';

export interface Timers { setTimeout(fn:()=>void,ms:number):unknown; clearTimeout(handle:unknown):void }
const realTimers:Timers={setTimeout:(fn,ms)=>{const handle=setTimeout(fn,ms);handle.unref?.();return handle;},clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)};

export interface EventSubClientOptions {
  subscriptions:()=>SubscriptionRequest[]|Promise<SubscriptionRequest[]>;
  creator:SubscriptionCreator;
  onNotification:(type:string,event:unknown,messageId:string)=>void;
  onRevocation?:(revocation:Revocation)=>void;
  /** After every fresh session has its subscriptions in place (not after a reconnect handover). */
  onSubscribed?:(info:{sessionId:string;first:boolean})=>void;
  url?:string;
  socketFactory?:SocketFactory;
  timers?:Timers;
  now?:()=>number;
  /** No welcome within this long after connecting counts as a failed connection. */
  welcomeTimeoutMs?:number;
  /** Slack on top of keepalive_timeout_seconds before the link counts as lost. */
  keepaliveGraceMs?:number;
  backoffMs?:(attempt:number)=>number;
  log?:(message:string)=>void;
}

interface Connection { socket:EventSubSocket; url:string; purpose:'fresh'|'handover'; sessionId?:string; welcomeTimer?:unknown; dead?:boolean }

export class EventSubClient {
  private active?:Connection;
  private pending?:Connection;
  private watchdog?:unknown;
  private retryTimer?:unknown;
  private attempt=0;
  private stopped=true;
  private everSubscribed=false;
  private seen=new Set<string>();
  private readonly timers:Timers;
  private readonly now:()=>number;
  private authRevoked=false;
  private state:EventSubStatus={state:'idle',subscribed:[],failed:[],revoked:[],reconnects:0,notifications:0};
  constructor(private options:EventSubClientOptions){this.timers=options.timers??realTimers;this.now=options.now??(()=>Date.now());}
  get url(){return this.options.url??EVENTSUB_URL;}
  status():EventSubStatus{return {...this.state,subscribed:[...this.state.subscribed],failed:[...this.state.failed],revoked:[...this.state.revoked]};}
  start(){if(!this.stopped)return;this.stopped=false;this.open(this.url,'fresh');}
  stop(){
    this.stopped=true;this.clearWatchdog();
    if(this.retryTimer!==undefined){this.timers.clearTimeout(this.retryTimer);this.retryTimer=undefined;}
    for(const connection of [this.pending,this.active])if(connection)this.drop(connection);
    this.pending=this.active=undefined;this.state.state='stopped';
  }
  private open(url:string,purpose:Connection['purpose']){
    if(this.stopped)return;
    if(purpose==='fresh')this.state.state=this.state.reconnects||this.everSubscribed?'reconnecting':'connecting';
    let socket:EventSubSocket;
    try{socket=(this.options.socketFactory??connectWebSocket)(url);}
    catch(error){this.state.lastError='Could not open the EventSub socket.';this.options.log?.(`eventsub: could not open the socket: ${error instanceof Error?error.message:String(error)}`);if(purpose==='fresh')this.scheduleReconnect();return;}
    const connection:Connection={socket,url,purpose};
    if(purpose==='fresh')this.active=connection;else this.pending=connection;
    connection.welcomeTimer=this.timers.setTimeout(()=>{if(connection.sessionId||connection.dead)return;this.fail(connection,'No welcome from EventSub in time.');},this.options.welcomeTimeoutMs??10_000);
    socket.onmessage=text=>this.receive(connection,text);
    socket.onerror=error=>{this.state.lastError='The EventSub socket reported an error.';this.options.log?.(`eventsub: socket error: ${error.message}`);};
    socket.onclose=(code,reason)=>this.closed(connection,code,reason);
  }
  private drop(connection:Connection){
    connection.dead=true;
    if(connection.welcomeTimer!==undefined)this.timers.clearTimeout(connection.welcomeTimer);
    try{connection.socket.close(1000);}catch{/* already closed */}
  }
  private fail(connection:Connection,reason:string){
    if(connection.dead)return;
    this.state.lastError=reason;this.options.log?.(`eventsub: ${reason}`);
    this.drop(connection);
    if(connection===this.pending){this.pending=undefined;if(this.active&&!this.active.dead)return;}
    if(connection===this.active){this.active=undefined;this.clearWatchdog();}
    if(this.pending&&!this.pending.dead)return;
    this.scheduleReconnect();
  }
  private closed(connection:Connection,code:number,reason:string){
    if(connection.dead||this.stopped)return;
    // 4007 "invalid reconnect" on a handover socket: fall back to a fresh connection.
    // Twitch's close reason goes to the log only; the status keeps the code.
    if(reason)this.options.log?.(`eventsub: close ${code}: ${reason}`);
    this.fail(connection,`EventSub closed the connection (${code}).`);
  }
  private scheduleReconnect(){
    if(this.stopped||this.retryTimer!==undefined)return;
    this.state.state='reconnecting';this.state.reconnects+=1;this.state.subscribed=[];this.state.sessionId=undefined;
    const delay=(this.options.backoffMs??(attempt=>Math.min(30_000,1000*2**attempt)))(this.attempt++);
    this.retryTimer=this.timers.setTimeout(()=>{this.retryTimer=undefined;this.open(this.url,'fresh');},delay);
  }
  private armWatchdog(){
    this.clearWatchdog();
    const seconds=this.state.keepaliveSeconds;const connection=this.active;
    if(!seconds||!connection)return;
    this.watchdog=this.timers.setTimeout(()=>{if(connection===this.active)this.fail(connection,`No keepalive for ${seconds} s; reconnecting.`);},seconds*1000+(this.options.keepaliveGraceMs??1000));
  }
  private clearWatchdog(){if(this.watchdog!==undefined){this.timers.clearTimeout(this.watchdog);this.watchdog=undefined;}}
  private remember(id:string):boolean{
    if(this.seen.has(id))return false;
    this.seen.add(id);if(this.seen.size>2000)this.seen.delete(this.seen.values().next().value!);
    return true;
  }
  private receive(connection:Connection,text:string){
    if(connection.dead||this.stopped)return;
    let message:EventSubMessage;
    try{message=JSON.parse(text) as EventSubMessage;}catch{return;}
    const type=message?.metadata?.message_type;
    if(!type)return;
    if(type==='session_welcome'){void this.welcome(connection,message);return;}
    if(connection===this.active)this.armWatchdog();
    if(type==='session_keepalive')return;
    if(type==='session_reconnect'){
      const next=message.payload.session?.reconnect_url;
      if(!next||connection!==this.active)return;
      if(this.pending)this.drop(this.pending);
      this.open(next,'handover');
      return;
    }
    // Twitch may resend a message; process each message_id once.
    if(!message.metadata.message_id||!this.remember(message.metadata.message_id))return;
    if(type==='notification'){
      const subscriptionType=message.metadata.subscription_type??message.payload.subscription?.type;
      if(!subscriptionType)return;
      this.state.notifications+=1;
      try{this.options.onNotification(subscriptionType,message.payload.event,message.metadata.message_id);}
      catch(error){this.options.log?.(`eventsub: handler failed: ${error instanceof Error?error.message:String(error)}`);}
      return;
    }
    if(type==='revocation'){
      const subscription=message.payload.subscription;if(!subscription)return;
      const revocation:Revocation={type:subscription.type,version:subscription.version,status:subscription.status,at:this.now()};
      this.state.revoked=[revocation,...this.state.revoked].slice(0,20);
      this.state.subscribed=this.state.subscribed.filter(entry=>entry!==subscription.type);
      if(subscription.status==='authorization_revoked'){this.authRevoked=true;this.state.state='revoked';this.state.lastError='Twitch access was withdrawn; sign in to Twitch again.';}
      this.options.onRevocation?.(revocation);
    }
  }
  private async welcome(connection:Connection,message:EventSubMessage){
    const session=message.payload.session;
    if(!session?.id||connection.sessionId)return;
    connection.sessionId=session.id;
    if(connection.welcomeTimer!==undefined)this.timers.clearTimeout(connection.welcomeTimer);
    this.state.sessionId=session.id;
    if(typeof session.keepalive_timeout_seconds==='number')this.state.keepaliveSeconds=session.keepalive_timeout_seconds;
    if(connection.purpose==='handover'){
      // The new session already carries every subscription: swap, then close the old socket.
      const old=this.active;this.active=connection;this.pending=undefined;
      if(old&&old!==connection)this.drop(old);
      this.armWatchdog();this.attempt=0;
      return;
    }
    this.active=connection;this.armWatchdog();this.state.state='welcomed';
    const wanted=await this.options.subscriptions();
    const failed:EventSubStatus['failed']=[];const subscribed:string[]=[];
    await Promise.all(wanted.map(async request=>{
      try{await this.options.creator.createEventSubSubscription({type:request.type,version:request.version,condition:request.condition,sessionId:session.id});subscribed.push(request.type);}
      catch(error){failed.push({type:request.type,error:error instanceof Error?error.message:'Subscription failed.'});}
    }));
    if(connection.dead||this.stopped)return;
    this.state.subscribed=wanted.map(request=>request.type).filter(type=>subscribed.includes(type));
    this.state.failed=failed;
    // Still revoked until Twitch accepts a subscription again (a new sign-in).
    if(subscribed.length)this.authRevoked=false;
    this.state.state=this.authRevoked?'revoked':'subscribed';this.attempt=0;
    const first=!this.everSubscribed;this.everSubscribed=true;
    this.options.onSubscribed?.({sessionId:session.id,first});
  }
}
