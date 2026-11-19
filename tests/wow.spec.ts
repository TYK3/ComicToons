import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { capture } from './screenshot';
import { assertLettering } from './lettering';

const sizes = [{width:390,height:844},{width:768,height:1024},{width:1440,height:900},{width:1920,height:1080}];
test('art-led landing: routes, both styles, motion, responsive accessibility and protected art', async ({page}) => {
  await mkdir('artifacts/ui-wow',{recursive:true});
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  const results:Record<string,unknown>={};
  for(const size of sizes){
    await page.setViewportSize(size);
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto('/classic');
    await expect(page.getByRole('heading',{level:1})).toHaveText('Make your stream comic history.');
    for(const style of ['Festival colour','Midnight noir']){
      await page.getByRole('button',{name:style,exact:true}).click();
      await expect(page.getByRole('button',{name:style,exact:true})).toHaveAttribute('aria-pressed','true');
      await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.decode()));});
      await assertLettering(page);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(await page.locator('.assembly-panel:visible .panel-art img').evaluateAll(imgs=>imgs.every(img=>img.getAttribute('src')?.startsWith('/art/generated/')&&(img as HTMLImageElement).naturalWidth===1280))).toBe(true);
      const findings=(await new AxeBuilder({page}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical');
      results[`landing-${size.width}-${style}`]=findings;
      expect(findings).toEqual([]);
      await page.evaluate(()=>scrollTo(0,0));
      await capture(page,{path:`artifacts/ui-wow/landing-${size.width}-${style==='Festival colour'?'pop':'noir'}.jpg`});
    }
    await page.locator('#styles').scrollIntoViewIfNeeded();
    await capture(page,{path:`artifacts/ui-wow/styles-${size.width}.jpg`});
    await page.getByRole('link',{name:'See the recap',exact:true}).click();
    await expect(page.locator('#recap')).toBeInViewport();
    await capture(page,{path:`artifacts/ui-wow/recap-preview-${size.width}.jpg`});
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto('/classic');
  await page.evaluate(()=>document.fonts.ready);
  const geometry=await page.locator('.assembly-panel').evaluateAll(nodes=>nodes.map(n=>({top:(n as HTMLElement).offsetTop,height:(n as HTMLElement).offsetHeight})));
  await expect(page.locator('.is-assembled')).toHaveCount(3);
  expect(await page.locator('.assembly-panel').evaluateAll(nodes=>nodes.map(n=>({top:(n as HTMLElement).offsetTop,height:(n as HTMLElement).offsetHeight})))).toEqual(geometry);
  await page.getByRole('button',{name:'Pause assembly'}).click();
  await expect(page.getByRole('button',{name:'Replay assembly'})).toBeVisible();
  await page.getByRole('button',{name:'Midnight noir',exact:true}).click();
  await expect(page.getByRole('link',{name:'Watch the demo',exact:true}).first()).toHaveAttribute('href','/studio?demo=1&style=noir');
  await page.getByRole('link',{name:'Watch the demo',exact:true}).first().click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole('heading',{name:'Live studio',exact:true})).toBeVisible();
  await expect(page.locator('.studio-status')).toContainText('Replay live');
  await expect(page.getByRole('heading',{name:'Moment timeline'})).toBeVisible();
  expect(errors).toEqual([]);
  await writeFile('artifacts/ui-wow/axe-results.json',JSON.stringify(results,null,2));
});

test('studio and published issue have a clear comic hierarchy at every shipped width',async({page,request})=>{
  await mkdir('artifacts/ui-wow',{recursive:true});
  await request.post('/api/replay',{data:{fixtureId:'tabletop-night',speed:60,style:'risograph'}});
  await expect.poll(async()=>(await(await request.get('/api/state')).json()).pendingPanels.length,{timeout:20000}).toBeGreaterThanOrEqual(3);
  await request.post('/api/approve', { data: { all: true } });
  for(const size of sizes){
    await page.setViewportSize(size);await page.goto('/studio');
    await expect(page.locator('.comic-panel').first()).toBeVisible();
    await assertLettering(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await capture(page,{path:`artifacts/ui-wow/studio-${size.width}.jpg`});
  }
  const end=await request.post('/api/end');expect(end.ok()).toBeTruthy();
  const {recapUrl}=await end.json();
  for(const size of sizes){
    await page.setViewportSize(size);await page.goto(recapUrl);
    await expect(page.locator('.comic-panel').first()).toBeVisible();
    await assertLettering(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const findings=(await new AxeBuilder({page}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical');expect(findings).toEqual([]);
    await capture(page,{path:`artifacts/ui-wow/recap-${size.width}.jpg`});
  }
});
