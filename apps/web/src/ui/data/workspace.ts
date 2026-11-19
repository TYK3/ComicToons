import type {ComicToonsAdapter,UiSnapshot} from './adapter';

/** A live workspace never falls back to bundled or simulated content. */
export function liveWorkspace(base:ComicToonsAdapter,followBroadcast=false):ComicToonsAdapter {
  let previous:UiSnapshot|undefined,cached:UiSnapshot|undefined,previousChannel:string|null=null;
  const snapshot=()=>{
    const raw=base.getSnapshot();let channel:string|null=null;
    try{channel=sessionStorage.getItem('comictoons-studio-live-channel-v1');}catch{/* this window */}
    if(raw===previous&&cached&&channel===previousChannel)return cached;
    previous=raw;previousChannel=channel;
    const selected=raw.studio.source.requested==='twitch'&&!raw.studio.source.simulated&&(followBroadcast||channel===raw.studio.source.channel);
    const actual=selected&&raw.studio.source.active==='twitch';
    cached={...raw,chat:actual?raw.chat:[],broadcast:actual?raw.broadcast:undefined,sampleReplay:undefined,sampleSimulation:undefined,
      participation:actual?raw.participation:{...raw.participation,poll:null,prediction:null,lastPoll:undefined,lastCatchup:undefined,reward:{...raw.participation.reward,redemptions:[]}},
      studio:{...raw.studio,panels:actual?raw.studio.panels.filter(p=>p.origin==='twitch'):[],pendingPanels:actual?raw.studio.pendingPanels.filter(p=>p.origin==='twitch'):[],
        status:actual?raw.studio.status:'idle',streamTitle:actual?raw.studio.streamTitle:'',issueTitle:actual?raw.studio.issueTitle:'',elapsed:actual?raw.studio.elapsed:0,duration:actual?raw.studio.duration:0,
        source:selected?raw.studio.source:{requested:'twitch',active:'sample',connection:'stopped',simulated:false,received:0},
        recapUrl:raw.studio.recapUrl?.includes('/sample-')?undefined:raw.studio.recapUrl,latestRecapUrl:raw.studio.latestRecapUrl?.includes('/sample-')?undefined:raw.studio.latestRecapUrl,
        budget:actual?raw.studio.budget:{...raw.studio.budget,used:0}}};
    return cached;
  };
  const ownIssue=async(id:string,look:Parameters<ComicToonsAdapter['getIssue']>[1])=>{
    if(!id||id.startsWith('sample-'))throw new Error('This is a Sample issue. Open it from the Sample demo.');
    const issue=await base.getIssue(id,look);
    if(issue.sample||issue.panels.some(p=>p.origin==='sample'))throw new Error('Sample issues stay in the Sample demo.');
    return issue;
  };
  return new Proxy(base,{get(target,key){
    if(key==='getSnapshot')return snapshot;
    if(key==='onEvent')return (names:Parameters<ComicToonsAdapter['onEvent']>[0],onEvent:Parameters<ComicToonsAdapter['onEvent']>[1])=>base.onEvent(names,event=>{if(snapshot().studio.source.active==='twitch')onEvent(event);});
    if(key==='listIssues')return async()=>{
      const ids=(await base.listIssues()).filter(id=>!id.startsWith('sample-'));
      // Exclude known Sample content, but let failed reads reach the Library retry state.
      const checked=await Promise.all(ids.map(async id=>{
        const issue=await base.getIssue(id,snapshot().studio.look);
        return issue.sample||issue.panels.some(panel=>panel.origin==='sample')?undefined:id;
      }));
      return checked.filter((id):id is string=>!!id);
    };
    if(key==='getIssue')return ownIssue;
    if(key==='getSeries')return async(id:string,look:Parameters<ComicToonsAdapter['getSeries']>[1])=>{await ownIssue(id,look);const series=await base.getSeries(id,look);if(series.sample||series.episodes.some(episode=>episode.panels.some(panel=>panel.origin==='sample')))throw new Error('Sample episodes stay in the Sample demo.');return series;};
    if(key==='getCatchup')return async(minutes:number)=>{const result=await base.getCatchup(minutes);return {...result,sample:false,panels:result.sample?[]:result.panels.filter(p=>p.origin==='twitch'),raidLine:result.sample?undefined:result.raidLine};};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}
