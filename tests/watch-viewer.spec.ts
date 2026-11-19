import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type {WatchSnapshot} from '@comictoons/core';

async function mockWatch(page:import('@playwright/test').Page){
  await page.route('**/api/twitch/status',route=>route.fulfill({json:{configured:true,connected:false,scopes:[]}}));
  let state:WatchSnapshot|undefined;
  const posts:{path:string;body:Record<string,unknown>}[]=[];
  await page.route('**/api/watch**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();posts.push({path,body});
      if(path==='/api/watch/session')state={id:'qa-session',role:body.role,state:'idle',elapsed:0,chatConnection:'stopped',received:0,frames:[],chat:[],pages:[],events:[],generator:{provider:'openai',model:'gpt-image-1.5',configured:false,ownKey:false,checked:false,maxPages:3,used:0},analysisMode:'frames-and-chat',transcription:false};
      if(!state)return route.fulfill({status:404,json:{error:'Choose a role first.'}});
      if(path==='/api/watch/start')state={...state,state:'running',channel:body.channel,elapsed:10,received:12,frames:[{id:'frame-1',capturedAt:Date.now(),videoTime:10,sha256:'test',url:'/qa/jynxzi/reference-channel.png'}]};
      if(path==='/api/watch/generator')state={...state,generator:{...state.generator,provider:body.provider??'openai',model:body.model??'gpt-image-1.5',configured:!body.useDefault,ownKey:!body.useDefault,maxPages:body.maxPages??3}};
      if(path==='/api/watch/stop')state={...state,state:'stopped'};
    }
    return state?route.fulfill({json:state}):route.fulfill({status:404,json:{error:'No session.'}});
  });
  return posts;
}

test('Viewer pastes a stream link and sees automatic source capture without broadcaster controls',async({page})=>{
  const posts=await mockWatch(page);await page.goto('/ui.html#/studio');
  await page.getByRole('button',{name:'Viewer',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Watch the story arrive',exact:true})).toBeVisible();
  for(const label of ['Panic hide','End stream','Start a prediction','Start a 45-second vote'])await expect(page.getByRole('button',{name:label,exact:true})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Twitch stream link',exact:true}).fill('https://example.com/fake');await page.getByRole('button',{name:'Watch and create comics',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Twitch');expect(posts.filter(p=>p.path.endsWith('/start'))).toHaveLength(0);
  await page.getByRole('textbox',{name:'Twitch stream link',exact:true}).fill('https://www.twitch.tv/lacy');await page.getByRole('button',{name:'Watch and create comics',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('#lacy');await expect(page.getByAltText('Latest actual captured stream frame')).toBeVisible();
  expect(posts.find(p=>p.path.endsWith('/start'))?.body).toMatchObject({channel:'lacy',duration:120});
  await page.getByRole('button',{name:'Stop viewing session',exact:true}).click();await expect(page.getByRole('status')).toContainText('stopped');
  await page.goto('/ui.html#/director');await expect(page.getByRole('heading',{name:'Watch the story arrive',exact:true})).toBeVisible();
});

test('both roles offer reference-image provider settings; secrets never enter browser storage',async({page})=>{
  const posts=await mockWatch(page);await page.goto('/ui.html#/studio');await page.getByRole('button',{name:'Viewer',exact:true}).click();
  await page.locator('.ct-generator summary').click();
  await page.getByLabel('Provider',{exact:true}).selectOption('gemini');await page.getByLabel('Image model',{exact:true}).selectOption('gemini-3.1-flash-image');
  const input=page.getByLabel('API key',{exact:true});await expect(input).toHaveAttribute('type','password');await input.fill('qa-key-never-store-in-browser');
  await page.getByLabel('Maximum pages this session',{exact:true}).selectOption('1');await page.getByRole('button',{name:'Use my key for this session',exact:true}).click();
  await expect(input).toHaveValue('');expect(posts.find(p=>p.path==='/api/watch/generator')?.body).toMatchObject({provider:'gemini',model:'gemini-3.1-flash-image',maxPages:1});
  expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('qa-key-never-store-in-browser');
  await page.getByRole('button',{name:'Streamer',exact:true}).click();await expect(page.getByRole('region',{name:'Scene capture',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Capture my stream for 2 minutes',exact:true})).toBeDisabled();
});

test('Viewer layout stays within phone and desktop widths and has no serious accessibility violations',async({page})=>{
  await mockWatch(page);await page.goto('/ui.html#/studio');await page.getByRole('button',{name:'Viewer',exact:true}).click();await page.locator('.ct-generator summary').click();
  await mkdir('artifacts/qa/watch',{recursive:true});
  for(const width of [1242,390]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`artifacts/qa/watch/viewer-${width}.jpg`,type:'jpeg',quality:85});}
  const violations=(await new AxeBuilder({page}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical');expect(violations).toEqual([]);
});

test('returning from Viewer refreshes stale broadcaster access errors',async({page})=>{
  await page.addInitScript(()=>{
    sessionStorage.setItem('comictoons-role','viewer');
    class ControlledEvents {static CLOSED=2;readyState=1;addEventListener(){}close(){this.readyState=2;}}
    window.EventSource=ControlledEvents as unknown as typeof EventSource;
  });
  const posts=await mockWatch(page);let denied=0,recovered=0;
  await page.route('**/api/state',async route=>{
    if(!posts.some(p=>p.path==='/api/watch/session'&&p.body.role==='streamer')){
      denied++;return route.fulfill({status:403,json:{error:'Viewer sessions cannot access broadcaster data or controls.'}});
    }
    recovered++;return route.fulfill({json:{status:'idle',fixtureId:'tabletop-night',speed:1,style:'risograph',approvalMode:true,panels:[],pendingPanels:[],streamTitle:'',issueTitle:'',elapsed:0,duration:0,source:{requested:'sample',active:'sample',connection:'sample',simulated:false,received:0}}});
  });
  await page.goto('/ui.html#/studio');
  await expect(page.getByRole('heading',{name:'Watch the story arrive',exact:true})).toBeVisible();
  await expect.poll(()=>denied).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Streamer',exact:true}).click();
  await expect(page.getByRole('region',{name:'Scene capture',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'The studio didn’t answer',exact:true})).toHaveCount(0);
  expect(recovered).toBeGreaterThan(0);
  await mkdir('artifacts/qa/watch',{recursive:true});
  await page.setViewportSize({width:1242,height:900});
  await page.screenshot({path:'artifacts/qa/watch/role-return.jpg',type:'jpeg',quality:85});
});

test('pasting another channel from the connected-account page switches to Viewer without broadcaster writes',async({page})=>{
  const posts=await mockWatch(page);const broadcasterWrites:string[]=[];
  page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(ingest|approve|hide|participation)/.test(r.url()))broadcasterWrites.push(r.url());});
  await page.route('**/api/twitch/status',route=>route.fulfill({json:{configured:true,connected:true,login:'qa_owner',channel:'qa_owner',scopes:[],broadcaster_type:'affiliate'}}));
  await page.goto('/ui.html#/connect');const form=page.getByRole('form',{name:'Read another channel'});
  await form.getByLabel('Read another channel',{exact:true}).fill('https://www.twitch.tv/lacy');await form.getByRole('button',{name:'Read chat',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Watch the story arrive',exact:true})).toBeVisible();
  expect(posts.find(p=>p.path==='/api/watch/session')?.body.role).toBe('viewer');expect(posts.find(p=>p.path==='/api/watch/start')?.body.channel).toBe('lacy');expect(broadcasterWrites).toEqual([]);
});
