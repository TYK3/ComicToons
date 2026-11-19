import {test,expect} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';

test('generated-page edit stays open on image failure and closes only after successful reviewed artwork',async({page})=>{
  await page.setViewportSize({width:1242,height:900});
  await page.addInitScript(()=>{
    localStorage.setItem('comictoons-studio-mode-v1','live');sessionStorage.setItem('comictoons-role','streamer');sessionStorage.setItem('comictoons-studio-live-channel-v1','qa_owner');
    class ControlledEvents {static CLOSED=2;readyState=1;addEventListener(){}close(){this.readyState=2;}}
    window.EventSource=ControlledEvents as unknown as typeof EventSource;
  });
  const panel={id:'controlled-page',origin:'twitch',caption:'Controlled original caption',dialogue:[],scene:'Controlled browser regression',characters:[],mood:'calm',altText:'Controlled artwork for dialog regression',imageUrl:'/art/scenes/controlled-page',at:0,releaseBlocked:undefined as string|undefined,provenance:{provider:'scene-pollinations',style:'comic',fallback:false}};
  const state={status:'live',fixtureId:'tabletop-night',speed:1,style:'risograph',approvalMode:true,panels:[],pendingPanels:[panel],streamTitle:'Controlled UI test',issueTitle:'Controlled UI test',elapsed:12,duration:600,nextUp:panel.id,source:{requested:'twitch',active:'twitch',channel:'qa_owner',connection:'live',simulated:false,received:3}};
  const art=await readFile(new URL('../fixtures/art/generated/panel-01-stream-start.webp',import.meta.url));
  await page.route('**/art/scenes/controlled-page*',route=>route.fulfill({body:art,contentType:'image/webp'}));
  let saves=0;
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/state')return route.fulfill({json:state});
    if(path==='/api/twitch/status')return route.fulfill({json:{configured:true,connected:true,channel:'qa_owner',login:'qa_owner',scopes:[],broadcaster_type:'affiliate'}});
    if(path==='/api/fixtures')return route.fulfill({json:[]});
    if(path==='/api/participation/status')return route.fulfill({json:{flags:{},budget:{perHour:12,used:0},poll:null,lastPollResult:null,reward:null,catchups:[],hype:null,optedOut:0}});
    if(path==='/api/participation/eventsub')return route.fulfill({json:{state:'connected',signedIn:true,subscribed:[],failed:[],revoked:[],reconnects:0,notifications:0}});
    if(path==='/api/caption'){
      saves++;if(saves===1)return route.fulfill({status:409,json:{error:'Controlled image revision failure; original picture retained.'}});
      panel.caption=route.request().postDataJSON().caption;panel.imageUrl='/art/scenes/controlled-page?v=reviewed';return route.fulfill({json:state});
    }
    return route.fulfill({status:404,json:{error:'Not part of this controlled dialog test.'}});
  });
  await page.goto('/ui.html#/studio');
  await page.locator('.ct-desk').getByRole('button',{name:/^Edit caption/}).click();
  await page.getByRole('dialog').getByRole('textbox',{name:'Caption',exact:true}).fill('The reviewed replacement line');
  await page.getByRole('button',{name:'Save caption',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Edit caption',exact:true})).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('original picture retained');
  await expect(page.locator('.ct-grid [data-panel-id="controlled-page"] img')).toHaveAttribute('src','/art/scenes/controlled-page');
  await mkdir('artifacts/qa/revisions',{recursive:true});await page.screenshot({path:'artifacts/qa/revisions/caption-contract-failure.jpg',type:'jpeg',quality:85});
  await page.getByRole('button',{name:'Save caption',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Edit caption',exact:true})).toHaveCount(0);
  await expect(page.locator('.ct-grid [data-panel-id="controlled-page"] img')).toHaveAttribute('src','/art/scenes/controlled-page?v=reviewed');
  expect(saves).toBe(2);
  panel.releaseBlocked='A source-grounded cameo image has not been generated. Library placeholders cannot go on air.';
  panel.provenance.provider='library';panel.provenance.fallback=true;
  await page.reload();
  await expect(page.locator('.ct-desk').getByRole('button',{name:/^Release/})).toBeDisabled();
  await expect(page.locator('.ct-grid').getByRole('button',{name:'Release',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Accept all waiting (1)',exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:900});
  await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
  await page.setViewportSize({width:1242,height:900});
  await expect(page.getByText(panel.releaseBlocked,{exact:true})).toBeVisible();
  await page.locator('.ct-desk').scrollIntoViewIfNeeded();
  await page.screenshot({path:'artifacts/qa/revisions/placeholder-controls.jpg',type:'jpeg',quality:85});
});
