import {expect,test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdir} from 'node:fs/promises';

test('own-channel reader validates links and stops from Studio',async({page,request})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(()=>localStorage.setItem('comictoons-studio-mode-v1','sample'));
  await page.setViewportSize({width:1280,height:900});
  let state=await (await request.get('/api/state')).json();
  const writes:{mode:string;channel?:string}[]=[];
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    class FixtureEvents {static CLOSED=2;readyState=1;addEventListener(){} close(){this.readyState=2;}}
    window.EventSource=FixtureEvents as unknown as typeof EventSource;
  });
  await page.route('**/api/twitch/status',route=>route.fulfill({json:{configured:true,connected:true,login:'streamer',channel:'streamer',scopes:[],missingScopes:[],broadcaster_type:'affiliate'}}));
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.route('**/api/ingest',async route=>{
    const body=route.request().postDataJSON();writes.push(body);
    state={...state,source:body.mode==='sample'?{requested:'sample',active:'sample',connection:'sample',simulated:false,received:0}:{requested:'twitch',active:'twitch',connection:'live',channel:body.channel,simulated:false,received:1,transport:'tls'}};
    await route.fulfill({json:state});
  });
  await page.goto('/ui.html#/connect');
  const form=page.getByRole('form',{name:'Read another channel'});
  await form.getByLabel('Read another channel',{exact:true}).fill('https://example.com/nope');
  await form.getByRole('button',{name:'Read chat',exact:true}).click();
  await expect(form.getByRole('alert')).toContainText('Twitch');expect(writes).toHaveLength(0);
  await form.getByLabel('Read another channel',{exact:true}).fill('https://www.twitch.tv/Streamer/');
  await form.getByRole('button',{name:'Read chat',exact:true}).click();
  await expect(page).toHaveURL(/#\/studio/);
  await expect(page.locator('.ct-studio')).toHaveAttribute('data-workspace','live');
  await page.getByText('Read public chat only',{exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Reading #streamer'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Read-only channel'})).toHaveCount(0);
  expect(writes[0]).toEqual({mode:'twitch',channel:'streamer',fresh:true,chatOnly:true});
  const violations=(await new AxeBuilder({page}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical');
  expect(violations).toEqual([]);
  await mkdir('artifacts/tmp/public-channel',{recursive:true});
  await page.screenshot({path:'artifacts/tmp/public-channel/desktop.jpg',type:'jpeg',quality:80});
  await page.setViewportSize({width:390,height:844});
  if(await page.getByRole('button',{name:'Close On air sidebar',exact:true}).isVisible())await page.getByRole('button',{name:'Close On air sidebar',exact:true}).click();
  await expect(form.getByLabel('Read another channel',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/tmp/public-channel/mobile.jpg',type:'jpeg',quality:80});
  await form.getByRole('button',{name:'Stop reading',exact:true}).click();
  await expect(form.getByRole('status')).toHaveText('Choose a Twitch channel to start reading.');
  expect(writes.at(-1)).toEqual({mode:'sample'});expect(errors).toEqual([]);
});

test('signed-out readers see the Twitch sign-in prerequisite',async({page})=>{
  await page.route('**/api/twitch/status',route=>route.fulfill({json:{configured:true,connected:false,scopes:[]}}));
  await page.goto('/ui.html#/connect');
  const form=page.getByRole('form',{name:'Read another channel'});
  await form.getByLabel('Read another channel',{exact:true}).fill('other_streamer');
  await expect(form.getByRole('button',{name:'Read chat',exact:true})).toBeDisabled();
  await expect(form).toContainText('Connect Twitch');
});
