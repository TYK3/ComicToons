import {MockAdapter} from './mock';
import {sampleStoryIssue,panelArtUrl} from './sampleStories';
import type {UiSnapshot,UiPanel,LookId,CatchupView,OutputMode,IssueView} from './adapter';

export const SAMPLE_STATE_KEY='comictoons-sample-studio-v1';
export const SAMPLE_ISSUES_KEY='comictoons-sample-issues-v1';
export const SAMPLE_FIXTURES=[
  {id:'tabletop-night',streamTitle:'Critical Mess — tabletop adventure'},
  {id:'speedrun-fail',streamTitle:'Frame Perfect — sky-city race'},
  {id:'irl-cooking',streamTitle:'Batter Days — breakfast chaos'},
  {id:'jynxzi-qa',streamTitle:'Jynxzi QA — chat-inspired sample'},
];
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** Local sample simulation. Its queue, participation and viewer events never touch Twitch. */
export class SampleStudioAdapter extends MockAdapter {
  private replayTimer?:ReturnType<typeof setTimeout>;
  private voteTimer?:ReturnType<typeof setTimeout>;
  private finaleTimer?:ReturnType<typeof setTimeout>;
  private issues:Record<string,IssueView>={};
  private readIssues(){
    try{const saved=localStorage.getItem(SAMPLE_ISSUES_KEY);if(saved){const parsed=JSON.parse(saved) as Record<string,IssueView>;this.issues=Object.fromEntries(Object.entries(parsed).filter(([id,issue])=>id.startsWith('sample-session-')&&Array.isArray(issue.panels)&&issue.panels.every(p=>p.origin==='sample')));}}catch{/* local-only memory fallback */}
  }
  private note(text:string){
    const simulation=this.snapshot.sampleSimulation??{guided:false,viewers:0,events:[]};
    this.set({sampleSimulation:{...simulation,events:[...simulation.events.slice(-9),{id:`event-${++this.sequence}`,text,at:Date.now()}]}});
  }
  async startSampleDemo(fixtureId=this.snapshot.studio.fixtureId){
    await this.replay(fixtureId==='jynxzi-qa'?'tabletop-night':fixtureId);
    this.patchStudio({approvalMode:false,speed:60});
    this.set({sampleSimulation:{guided:true,viewers:3,events:[]}});
    this.note('Stream started. Chat is arriving; the demo director releases each scene.');
  }
  stopSampleDemo(){
    clearTimeout(this.replayTimer);clearTimeout(this.finaleTimer);clearTimeout(this.voteTimer);
    this.set({sampleSimulation:{...this.snapshot.sampleSimulation!,guided:false,paused:true},sampleReplay:{...this.snapshot.sampleReplay!,running:false}});
    this.patchStudio({approvalMode:true});this.note('Guided demo paused. You can review and release panels yourself.');
  }
  resumeSampleDemo(){
    if(!this.snapshot.sampleSimulation?.paused)return;
    this.patchStudio({approvalMode:false});
    this.set({sampleSimulation:{...this.snapshot.sampleSimulation,guided:true,paused:false},sampleReplay:{...this.snapshot.sampleReplay!,running:true}});
    this.note('Demo resumed. Automatic releases and viewer activity continue.');
    if(this.snapshot.sampleReplay!.revealed>=this.snapshot.sampleReplay!.total){
      this.finaleTimer=setTimeout(()=>void this.endStream(this.snapshot.studio.issueTitle,['book','series','catchup'],this.snapshot.studio.look),1800);
    }else this.schedule(450);
    if(this.snapshot.participation.poll)this.voteTimer=setTimeout(()=>void this.endPoll(),45000);
  }
  simulateSampleArrival(){
    const simulation=this.snapshot.sampleSimulation??{guided:false,viewers:0,events:[]};
    const name=`SampleGuest${simulation.viewers+1}`;
    this.set({sampleSimulation:{...simulation,viewers:simulation.viewers+1,arrival:{name,at:Date.now(),panelIds:this.snapshot.studio.panels.slice(-6).map(p=>p.id)}}});
    this.chat('Just joined! What did I miss?',name);this.note(`${name} joined and received the story so far.`);
    if(this.snapshot.studio.panels.length)void this.playCatchup();
  }
  private async guidedBeat(scene:number,total:number){
    if(!this.snapshot.sampleSimulation?.guided)return;
    const activity:Record<number,string>={4:'Chat vote opened on air.',6:'Chat chose the dialogue; the result is on air.',8:'A raid brought 42 viewers; catch-up is playing.',10:'A viewer redeemed Ink Me; their cameo is on air.',12:'Prediction opened for the next attempt.',14:'Prediction settled; the result is on air.'};
    if(scene===2||scene===16)this.simulateSampleArrival();
    if(scene===4){await this.startPoll();this.castSampleVote(2);this.castSampleVote(2);this.castSampleVote(1);}
    if(scene===6)await this.endPoll();
    if(scene===8)this.simulateSampleRaid();
    if(scene===10){this.redeemSampleInk();const request=this.snapshot.participation.reward.redemptions.at(-1);if(request){await this.resolveRedemption(request.id,'fulfil');const cameo=this.snapshot.studio.pendingPanels.find(p=>p.cameo);if(cameo)await this.approve(cameo.id);}}
    if(scene===12){await this.startPrediction();this.castSamplePrediction('Success');}
    if(scene===14)await this.resolvePrediction('Success');
    if(activity[scene])this.note(activity[scene]);
    if(scene===total){
      this.note('The stream finished. Binding this Sample session into its own issue.');
      this.finaleTimer=setTimeout(()=>void this.endStream(this.snapshot.studio.issueTitle,['book','series','catchup'],this.snapshot.studio.look).then(()=>this.note('Sample issue saved. Open Sample Issues or Outputs to read it.')),1800);
    }
  }
  private epoch=0;
  private sequence=0;
  private receiving=false;
  private initialized=false;
  private storageListener=(event:StorageEvent)=>{
    if(event.key===SAMPLE_ISSUES_KEY){this.readIssues();this.receiving=true;this.set({});this.receiving=false;return;}
    if(event.key!==SAMPLE_STATE_KEY||!event.newValue)return;
    try { const next=JSON.parse(event.newValue) as UiSnapshot;
      if(!SAMPLE_FIXTURES.some(f=>f.id===next.studio?.fixtureId)||[...next.studio.panels,...next.studio.pendingPanels].some(p=>p.origin!=='sample'))return;
      const replaced=next.sampleReplay?.runId!==this.snapshot.sampleReplay?.runId;
      if(replaced)this.epoch++;
      if(replaced||!next.sampleReplay?.running||next.studio.fixtureId!==this.snapshot.studio.fixtureId){clearTimeout(this.replayTimer);clearTimeout(this.finaleTimer);clearTimeout(this.voteTimer);}
      this.receiving=true;this.set({...next,broadcast:next.broadcast});this.receiving=false;
    } catch {this.receiving=false;}
  };
  constructor({restore=true}={}){
    super({freeze:true,state:'empty',poll:false,prediction:false});
    let saved:string|null=null;
    if(restore&&typeof localStorage!=='undefined')try{saved=localStorage.getItem(SAMPLE_STATE_KEY);}catch{/* private mode */}
    this.set({fixtures:SAMPLE_FIXTURES,chat:[],loading:false,error:'',offline:false,sampleReady:true,
      twitch:{state:'connected',login:'sample_streamer',broadcasterType:'partner'},
      participation:{...this.snapshot.participation,poll:null,prediction:null,lastPoll:undefined,
        reward:{...this.snapshot.participation.reward,status:'ready',redemptions:[],cooldownEndsAt:undefined},rules:{raidCatchup:true,previouslyCommand:true,modApprove:false}},
      studio:{...this.snapshot.studio,fixtureId:'tabletop-night',speed:10,hidden:false,source:{requested:'sample',active:'sample',connection:'sample',simulated:true,received:0}},
      sampleReplay:{running:false,revealed:0,total:20},sampleSimulation:{guided:false,viewers:0,events:[]}});
    if(typeof window!=='undefined'){
      if(saved)this.storageListener({key:SAMPLE_STATE_KEY,newValue:saved} as StorageEvent);
      if(this.snapshot.sampleReplay?.running||this.snapshot.sampleSimulation?.guided)this.set({sampleReplay:{...this.snapshot.sampleReplay!,running:false},sampleSimulation:{...this.snapshot.sampleSimulation!,guided:false}});
      window.addEventListener('storage',this.storageListener);
    }
    this.readIssues();
    this.initialized=true;
  }
  protected override set(next:Partial<UiSnapshot>){
    super.set(next);
    if(this.initialized&&!this.receiving&&typeof localStorage!=='undefined')try{localStorage.setItem(SAMPLE_STATE_KEY,JSON.stringify(this.snapshot));}catch{/* this window still works */}
  }
  override now(){return Date.now();}
  private cue(kind:NonNullable<UiSnapshot['broadcast']>['kind'],title:string,panelIds?:string[],detail?:string){
    this.set({broadcast:{id:`sample-cue-${Date.now()}-${++this.sequence}`,kind,title,detail,panelIds,createdAt:Date.now()}});
  }
  private chat(text:string,user='SampleViewer',kind:'chat'|'command'|'redemption'|'raid'='chat'){
    this.set({chat:[...this.snapshot.chat.slice(-39),{id:`sample-chat-${++this.sequence}`,at:Date.now(),user,text,kind}]});
  }
  private schedule(ms=1500){clearTimeout(this.replayTimer);this.replayTimer=setTimeout(()=>void this.revealNext(),ms);}
  async revealNext(){
    const replay=this.snapshot.sampleReplay;if(!replay?.running)return;
    const generation=this.epoch;
    const issue=sampleStoryIssue(`sample-${this.snapshot.studio.fixtureId}`,this.snapshot.studio.look);
    const source=issue.panels[replay.revealed];
    if(!source){this.set({sampleReplay:{...replay,running:false}});return;}
    if(typeof Image!=='undefined'){
      const image=new Image();image.src=panelArtUrl(source,this.snapshot.studio.look);
      try{await image.decode();}catch{if(generation===this.epoch)this.set({error:'The sample picture did not load. Restart the replay to try again.'});return;}
    }
    if(generation!==this.epoch||!this.snapshot.sampleReplay?.running)return;
    const panel={...source,id:`${source.id}-replay-${this.epoch}`,at:replay.revealed*60};
    const s=this.snapshot.studio;
    this.patchStudio({status:'running',elapsed:panel.at,source:{...s.source,received:replay.revealed+1},
      pendingPanels:s.approvalMode?[...s.pendingPanels,panel]:s.pendingPanels,
      panels:s.approvalMode?s.panels:[...s.panels,panel],budget:{...s.budget,used:replay.revealed+1}});
    this.chat(panel.dialogue[0]??panel.caption,panel.id.includes('jynxzi')?'Captured chat / QA narrator':'Sample narrator');
    if(this.snapshot.sampleSimulation?.guided)this.chat(['Here we go!','That timing 😂','Chat, did you see that?','One more try!','What a moment!'][replay.revealed%5]!,['PixelFan','MapleGlitch','SampleCrew','CozyFox'][replay.revealed%4]);
    const revealed=replay.revealed+1;
    this.set({sampleReplay:{...replay,running:revealed<issue.panels.length,revealed,total:issue.panels.length}});
    if(!s.approvalMode)this.cue('panel','New comic panel',[panel.id]);
    await this.guidedBeat(revealed,issue.panels.length);
    if(generation!==this.epoch)return;
    if(revealed<issue.panels.length)this.schedule(this.snapshot.sampleSimulation?.guided?([2,8,16].includes(revealed)?3500:[4,6,10,12,14].includes(revealed)?2200:900):this.snapshot.studio.speed===1?4000:this.snapshot.studio.speed===10?1800:900);
  }
  override async replay(fixtureId:string){
    if(!SAMPLE_FIXTURES.some(f=>f.id===fixtureId))throw new Error('Choose one of the sample streams.');
    this.epoch++;clearTimeout(this.replayTimer);clearTimeout(this.voteTimer);clearTimeout(this.finaleTimer);
    const issue=sampleStoryIssue(`sample-${fixtureId}`,this.snapshot.studio.look);
    this.patchStudio({fixtureId,status:'running',streamTitle:issue.streamTitle,issueTitle:issue.title,panels:[],pendingPanels:[],recapUrl:undefined,approvalMode:true,hidden:false,elapsed:0,duration:issue.panels.length*60,
      source:{requested:'sample',active:'sample',connection:'sample',simulated:true,received:0},budget:{perHour:30,used:0}});
    this.patchParticipation({poll:null,prediction:null,optedOut:0,lastPoll:undefined,lastCatchup:undefined,reward:{...this.snapshot.participation.reward,status:'ready',redemptions:[],cooldownEndsAt:undefined}});
    this.set({chat:[],error:'',broadcast:undefined,sampleSimulation:{guided:false,viewers:0,events:[]},sampleReplay:{running:true,revealed:0,total:issue.panels.length,runId:crypto.randomUUID()}});this.schedule(450);
  }
  pauseReplay(){
    const replay=this.snapshot.sampleReplay;if(!replay)return;
    clearTimeout(this.replayTimer);this.set({sampleReplay:{...replay,running:!replay.running&&replay.revealed<replay.total}});
    if(this.snapshot.sampleReplay?.running)this.schedule(350);
  }
  override async approve(panelId?:string){
    const panel=panelId?this.snapshot.studio.pendingPanels.find(p=>p.id===panelId):this.snapshot.studio.pendingPanels[0];
    if(!panel)return {};
    const result=await super.approve(panel.id);
    this.cue(panel.cameo?'inkme':'panel',panel.cameo?`@${panel.cameo} joins the comic`:'New comic panel',[panel.id]);return result;
  }
  async approveAll(){
    const ids=this.snapshot.studio.pendingPanels.map(p=>p.id),epoch=this.epoch;
    for(const id of ids){if(epoch!==this.epoch)break;await this.approve(id);if(id!==ids.at(-1))await delay(650);}
    return {};
  }
  override async startPoll(){
    const panel=[...this.snapshot.studio.pendingPanels,...this.snapshot.studio.panels.slice().reverse()].find(p=>p.art.bubble&&!p.art.lettered);
    if(!panel){this.set({error:'A dialogue panel is still arriving. Start the vote when it reaches the queue.'});return;}
    const choices=[panel.dialogue[0]??'Here we go!','Chat, that was close!','One moment. A whole adventure.'];
    this.patchParticipation({poll:{id:`sample-poll-${++this.sequence}`,panelId:panel.id,mode:'chat',endsAt:Date.now()+45000,total:0,choices:choices.map((caption,i)=>({key:i+1,caption,votes:0}))}});
    this.cue('vote','Chat votes the dialogue',[panel.id]);clearTimeout(this.voteTimer);this.voteTimer=setTimeout(()=>void this.endPoll(),45000);
  }
  castSampleVote(key:number){
    const poll=this.snapshot.participation.poll;if(!poll||!poll.choices.some(c=>c.key===key))return;
    this.patchParticipation({poll:{...poll,total:poll.total+1,choices:poll.choices.map(c=>c.key===key?{...c,votes:c.votes+1}:c)}});this.chat(`!${key}`,'SampleViewer','command');
  }
  override async endPoll(){
    clearTimeout(this.voteTimer);const poll=this.snapshot.participation.poll;if(!poll)return;
    if(!poll.total){this.patchParticipation({poll:null});this.cue('vote-result','Vote closed',undefined,'No votes were cast.');return;}
    const winner=[...poll.choices].sort((a,b)=>b.votes-a.votes)[0]!;
    const change=(list:UiPanel[])=>list.map(p=>p.id===poll.panelId?{...p,dialogue:[winner.caption],caption:winner.caption,generatedCaption:true,chosenBy:{votes:poll.total,pct:Math.round(winner.votes/poll.total*100)},art:{...p.art,bubbleLabel:'Chat'}}:p);
    this.patchStudio({panels:change(this.snapshot.studio.panels),pendingPanels:change(this.snapshot.studio.pendingPanels)});
    this.patchParticipation({poll:null,lastPoll:{caption:winner.caption,voters:poll.total}});
    const onair=this.snapshot.studio.panels.some(p=>p.id===poll.panelId);
    this.cue('vote-result',onair?'Chat chose the dialogue':'Chat chose — panel awaits release',onair?[poll.panelId]:undefined,winner.caption);
  }
  redeemSampleInk(){
    const reward=this.snapshot.participation.reward;
    if(reward.status!=='ready')return;
    this.patchParticipation({reward:{...reward,redemptions:[...reward.redemptions,{id:`sample-ink-${++this.sequence}`,name:'SampleFox',at:Date.now(),status:'queued',note:'Draw me as a fox companion.'}]}});
    this.chat('Ink Me: draw me as a fox companion!','SampleFox','redemption');
  }
  override async resolveRedemption(id:string,action:'fulfil'|'cancel'){
    const request=this.snapshot.participation.reward.redemptions.find(r=>r.id===id);
    if(!request||!['queued','drawing'].includes(request.status))return;
    if(action==='fulfil'){
      const source=sampleStoryIssue('sample-tabletop-night',this.snapshot.studio.look).panels[1]!;
      const panel:UiPanel={...source,id:`sample-cameo-${++this.sequence}`,cameo:request.name,caption:'SampleFox joins the adventure.',dialogue:['SampleFox joins the adventure!'],at:this.snapshot.studio.elapsed};
      this.patchStudio({pendingPanels:[...this.snapshot.studio.pendingPanels,panel]});
    }
    await super.resolveRedemption(id,action);
  }
  override async startPrediction(){
    this.patchParticipation({prediction:{id:`sample-prediction-${++this.sequence}`,title:'Will the next attempt succeed?',status:'active',endsAt:Date.now()+120000,outcomes:[{title:'Success',users:0,points:0},{title:'Try again',users:0,points:0}]}});
    this.cue('prediction','Predict the next moment');
  }
  castSamplePrediction(outcome:string){
    const p=this.snapshot.participation.prediction;if(!p||p.status!=='active'||!p.outcomes.some(o=>o.title===outcome))return;
    this.patchParticipation({prediction:{...p,outcomes:p.outcomes.map(o=>o.title===outcome?{...o,users:o.users+1,points:o.points+100}:o)}});this.chat(`Predicts ${outcome} · 100 sample points`);
  }
  override async resolvePrediction(winner:string){
    if(!this.snapshot.participation.prediction?.outcomes.some(o=>o.title===winner))return;
    await super.resolvePrediction(winner);this.cue('prediction-result','Prediction resolved',undefined,winner);
  }
  override async playCatchup(){
    await super.playCatchup();this.cue('catchup','Previously on…',this.snapshot.studio.panels.slice(-6).map(p=>p.id));
  }
  sendSampleChat(text:string){
    const clean=text.trim().slice(0,400);if(!clean)return;
    if(clean==='!noink'){this.patchParticipation({optedOut:1});return;}
    if(/^![123]$/.test(clean)){this.castSampleVote(Number(clean.slice(1)));return;}
    if(clean==='!ink'){this.redeemSampleInk();return;}
    if(clean==='!previously'){void this.playCatchup().then(()=>this.patchParticipation({lastCatchup:{reason:'command',at:Date.now()}}));return;}
    this.chat(clean);
  }
  simulateSampleRaid(){
    if(!this.snapshot.studio.panels.length)return;
    this.chat('SampleCrew raided with 42 viewers.','SampleCrew','raid');
    this.set({sampleSimulation:{...(this.snapshot.sampleSimulation??{guided:false,events:[],viewers:0}),viewers:(this.snapshot.sampleSimulation?.viewers??0)+42}});
    void this.playCatchup().then(()=>this.patchParticipation({lastCatchup:{reason:'raid',at:Date.now(),raider:'SampleCrew',viewers:42}}));
  }
  override async listIssues(){this.readIssues();return Object.keys(this.issues).reverse();}
  override async getIssue(id:string,look:LookId){
    if(!id.startsWith('sample-'))throw new Error('Live issues stay in the Live workspace.');
    if(!id.startsWith('sample-session-'))return sampleStoryIssue(id,look);
    this.readIssues();const issue=this.issues[id];
    if(!issue)throw new Error('This Sample issue was not saved in this browser. Return to Sample Studio and bind an issue.');
    return {...structuredClone(issue),look};
  }
  override async saveRecap(look:LookId){
    if(!this.snapshot.studio.panels.length)throw new Error('Release at least one Sample panel before saving.');
    this.readIssues();const recapId=`sample-session-${this.snapshot.studio.fixtureId}-${Date.now().toString(36)}-${++this.sequence}`;
    const story=sampleStoryIssue(`sample-${this.snapshot.studio.fixtureId}`,look);
    this.issues[recapId]={...story,id:recapId,title:this.snapshot.studio.issueTitle||story.title,panels:structuredClone(this.snapshot.studio.panels),storyPanels:undefined,date:new Date().toISOString(),sample:true};
    try{localStorage.setItem(SAMPLE_ISSUES_KEY,JSON.stringify(this.issues));}catch{/* memory still works */}
    this.patchStudio({recapUrl:`/recap/${recapId}`,latestRecapUrl:`/recap/${recapId}`});return {recapId,look};
  }
  override async endStream(title:string,modes:OutputMode[],look:LookId){
    if(!this.snapshot.studio.panels.length)throw new Error('Release at least one Sample panel before saving.');
    this.epoch++;clearTimeout(this.replayTimer);clearTimeout(this.finaleTimer);clearTimeout(this.voteTimer);
    if(this.snapshot.sampleReplay)this.set({sampleReplay:{...this.snapshot.sampleReplay,running:false}});
    const result=await super.endStream(title,modes,look);
    const saved=await this.saveRecap(look);
    this.patchStudio({pendingPanels:[],approvalMode:true});
    this.set({sampleSimulation:{...(this.snapshot.sampleSimulation??{viewers:0,events:[]}),guided:false}});
    this.cue('stream-end','Sample stream ended',undefined,'Your Sample issue is ready.');
    return {...result,recapId:saved.recapId};
  }
  override async editCaption(id:string,caption:string){
    const update=(panels:UiPanel[])=>panels.map(p=>p.id===id?{...p,caption,...(p.art.bubble?{dialogue:[caption]}:{})}:p);
    this.patchStudio({panels:update(this.snapshot.studio.panels),pendingPanels:update(this.snapshot.studio.pendingPanels)});
  }
  override async getCatchup(minutes:number):Promise<CatchupView>{
    const windowMinutes=Number.isFinite(minutes)?Math.max(1,Math.min(30,minutes)):15;
    const since=Math.max(0,(this.snapshot.studio.elapsed??0)-windowMinutes*60);
    return {channel:sampleStoryIssue(`sample-${this.snapshot.studio.fixtureId}`,this.snapshot.studio.look).channel,minutes:windowMinutes,panels:this.snapshot.studio.panels.filter(panel=>(panel.at??0)>=since),sample:true};
  }
  override async setLook(look:LookId){this.patchStudio({look,mangaTheme:look==='ink'||look==='noir'||look==='pop'?'festival':look});}
  override dispose(){clearTimeout(this.replayTimer);clearTimeout(this.voteTimer);clearTimeout(this.finaleTimer);if(typeof window!=='undefined')window.removeEventListener('storage',this.storageListener);super.dispose();}
}
