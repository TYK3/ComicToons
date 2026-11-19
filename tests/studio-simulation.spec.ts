import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

async function replayControl(page:import('@playwright/test').Page,name:string){
  const menu=page.locator('.ct-replay-menu');
  if(!await menu.evaluate(node=>(node as HTMLDetailsElement).open))await menu.locator('summary').click();
  await page.getByRole('button',{name,exact:true}).click();
  await menu.locator('summary').click();
}


test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{localStorage.removeItem('comictoons-sample-studio-v1');localStorage.removeItem('comictoons-studio-mode-v1');sessionStorage.removeItem('comictoons-studio-live-channel-v1');});
});
async function startSample(page:import('@playwright/test').Page,fixture='tabletop-night'){
  await page.goto('/ui.html#/studio');await page.getByRole('switch',{name:'Live Twitch',exact:true}).uncheck();
  if(fixture==='tabletop-night')await replayControl(page,'Restart replay');
  else await page.getByLabel('Sample stream',{exact:true}).selectOption(fixture);
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(1);
  await replayControl(page,'Pause replay');
}

test('clean live input and gradual Jynxzi sample stay separate; all palettes use their own artwork',async({page})=>{
  await startSample(page,'jynxzi-qa');
  await expect(page.locator('.ct-sample-progress')).toContainText('1 / 6');
  await expect(page.locator('.ct-grid img')).toHaveAttribute('src','/qa/jynxzi/six-panel-page.png');
  await page.getByRole('tab',{name:'Settings',exact:true}).click();await page.locator('.ct-palette-card [data-look-id=sunset]').click();
  await expect(page.locator('.ct-grid img')).toHaveAttribute('src','/qa/jynxzi/six-panel-sunset.png');
  await page.getByRole('switch',{name:'Live Twitch',exact:true}).check();
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(0);
  await expect(page.getByPlaceholder('twitch.tv/channel or username')).toBeVisible();
  await expect(page.getByPlaceholder('twitch.tv/channel or username')).toHaveValue('');
  await expect(page.getByLabel('Sample stream',{exact:true})).toHaveCount(0);
  await page.getByRole('switch',{name:'Live Twitch',exact:true}).uncheck();
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(1);
});

test('releases animate in preview and viewer output, and update an open newcomer view',async({page,context})=>{
  await startSample(page);
  await page.locator('.ct-desk').getByRole('button',{name:/^Release/}).click();
  await expect(page.locator('.ct-onair .ct-viewer-item')).toHaveCount(1);
  await expect(page.locator('.ct-onair .ct-viewer-item')).toHaveCSS('animation-name','ct-viewer-release');
  const viewer=await context.newPage();await viewer.goto('/ui.html#/overlay?workspace=sample');
  await expect(viewer.locator('.ct-viewer-item')).toHaveCount(1);
  const newcomer=await context.newPage();await newcomer.goto('/ui.html#/catchup?workspace=sample');
  await expect(newcomer.locator('.ct-catchup__row .ct-panel')).toHaveCount(1);
  await replayControl(page,'Resume replay');
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(2);
  await replayControl(page,'Pause replay');
  await page.locator('.ct-desk').getByRole('button',{name:/^Release/}).click();
  await expect(viewer.locator('.ct-viewer-item')).toHaveCount(2);
  await expect(newcomer.locator('.ct-catchup__row .ct-panel')).toHaveCount(2);
  await page.getByRole('tab',{name:'New viewer',exact:true}).click();await page.getByRole('button',{name:'Play catch-up on air',exact:true}).click();await page.getByRole('tab',{name:'On air',exact:true}).click();
  await expect(page.locator('.ct-onair .ct-viewer-intro')).toHaveText('Previously on…');
  await expect(viewer.locator('.ct-viewer-intro')).toHaveText('Previously on…');
  await viewer.close();await newcomer.close();
});

test('sample vote, Ink Me and prediction drive the shared On air stage without Twitch writes',async({page})=>{
  const writes:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/'))writes.push(r.url());});
  await startSample(page);await page.locator('.ct-desk').getByRole('button',{name:/^Release/}).click();
  await page.getByRole('tab',{name:'Votes',exact:true}).click();await page.getByRole('button',{name:'Start a 45-second vote',exact:true}).click();
  await expect(page.locator('.ct-onair [aria-label="Viewer vote"]')).toBeVisible();
  await page.getByRole('button',{name:'Vote !2',exact:true}).click();
  await page.getByRole('button',{name:'End vote now',exact:true}).click();
  await expect(page.locator('#ct-air-view .ct-bubble')).toContainText('Chat, that was close!');
  await page.getByRole('tab',{name:'Cameos',exact:true}).click();await page.getByRole('button',{name:'Redeem Ink Me · 500 sample points',exact:true}).click();
  await page.getByRole('button',{name:'Create cameo panel',exact:true}).click();
  const cameo=page.locator('.ct-grid .ct-cell').filter({has:page.locator('[data-panel-id^=sample-cameo]')});
  await cameo.getByRole('button',{name:'Release',exact:true}).click();
  await expect(page.locator('.ct-onair .ct-viewer-banner')).toContainText('@SampleFox joins the comic');
  await page.getByRole('tab',{name:'Predictions',exact:true}).click();await page.getByRole('button',{name:'Start a prediction',exact:true}).click();
  await page.getByRole('button',{name:'Back Success · 100 sample points',exact:true}).click();
  await expect(page.locator('.ct-onair [aria-label="Viewer prediction"]')).toContainText('100 sample points');
  await page.locator('.ct-pred li').filter({hasText:'Success'}).getByRole('button',{name:'Pay out',exact:true}).click();
  await expect(page.locator('.ct-onair .ct-viewer-banner')).toContainText('Prediction result: Success');
  await page.locator('.ct-panic-top').click();
  await expect(page.locator('.ct-onair .ct-viewer-item')).toHaveCount(2);
  await expect(page.locator('.ct-onair')).not.toContainText('Hidden from viewers');
  expect(writes).toEqual([]);
  await mkdir('artifacts/qa/studio',{recursive:true});
  await page.setViewportSize({width:696,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.ct-onair').screenshot({path:'artifacts/qa/studio/on-air-prediction-696.jpg',type:'jpeg',quality:85});
});

test('Accept all releases the paused waiting batch without duplicate panels',async({page})=>{
  await startSample(page);await replayControl(page,'Resume replay');
  await page.locator('.ct-replay-menu summary').click();
  await page.locator('[aria-label="Replay speed"] [role=radio]').filter({hasText:'60×'}).click();
  await page.locator('.ct-replay-menu summary').click();
  await expect.poll(()=>page.locator('.ct-grid .ct-cell').count()).toBeGreaterThanOrEqual(3);
  await replayControl(page,'Pause replay');
  const before=await page.locator('.ct-grid .ct-cell').count();
  await page.getByRole('button',{name:/^Accept all waiting/}).click();
  await expect(page.locator('.ct-grid .ct-cell[data-status=Waiting]')).toHaveCount(0);
  await expect(page.locator('.ct-grid .ct-cell[data-status="On air"]')).toHaveCount(before);
  await expect(page.getByRole('button',{name:'Accept all waiting (0)',exact:true})).toBeDisabled();
});
