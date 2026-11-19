import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

async function releaseOne(page:Page){
  await page.goto('/ui.html#/studio?workspace=sample');
  await page.locator('.ct-replay-menu summary').click();
  await page.getByRole('button',{name:'Restart replay',exact:true}).click();
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(1);
  await page.getByRole('button',{name:'Pause replay',exact:true}).click();
  await page.locator('.ct-replay-menu summary').click();
  await page.locator('.ct-desk').getByRole('button',{name:/^Release/}).click();
}
async function showPreview(page:Page){
  if(await page.getByRole('button',{name:'Show On air',exact:true}).count())await page.getByRole('button',{name:'Show On air',exact:true}).click();
}

test('one sticky source row and a collapsible simulator drive the in-page audience preview',async({page})=>{
  await page.setViewportSize({width:1242,height:950});await page.emulateMedia({reducedMotion:'reduce'});
  const writes:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/'))writes.push(request.url());});
  await releaseOne(page);
  await expect(page.getByRole('switch',{name:'Live Twitch',exact:true})).not.toBeChecked();
  await expect(page.locator('.ct-demo,.ct-workspace-heading')).toHaveCount(0);
  const selector=await page.getByLabel('Sample stream',{exact:true}).boundingBox();
  const playback=await page.getByRole('button',{name:'Run the stream demo',exact:true}).boundingBox();
  expect(Math.abs(selector!.y-playback!.y)).toBeLessThan(3);
  await expect(page.getByLabel('Sample stream simulator',{exact:true})).toHaveCount(0);
  await page.getByRole('switch',{name:'Viewer simulator',exact:true}).check();
  await page.getByRole('button',{name:'Simulate viewer joining',exact:true}).click();
  await expect(page.locator('.ct-onair .ct-viewer-intro')).toHaveText('Previously on…');
  await page.getByRole('tab',{name:'New viewer',exact:true}).click();
  await expect(page.locator('.ct-latecomer')).toContainText('Welcome, SampleGuest1');
  await page.getByRole('tab',{name:'On air',exact:true}).click();
  await page.getByRole('switch',{name:'Viewer simulator',exact:true}).check();
  await page.getByRole('button',{name:'Try voting',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Votes',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:'Start a 45-second vote',exact:true}).click();
  await page.getByRole('button',{name:'Vote !2',exact:true}).click();
  await expect(page.locator('.ct-onair [aria-label="Viewer vote"]')).toContainText('1 votes');
  await page.getByRole('switch',{name:'Viewer simulator',exact:true}).uncheck();
  await page.evaluate(()=>window.scrollTo(0,700));
  await expect(page.getByRole('switch',{name:'Live Twitch',exact:true})).toBeInViewport();
  await expect(page.getByLabel('Sample stream',{exact:true})).toBeInViewport();
  await expect(page.locator('.ct-onair [aria-label="Viewer vote"]')).toBeInViewport();
  await mkdir('artifacts/qa/studio-navigation',{recursive:true});
  await page.screenshot({path:'artifacts/qa/studio-navigation/desktop-vote.jpg',type:'jpeg',quality:85});
  await page.getByRole('button',{name:'End vote now',exact:true}).click();
  await expect(page.locator('.ct-onair .ct-viewer-banner')).toContainText('Chat chose');
  await page.getByRole('tab',{name:'Votes',exact:true}).press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Cameos',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:'Close On air sidebar',exact:true}).click();
  await expect(page.getByRole('button',{name:'Show On air',exact:true})).toBeVisible();
  await showPreview(page);await expect(page.getByRole('tab',{name:'Cameos',exact:true})).toHaveAttribute('aria-selected','true');
  expect(writes).toEqual([]);
  await page.getByRole('switch',{name:'Live Twitch',exact:true}).check();
  await expect(page.locator('.ct-studio')).toHaveAttribute('data-workspace','live');
  await expect(page.getByRole('switch',{name:'Viewer simulator',exact:true})).toHaveCount(0);
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(0);
});

for(const width of [696,390])test(`sticky controls and On air quick swaps work at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});
  await releaseOne(page);
  await expect(page.locator('#ct-audience-sidebar')).toBeHidden();
  await page.getByRole('switch',{name:'Viewer simulator',exact:true}).check();
  await page.getByRole('button',{name:'Simulate viewer joining',exact:true}).click();
  await expect(page.locator('#ct-audience-sidebar')).toBeVisible();
  await page.getByRole('switch',{name:'Viewer simulator',exact:true}).uncheck();
  await page.getByRole('tab',{name:'Votes',exact:true}).click();
  await page.getByRole('button',{name:'Start a 45-second vote',exact:true}).click();
  await expect(page.locator('.ct-onair [aria-label="Viewer vote"]')).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await mkdir('artifacts/qa/studio-navigation',{recursive:true});
  await page.screenshot({path:`artifacts/qa/studio-navigation/sidebar-${width}.jpg`,type:'jpeg',quality:85});
  await page.getByRole('button',{name:'Close On air sidebar',exact:true}).click();
  await page.evaluate(()=>window.scrollTo(0,700));
  await expect(page.getByRole('switch',{name:'Live Twitch',exact:true})).toBeInViewport();
  await expect(page.getByLabel('Sample stream',{exact:true})).toBeInViewport();
});

test('the source switch stays available when Live opens with the saved Viewer role',async({page})=>{
  await page.addInitScript(()=>sessionStorage.setItem('comictoons-role','viewer'));
  await page.route('**/api/watch',route=>route.fulfill({status:404,json:{error:'No session'}}));
  await page.goto('/ui.html#/studio?workspace=sample');
  await page.getByRole('switch',{name:'Live Twitch',exact:true}).check();
  await expect(page.locator('.ct-watch')).toBeVisible();
  await expect(page.getByRole('switch',{name:'Live Twitch',exact:true})).toBeChecked();
  await page.getByRole('switch',{name:'Live Twitch',exact:true}).uncheck();
  await expect(page.locator('.ct-studio')).toHaveAttribute('data-workspace','sample');
});
