import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import type {AddressInfo} from 'node:net';
import {createApp} from '../apps/server/src/app.ts';

// UI-LIVE-A: the server data adapter (apps/web/src/ui/data/server.ts) run in Node against a real API
// (createApp on 127.0.0.1, Sample data, no Twitch keys, no network beyond loopback). The adapter's
// relative URLs are pointed at that API by a fetch shim, and /api/events uses a small fetch-based
// EventSource. Bundled art imports resolve to their file URL, as Vite would give a URL.
register('data:text/javascript,'+encodeURIComponent(`export async function load(url,context,next){if(/\\.(webp|png|jpe?g|css)$/.test(url))return {format:'module',source:'export default '+JSON.stringify(url),shortCircuit:true};return next(url,context);}`),import.meta.url);

type Connection='ok'|'lost'|'reconnecting';
type Snapshot={connection?:Connection;loading:boolean;offline:boolean;error:string;studio:{panels:{id:string}[];pendingPanels:{id:string}[];streamTitle:string;issueTitle:string;nextUp?:string|null};participation:Record<string,unknown>};
type Adapter={getSnapshot():Snapshot;subscribe(listener:()=>void):()=>void;dispose():void;listIssues():Promise<string[]>;getCatchup(minutes:number):Promise<unknown>;readonly connection?:Connection};

const realFetch=globalThis.fetch;
let base='';
const route=(input:string|URL|Request)=>typeof input==='string'&&input.startsWith('/')?base+input:input;

class LoopbackEventSource{
  static CONNECTING=0;static OPEN=1;static CLOSED=2;
  readyState=0;onopen:((event:Event)=>void)|null=null;onerror:((event:Event)=>void)|null=null;
  private handlers=new Map<string,((event:MessageEvent)=>void)[]>();
  private controller=new AbortController();
  constructor(path:string){void this.run(String(route(path)));}
  addEventListener(name:string,handler:(event:MessageEvent)=>void){this.handlers.set(name,[...(this.handlers.get(name)??[]),handler]);}
  close(){this.readyState=2;this.controller.abort();}
  private async run(url:string){
    try{
      const response=await realFetch(url,{headers:{accept:'text/event-stream'},signal:this.controller.signal});
      if(!response.ok||!response.body)throw new Error(`events ${response.status}`);
      this.readyState=1;this.onopen?.(new Event('open'));
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
      for(;;){
        const {done,value}=await reader.read();if(done)throw new Error('stream ended');
        buffer+=decoder.decode(value,{stream:true});let cut:number;
        while((cut=buffer.indexOf('\n\n'))>=0){
          const block=buffer.slice(0,cut);buffer=buffer.slice(cut+2);
          const name=/^event: (.*)$/m.exec(block)?.[1];const data=/^data: (.*)$/m.exec(block)?.[1];
          if(name&&data!==undefined)for(const handler of this.handlers.get(name)??[])handler(new MessageEvent(name,{data}));
        }
      }
    }catch{
      if(this.readyState===2)return;
      // A refused or dropped stream, as a browser reports it once the proxy answers 500: closed, no retry.
      this.readyState=2;this.onerror?.(new Event('error'));
    }
  }
}

async function loadAdapter():Promise<new()=>Adapter>{
  const module=await import('../apps/web/src/ui/data/server.ts') as unknown as {ServerAdapter:new()=>Adapter};
  return module.ServerAdapter;
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,ms:number,what:string){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await sleep(50);}assert.fail(`timed out waiting for ${what}`);}

test('UI-LIVE-A-INKCHAT: inkChat from GET /api/participation/status reaches the snapshot unchanged',async()=>{
  const inkChat={active:true,text:'Not an Affiliate or Partner? Viewers type !ink in chat instead. You or a mod answer with !ink yes or !ink no.',cooldownEndsAt:1_900_000_000_000,note:'Cooldown: the last !ink was under 5 minutes ago, so this one was skipped.',
    requests:[{id:'ink-chat-2',name:'Opted-out viewer',at:1_899_999_000_000,status:'withdrawn',note:'Withdrawn: this viewer opted out with !noink.'},{id:'ink-chat-1',name:'sample_viewer_a',at:1_899_998_000_000,status:'drafted',note:'Cameo drafted; waiting for !ink yes or !ink no.',panelId:'cameo-ink-chat-1'}]};
  const wire:Record<string,unknown>={
    '/api/participation/status':{flags:{inkMe:true,director:true},budget:{perHour:12,used:1},poll:null,lastPollResult:null,reward:null,catchups:[],hype:null,optedOut:0,inkChat},
    '/api/state':{status:'idle',fixtureId:'tabletop-night',speed:60,style:'risograph',approvalMode:true,panels:[],pendingPanels:[],streamTitle:'',issueTitle:'',elapsed:0,duration:1440,nextUp:null},
    '/api/fixtures':[],'/api/twitch/status':{configured:false,connected:false,scopes:[]},'/api/participation/eventsub':{state:'idle',signedIn:false,subscribed:[],failed:[],revoked:[],reconnects:0,notifications:0},
  };
  globalThis.fetch=(async(input:string|URL|Request)=>new Response(JSON.stringify(wire[String(input).split('?')[0]!]??{}),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  const ServerAdapter=await loadAdapter();const adapter=new ServerAdapter();
  try{
    await until(()=>!adapter.getSnapshot().loading&&'inkChat' in adapter.getSnapshot().participation,3000,'participation status');
    assert.deepEqual(adapter.getSnapshot().participation.inkChat,inkChat,'active, text, requests, cooldown and note pass through unchanged');
  }finally{adapter.dispose();globalThis.fetch=realFetch;}
});

test('UI-LIVE-A-CONNECTION: API down for 8 s gives lost, then reconnecting; after the restart the same adapter shows 4 panels, no reload',{timeout:90_000},async()=>{
  const wanted=Number(process.env.COMICTOONS_E2E_API_PORT??0)||0;
  let app=createApp({env:{},logger:false});
  await app.listen({port:wanted,host:'127.0.0.1'});
  const port=(app.server.address() as AddressInfo).port;
  base=`http://127.0.0.1:${port}`;
  const unhandled:unknown[]=[];const onUnhandled=(reason:unknown)=>{unhandled.push(reason);};process.on('unhandledRejection',onUnhandled);
  globalThis.fetch=((input:string|URL|Request,init?:RequestInit)=>realFetch(route(input),init)) as typeof fetch;
  (globalThis as {EventSource?:unknown}).EventSource=LoopbackEventSource;
  const ServerAdapter=await loadAdapter();const adapter=new ServerAdapter();
  const seen:Connection[]=[];const unsubscribe=adapter.subscribe(()=>{const now=adapter.getSnapshot().connection;if(now&&seen.at(-1)!==now)seen.push(now);});
  try{
    await until(()=>!adapter.getSnapshot().loading,5000,'first load');
    assert.equal(adapter.getSnapshot().connection,'ok');
    await realFetch(`${base}/api/replay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixtureId:'tabletop-night',speed:60})});
    await until(()=>adapter.getSnapshot().studio.pendingPanels.length>=1,5000,'the first waiting panel over SSE');

    await app.close();
    const downAt=Date.now();
    await until(()=>adapter.getSnapshot().connection==='lost',6000,'connection lost');
    assert.equal(adapter.getSnapshot().offline,true);
    assert.match(adapter.getSnapshot().error,/lost its connection/);
    await until(()=>adapter.getSnapshot().connection==='reconnecting',8000,'reconnecting');
    await sleep(Math.max(0,8000-(Date.now()-downAt)));
    assert.equal(adapter.getSnapshot().connection,'reconnecting','still reconnecting while the API is down');
    assert.deepEqual(seen,['ok','lost','reconnecting'],'ok, then lost, then reconnecting; it never pretends to be back');

    app=createApp({env:{},logger:false});
    await app.listen({port,host:'127.0.0.1'});
    await realFetch(`${base}/api/settings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({approvalMode:false})});
    await realFetch(`${base}/api/replay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixtureId:'tabletop-night',speed:60})});
    await until(()=>adapter.getSnapshot().connection==='ok',15_000,'reconnected');
    assert.equal(adapter.getSnapshot().offline,false);assert.equal(adapter.getSnapshot().error,'');
    await until(()=>adapter.getSnapshot().studio.panels.length===4,30_000,'4 panels on air from the restarted API, pushed to the same adapter');
    const server=await (await realFetch(`${base}/api/state`)).json() as {panels:{id:string}[]};
    assert.deepEqual(adapter.getSnapshot().studio.panels.map(panel=>panel.id),server.panels.map(panel=>panel.id));
    assert.deepEqual(unhandled,[],'no unhandled "The server said 500." rejections while the API was down');
  }finally{unsubscribe();adapter.dispose();await app.close();globalThis.fetch=realFetch;delete (globalThis as {EventSource?:unknown}).EventSource;process.off('unhandledRejection',onUnhandled);}
});

test('UI-LIVE-A-STATES: first-load error, loading titles, shelf and reader errors are honest when the API cannot be reached',{timeout:30_000},async()=>{
  const unhandled:unknown[]=[];const onUnhandled=(reason:unknown)=>{unhandled.push(reason);};process.on('unhandledRejection',onUnhandled);
  // As the Vite proxy answers while the API is stopped: 500 with an empty body.
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
  let mode:'hold'|'down'='hold';
  globalThis.fetch=(async()=>{if(mode==='hold')await held;return new Response('',{status:500});}) as typeof fetch;
  (globalThis as {EventSource?:unknown}).EventSource=class{static CLOSED=2;readyState=2;onerror:((event:Event)=>void)|null=null;onopen=null;constructor(){setTimeout(()=>this.onerror?.(new Event('error')),10);}addEventListener(){}close(){}};
  const ServerAdapter=await loadAdapter();const adapter=new ServerAdapter();
  try{
    const loading=adapter.getSnapshot();
    assert.equal(loading.loading,true);
    assert.equal(loading.studio.streamTitle,'','#7: no Sample stream title before the server answers');
    assert.equal(loading.studio.issueTitle,'','#7: no Sample issue title before the server answers');
    let shelf:'pending'|'done'|'failed'='pending';
    const issues=adapter.listIssues().then(()=>{shelf='done';},()=>{shelf='failed';});
    await sleep(200);
    assert.equal(shelf,'pending','#5: the shelf stays loading while the API is held');
    mode='down';release();
    await issues;
    assert.equal(shelf,'failed','#5: the shelf reports an error when the API cannot be reached');
    await until(()=>!adapter.getSnapshot().loading,3000,'first load to fail');
    await sleep(300);
    const failed=adapter.getSnapshot();
    assert.doesNotMatch(failed.error,/lost its connection/,'#6: a first load that never connected is not reported as a lost connection');
    assert.match(failed.error,/can.t reach/,'#6: the first-load message stays');
    await assert.rejects(adapter.getCatchup(10),(error:Error)=>!/The server said 500/.test(error.message)&&/can.t reach/.test(error.message),'#9: readers get a plain message, not "The server said 500."');
    await sleep(200);
    assert.deepEqual(unhandled,[],'#3: polling never leaves an unhandled rejection');
  }finally{adapter.dispose();globalThis.fetch=realFetch;delete (globalThis as {EventSource?:unknown}).EventSource;process.off('unhandledRejection',onUnhandled);}
});
