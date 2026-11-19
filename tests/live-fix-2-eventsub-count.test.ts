import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {EVENTSUB_TYPES,eventSubHealth,type EventSubStatus} from '../apps/web/src/ui/data/adapter.ts';
import {comicToonsSubscriptions} from '../apps/server/src/eventsub/subscriptions.ts';

// LIVE-FIX-2: the server subscribes to 16 EventSub types (stream.offline is not one of the Studio's 15),
// so the Studio chip read "16 of 15 subscriptions". The adapter's getEventSub() poll must pass the status
// through listedEventSubStatus() (LIVE-FIX-1) before it reaches the snapshot that EventSub.tsx counts.
// Runs the real ServerAdapter in Node with a fetch shim; no network, no Twitch.
register('data:text/javascript,'+encodeURIComponent(`export async function load(url,context,next){if(/\\.(webp|png|jpe?g|css)$/.test(url))return {format:'module',source:'export default '+JSON.stringify(url),shortCircuit:true};return next(url,context);}`),import.meta.url);

type Snapshot={loading:boolean;eventsub:EventSubStatus};
type Adapter={getSnapshot():Snapshot;getEventSub():Promise<EventSubStatus>;dispose():void};

const realFetch=globalThis.fetch;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('LIVE-FIX-2: the Studio EventSub poll keeps only the listed types, so it never shows "16 of 15"',async()=>{
  const all=comicToonsSubscriptions('1337').map(entry=>entry.type);
  assert.equal(all.length,16,'the server subscribes to 16 types');
  const unlisted=all.filter(type=>!EVENTSUB_TYPES.some(entry=>entry.type===type));
  assert.deepEqual(unlisted,['stream.offline']);
  const server:EventSubStatus={state:'subscribed',signedIn:true,subscribed:all,failed:[{type:'stream.offline',error:'x'}],revoked:[],reconnects:0,notifications:3};
  const wire:Record<string,unknown>={
    '/api/participation/status':{flags:{},budget:{perHour:12,used:0},poll:null,lastPollResult:null,reward:null,catchups:[],hype:null,optedOut:0},
    '/api/state':{status:'idle',fixtureId:'tabletop-night',speed:60,style:'risograph',approvalMode:true,panels:[],pendingPanels:[],streamTitle:'',issueTitle:'',elapsed:0,duration:1440,nextUp:null},
    '/api/fixtures':[],'/api/twitch/status':{configured:true,connected:true,scopes:[],login:'fake_streamer',broadcaster_type:''},
    '/api/participation/eventsub':server,
  };
  globalThis.fetch=(async(input:string|URL|Request)=>new Response(JSON.stringify(wire[String(input).split('?')[0]!]??{}),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  (globalThis as {EventSource?:unknown}).EventSource=class{static CLOSED=2;readyState=0;onerror=null;onopen=null;addEventListener(){}close(){this.readyState=2;}};
  const {ServerAdapter}=await import('../apps/web/src/ui/data/server.ts') as unknown as {ServerAdapter:new()=>Adapter};
  const adapter=new ServerAdapter();
  try{
    const end=Date.now()+3000;while(adapter.getSnapshot().loading&&Date.now()<end)await sleep(20);
    const returned=await adapter.getEventSub();
    const shown=adapter.getSnapshot().eventsub;
    for(const status of [returned,shown]){
      assert.ok(status.subscribed.length<=EVENTSUB_TYPES.length,`the chip would read "${status.subscribed.length} of ${EVENTSUB_TYPES.length} subscriptions"`);
      assert.equal(status.subscribed.length,EVENTSUB_TYPES.length,'all 15 listed types are counted');
      assert.ok(!status.subscribed.includes('stream.offline'),'the unlisted type is not counted');
      assert.deepEqual(status.failed,[],'an unlisted failure is not shown as missing');
      assert.equal(eventSubHealth(status),'connected');
      assert.equal(status.state,'subscribed');assert.equal(status.notifications,3);
    }
    assert.equal(server.subscribed.length,16,'the wire status is not mutated');
  }finally{adapter.dispose();globalThis.fetch=realFetch;delete (globalThis as {EventSource?:unknown}).EventSource;}
});
