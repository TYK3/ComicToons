import {test,expect,type Page} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import type {WatchSnapshot} from '@comictoons/core';

// Controlled UI evidence only. Neither the feed nor the fixture image proves a live vote/generation.
async function viewerFixture(page:Page){
  await page.setViewportSize({width:1242,height:900});
  await page.addInitScript(()=>{
    sessionStorage.setItem('comictoons-role','viewer');
    class ControlledEvents {static CLOSED=2;readyState=1;addEventListener(){}close(){this.readyState=2;}}
    window.EventSource=ControlledEvents as unknown as typeof EventSource;
  });
  let state:WatchSnapshot={id:'qa-viewer-session',role:'viewer',state:'idle',elapsed:0,chatConnection:'stopped',received:0,frames:[],chat:[],pages:[],events:[],generator:{provider:'openai',model:'gpt-image-1.5',configured:false,ownKey:false,checked:false,maxPages:3,used:0},analysisMode:'frames-and-chat',transcription:false};
  const posts:{path:string;body:Record<string,unknown>}[]=[];
  const feed={panels:[{id:'previous-approved',imageUrl:'/art/scenes/qa-previous?v=original',caption:'Previously approved scene',altText:'Controlled previous artwork'}]};
  const art=await readFile(new URL('../fixtures/art/generated/panel-01-stream-start.webp',import.meta.url));
  await page.route('**/art/scenes/qa-*',route=>route.fulfill({body:art,contentType:'image/webp'}));
  await page.route('**/api/**',route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON() as Record<string,unknown>;posts.push({path,body});
      if(path==='/api/watch/session')state={...state,role:body.role as WatchSnapshot['role']};
      if(path==='/api/watch/start')state={...state,channel:body.channel as string,state:'running'};
      if(path==='/api/watch/generator')state={...state,generator:{...state.generator,provider:body.provider as WatchSnapshot['generator']['provider'],model:body.model as string,configured:true,ownKey:true,maxPages:body.maxPages as number}};
    }
    if(path==='/api/watch/approved')return route.fulfill({json:{channel:url.searchParams.get('channel'),...feed}});
    if(path==='/api/watch'||path.startsWith('/api/watch/'))return route.fulfill({json:state});
    if(path==='/api/twitch/status')return route.fulfill({json:{configured:true,connected:false,scopes:[]}});
    if(path==='/api/fixtures')return route.fulfill({json:[]});
    if(path==='/api/state')return route.fulfill({status:403,json:{error:'Viewer broadcaster boundary'}});
    if(path==='/api/participation/status')return route.fulfill({json:{flags:{},budget:{perHour:12,used:0},poll:null,lastPollResult:null,reward:null,catchups:[],hype:null,optedOut:0}});
    if(path==='/api/participation/eventsub')return route.fulfill({json:{state:'idle',signedIn:false,subscribed:[],failed:[],revoked:[],reconnects:0,notifications:0}});
    return route.fulfill({status:404,json:{error:'Outside this controlled Viewer regression.'}});
  });
  await page.goto('/ui.html#/viewer');
  await expect(page.getByRole('heading',{name:'Capture a Twitch stream',exact:true})).toBeVisible();
  return {posts,feed};
}

test('Viewer defaults to two minutes and refreshes approved pages and a reviewed vote image without broadcaster controls',async({page})=>{
  const {posts,feed}=await viewerFixture(page);
  for(const label of ['Panic hide','End stream','Start a prediction','Start a 45-second vote','Approve','Release'])await expect(page.getByRole('button',{name:label,exact:true})).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'Capture duration',exact:true})).toHaveValue('120');
  await page.getByRole('textbox',{name:'Twitch stream link',exact:true}).fill('https://www.twitch.tv/qa_owner');
  await page.getByRole('button',{name:'Capture this stream for 2 minutes',exact:true}).click();
  expect(posts.find(post=>post.path==='/api/watch/start')?.body).toMatchObject({channel:'qa_owner',duration:120});
  const approved=page.getByRole('region',{name:'Broadcaster approved catch-up',exact:true});
  await expect(approved.getByRole('img',{name:'Controlled previous artwork',exact:true})).toHaveAttribute('src',feed.panels[0].imageUrl);
  feed.panels.push({id:'new-approved',imageUrl:'/art/scenes/qa-new?v=original',caption:'Newly approved scene',altText:'Controlled new artwork'});
  await expect(approved.getByRole('img')).toHaveCount(2);
  feed.panels[1]={...feed.panels[1],imageUrl:'/art/scenes/qa-new?v=reviewed-vote',caption:'Chat chose the reviewed line'};
  await expect(approved.getByRole('img',{name:'Controlled new artwork',exact:true})).toHaveAttribute('src',feed.panels[1].imageUrl);
  await expect(approved).toContainText('Chat chose the reviewed line');
  await expect(approved.getByRole('img')).toHaveCount(2);
  expect(posts.filter(post=>/^\/api\/(ingest|approve|hide|participation)/.test(post.path))).toEqual([]);
  await approved.scrollIntoViewIfNeeded();
  await mkdir('artifacts/qa/sprint',{recursive:true});
  await page.screenshot({path:'artifacts/qa/sprint/viewer-approved-feed.jpg',type:'jpeg',quality:85});
});

test('Viewer offers Cloudflare own-key settings, requires a matching account ID and clears submitted credentials',async({page})=>{
  const {posts}=await viewerFixture(page);
  await page.locator('.ct-generator summary').click();
  await page.getByLabel('Provider',{exact:true}).selectOption('cloudflare');
  await expect(page.getByLabel('Image model',{exact:true})).toHaveValue('@cf/black-forest-labs/flux-2-klein-9b');
  const key=page.getByLabel('API key',{exact:true}),account=page.getByLabel('Cloudflare account ID',{exact:true});
  await expect(key).toHaveAttribute('type','password');
  await expect(account).toHaveAttribute('required','');
  await key.fill('qa-cloudflare-token-never-stored');
  await page.getByRole('button',{name:'Use my key for this session',exact:true}).click();
  expect(posts.filter(post=>post.path==='/api/watch/generator')).toHaveLength(0);
  await account.fill('0123456789abcdef0123456789abcdef');
  await page.getByLabel('Maximum pages this session',{exact:true}).selectOption('2');
  await page.getByRole('button',{name:'Use my key for this session',exact:true}).click();
  await expect(key).toHaveValue('');await expect(account).toHaveValue('');
  expect(posts.find(post=>post.path==='/api/watch/generator')?.body).toMatchObject({provider:'cloudflare',model:'@cf/black-forest-labs/flux-2-klein-9b',key:'qa-cloudflare-token-never-stored',accountId:'0123456789abcdef0123456789abcdef',maxPages:2});
  const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));
  expect(storage).not.toContain('qa-cloudflare-token-never-stored');expect(storage).not.toContain('0123456789abcdef0123456789abcdef');
  await account.scrollIntoViewIfNeeded();
  await mkdir('artifacts/qa/sprint',{recursive:true});
  await page.screenshot({path:'artifacts/qa/sprint/viewer-cloudflare-settings.jpg',type:'jpeg',quality:85});
});
