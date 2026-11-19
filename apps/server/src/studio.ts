import type { StoryFlowReport, StoryFlowMoment, ScenePage, AuthoredLettering } from '@comictoons/core';
import { readProductEnv } from '../../../packages/core/src/env.mjs';
import { illustrateIssue, LibraryProvider } from './pipeline/library.ts';
import {buildIssue, fixtures, getFixture, safeText, isOptOutCommand, mockArt, eventBus, type ComicPanel, type ComicIssue, type TwitchConnection} from '@comictoons/core';
import {ChatSource} from './ingest/source.ts';
import {validChannel,type AdapterFactory} from './ingest/irc.ts';
import {resolveMangaTheme,sampleSource,type ChatSourceState,type StreamEvent,type MangaTheme} from '@comictoons/core';
import {randomUUID} from 'node:crypto';
import {MomentDetector, defaultMomentConfig, type LiveMoment, type MomentConfig, type MomentKind} from './pipeline/moments.ts';
import {writeCaptionSync, type WriterContext} from './pipeline/writer.ts';
import {ArtPipeline, buildArtPrompt} from './pipeline/imagegen.ts';
import {nextUpFor} from './participation/director.ts';
import {parseCommand} from './participation/commands.ts';

/**
 * Every chat command participation/commands.ts handles (!ink, !ink yes|no, !1-!5, !previously, !noink, !optout)
 * is never panel dialogue. The raw !ink form also catches a tab-separated "!ink\tyes", which safeText would join.
 */
const isChatCommand=(text:string|undefined)=>parseCommand(text)!==null||/^!ink(?:\s+(?:yes|no))?$/i.test(text?.trim()??'');

export type StudioState = {mangaTheme?:MangaTheme;source?:ChatSourceState;status:string;fixtureId:string;speed:number;style:string;approvalMode:boolean;panels:ComicPanel[];pendingPanels:ComicPanel[];streamTitle:string;issueTitle:string;elapsed:number;duration:number;recapUrl?:string;shareUrl?:string;
  /** UI-LIVE-A: the waiting panel a mod's `!ink yes` or the studio's A key approves next (director.ts nextUpFor); null when none waits. */
  nextUp?:string|null;pageUrls?:string[];
  /** CLIP-WATCH-1: clips the poller has brought in this live session (the studio's "Clips: N"). */
  clips?:number};
/** live: the detector's (possibly still growing) moment; moment: the snapshot the panel was
 * last written from, so a later delete can always find every line the panel quotes. */
type MomentDraft={live:LiveMoment;moment:LiveMoment;removed:Set<string>};
type UndoAction={kind:'approve'|'reject';panels:ComicPanel[];expires:number};
export class Studio {
  state:StudioState={mangaTheme:'festival',status:'idle',fixtureId:'tabletop-night',speed:60,style:'risograph',approvalMode:true,panels:[],pendingPanels:[],streamTitle:fixtures[0]!.streamTitle,issueTitle:fixtures[0]!.streamTitle,elapsed:0,duration:fixtures[0]!.duration};
  private library=new LibraryProvider();
  private issue:ComicIssue=illustrateIssue(buildIssue(fixtures[0]!),'risograph',this.library);
  private published=new Set<string>();
  private undoActions=new Map<string,UndoAction>();
  private anchor=Date.now();
  private anchorElapsed=0;
  readonly ingest:ChatSource;
  private sampleFallback?:StudioState;
  private liveDrafts=new Map<string,{bucket:number;lines:{user?:string;text:string;id?:string;t:number}[]}>();
  private liveSession='';
  private liveSequence=0;
  private liveArchive?:StudioState;
  private moments:MomentDetector;
  private readonly momentConfig?:Partial<MomentConfig>;
  /** Panels opened for a detected moment (spike/burst from chat ingest, or a bus signal),
   * keyed by panel id, so withdrawals and opt-outs can rewrite or purge them too. */
  private momentDrafts=new Map<string,MomentDraft>();
  private seenEventIds=new Set<string>();
  private recentScenes=new Map<string,string>();
  private promptedScenes=new Map<string,string>();
  private deniedUsers=new Set<string>();
  /** Ids of withdrawn lines (deleted, cleared or timed out), so a moment opened later never cites them. */
  private withdrawnIds=new Set<string>();
  private recentCaptions=new Map<string,string>();
  private art:ArtPipeline;
  private readonly forceArtUpgrade:boolean;
  private pendingArtUpgrades=new Set<Promise<void>>();
  private readonly unsubscribeBus:()=>void;
  /** True while an EventSub session is connected (bus 'twitch-connected' {source:'eventsub'}): the
   * session counts as live Twitch even when IRC is idle, and EventSub is then the chat source. */
  private eventSubLive=false;
  /** CLOCK-1: wall-clock time (ms) at which the live session's elapsed was 0, so tick() keeps the
   * stream clock running when no chat line is quoted (raids, commands, quiet spells). */
  private liveAnchor=0;
  private readonly now:()=>number;
  /** STREAM-END-1: true from a bus 'stream-offline' until the next 'stream-online'. While true,
   * liveEvent/busEvent stop drafting new panels, and sourceChanged keeps reporting the chat
   * connection as 'ended' even if chat keeps arriving on the old transport. */
  private liveEnded=false;
  private sceneCapture=false;
  private chatOnly=false;
  constructor(options:{managedChatSource?:boolean;adapterFactory?:AdapterFactory;now?:()=>number;momentConfig?:Partial<MomentConfig>;artPipeline?:ArtPipeline}={}) {
    this.momentConfig=options.momentConfig;
    this.now=options.now??(()=>Date.now());
    this.moments=new MomentDetector(options.momentConfig);
    this.art=options.artPipeline??new ArtPipeline();
    // An explicitly injected pipeline (replay/demo scripts, tests) is meant to run every
    // time; the real default pipeline only ever touches the network behind this flag so
    // unit/e2e tests never reach it even when provider keys are present in the environment.
    this.forceArtUpgrade=!!options.artPipeline;
    this.state.source=sampleSource();
    this.ingest=new ChatSource({change:source=>this.sourceChanged(source),event:event=>this.liveEvent(event)},options.adapterFactory,options.now);
    // S1 will later emit normalised live events (raid, cheer, hype, redemption, poll, clip)
    // onto this bus; dedup against seenEventIds keeps it from double-processing anything
    // the IRC/sample ingest path above already handled.
    const offEvents=eventBus.on('stream-event',event=>this.busEvent(event));
    const offConnected=eventBus.on('twitch-connected',connection=>{if(!options.managedChatSource)this.twitchConnection(true,connection);});
    const offDisconnected=eventBus.on('twitch-disconnected',connection=>{if(!options.managedChatSource)this.twitchConnection(false,connection);});
    // Stream end/start are independent of chat transport (unlike twitch-connected/disconnected
    // above), so both react regardless of managedChatSource.
    // STREAM-END-1 r1: the next broadcast also undoes endLiveSession's status, or /api/state keeps
    // reading 'stream-ended' while the source is Live again (QA check 3).
    const offOnline=eventBus.on('stream-online',()=>{if(this.liveEnded&&this.state.source?.active==='twitch')this.state={...this.state,status:'live'};this.liveEnded=false;});
    const offOffline=eventBus.on('stream-offline',()=>this.endLiveSession());
    this.unsubscribeBus=()=>{offEvents();offConnected();offDisconnected();offOnline();offOffline();};
  }
  /** STREAM-END-1: EventSub stream.offline moves the session out of Live without losing the issue.
   * Approved panels and the manga export are untouched (unlike stop(), nothing here clears
   * panels/pendingPanels/recapUrl); only new drafting stops (liveEnded, checked in liveEvent and
   * busEvent) and the chat chip (chatSourceChip/chatStateText, apps/web/src/ui/screens/studio/live.ts)
   * reads "Stream ended" once source.connection is 'ended'. */
  private endLiveSession(){
    if(this.state.source?.active!=='twitch'||this.liveEnded)return;
    this.liveEnded=true;
    this.state={...this.state,status:'stream-ended',source:{...this.state.source,connection:'ended',reason:'ended'}};
  }
  sampleSnapshot():StudioState {
    if(this.state.source?.active==='twitch' && this.sampleFallback)return structuredClone(this.sampleFallback);
    if(this.state.panels.length||this.state.pendingPanels.length)return {...structuredClone(this.state),source:sampleSource()};
    const panels=structuredClone(this.issue.panels);
    return {...structuredClone(this.state),source:sampleSource(),status:'ready',elapsed:this.state.duration,
      panels:this.state.approvalMode?[]:panels,pendingPanels:this.state.approvalMode?panels:[],recapUrl:undefined,shareUrl:undefined,pageUrls:undefined};
  }
  private sceneEditor?: (id:string,lettering:AuthoredLettering)=>Promise<unknown>;
  setSceneEditor(editor:(id:string,lettering:AuthoredLettering)=>Promise<unknown>){this.sceneEditor=editor;}
  queueScenePage(page:ScenePage,channel:string,imageUrl:string){
    const existing=[...this.state.pendingPanels,...this.state.panels].find(panel=>panel.id===page.id);
    if(existing&&page.status==='ready'&&page.authoredLettering){existing.imageUrl=imageUrl;existing.caption=page.authoredLettering.text;existing.imageRevision=undefined;return;}
    if(page.status!=='ready'||this.state.panels.some(p=>p.id===page.id)||this.state.pendingPanels.some(p=>p.id===page.id))return;
    const description=page.provider==='source'?'Actual captured frames composed locally with attributed chat; no AI illustration':'AI interpretation of timestamped captured frames';
    this.state.pendingPanels.push({id:page.id,origin:'twitch',caption:page.title,dialogue:[],scene:description,characters:[],mood:'observed',altText:`${page.title}. ${description}; no speech transcription.`,imageUrl,at:this.state.elapsed,provenance:{provider:`scene-${page.provider}`,style:'comic',asset:page.id,fallback:false},sources:page.sourceChatIds});
    this.state.issueTitle=this.state.issueTitle||`#${channel} comic`;this.state.status='live';
  }
  beginSceneCapture(channel:string){this.sceneCapture=true;this.useSource('twitch',channel,true);}
  withdrawScenePage(id:string){this.state.panels=this.state.panels.filter(p=>p.id!==id);this.state.pendingPanels=this.state.pendingPanels.filter(p=>p.id!==id);}
  storyFlow(): StoryFlowReport {
    const panels = [...this.state.panels, ...this.state.pendingPanels];
    const moments: StoryFlowMoment[] = panels.filter(panel => panel.origin === 'twitch').map(panel => {
      const draft = this.momentDrafts.get(panel.id);
      const bucket = this.liveDrafts.get(panel.id);
      const moment = draft ? this.visibleMoment(draft) : undefined;
      const events = moment?.events ?? (bucket?.lines ?? []).map(line => ({ ...line, type: 'chat' as const }));
      const chats = events.filter(event => event.type === 'chat');
      return { id: panel.id, kind: moment?.kind ?? 'chat', at: panel.at, endAt: moment?.endAt ?? events.at(-1)?.t ?? panel.at,
        score: moment?.score ?? chats.length, candidate: !!moment && moment.kind !== 'chat', token: moment?.token,
        messageCount: chats.length, distinctUsers: new Set(chats.map(event => event.user).filter(Boolean)).size,
        quotes: chats.slice(0, 8).map(event => ({ id: event.id, at: event.t, text: safeText(event.text ?? '') })),
        sourceIds: moment?.sourceIds ?? panel.sources ?? [], clipUrl: panel.clipUrl,
        artProvider: panel.provenance?.provider ?? 'unknown', caption: panel.caption };
    });
    const source = this.state.source ?? sampleSource();
    return { capturedAt: new Date(this.now()).toISOString(), channel: source.channel, connected: source.active === 'twitch',
      simulated: source.simulated, transport: source.transport, received: source.received, throttled: this.ingest.diagnostics.throttled,
      clips: this.state.clips ?? 0, detector: this.moments.diagnostics(this.state.elapsed),
      thresholds: { ...defaultMomentConfig, ...this.momentConfig }, moments: moments.slice(-24).reverse(),
      capabilities: { videoAnalysis: false, speechTranscription: false, automaticScenePages: false } };
  }
  useSource(mode:'sample'|'twitch',channel='',fresh=false,chatOnly=false) {
    if(this.state.status==='exporting')throw new Error('Please wait while your issue is being exported.');
    this.chatOnly=mode==='twitch'&&chatOnly;
    if(mode==='sample') {
      if(this.state.source?.active!=='twitch')this.state=this.sampleSnapshot();
      this.ingest.sample();
    } else {
      if(!validChannel(channel))throw new Error('Enter a valid Twitch channel name.');
      if(this.state.source?.active==='twitch')this.liveArchive=structuredClone(this.state);
      if(fresh)this.liveArchive=undefined;
      this.sampleFallback=this.sampleSnapshot();this.sampleFallback.status='ready';
      this.state=structuredClone(this.sampleFallback);
      this.ingest.start(channel);
    }
    return this.state;
  }
  /** An EventSub session is live Twitch in its own right (REQUEST 3 of report-t3): raids, cheers,
   * hype, redemptions and chat open panels while it is connected, with or without IRC. */
  private twitchConnection(connected:boolean,connection?:TwitchConnection) {
    if(connection?.source!=='eventsub')return;
    if(connected) {
      this.eventSubLive=true;
      if(this.state.source?.active!=='twitch')this.sourceChanged({requested:'twitch',active:'twitch',connection:'live',simulated:false,received:0,
        channel:connection.channel??this.state.source?.channel??this.ingest.state.channel});
      return;
    }
    this.eventSubLive=false;
    // Back to whatever IRC reports: still live when the IRC fallback is connected, else Sample Data.
    if(this.ingest.state.active!=='twitch')this.sourceChanged({...this.ingest.state,reason:this.ingest.state.reason??'disconnected'});
  }
  private sourceChanged(source:ChatSourceState) {
    const wasLive=this.state.source?.active==='twitch';
    // IRC dropping to Sample Data does not end a session that EventSub still carries.
    if(source.active==='sample'&&wasLive&&this.eventSubLive)return;
    if(source.active==='twitch'&&!wasLive) {
      this.liveEnded=false;
      this.sampleFallback={...structuredClone(this.state),source:sampleSource(),status:'ready'};
      this.undoActions.clear();
      if(this.liveArchive&&this.liveArchive.source?.channel===source.channel)this.state={...structuredClone(this.liveArchive),status:'live'};
      else {
        this.liveDrafts.clear();this.liveSession=randomUUID();this.liveSequence=0;this.liveArchive=undefined;
        this.recentCaptions.clear();this.recentScenes.clear();this.promptedScenes.clear();this.seenEventIds.clear();this.withdrawnIds.clear();this.momentDrafts.clear();this.moments=new MomentDetector(this.momentConfig);
        this.state={...this.state,status:'live',fixtureId:'twitch',streamTitle:`#${source.channel} chat`,issueTitle:'Live chat, illustrated',
          panels:[],pendingPanels:[],elapsed:0,duration:0,recapUrl:undefined,shareUrl:undefined,pageUrls:undefined,clips:0};
      }
      this.liveAnchor=this.now()-(this.state.elapsed??0)*1000;
    } else if(source.active==='sample'&&wasLive&&this.sampleFallback) {
      this.liveArchive=structuredClone(this.state);
      this.state=structuredClone(this.sampleFallback);this.undoActions.clear();
    }
    // STREAM-END-1: once the stream has ended, a chat line still arriving on the old transport
    // (source.ts always reports it as 'live') must not resurrect the stale Live indicator; only a
    // fresh live session (handled above) or a 'stream-online' bus event clears liveEnded.
    this.state.source=(this.liveEnded&&source.active==='twitch')?{...source,connection:'ended',reason:'ended'}:source;
  }
  private static purgePanels(target:{panels:ComicPanel[];pendingPanels:ComicPanel[]},ids:Set<string>) {
    target.panels=target.panels.filter(panel=>!ids.has(panel.id));
    target.pendingPanels=target.pendingPanels.filter(panel=>!ids.has(panel.id));
  }
  private withdraw(event:StreamEvent){
    if(event.withdraw==='message'){this.withdrawMessage(event.targetId,event.scope==='room');return;}
    if(event.withdraw==='user'&&event.targetUser){
      const user=event.targetUser;
      const keys=new Set<string>();
      for(const draft of this.liveDrafts.values())for(const line of draft.lines)if(line.user===user&&!line.id)keys.add(Studio.lineKey(line));
      for(const draft of this.momentDrafts.values())for(const item of draft.moment.events)if(item.type==='chat'&&item.user===user&&!item.id)keys.add(Studio.lineKey(item));
      const ids=new Set<string>();
      for(const draft of this.liveDrafts.values())for(const line of draft.lines)if(line.user===user&&line.id)ids.add(line.id);
      for(const draft of this.momentDrafts.values())for(const item of draft.moment.events)if(item.user===user&&item.id)ids.add(item.id);
      for(const id of ids)this.withdrawMessage(id);
      this.withdrawIdless(keys);
      this.moments.forgetUser(user);
      this.moments.forget(event=>event.type==='chat'&&event.user===user);
    }
  }
  private static lineKey(line:{user?:string;text?:string;t:number}):string{return JSON.stringify([line.user??'',line.text??'',line.t]);}
  /** User clears also cover legacy chat without ids, identified by user/text/time. */
  private withdrawIdless(keys:Set<string>){
    if(!keys.size)return;
    const match=(event:StreamEvent)=>event.type==='chat'&&!event.id&&keys.has(Studio.lineKey(event));
    this.moments.forget(match);
    for(const [id,draft] of [...this.liveDrafts]){
      const kept=draft.lines.filter(line=>line.id||!keys.has(Studio.lineKey(line)));
      if(kept.length===draft.lines.length)continue;
      draft.lines=kept;
      if(!kept.length){
        Studio.purgePanels(this.state,new Set([id]));if(this.liveArchive)Studio.purgePanels(this.liveArchive,new Set([id]));
        this.liveDrafts.delete(id);this.recentCaptions.delete(id);
      }else this.forEachLivePanel(id,panel=>{panel.dialogue=kept.map(line=>line.text);if(panel.storyBeats?.[0])panel.storyBeats[0].dialogue=[...panel.dialogue];this.describeBucketPanel(panel,draft,panel.at);});
    }
    for(const [id,draft] of [...this.momentDrafts]){
      const kept=draft.moment.events.filter(event=>!match(event));
      if(kept.length===draft.moment.events.length)continue;
      draft.moment={...draft.moment,events:kept,sourceIds:kept.flatMap(event=>event.id?[event.id]:[])};
      this.rewriteOrPurgeMoment(id);
    }
    this.undoActions.clear();
    if(!this.state.panels.length&&!this.state.pendingPanels.length)this.ingest.empty();
  }
  /** Published means approved onto the issue (live state or its archive), not a pending draft. */
  private isPublished(id:string):boolean {
    return this.state.panels.some(panel=>panel.id===id)||!!this.liveArchive?.panels.some(panel=>panel.id===id);
  }
  /** Young's ruling (31 Oct, 02:14): a room-wide clear (room=true) drops the cleared lines from
   * drafts and moments but never rewrites or purges a published panel, and it is not an opt-out.
   * A single deletion (CLEARMSG) and a ban or timeout still withdraw the line everywhere. */
  private withdrawMessage(targetId?:string,room=false) {
    if(!targetId)return;
    this.withdrawnIds.add(targetId);
    while(this.withdrawnIds.size>1024)this.withdrawnIds.delete(this.withdrawnIds.values().next().value!);
    let panelId:string|undefined,publishedHit=false;
    for(const [id,draft] of this.liveDrafts) {
      const index=draft.lines.findIndex(line=>line.id===targetId);
      if(index<0)continue;
      if(room&&this.isPublished(id)){publishedHit=true;break;}
      draft.lines.splice(index,1);panelId=id;break;
    }
    const momentHit=this.withdrawFromMoments(targetId,room);
    if(panelId===undefined){if(momentHit||publishedHit)this.undoActions.clear();return;}
    const draft=this.liveDrafts.get(panelId)!;
    const lines=draft.lines.map(line=>line.text);
    const sync=(panel:ComicPanel)=>{if(panel.id!==panelId)return;panel.dialogue=lines;panel.storyBeats![0]!.dialogue=[...lines];if(lines.length)this.describeBucketPanel(panel,draft,panel.at);};
    this.state.panels.forEach(sync);this.state.pendingPanels.forEach(sync);
    if(this.liveArchive){this.liveArchive.panels.forEach(sync);this.liveArchive.pendingPanels.forEach(sync);}
    if(!lines.length) {
      const affected=new Set([panelId]);
      Studio.purgePanels(this.state,affected);
      if(this.liveArchive)Studio.purgePanels(this.liveArchive,affected);
      this.liveDrafts.delete(panelId);
      if(!this.state.panels.length&&!this.state.pendingPanels.length)this.ingest.empty();
    }
    if(!this.state.panels.length&&!this.state.pendingPanels.length)this.ingest.empty();
    this.undoActions.clear();
  }
  /** A viewer opting out: their drafted lines and moment panels are purged at once. */
  private optOut(user?:string) {
    if(!user)return;
    this.deniedUsers.add(user);
    this.moments.forget(event=>event.type==='chat'&&event.user===user);
    const affected=new Set([...this.liveDrafts].filter(([,draft])=>draft.lines.some(line=>line.user===user)).map(([id])=>id));
    Studio.purgePanels(this.state,affected);
    if(this.liveArchive)Studio.purgePanels(this.liveArchive,affected);
    for(const id of affected){this.liveDrafts.delete(id);this.recentCaptions.delete(id);}
    const momentHit=this.optOutFromMoments(user);
    this.undoActions.clear();
    if((affected.size||momentHit)&&!this.state.panels.length&&!this.state.pendingPanels.length)this.ingest.empty();
  }
  private liveEvent(event:StreamEvent) {
    if(event.withdraw){this.withdraw(event);return;}
    const text=safeText(event.text ?? '').trim();
    if(isOptOutCommand(event.text,event)){if(event.user)this.moments.forgetUser(event.user);this.optOut(event.user);return;}
    if(isChatCommand(event.text))return;
    // One chat line is handled once, whichever source (IRC here, EventSub on the bus) brings it
    // first: the same message id arriving by the other path is neither counted nor quoted again.
    if(event.id){if(this.seenEventIds.has(event.id))return;this.markSeenEventId(event.id);}
    const opened=text?this.moments.ingest(event):undefined;
    if(this.sceneCapture||this.chatOnly)return;
    if(!text||/^!ink$/i.test(text)||this.state.source?.active!=='twitch'||this.liveEnded)return;
    // Chat velocity spikes and emote/keyword bursts become their own kind-specific panels.
    if(opened)this.openMomentPanel(opened);
    else this.refreshMomentPanel(event);
    this.quoteChat(event,text);
  }
  /** Adds one chat line to the per-minute chat panel for its minute. */
  private quoteChat(event:StreamEvent,text:string) {
    this.state.elapsed=Math.max(this.state.elapsed,event.t);
    // An opted-out viewer is never quoted, even when the ingest source did not recognise the
    // command form they used (every alias in core optOutCommands lands here).
    if(event.user&&this.deniedUsers.has(event.user))return;
    const bucket=Math.floor(event.t/60);
    let panel=(this.state.approvalMode?this.state.pendingPanels:this.state.panels).find(candidate=>this.liveDrafts.get(candidate.id)?.bucket===bucket);
    let created=false;
    if(!panel) {
      if(this.state.pendingPanels.length>=24||this.liveDrafts.size>=120)return;
      const id=`irc-${this.liveSession}-${this.liveSequence++}`;
      const origin=this.state.source?.simulated?'sample':'twitch';
      const art=this.pickLiveArt('chat');
      panel={id,origin,caption:'',storyCaption:'',dialogue:[],at:event.t,scene:'',altText:'',characters:[],mood:'reflective',imageUrl:art.imageUrl,
        provenance:{provider:art.provider,asset:art.asset,style:this.state.style==='noir'?'midnight-noir':'pop-ink',fallback:art.fallback},
        storyBeats:[{frame:0,imageUrl:art.imageUrl,scene:'',dialogue:[]}]};
      this.liveDrafts.set(id,{bucket,lines:[]});
      (this.state.approvalMode?this.state.pendingPanels:this.state.panels).push(panel);
      created=true;
    }
    const draft=this.liveDrafts.get(panel.id)!;
    if(draft.lines.length>=4||draft.lines.some(line=>line.text===text))return;
    draft.lines.push({user:event.user,text,id:event.id,t:event.t});panel.dialogue=draft.lines.map(line=>line.text);
    panel.storyBeats![0]!.dialogue=[...panel.dialogue];
    this.describeBucketPanel(panel,draft,event.t);
    if(created)this.upgradeArtAsync(panel);
  }
  private markSeenEventId(id:string):void {
    this.seenEventIds.add(id);
    while(this.seenEventIds.size>2048)this.seenEventIds.delete(this.seenEventIds.values().next().value!);
  }
  private writerContext(excludeId:string):WriterContext {
    const others=(map:Map<string,string>)=>[...map].filter(([id])=>id!==excludeId).map(([,value])=>value);
    return {recentCaptions:others(this.recentCaptions),recentScenes:[...others(this.recentScenes),...others(this.promptedScenes)]};
  }
  /** Scenes are remembered like captions, so another panel's scene (its alt text) and any
   * scene already sent to the image model are never asked for again. */
  private rememberScene(id:string,scene:string,map:Map<string,string>=this.recentScenes):void {
    map.delete(id);map.set(id,scene);
    while(map.size>200)map.delete(map.keys().next().value!);
  }
  private rememberCaption(id:string,caption:string):void {
    this.recentCaptions.delete(id);this.recentCaptions.set(id,caption);
    while(this.recentCaptions.size>200)this.recentCaptions.delete(this.recentCaptions.keys().next().value!);
  }
  /** Replaces the old fixed caption/image (B2) with a caption written from this bucket's
   * real chat lines, keeping the existing per-minute bucketing and caps unchanged. */
  private describeBucketPanel(panel:ComicPanel,draft:{bucket:number;lines:{user?:string;text:string;id?:string;t:number}[]},t:number):void {
    const events:StreamEvent[]=draft.lines.map(line=>({id:line.id,t,type:'chat',user:line.user,text:line.text}));
    const moment:LiveMoment={kind:'chat',startAt:panel.at,endAt:t,score:events.length,events,sourceIds:events.map(e=>e.id).filter((id):id is string=>!!id)};
    const written=writeCaptionSync(moment,this.writerContext(panel.id));
    panel.caption=written.caption;panel.storyCaption=written.caption;panel.sfx=written.sfx;panel.mood=written.mood;panel.sources=written.sources;
    panel.scene=written.scene;panel.altText=written.scene;
    if(panel.storyBeats?.[0])panel.storyBeats[0]!.scene=written.scene;
    this.rememberCaption(panel.id,written.caption);this.rememberScene(panel.id,written.scene);
  }
  /** Rotates through the existing library so successive live panels get different art
   * immediately; upgradeArtAsync may later replace it in place with generated/clip art. */
  private pickLiveArt(kind?:MomentKind):{imageUrl:string;provider:string;asset?:string;fallback:boolean} {
    const picked=this.library.pickLiveImage({style:this.state.style,kind});
    if(picked)return {imageUrl:picked.imageUrl,provider:picked.provider,asset:picked.asset,fallback:false};
    return {imageUrl:mockArt(0,this.state.style),provider:'procedural',fallback:true};
  }
  /** Opt-in only (COMICTOONS_ART_NETWORK=1, or an explicitly injected pipeline) so unit/e2e
   * tests never reach the network even when provider keys are present in the environment.
   * Upgrades the panel in place; state polling picks the change up. Any failure leaves the
   * already-assigned library art. */
  private upgradeArtAsync(panel:ComicPanel):void {
    if(!this.forceArtUpgrade&&readProductEnv('COMICTOONS_ART_NETWORK')!=='1')return;
    const prompt=buildArtPrompt(panel.scene,this.state.mangaTheme);
    this.rememberScene(panel.id,panel.scene,this.promptedScenes);
    const clip=panel.clipUrl?{url:panel.clipUrl,thumbnailUrl:panel.frameUrl??panel.clipUrl}:undefined;
    const job=this.art.generate({prompt,cacheKey:`${panel.id}:${prompt}`,clip}).then(result=>{
      if(!result)return;
      panel.imageUrl=result.imageUrl;panel.frameUrl=result.imageUrl;
      if(panel.storyBeats?.[0])panel.storyBeats[0]!.imageUrl=result.imageUrl;
      panel.provenance={provider:result.provider,style:panel.provenance?.style??(this.state.style==='noir'?'midnight-noir':'pop-ink'),fallback:false};
    }).catch(()=>{/* keep the already-assigned library art on any failure */}).finally(()=>{this.pendingArtUpgrades.delete(job);});
    this.pendingArtUpgrades.add(job);
  }
  /** Lets tests/scripts await every art upgrade an injected pipeline has in flight before
   * reading final panel state; the real server never needs to call this. */
  async flushArtUpgrades():Promise<void> {
    while(this.pendingArtUpgrades.size)await Promise.all([...this.pendingArtUpgrades]);
  }
  /** Opted-out users are never quoted, including for bus-sourced moments. */
  private sanitizeMoment(moment:LiveMoment):LiveMoment {
    const events=moment.events.filter(event=>!(event.type==='chat'&&event.user&&this.deniedUsers.has(event.user)));
    return {...moment,events,sourceIds:events.map(event=>event.id).filter((id):id is string=>!!id)};
  }
  /** Applies moderator deletes and opt-outs to a moment before it is written. */
  private visibleMoment(draft:MomentDraft):LiveMoment {
    const moment=draft.moment,events=moment.events.filter(event=>!event.id||!draft.removed.has(event.id));
    return this.sanitizeMoment({...moment,events,sourceIds:events.flatMap(event=>event.id?[event.id]:[])});
  }
  private static snapshot(moment:LiveMoment):LiveMoment {return {...moment,events:[...moment.events],sourceIds:[...moment.sourceIds]};}
  private static chatDriven(moment:LiveMoment):boolean {return moment.kind==='spike'||moment.kind==='burst'||moment.kind==='chat';}
  /** Rewrites a moment panel from its visible events; returns false when nothing quotable is
   * left (a chat-driven moment whose every line was deleted or opted out), so the caller purges it. */
  private writeMomentPanel(panel:ComicPanel,draft:MomentDraft):boolean {
    const visible=this.visibleMoment(draft);
    if(Studio.chatDriven(visible)&&!visible.events.some(event=>event.type==='chat'))return false;
    const written=writeCaptionSync(visible,this.writerContext(panel.id));
    panel.caption=written.caption;panel.storyCaption=written.caption;panel.dialogue=written.dialogue;panel.sfx=written.sfx;panel.mood=written.mood;
    panel.sources=written.sources;panel.scene=written.scene;panel.altText=written.scene;
    if(panel.storyBeats?.[0]){panel.storyBeats[0]!.scene=written.scene;panel.storyBeats[0]!.dialogue=[...written.dialogue];}
    this.rememberCaption(panel.id,written.caption);this.rememberScene(panel.id,written.scene);
    return true;
  }
  private forEachLivePanel(id:string,fn:(panel:ComicPanel)=>void):void {
    for(const target of [this.state,this.liveArchive])if(target)for(const panel of [...target.panels,...target.pendingPanels])if(panel.id===id)fn(panel);
  }
  private rewriteOrPurgeMoment(id:string):void {
    const draft=this.momentDrafts.get(id);if(!draft)return;
    let keep=true;this.forEachLivePanel(id,panel=>{keep=this.writeMomentPanel(panel,draft)&&keep;});
    if(keep)return;
    const affected=new Set([id]);
    Studio.purgePanels(this.state,affected);
    if(this.liveArchive)Studio.purgePanels(this.liveArchive,affected);
    this.momentDrafts.delete(id);
    this.recentCaptions.delete(id);
  }
  private withdrawFromMoments(targetId:string,room=false):boolean {
    let hit=false;
    this.moments.forget([targetId]);
    for(const [id,draft] of [...this.momentDrafts]) {
      if(!draft.moment.events.some(event=>event.id===targetId))continue;
      hit=true;
      if(room&&this.isPublished(id))continue;
      const kept=draft.moment.events.filter(event=>event.id!==targetId);
      draft.moment={...draft.moment,events:kept,sourceIds:kept.flatMap(event=>event.id?[event.id]:[])};
      this.rewriteOrPurgeMoment(id);
    }
    if(hit&&!this.state.panels.length&&!this.state.pendingPanels.length)this.ingest.empty();
    return hit;
  }
  private optOutFromMoments(user:string):boolean {
    let hit=false;
    for(const [id,draft] of [...this.momentDrafts]) {
      if(!draft.moment.events.some(event=>event.type==='chat'&&event.user===user))continue;
      const kept=draft.moment.events.filter(event=>event.type!=='chat'||event.user!==user);
      draft.moment={...draft.moment,events:kept,sourceIds:kept.flatMap(event=>event.id?[event.id]:[])};
      hit=true;this.rewriteOrPurgeMoment(id);
    }
    return hit;
  }
  /** While a moment is still unfolding, chat lines that join the detector's open moment
   * refresh its panel (more voices and the crowd's real line for a spike/burst; real chat
   * reactions as dialogue for a raid/cheer/hype/etc.), then the panel settles. */
  private refreshMomentPanel(event:StreamEvent):void {
    const open=this.moments.current();
    if(!open||open.events.at(-1)!==event)return;
    const window=Math.max(this.momentConfig?.spikeWindowSeconds??10,this.momentConfig?.burstWindowSeconds??8);
    if(event.t-open.startAt>window)return;
    for(const [id,draft] of this.momentDrafts)if(draft.live===open){draft.moment=Studio.snapshot(open);this.rewriteOrPurgeMoment(id);return;}
  }
  /** Strong signals (raid/cheer/hype/redemption/poll/clip) from the bus, and chat velocity
   * spikes and emote/keyword bursts from either the chat ingest path or the bus, each become
   * their own kind-specific panel, independent of the per-minute chat bucket above. */
  private openMomentPanel(moment:LiveMoment):void {
    if(this.state.pendingPanels.length>=24||this.liveDrafts.size+this.momentDrafts.size>=120)return;
    // The detector may still hold withdrawn lines in its windows; a new moment never cites them.
    const removed=new Set(moment.events.flatMap(event=>event.id&&this.withdrawnIds.has(event.id)?[event.id]:[]));
    const draft:MomentDraft={live:moment,moment:Studio.snapshot(moment),removed};
    const sanitized=this.visibleMoment(draft);
    if(Studio.chatDriven(sanitized)&&!sanitized.events.some(event=>event.type==='chat'))return;
    const written=writeCaptionSync(sanitized,this.writerContext(''));
    const id=`irc-${this.liveSession}-${this.liveSequence++}`;
    const origin=this.state.source?.simulated?'sample':'twitch';
    const art=this.pickLiveArt(moment.kind);
    const panel:ComicPanel={id,origin,caption:written.caption,storyCaption:written.caption,dialogue:written.dialogue,at:moment.startAt,
      scene:written.scene,altText:written.scene,characters:[],mood:written.mood,imageUrl:art.imageUrl,sfx:written.sfx,sources:written.sources,
      provenance:{provider:art.provider,asset:art.asset,style:this.state.style==='noir'?'midnight-noir':'pop-ink',fallback:art.fallback},
      storyBeats:[{frame:0,imageUrl:art.imageUrl,scene:written.scene,dialogue:written.dialogue}],
      ...(moment.frame?{clipUrl:moment.frame.url,frameUrl:moment.frame.thumbnailUrl}:{})};
    this.rememberCaption(id,written.caption);this.rememberScene(id,written.scene);
    this.momentDrafts.set(id,draft);
    (this.state.approvalMode?this.state.pendingPanels:this.state.panels).push(panel);
    this.upgradeArtAsync(panel);
  }
  private busEvent(event:StreamEvent|null|undefined):void {
    if(!event)return;
    if(event.id){ if(this.seenEventIds.has(event.id))return; this.markSeenEventId(event.id); }
    if(event.withdraw){this.withdraw(event);return;}
    const text=safeText(event.text ?? '').trim();
    if(event.type==='chat'&&isOptOutCommand(event.text,event)){if(event.user)this.moments.forgetUser(event.user);this.optOut(event.user);return;}
    if(event.user&&isOptOutCommand(event.text,event))this.deniedUsers.add(event.user);
    if(isChatCommand(event.text))return;
    if(this.state.source?.active!=='twitch'||this.liveEnded)return;
    if(event.type==='clip')this.state.clips=(this.state.clips??0)+1;
    const opened=this.moments.ingest(event);
    if(this.sceneCapture||this.chatOnly)return;
    if(opened)this.openMomentPanel(opened);
    // EventSub chat on the bus is quoted like IRC chat (it is the chat source while connected);
    // a line already taken from IRC never reaches here, because its id was seen above.
    if(event.type!=='chat'||!text||/^!ink$/i.test(text))return;
    if(!opened)this.refreshMomentPanel(event);
    this.quoteChat(event,text);
  }
  close(){this.unsubscribeBus();this.ingest.close();}
  tick(){
    this.ingest.tick();
    if(this.state.status==='live'&&this.state.source?.active==='twitch')this.state.elapsed=Math.max(this.state.elapsed??0,(this.now()-this.liveAnchor)/1000);
    if(this.state.status!=='replaying')return this.withNextUp();
    const elapsed=Math.min(this.state.duration,this.anchorElapsed+(Date.now()-this.anchor)/1000*this.state.speed);
    this.state.elapsed=elapsed;
    for(const panel of this.issue.panels){if(panel.at<=elapsed&&!this.published.has(panel.id)){this.published.add(panel.id);(this.state.approvalMode?this.state.pendingPanels:this.state.panels).push(structuredClone(panel));}}
    if(elapsed>=this.state.duration)this.state.status='ready';
    return this.withNextUp();
  }
  /** UI-LIVE-A: stamp `nextUp` on the state the API sends (GET /api/state, the event stream after each tick, approve/reject). */
  private withNextUp(){this.state.nextUp=nextUpFor(this.state.pendingPanels)??null;return this.state;}
  replay(fixtureId:string,speed=60,style='risograph'){
    const fixture=getFixture(fixtureId);this.ingest.sample();this.sampleFallback=undefined;this.liveArchive=undefined;this.liveDrafts.clear();this.momentDrafts.clear();this.issue=illustrateIssue(buildIssue(fixture,style),style,this.library);this.published.clear();this.undoActions.clear();this.anchor=Date.now();this.anchorElapsed=0;
    this.state={...this.state,status:'replaying',fixtureId,speed,style,panels:[],pendingPanels:[],streamTitle:fixture.streamTitle,issueTitle:fixture.streamTitle,elapsed:0,duration:fixture.duration,recapUrl:undefined,shareUrl:undefined,pageUrls:undefined};return this.tick();
  }
  settings(body:{speed?:number;approvalMode?:boolean;mangaTheme?:MangaTheme}){
    if(body.mangaTheme){const theme=resolveMangaTheme(body.mangaTheme);this.state.mangaTheme=theme;if(this.sampleFallback)this.sampleFallback.mangaTheme=theme;if(this.liveArchive)this.liveArchive.mangaTheme=theme;}
    this.tick();this.anchorElapsed=this.state.elapsed;this.anchor=Date.now();
    if(body.speed!==undefined)this.state.speed=body.speed;
    if(body.approvalMode===false&&this.state.pendingPanels.some(panel=>panel.releaseBlocked))throw new Error('Source-grounded cameo art is required; library placeholders cannot be released.');
    if(body.approvalMode===false&&this.state.pendingPanels.some(panel=>panel.imageRevision))throw new Error('Resolve image lettering revisions before enabling automatic release.');
    if(body.approvalMode!==undefined){this.state.approvalMode=body.approvalMode;if(!body.approvalMode){this.state.panels.push(...this.state.pendingPanels);this.state.pendingPanels=[];}}
    return this.state;
  }
  private remember(kind:UndoAction['kind'],panels:ComicPanel[]){
    for(const [token,action] of this.undoActions)if(action.expires<Date.now())this.undoActions.delete(token);
    const token=randomUUID();this.undoActions.set(token,{kind,panels:structuredClone(panels),expires:Date.now()+30_000});return token;
  }
  moderate(kind:'approve'|'reject',panelId?:string,all=false){
    this.tick();const selected=this.state.pendingPanels.filter((p,i)=>panelId?p.id===panelId:all||kind==='approve'||i===0);
    if(!selected.length)throw new Error('There are no matching panels waiting for review.');
    if(kind==='approve'&&selected.some(panel=>panel.releaseBlocked))throw new Error('Source-grounded cameo art is required; library placeholders cannot be released.');
    if(kind==='approve'&&selected.some(panel=>panel.imageRevision))throw new Error('Resolve the image lettering revision before releasing this page.');
    this.state.pendingPanels=this.state.pendingPanels.filter(p=>!selected.some(s=>s.id===p.id));
    if(kind==='approve')this.state.panels.push(...selected);
    this.state.panels.sort((a,b)=>a.at-b.at);
    return {...this.withNextUp(),undoToken:this.remember(kind,selected)};
  }
  undo(token:string){
    const action=this.undoActions.get(token);if(!action||action.expires<Date.now())throw new Error('This undo has expired. New strips are still waiting in the studio.');
    this.undoActions.delete(token);
    if(action.kind==='approve')this.state.panels=this.state.panels.filter(p=>!action.panels.some(s=>s.id===p.id));
    const present=new Set([...this.state.panels,...this.state.pendingPanels].map(p=>p.id));this.state.pendingPanels.push(...action.panels.filter(p=>!present.has(p.id)));
    this.state.pendingPanels.sort((a,b)=>a.at-b.at);return this.state;
  }
  caption(panelId:string,caption:string,attribution:AuthoredLettering['attribution']='Author'){
    const panel=[...this.state.pendingPanels,...this.state.panels].find(p=>p.id===panelId);if(!panel)throw new Error('That panel is no longer available.');
    const cleaned=safeText(caption).trim();if(!cleaned||cleaned.length>280)throw new Error('Use 1 to 280 characters for the caption.');
    if(panel.provenance?.provider.startsWith('scene-')){
      if(!this.sceneEditor)throw new Error('Image revision is unavailable. The original picture is unchanged.');
      if(panel.imageRevision?.status==='rendering')throw new Error('This image revision is already rendering.');
      panel.imageRevision={status:'rendering'};
      return this.sceneEditor(panelId,{text:cleaned,attribution}).then(()=>{panel.imageRevision=undefined;return this.state;},error=>{panel.imageRevision={status:'failed',reason:error instanceof Error?error.message:'Image revision failed.'};throw error;});
    }
    if(!this.state.pendingPanels.includes(panel))throw new Error('That panel is no longer waiting for review.');
    panel.caption=cleaned;return this.state;
  }
  discardImageRevision(panelId:string){
    const panel=[...this.state.pendingPanels,...this.state.panels].find(p=>p.id===panelId);if(!panel||panel.imageRevision?.status!=='failed')throw new Error('Only a failed image revision can be discarded.');panel.imageRevision=undefined;return this.state;
  }
  /** Edits a pending panel's speech balloons; the caption is left exactly as it is. */
  dialogue(panelId:string,lines:string[]){
    const panel=this.state.pendingPanels.find(p=>p.id===panelId);if(!panel)throw new Error('That panel is no longer waiting for review.');
    const cleaned=lines.map(line=>safeText(line).trim()).filter(Boolean).slice(0,4);
    if(!cleaned.length)throw new Error('Write at least one line of dialogue before saving.');
    panel.dialogue=cleaned;if(panel.storyBeats?.[0])panel.storyBeats[0].dialogue=[...cleaned];return this.state;
  }
  stop(){this.ingest.sample('stopped');this.liveArchive=undefined;this.liveDrafts.clear();this.momentDrafts.clear();this.state.status='stopped';this.state.panels=[];this.state.pendingPanels=[];this.undoActions.clear();return this.state;}
}
