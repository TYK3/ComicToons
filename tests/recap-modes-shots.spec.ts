import { readProductEnv } from '../packages/core/src/env.mjs';
import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const shots=readProductEnv('COMICTOONS_S3_SHOTS')||'artifacts/tmp/s3-shots';
async function shot(page:Page,name:string){await mkdir(shots,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`${shots}/${name}-${width}.jpg`,type:'jpeg',quality:80,fullPage:true,animations:'disabled'});}}
async function axe(page:Page){const results=await new AxeBuilder({page}).analyze();expect(results.violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);}
async function balloonsFit(page:Page){
 await page.evaluate(()=>document.fonts.ready);
 // FESTIVAL-UI p4 (design signed off by the lead 15:33): comic panels and balloons are Festival ink #142b36, no longer #0b0b0c.
 for(const panel of await page.locator('.s3-panel:visible').all())await expect(panel).toHaveCSS('border-top-color','rgb(20, 43, 54)');
 for(const balloon of await page.locator('.s3-balloon:visible').all())await expect(balloon).toHaveCSS('color','rgb(20, 43, 54)');
 const geometry=await page.locator('.s3-balloon').evaluateAll(elements=>elements.filter(el=>el.checkVisibility()).map(el=>{
  const box=el.getBoundingClientRect(),style=getComputedStyle(el),border=parseFloat(style.borderLeftWidth);
  const panel=el.closest('.s3-panel')!.getBoundingClientRect();
  const corners:number[]=[];
  for(const node of el.querySelectorAll('span,small')){
   if(!node.checkVisibility())continue;
   const range=document.createRange();range.selectNodeContents(node);
   for(const line of range.getClientRects())for(const [x,y] of [[line.left,line.top],[line.right,line.top],[line.left,line.bottom],[line.right,line.bottom]])corners.push(((x-box.x-box.width/2)/(box.width/2-border))**2+((y-box.y-box.height/2)/(box.height/2-border))**2);
  }
  return {text:el.textContent,max:Math.max(...corners),inside:box.left>=panel.left&&box.right<=panel.right&&box.top>=panel.top&&box.bottom<=panel.bottom};
 }));
 expect(geometry.length).toBeGreaterThan(0);
 for(const balloon of geometry){expect(balloon.inside,balloon.text||'balloon').toBe(true);expect(balloon.max,balloon.text||'balloon').toBeLessThanOrEqual(.95);}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
// LOAD-FLAKE-1: the catch-up is on screen for 12 s (components/Overlay.tsx), and the spec slept 2.8 s twice inside that
// window before measuring; on a loaded box that ran past 12 s and left no balloons to measure. Its entrance animations
// are short (heading and raid line s3-slam end 0.8 s after mount; panels use panel-ink, 0.2 s), so wait for them to
// finish instead: 2.4 s is 3x the longest, and an animation that never ends fails here.
async function catchUpSettled(page:Page){
 const asked=Date.now();
 await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.playState!=='finished').length),{message:'catch-up animations finished',timeout:2_400,intervals:[50,100]}).toBe(0);
 await expect(page.getByRole('heading',{name:'PREVIOUSLY ON…'}),'catch-up still on screen').toBeVisible({timeout:1});
 test.info().annotations.push({type:'catchup-settled',description:`${Date.now()-asked} ms`});
}
test('sample output picker, book PNG, series, catch-up SSE, and responsive proofs',async({page,context,request})=>{
 await request.post('/api/stop');await request.post('/api/replay',{data:{fixtureId:'tabletop-night',speed:60}});
 await expect.poll(async()=>{await request.post('/api/approve',{data:{all:true}});return (await (await request.get('/api/state')).json()).panels.length;},{timeout:40000}).toBeGreaterThanOrEqual(3);
 await page.goto('/studio');await shot(page,'studio-output');await page.getByRole('button',{name:'Bind end-of-stream outputs →'}).click();await expect(page.getByRole('dialog')).toBeVisible();await axe(page);await shot(page,'picker-choose');
 await page.route('**/api/end',route=>route.fulfill({status:500,json:{error:'Export unavailable. Your approved panels are safe.'}}));await page.getByRole('button',{name:'Bind it →'}).click();await expect(page.getByRole('alert').filter({hasText:'Export unavailable'})).toBeVisible();await shot(page,'picker-error');await page.unroute('**/api/end');
 const ending=page.waitForResponse(r=>r.url().endsWith('/api/end')&&r.request().method()==='POST');await page.getByRole('button',{name:'Retry binding →'}).click();await expect(page.getByRole('status').filter({hasText:'Picked approved moments'})).toBeVisible();await shot(page,'picker-binding');const result=await (await ending).json();await expect(page.getByRole('heading',{name:'Bound & lettered.'})).toBeVisible({timeout:30000});await shot(page,'picker-done');const id=result.recapUrl.split('/').at(-1);
 const overlay=await context.newPage();await overlay.goto('/overlay');await shot(overlay,'overlay-idle');await overlay.waitForTimeout(600);const started=Date.now();await request.post('/api/catchup',{data:{minutes:60,reason:'raid',raider:'quietkoi',viewers:48}});await expect(overlay.getByRole('heading',{name:'PREVIOUSLY ON…'})).toBeVisible({timeout:2000});const latency=Date.now()-started;expect(latency).toBeLessThan(2000);await expect(overlay.locator('.s3-overlay-panels .comic-panel')).toHaveCount(3);await writeFile(`${shots}/catchup-latency.txt`,`${latency} ms\n`);for(const width of [1440,390]){await overlay.setViewportSize({width,height:1000});await overlay.locator('.s3-overlay-panels .s3-panel').last().waitFor({state:'visible'});await catchUpSettled(overlay);await balloonsFit(overlay);}await shot(overlay,'overlay-catchup');await overlay.close();
 await page.goto('/catchup');await axe(page);await shot(page,'catchup');
 await page.goto(`/book/${id}`);await expect(page.getByRole('article',{name:'cover page 1'})).toBeVisible();await axe(page);const book=await (await request.get(`/api/book/${id}`)).json();expect(book.chapters.length).toBeGreaterThanOrEqual(2);await shot(page,'book-cover');
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download PNGs'}).click();const download=await downloadPromise;const path=await download.path();const png=await readFile(path!);expect([...png.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);expect(png.readUInt32BE(16)).toBeGreaterThan(0);
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.getByRole('button',{name:'Ch. 1',exact:true}).click();await balloonsFit(page);await page.keyboard.press('ArrowRight');await balloonsFit(page);await page.keyboard.press('ArrowRight');await balloonsFit(page);}await page.getByRole('button',{name:'Ch. 1',exact:true}).click();await page.keyboard.press('ArrowRight');await expect(page.getByRole('article',{name:/peak page/})).toBeVisible();await shot(page,'book-story');
 await page.goto(`/series/${id}`);const series=await (await request.get(`/api/series/${id}`)).json();await expect(page.getByRole('navigation',{name:'Episode index'}).getByRole('button')).toHaveCount(series.highlightCount);expect(await page.getByRole('link',{name:'Watch the clip on Twitch ↗'}).count()).toBe(series.episodes[0].highlight.clipUrl?1:0);await axe(page);for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await balloonsFit(page);}await shot(page,'series');
 series.episodes[0].highlight.clipUrl='https://clips.twitch.tv/ExampleMockedForQA';await page.route(`**/api/series/${id}`,route=>route.fulfill({json:series}));await page.reload();const watch=page.getByRole('link',{name:'Watch the clip on Twitch ↗'});/* FESTIVAL-UI: the Watch link is the amber call to action with ink text (9.18:1); focused, it turns paper with an ink ring (13.63:1). */await expect(watch).toHaveCSS('background-color','rgb(255, 194, 88)');await expect(watch).toHaveCSS('color','rgb(20, 43, 54)');await expect(watch).toHaveCSS('border-top-color','rgb(20, 43, 54)');await watch.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(watch).toBeFocused();await expect(watch).toHaveCSS('background-color','rgb(255, 245, 232)');await expect(watch).toHaveCSS('color','rgb(20, 43, 54)');await expect(watch).toHaveCSS('outline-style','solid');await expect(watch).toHaveCSS('outline-color','rgb(20, 43, 54)');await expect(watch).toHaveCSS('outline-width','3px');await expect(watch).toHaveCSS('outline-offset','4px');
 await page.route('**/api/series/empty',route=>route.fulfill({json:{title:'Empty series',sample:false,episodes:[],highlightCount:0}}));await page.goto('/series/empty');await expect(page.getByRole('heading',{name:'No episodes this time'})).toBeVisible();await shot(page,'series-empty');
});
