import {test,expect} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';

// Controlled UI regression only: the art and stream events are fixtures, not a live Twitch proof.
test('catch-up refreshes an accepted page when its image or caption changes without a new panel',async({page})=>{
  await page.setViewportSize({width:1242,height:900});
  await page.addInitScript(()=>{
    sessionStorage.setItem('comictoons-role','streamer');
    class ControlledEvents {
      static CLOSED=2;readyState=1;
      private handlers=new Map<string,EventListener[]>();
      constructor(){window.addEventListener('qa-catchup-state',event=>{
        const data=JSON.stringify((event as CustomEvent).detail);
        for(const handler of this.handlers.get('state')??[])handler(new MessageEvent('state',{data}));
      });}
      addEventListener(name:string,handler:EventListener){this.handlers.set(name,[...this.handlers.get(name)??[],handler]);}
      close(){this.readyState=2;}
    }
    window.EventSource=ControlledEvents as unknown as typeof EventSource;
  });
  const panel={id:'qa-accepted-page',origin:'twitch',caption:'Original accepted line',dialogue:[],scene:'Controlled catch-up refresh',characters:[],mood:'calm',altText:'Controlled regression artwork',imageUrl:'/art/scenes/qa-accepted-page?v=original',at:10,provenance:{provider:'scene-openai',style:'comic',fallback:false}};
  const state={status:'live',fixtureId:'twitch',speed:1,style:'risograph',approvalMode:true,panels:[panel],pendingPanels:[],streamTitle:'Controlled QA',issueTitle:'Controlled QA',elapsed:20,duration:600,source:{requested:'twitch',active:'twitch',channel:'qa_owner',connection:'live',simulated:false,received:2}};
  const art=await readFile(new URL('../fixtures/art/generated/panel-01-stream-start.webp',import.meta.url));
  await page.route('**/art/scenes/qa-accepted-page*',route=>route.fulfill({body:art,contentType:'image/webp'}));
  let catchupReads=0;
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/state')return route.fulfill({json:state});
    if(path==='/api/catchup'){catchupReads++;return route.fulfill({json:{channel:'qa_owner',minutes:15,panels:state.panels,panelCount:1,sample:false}});}
    if(path==='/api/twitch/status')return route.fulfill({json:{configured:false,connected:false,scopes:[]}});
    if(path==='/api/fixtures')return route.fulfill({json:[]});
    if(path==='/api/participation/status')return route.fulfill({json:{flags:{},budget:{perHour:12,used:0},poll:null,lastPollResult:null,reward:null,catchups:[],hype:null,optedOut:0}});
    if(path==='/api/participation/eventsub')return route.fulfill({json:{state:'idle',signedIn:false,subscribed:[],failed:[],revoked:[],reconnects:0,notifications:0}});
    return route.fulfill({status:404,json:{error:'Outside this controlled catch-up regression.'}});
  });
  await page.goto('/ui.html#/catchup');
  const image=page.locator('[data-panel-id="qa-accepted-page"] img');
  await expect(image).toHaveAttribute('src',panel.imageUrl);
  const firstReads=catchupReads;
  panel.imageUrl='/art/scenes/qa-accepted-page?v=reviewed';
  await page.evaluate(value=>window.dispatchEvent(new CustomEvent('qa-catchup-state',{detail:value})),state);
  await expect(image).toHaveAttribute('src',panel.imageUrl);
  expect(catchupReads).toBeGreaterThan(firstReads);
  const imageReads=catchupReads;
  panel.caption='Chat chose this revised line';
  await page.evaluate(value=>window.dispatchEvent(new CustomEvent('qa-catchup-state',{detail:value})),state);
  await expect(page.locator('.ct-catchup__cap')).toContainText(panel.caption);
  expect(catchupReads).toBeGreaterThan(imageReads);
  await expect(page.locator('[data-panel-id="qa-accepted-page"]')).toHaveCount(1);
  await mkdir('artifacts/qa/sprint',{recursive:true});
  await page.screenshot({path:'artifacts/qa/sprint/catchup-revision.jpg',type:'jpeg',quality:85});
});
