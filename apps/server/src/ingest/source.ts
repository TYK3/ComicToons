import {isOptOutCommand,sampleSource,type ChatSourceState,type FallbackReason,type StreamEvent} from '@comictoons/core';
import {TwitchIrcAdapter,validChannel,type ChatAdapter,type AdapterFactory,type IrcTransportFactory,type IrcSchedule} from './irc.ts';
import {createHash} from 'node:crypto';

/** Supply private credentials at each adapter start/retry without changing IRC resilience.
 * `now`/`schedule` are an optional test seam: they let a test build a second adapter that
 * shares the first adapter's virtual clock, with no effect on the real (unset) defaults. */
export function authenticatedIrcFactory(
  authenticate: NonNullable<ConstructorParameters<typeof TwitchIrcAdapter>[0]['authenticate']>,
  transport?: IrcTransportFactory,
  now?: () => number,
  schedule?: IrcSchedule,
): AdapterFactory {
  return channel => new TwitchIrcAdapter({channel, authenticate, transport, now, schedule});
}

type ChatOrigin = 'irc' | 'eventsub';
interface SeenEvent {at:number;origin:ChatOrigin;hasId:boolean;crossSource?:boolean}
const CROSS_SOURCE_MS=5000,STANDBY_MS=10_000,STANDBY_MAX=200;

export class ChatSource {
  state:ChatSourceState=sampleSource();
  private adapter?:ChatAdapter;
  private generation=0;
  private lastMessage=0;
  private eventSubChat=false;
  private seen=new Map<string,SeenEvent>();
  private standby:{event:StreamEvent;at:number}[]=[];
  private withdrawn=new Set<string>();
  private denied=new Set<string>();
  private rate:number[]=[];
  private throttled=0;
  get diagnostics(){return {seenEntries:this.seen.size,deniedUsers:this.denied.size,rateEntries:this.rate.length,throttled:this.throttled,standbyEntries:this.standby.length};}
  private privacyChannel='';
  private privacyLocked=false;
  private eventPublisher?:(event:StreamEvent)=>StreamEvent;
  constructor(private callbacks:{change:(source:ChatSourceState)=>void;event:(event:StreamEvent)=>void},
    private factory:AdapterFactory=channel=>new TwitchIrcAdapter({channel}),
    private now:()=>number=()=>Date.now()) {}
  /** App publication runs only after admission; its canonical id is shared with Studio. */
  setEventPublisher(publisher:(event:StreamEvent)=>StreamEvent){this.eventPublisher=publisher;}
  private forwardEvent(event:StreamEvent){const published=this.eventPublisher?.({...event})??event;this.callbacks.event(published);}
  private publish(){this.callbacks.change({...this.state});}
  private detach(){this.generation++;const adapter=this.adapter;this.adapter=undefined;try{adapter?.stop();}catch{/* Fallback is synchronous even if teardown fails. */}}
  private clearAdmission(){this.seen.clear();this.withdrawn.clear();this.standby=[];this.rate=[];this.throttled=0;}
  private remember(key:string,entry:SeenEvent){
    this.seen.set(key,entry);
    while(this.seen.size>1024)this.seen.delete(this.seen.keys().next().value!);
  }
  private payload(event:StreamEvent){return createHash('sha256').update(JSON.stringify([event.user??'',event.text??''])).digest('hex');}
  private pruneStandby(){const cutoff=this.now()-STANDBY_MS;this.standby=this.standby.filter(entry=>entry.at>=cutoff);}
  /** `ended`: EventSub chat is gone for good (sign-in lost, chat subscription revoked), not a reconnect. */
  setEventSubChat(active:boolean,ended=false){
    const previous=this.eventSubChat;this.eventSubChat=active;
    if(this.state.requested!=='twitch')return;
    if(active){
      if(this.privacyLocked)return;
      // A subscribed transport establishes availability, not an extra received message.
      if(!previous){this.lastMessage=this.now();const next:ChatSourceState={...this.state,active:'twitch',connection:'live',reason:undefined,simulated:false};delete next.transport;this.state=next;this.publish();}
    }else if(previous){
      this.pruneStandby();const pending=this.standby;this.standby=[];const before=this.lastMessage;
      for(const {event} of pending)this.admitChat(event,'irc');
      // Unless IRC carried lines meanwhile, leave Live now instead of after the idle tick; the next IRC line brings it back.
      if(ended&&this.lastMessage===before&&this.state.active==='twitch')this.empty();
    }
  }
  acceptEventSub(event:StreamEvent){
    if(this.state.requested!=='twitch'||event.type!=='chat')return;
    // Privacy controls remain immediate even during a transport transition.
    if(!this.eventSubChat){this.privacy(event);return;}
    this.admitChat(event,'eventsub');
  }
  acceptEventSubRaid(event:StreamEvent){
    if(this.state.requested==='twitch'&&event.type==='raid')this.admitSignal(event,'eventsub');
  }
  private admitSignal(event:StreamEvent,origin:ChatOrigin){
    if(origin==='irc'&&this.eventSubChat&&event.type==='raid')return;
    const now=this.now(),id=event.id?`id:${event.id}`:undefined;
    if(id&&this.seen.has(id))return;
    const entry={at:now,origin,hasId:!!id};
    if(id)this.remember(id,entry);
    if(event.type==='raid'){
      // IRC and EventSub assign different envelope ids to the same raid.
      const key=`raid:${createHash('sha256').update(JSON.stringify([event.from?.trim().toLowerCase(),event.viewers])).digest('hex')}`;
      const prior=this.seen.get(key);
      if(prior&&prior.origin!==origin&&now-prior.at<10_000)return;
      this.remember(key,entry);
    }
    // Publish before the direct callback: Studio sees one canonical id on both paths.
    this.forwardEvent(event);
  }
  private privacy(event:StreamEvent):boolean {
    if(event.withdraw==='user'&&event.targetUser){
      const key=event.id?`user:${event.id}`:undefined;
      if(key&&this.withdrawn.has(key))return true;
      if(key){this.withdrawn.add(key);while(this.withdrawn.size>1024)this.withdrawn.delete(this.withdrawn.values().next().value!);}
      this.standby=this.standby.filter(entry=>entry.event.user!==event.targetUser);
      this.forwardEvent(event);return true;
    }
    if(event.withdraw==='message'){
      if(event.targetId){
        // A room-wide clear keeps published panels, so a later single deletion of the
        // same line must still reach Studio: the two are deduplicated separately.
        const key=event.scope==='room'?`room:${event.targetId}`:event.targetId;
        if(this.withdrawn.has(key))return true;
        this.withdrawn.add(key);
        while(this.withdrawn.size>1024)this.withdrawn.delete(this.withdrawn.values().next().value!);
        this.standby=this.standby.filter(entry=>entry.event.id!==event.targetId);
      }
      this.forwardEvent(event);return true;
    }
    if(!isOptOutCommand(event.text,event))return false;
    if(event.user&&!this.denied.has(event.user)){
      const key=`optout:${event.user}`;
      if(this.seen.has(key))return true;
      this.remember(key,{at:this.now(),origin:'irc',hasId:!!event.id});
      // Preserve the existing fail-closed opt-out capacity and permanent channel ledger.
      if(this.denied.size>=4096){this.privacyLocked=true;this.empty();}
      else this.denied.add(event.user);
      this.standby=this.standby.filter(entry=>entry.event.user!==event.user);
      this.forwardEvent(event);
    }
    return true;
  }
  private admitChat(event:StreamEvent,origin:ChatOrigin){
    if(this.state.requested!=='twitch')return;
    if(this.privacy(event))return;
    if(this.privacyLocked||(event.user&&this.denied.has(event.user))||(event.id&&(this.withdrawn.has(event.id)||this.withdrawn.has(`room:${event.id}`))))return;
    const now=this.now();
    if(origin==='irc'&&this.eventSubChat){
      this.pruneStandby();
      if(event.id&&this.standby.some(entry=>entry.event.id===event.id))return;
      this.standby.push({event:{...event},at:now});
      if(this.standby.length>STANDBY_MAX)this.standby.shift();
      return;
    }
    const id=event.id?`id:${event.id}`:undefined,payload=this.payload(event),prior=this.seen.get(payload);
    if(id&&this.seen.has(id))return;
    const duplicate=prior&&(now-prior.at<500||((prior.origin!==origin||prior.crossSource)&&(!prior.hasId||!id)&&now-prior.at<CROSS_SOURCE_MS));
    if(duplicate){
      if(prior.origin!==origin)prior.crossSource=true;
      // Remember a newly supplied id even if its earlier delivery had no id.
      if(id)this.remember(id,{at:now,origin,hasId:true});
      return;
    }
    this.rate=this.rate.filter(at=>now-at<1000);
    if(this.rate.length>=60){this.throttled++;this.state={...this.state,throttled:this.throttled};this.publish();return;}
    this.rate.push(now);
    const entry={at:now,origin,hasId:!!id};
    if(id)this.remember(id,entry);this.remember(payload,entry);
    this.lastMessage=now;this.state={...this.state,active:'twitch',connection:'live',reason:undefined,
      simulated:origin==='eventsub'?false:!!this.adapter?.simulated,received:this.state.received+1};
    this.publish();this.forwardEvent(event);
  }
  sample(reason:FallbackReason='manual') {
    this.detach();this.clearAdmission();this.state={...sampleSource(),reason,connection:reason==='manual'?'sample':reason};this.publish();
  }
  start(channel:string) {
    if(!validChannel(channel))throw new Error('Enter a valid Twitch channel name.');
    this.detach();this.clearAdmission();const generation=this.generation;
    if(channel!==this.privacyChannel){this.denied.clear();this.privacyLocked=false;this.privacyChannel=channel;}
    const available=this.eventSubChat&&!this.privacyLocked;
    this.state={requested:'twitch',active:available?'twitch':'sample',connection:available?'live':'connecting',reason:available?undefined:'empty',channel,simulated:false,received:0};this.publish();
    if(available)this.lastMessage=this.now();
    try {
      const adapter=this.factory(channel);this.adapter=adapter;if(!this.eventSubChat)this.state.simulated=!!adapter.simulated;
      adapter.start({status:(status,retrying)=>{
        if(generation!==this.generation)return;
        if(status!=='connecting'&&status!=='empty'&&!retrying)this.detach();
        if(this.eventSubChat)return;
        // Name the IRC leg once the adapter is welcomed; a TLS-to-WSS fallback updates it.
        const leg=(adapter as {transportName?:unknown}).transportName;
        const transport=status==='empty'&&(leg==='tls'||leg==='wss')?{transport:leg as 'tls'|'wss'}:{};
        this.state={...this.state,...transport,active:'sample',connection:status,reason:status==='connecting'?'empty':status};this.publish();
      },event:event=>{
        if(generation!==this.generation)return;
        if(event.type==='chat'){this.admitChat(event,'irc');return;}
        this.admitSignal(event,'irc');
      }});
    } catch {if(!this.eventSubChat){this.state={...this.state,active:'sample',connection:'unreachable',reason:'unreachable'};this.publish();}}
  }
  empty(){this.state={...this.state,active:'sample',connection:'empty',reason:'empty'};this.publish();}
  /** Quiet chat never leaves Live (RAID-SAMPLE-1): a lull, or a raid with no chat after it, is still the
   * streamer's session, so only a real end (drop, sign-in lost, opt-out ledger full, switch) leaves it. */
  tick(){this.pruneStandby();}
  close(){this.detach();this.clearAdmission();this.eventSubChat=false;}
}
