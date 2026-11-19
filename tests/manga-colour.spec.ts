import {expect,test} from './app-fixture';
import {type Page,type APIRequestContext} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {capture} from './screenshot';

async function sample(request:APIRequestContext,mangaTheme='festival') {
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true,mangaTheme}});
  await request.post('/api/ingest',{data:{mode:'sample'}});await request.post('/api/approve', { data: { all: true } });
}
async function pixelProof(page:Page,bytes:Buffer) {
  return page.evaluate(async base64=>{
    const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=200;canvas.height=200;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,image.height*.15,image.width,image.height*.75,0,0,200,200);
    const pixels=context.getImageData(0,0,200,200).data;let colour=0,warm=0,cool=0,dark=0;
    for(let i=0;i<pixels.length;i+=4){const [r,g,b]=[pixels[i]!,pixels[i+1]!,pixels[i+2]!];if(Math.max(r,g,b)-Math.min(r,g,b)>14)colour++;if(r>b+14)warm++;if(b>r+6||g>r+12)cool++;if(Math.max(r,g,b)<80)dark++;}
    return {colour:colour/40000,warm:warm/40000,cool:cool/40000,dark:dark/40000};
  },bytes.toString('base64'));
}

// THEMES-4: the live /api/settings and /api/recaps enums now accept all seven look ids (LOOK_ENUM in
// apps/server/src/app.ts: festival, sunset, lagoon, blossom and the legacy ink, noir and pop); this spec
// sets the legacy 'ink' id, which resolves to festival.
test('CT-SWITCH: the picker lists all 4 themes with Festival first and default; a legacy setting resolves to Festival and that persists on reload, reaches overlay and keeps Sample Data visible',async({page,request,context})=>{
  await sample(request,'ink');await page.goto('/studio');const choice=page.getByRole('combobox',{name:'Manga colour theme',exact:true});
  await expect(choice).toHaveValue('festival'); // a legacy 'ink' setting resolves to the new default
  await expect(choice.locator('option')).toHaveText(['Festival colour','Sunset glow','Lagoon','Blossom']);
  await expect(page.locator('.preview-stage .manga-pages')).toHaveAttribute('data-manga-theme','festival');
  await page.reload();await expect(choice).toHaveValue('festival');
  const overlay=await context.newPage();await overlay.goto('/overlay');await expect(overlay.locator('.manga-pages')).toHaveAttribute('data-manga-theme','festival');await expect(overlay.locator('.manga-sample')).toContainText('Sample Data');await overlay.close();
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});await expect(choice).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect((await new AxeBuilder({page}).analyze()).violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
  }
  await request.post('/api/settings',{data:{mangaTheme:'ink'}});
  await page.reload();await expect(choice).toHaveValue('festival'); // a legacy server default still resolves after reload
});

test('CT-EXPORT: browser PNG, saved recap and per-page PNG retain the festival palette',async({page,request})=>{
  const mangaTheme='festival';
  await mkdir('artifacts/manga-colour',{recursive:true});await sample(request,mangaTheme);await page.goto('/studio');
  await expect(page.locator('.preview-stage .manga-pages')).toHaveAttribute('data-manga-theme',mangaTheme);
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download recap PNG',exact:true}).click();const download=await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^comictoons-recap-[a-z0-9-]+\.png$/);await download.saveAs(`artifacts/manga-colour/${mangaTheme}-client.png`);
  const client=await readFile(`artifacts/manga-colour/${mangaTheme}-client.png`);expect(client.length).toBeGreaterThan(50_000);
  const clientProof=await pixelProof(page,client);
  const ended=await request.post('/api/end');expect(ended.ok()).toBe(true);const links=await ended.json();
  await page.goto(`/recap/${links.recapUrl.split('/').at(-1)}`);await expect(page.locator('.manga-pages')).toHaveAttribute('data-manga-theme',mangaTheme);await expect(page.locator('.manga-sample')).toContainText('Sample Data');
  await expect(page.locator('.story-balloon').first()).toBeVisible();await expect(page.locator('.story-sfx').first()).toBeVisible();
  const png=await request.get(links.pageUrls[0]);expect(png.ok()).toBe(true);const bytes=await png.body();expect(bytes.length).toBeGreaterThan(50_000);const serverProof=await pixelProof(page,bytes);
  await writeFile(`artifacts/manga-colour/${mangaTheme}-page.png`,bytes);
  for(const proof of [clientProof,serverProof]){
    expect(proof.colour).toBeGreaterThan(.15);expect(proof.warm).toBeGreaterThan(.03);expect(proof.cool).toBeGreaterThan(.03);
    expect(proof.dark,'Ink detail must remain present').toBeGreaterThan(.02);
  }
  await page.setViewportSize({width:1280,height:1000});await capture(page,{path:`artifacts/manga-colour/${mangaTheme}-recap.jpg`});
  await writeFile(`artifacts/manga-colour/${mangaTheme}-proof.json`,JSON.stringify({theme:mangaTheme,filename:download.suggestedFilename(),clientBytes:client.length,pageBytes:bytes.length,clientProof,serverProof},null,2));
  await request.post('/api/settings',{data:{mangaTheme:'festival'}});
});
