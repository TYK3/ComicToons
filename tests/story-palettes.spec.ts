import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('sample covers fit their artwork and credits without an empty portrait-height area', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await mkdir('artifacts/qa/covers',{recursive:true});
  for (const width of [696,1242,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto('/ui.html');
    for (const fixture of ['tabletop-night','speedrun-fail','irl-cooking']) {
      await page.locator(`#ct-set-tab-${fixture}`).click();
      const cover=page.locator('.ct-part__cover');
      await cover.locator('img').evaluate(image=>(image as HTMLImageElement).decode());
      if(width===696&&fixture==='tabletop-night') await cover.screenshot({path:'artifacts/qa/covers/landing-cover-696.jpg',type:'jpeg',quality:85});
      const layout=await cover.evaluate(node=>{
        const box=node.getBoundingClientRect();
        const badge=node.querySelector('.ct-book__sample')!.getBoundingClientRect();
        const art=node.querySelector('.ct-art')!.getBoundingClientRect();
        const title=node.querySelector('.ct-book__title')!.getBoundingClientRect();
        return {bottomGap:box.bottom-badge.bottom,titleLeft:title.left-box.left,titleTop:title.top-art.bottom};
      });
      expect(layout.bottomGap,`${fixture} at ${width}px`).toBeLessThan(40);
      expect(layout.titleLeft,`${fixture} at ${width}px`).toBeLessThan(25);
      expect(layout.titleTop,`${fixture} at ${width}px`).toBeGreaterThanOrEqual(0);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test('landing previews show four full painted scenes and unstretched sample cards at 696px', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:696,height:668});
  await page.goto('/ui.html');
  const previews=page.locator('.ct-glass__look .ct-look img');
  await expect(previews).toHaveCount(4);
  await expect.poll(()=>previews.evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);
  await previews.evaluateAll(images=>Promise.all(images.map(image=>(image as HTMLImageElement).decode())));
  expect(new Set(await previews.evaluateAll(images=>images.map(image=>(image as HTMLImageElement).src))).size).toBe(4);
  const thumbs=page.locator('.ct-sets__thumb');
  await expect(thumbs).toHaveCount(3);
  await expect.poll(()=>thumbs.locator('img').evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);
  const measurements=await thumbs.evaluateAll(nodes=>nodes.map(node=>{
    const frame=node.getBoundingClientRect();const image=node.querySelector('img')!;
    const rect=image.getBoundingClientRect();
    return {frameRatio:frame.width/frame.height,scaleX:rect.width/image.naturalWidth,scaleY:rect.height/image.naturalHeight};
  }));
  for(const m of measurements){expect(m.frameRatio).toBeCloseTo(16/9,1);expect(m.scaleX/m.scaleY).toBeCloseTo(1,2);}
  await expect(page.getByRole('heading',{name:'Comic book',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Manga series',exact:true})).toBeVisible();
  await mkdir('artifacts/qa/feedback',{recursive:true});
  await page.locator('.ct-glass__look').screenshot({path:'artifacts/qa/feedback/palettes-696.jpg',type:'jpeg',quality:85});
  await page.locator('.ct-sets__tabs').screenshot({path:'artifacts/qa/feedback/sample-cards-696.jpg',type:'jpeg',quality:85});
});

test('old read-only Jynxzi QA stays out of landing and a fresh Live workspace', async ({page,request})=>{
  const state=await (await request.get('/api/state')).json();
  const quote='he said i’m cheating because i killed him once lmao';
  const panel={id:'qa-dialogue',origin:'twitch',caption:'Chat-inspired QA',dialogue:[quote,'A second retained chat line.'],altText:'Legacy sunset illustration',
    imageUrl:'/art/generated/panel-15-sunset-goodbye.webp',at:1,provenance:{provider:'library',asset:'panel-15-sunset-goodbye.webp',style:'pop-ink',fallback:true}};
  await page.addInitScript(()=>{class FixtureEvents{static CLOSED=2;readyState=1;addEventListener(){}close(){this.readyState=2;}}window.EventSource=FixtureEvents as unknown as typeof EventSource;});
  await page.route('**/api/state',route=>route.fulfill({json:{...state,panels:[panel,{...panel,id:'qa-2'},{...panel,id:'qa-3'}],pendingPanels:[],source:{requested:'twitch',active:'twitch',connection:'live',channel:'jynxzi',simulated:false,received:10}}}));
  await page.route('**/api/twitch/status',route=>route.fulfill({json:{configured:true,connected:true,login:'qa_owner',scopes:[]}}));
  await page.goto('/ui.html');
  await expect(page.locator('.ct-featured [data-panel-id^=qa-]')).toHaveCount(0);
  await expect(page.locator('.ct-issues')).not.toContainText('@jynxzi');
  await page.goto('/ui.html#/studio');
  await expect(page.locator('.ct-grid .ct-panel')).toHaveCount(0);
  await expect(page.getByPlaceholder('twitch.tv/channel or username')).toHaveValue('');
});

test('sample manga renders all twenty scenes on five pages, with reviewed in-image speech balloons', async ({ page }) => {
  await page.goto('/ui.html#/read/sample-tabletop-night');
  const pages = page.locator('.ct-manga-pages .ct-page');
  await expect(pages).toHaveCount(5);
  await expect(page.locator('.ct-manga-pages .ct-panel')).toHaveCount(20);
  await expect(page.locator('.ct-manga-pages [data-integrated=true]')).toHaveCount(20);
  const contained = await page.locator('.ct-manga-pages .ct-panel').evaluateAll(panels => panels.every(panel => {
    const art = panel.querySelector('.ct-art')!.getBoundingClientRect();
    const bubble = panel.querySelector('.ct-bubble')!.getBoundingClientRect();
    return bubble.left >= art.left && bubble.right <= art.right && bubble.top >= art.top && bubble.bottom <= art.bottom;
  }));
  expect(contained).toBe(true);
  await expect(page.getByText('The end', { exact: true })).toBeVisible();
});

test('palette switching loads painted art and keeps natural colours', async ({ page }) => {
  await page.goto('/ui.html#/read/sample-tabletop-night');
  await expect(page.locator('.ct-manga-pages .ct-art img').first()).toBeVisible();
  for (const id of ['sunset', 'lagoon', 'blossom', 'festival']) {
    await page.locator(`[role=radio][data-look-id=${id}]`).click();
    const image = page.locator('.ct-manga-pages .ct-art img').first();
    await expect(image).toHaveAttribute('src', `/samples/stories/tabletop-${id}.png`);
    await expect(image).toHaveCSS('filter', 'none');
    await expect(image).toHaveCSS('mix-blend-mode', 'normal');
  }
});

test('Studio palette is in the sidebar and Director has a back button', async ({ page }) => {
  await page.goto('/ui.html#/studio');
  await expect(page.locator('.ct-side .ct-palette-card')).toBeVisible();
  await expect(page.locator('.ct-toolbar .ct-looks')).toHaveCount(0);
  await page.goto('/ui.html#/director');
  await page.getByRole('link', { name: 'Back to Studio', exact: true }).click();
  await expect(page).toHaveURL(/#\/studio/);
});

test('Director keeps the back button within a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ui.html#/director');
  await expect(page.getByRole('link', { name: 'Back to Studio', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the episode reader supports four, five or six panels without losing scenes',async({page})=>{
  await page.goto('/ui.html#/read/sample-tabletop-night');
  for(const n of [4,5,6]){
    await page.getByLabel('Panels per page',{exact:true}).selectOption(String(n));
    await expect(page.locator('.ct-manga-pages .ct-panel')).toHaveCount(20);
    await expect(page.locator('.ct-manga-pages .ct-page').first().locator('.ct-panel')).toHaveCount(n);
  }
});
