import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

async function replayControl(page:import('@playwright/test').Page,name:string){
  const menu=page.locator('.ct-replay-menu');
  if(!await menu.evaluate(node=>(node as HTMLDetailsElement).open))await menu.locator('summary').click();
  await page.getByRole('button',{name,exact:true}).click();
  await menu.locator('summary').click();
}


test('Sample and Live tabs keep independent chat, overlays, catch-up, issues and output',async({page,context})=>{
  await page.goto('/ui.html#/studio?workspace=sample');
  await replayControl(page,'Restart replay');
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(1);
  await replayControl(page,'Pause replay');
  await page.locator('.ct-desk').getByRole('button',{name:/^Release/}).click();
  const live=await context.newPage();
  await live.goto('/ui.html#/studio?workspace=live');
  await expect(live.locator('.ct-studio')).toHaveAttribute('data-workspace','live');
  await expect(live.locator('.ct-grid .ct-cell')).toHaveCount(0);
  await live.goto('/ui.html#/issues?workspace=live');
  await expect(live.getByText('Loading issues…',{exact:true})).toHaveCount(0);
  const liveIssues=await live.locator('.ct-issue-list a').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  expect(liveIssues.every(link=>link&&!link.includes('sample-'))).toBe(true);
  await live.goto('/ui.html#/studio?workspace=live');
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(1);
  await expect(page).toHaveURL(/workspace=sample/);
  await live.getByRole('switch',{name:'Live Twitch',exact:true}).uncheck();
  await expect(live.locator('.ct-grid .ct-cell')).toHaveCount(1);
  await live.getByRole('switch',{name:'Live Twitch',exact:true}).check();
  await expect(page).toHaveURL(/workspace=sample/);
  const overlay=await context.newPage();await overlay.goto('/ui.html#/overlay?workspace=sample');
  await expect(overlay.locator('.ct-viewer-item')).toHaveCount(1);
  await overlay.getByRole('link',{name:'← Back to Sample Studio',exact:true}).click();
  await expect(overlay.locator('.ct-studio')).toHaveAttribute('data-workspace','sample');
  await expect(overlay.locator('.ct-grid .ct-cell')).toHaveCount(1);
  await expect(live.locator('.ct-grid .ct-cell')).toHaveCount(0);
  for(const path of ['overlay','catchup','issues','output']){
    await live.goto(`/ui.html#/${path}?workspace=live`);
    await expect(live.locator('.ct-panel')).toHaveCount(0);
    await expect(live.locator('.ct-readerbar .ct-sample')).toHaveCount(0);
  }
  await expect(live.getByText('Nothing to bind yet',{exact:true})).toBeVisible();
  await page.locator('.ct-studio-more summary').click();
  await page.getByRole('button',{name:'End stream',exact:true}).click();
  await page.getByRole('button',{name:'End stream and bind',exact:true}).click();
  await expect(page).toHaveURL(/output.*workspace=sample/);
  await page.goto('/ui.html#/issues?workspace=sample');
  await expect(page.locator('.ct-issue-list>li')).toHaveCount(1);
  await live.goto('/ui.html#/issues?workspace=live');
  await expect(live.getByText('Loading issues…',{exact:true})).toHaveCount(0);
  expect(await live.locator('.ct-issue-list a').evaluateAll(links=>links.map(link=>link.getAttribute('href')))).toEqual(liveIssues);
});

test('guided Sample stream shows arrivals, on-air events and a saved immutable issue',async({page,context})=>{
  test.setTimeout(60000);
  const writes:string[]=[];context.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/'))writes.push(r.url());});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/ui.html#/studio?workspace=sample');
  const audience=await context.newPage();await audience.emulateMedia({reducedMotion:'reduce'});await audience.goto('/ui.html#/audience?workspace=sample');
  await page.getByRole('button',{name:'Run the stream demo',exact:true}).click();
  await expect(audience.locator('.ct-newcomer h2')).toContainText('Welcome, SampleGuest',{timeout:15000});
  await expect(audience.locator('.ct-viewer-intro')).toHaveText('Previously on…');
  await expect(audience.locator('.ct-newcomer__panels .ct-panel')).toHaveCount(2);
  await expect(audience.getByLabel('Viewer vote',{exact:true})).toBeVisible({timeout:12000});
  await expect(audience.locator('.ct-viewer-banner')).toContainText('Chat chose',{timeout:12000});
  await expect(audience.locator('.ct-viewer-intro')).toHaveText('Previously on…',{timeout:12000});
  await expect(audience.locator('.ct-audience__badge')).toContainText('46 simulated viewers');
  await mkdir('artifacts/qa/workspaces',{recursive:true});
  await audience.setViewportSize({width:1242,height:950});
  await expect.poll(()=>audience.locator('.ct-audience__player [role=tabpanel]:not([hidden]) img').evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0)),{timeout:10000}).toBe(true);
  await audience.screenshot({path:'artifacts/qa/workspaces/sample-audience-raid.jpg',type:'jpeg',quality:85});
  await expect(audience.locator('.ct-viewer-banner')).toContainText('@SampleFox joins the comic',{timeout:12000});
  await expect(audience.getByLabel('Viewer prediction',{exact:true})).toBeVisible({timeout:12000});
  await expect(audience.locator('.ct-viewer-banner')).toContainText('Prediction result: Success',{timeout:12000});
  await expect(page.getByRole('link',{name:'Read the finished Sample issue',exact:true})).toBeVisible({timeout:20000});
  await page.getByRole('switch',{name:'Viewer simulator',exact:true}).check();await expect(page.getByLabel('Stream activity')).toContainText('Sample issue saved');await page.getByRole('switch',{name:'Viewer simulator',exact:true}).uncheck();
  await audience.setViewportSize({width:390,height:844});
  await audience.getByRole('button',{name:'Join as a new viewer',exact:true}).click();
  await expect(audience.getByRole('tabpanel',{name:'Catch-up',exact:true})).toBeVisible();
  expect(await audience.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await audience.screenshot({path:'artifacts/qa/workspaces/sample-audience-390.jpg',type:'jpeg',quality:85});
  await audience.getByLabel('Catch-up window',{exact:true}).selectOption('5');
  await expect(audience.locator('.ct-newcomer__panels .ct-panel')).toHaveCount(6);
  await audience.getByLabel('Catch-up window',{exact:true}).selectOption('30');
  await expect(audience.locator('.ct-newcomer__panels .ct-panel')).toHaveCount(21);
  const issueLink=await page.getByRole('link',{name:'Read the finished Sample issue',exact:true}).getAttribute('href');
  expect(issueLink).toMatch(/sample-session-tabletop-night-.+workspace=sample/);
  await page.goto('/ui.html#/output?workspace=sample');
  await expect(page.locator('.ct-output__head--done')).toContainText('Bound · Sample');
  await expect(page.locator('.ct-share input')).toHaveValue(/workspace=sample/);
  await page.goto(`/ui.html${issueLink!.replace('/recap/','/read/')}`);
  await expect(page.locator('.ct-manga-pages .ct-panel')).toHaveCount(21);
  // A new stream clears its own current output, but preserves the previously bound issue.
  await page.goto('/ui.html#/studio?workspace=sample');
  await replayControl(page,'Restart replay');
  await page.goto('/ui.html#/output?workspace=sample');
  await expect(page.getByText('Nothing to bind yet',{exact:true})).toBeVisible();
  await page.goto(`/ui.html${issueLink!.replace('/recap/','/read/')}`);
  await expect(page.locator('.ct-manga-pages .ct-panel')).toHaveCount(21);
  expect(writes).toEqual([]);
});

test('Sample audience return and mobile controls remain usable; clean OBS output has no navigation',async({page})=>{
  await page.goto('/ui.html#/studio?workspace=sample');
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'Run the stream demo',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await mkdir('artifacts/qa/workspaces',{recursive:true});
  await page.screenshot({path:'artifacts/qa/workspaces/sample-studio-390.jpg',type:'jpeg',quality:85});
  await page.goto('/ui.html#/overlay?workspace=sample');
  await expect(page.getByRole('link',{name:'← Back to Sample Studio',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Clean OBS output',exact:true}).click();
  await expect(page.locator('.ct-overlay-root')).toHaveAttribute('data-clean','true');
  await expect(page.getByRole('link')).toHaveCount(0);
  await page.goto('/ui.html#/studio?workspace=live');
  await page.setViewportSize({width:1242,height:950});
  await page.screenshot({path:'artifacts/qa/workspaces/live-studio-1242.jpg',type:'jpeg',quality:85});
  await page.getByText('Read public chat only',{exact:true}).click();
  await expect(page.locator('.ct-channel-picker__status')).toHaveText('Choose a Twitch channel to start reading.');
  await expect(page.getByRole('button',{name:'Run the stream demo',exact:true})).toHaveCount(0);
  await page.getByRole('switch',{name:'Live Twitch',exact:true}).uncheck();
  await expect(page.locator('.ct-studio')).toHaveAttribute('data-workspace','sample');
});

test('a saved Twitch Viewer role does not replace the Sample demo or audience overlays',async({page})=>{
  await page.addInitScript(()=>sessionStorage.setItem('comictoons-role','viewer'));
  await page.route('**/api/watch',route=>route.fulfill({status:404,json:{error:'No viewing session'}}));
  await page.goto('/ui.html#/studio?workspace=sample');
  await expect(page.getByRole('button',{name:'Run the stream demo',exact:true})).toBeVisible();
  await expect(page.locator('.ct-role-choice')).toHaveCount(0);
  await page.goto('/ui.html#/overlay?workspace=sample');
  await page.getByRole('link',{name:'← Back to Sample Studio',exact:true}).click();
  await expect(page.getByRole('button',{name:'Run the stream demo',exact:true})).toBeVisible();
  await page.goto('/ui.html#/overlay?workspace=live');
  await expect(page.getByRole('link',{name:'← Back to Live Studio',exact:true})).toBeVisible();
  await page.goto('/ui.html#/catchup?workspace=live');
  await expect(page.locator('.ct-catchup')).toBeVisible();
});

test('landing and connection actions explicitly open the chosen workspace',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('comictoons-studio-mode-v1','live'));
  await page.goto('/ui.html#/');
  await page.getByRole('link',{name:'Try Sample demo',exact:true}).click();
  await expect(page.locator('.ct-studio')).toHaveAttribute('data-workspace','sample');
  await page.goto('/ui.html#/');
  await page.locator('.ct-pill').getByRole('link',{name:'Live Studio',exact:true}).click();
  await expect(page.locator('.ct-studio')).toHaveAttribute('data-workspace','live');
  await page.route('**/api/twitch/status',route=>route.fulfill({json:{configured:false,connected:false}}));
  await page.goto('/ui.html#/connect');
  await page.getByRole('link',{name:'Use Sample data',exact:true}).click();
  await expect(page.locator('.ct-studio')).toHaveAttribute('data-workspace','sample');
});
