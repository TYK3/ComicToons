import {expect,test,routeApp} from './app-fixture';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {capture} from './screenshot';
import {assertMangaRows} from './manga-rows';
import {buildMangaPages} from '../packages/core/src/index.ts';


async function sample(request:import('@playwright/test').APIRequestContext) {
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});
  await request.post('/api/ingest',{data:{mode:'sample'}});await request.post('/api/approve', { data: { all: true } });
  return (await request.get('/api/state')).json();
}

test('EX-PNG: studio downloads an actual browser canvas PNG with the required filename and size, without server rendering',async({page,request,appOrigin})=>{
  const state=await sample(request);await mkdir('artifacts/recap-export',{recursive:true});
  await page.addInitScript(()=>{
    const original=HTMLCanvasElement.prototype.toBlob;
    Object.assign(window,{pngCanvasCalls:0});
    HTMLCanvasElement.prototype.toBlob=function(...args){Object.assign(window,{pngCanvasCalls:(window as unknown as {pngCanvasCalls:number}).pngCanvasCalls+1});return original.apply(this,args);};
    const glyphs:{text:string;font:string}[]=[];Object.assign(window,{pngGlyphs:glyphs,pngFramesAdded:0,pngFramesRemoved:0});
    const fill=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(...args){glyphs.push({text:args[0],font:this.font});return fill.apply(this,args);};
    new MutationObserver(records=>{for(const record of records)for(const kind of ['addedNodes','removedNodes'] as const)for(const node of record[kind])if(node instanceof HTMLIFrameElement&&node.hasAttribute('data-png-measure')){
      const key=kind==='addedNodes'?'pngFramesAdded':'pngFramesRemoved';const values=window as unknown as Record<string,number>;values[key]++;
    }}).observe(document,{childList:true,subtree:true});
  });
  const forbidden:string[]=[];
  let persistedUrl='';
  await page.route('**/api/recaps',async route=>{const response=await route.fetch({url:`${appOrigin}/api/recaps`});const saved=await response.json();persistedUrl=saved.recapUrl;expect((await request.get(`/api/recaps/${persistedUrl.split('/').at(-1)}`)).ok()).toBe(true);await route.fulfill({response});});
  await page.route(/\/api\/end$|\/exports\//,route=>{forbidden.push(route.request().url());return route.abort();});
  await page.goto('/studio');const button=page.getByRole('button',{name:'Download recap PNG',exact:true});await expect(button).toBeEnabled();
  await page.setViewportSize({width:1280,height:900});await button.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await capture(page,{path:'artifacts/recap-export/studio-1280.jpg'});
  const pending=page.waitForEvent('download');await button.click();const download=await pending;
  expect(download.suggestedFilename()).toMatch(/^comictoons-recap-[a-f0-9]{32}\.png$/);expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe(`comictoons-recap-${persistedUrl.split('/').at(-1)}.png`);
  const destination=`artifacts/recap-export/${download.suggestedFilename()}`;await download.saveAs(destination);
  const bytes=await readFile(destination);expect(bytes.length).toBeGreaterThan(50_000);
  expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);expect(bytes.readUInt32BE(16)).toBe(1080);expect(bytes.readUInt32BE(20)).toBeGreaterThan(800);
  expect(await page.evaluate(()=>(window as unknown as {pngCanvasCalls:number}).pngCanvasCalls)).toBe(1);expect(forbidden).toEqual([]);
  await expect(button).toBeEnabled();expect((await(await request.get('/api/state')).json()).panels).toEqual(state.panels);
  const secondEvent=page.waitForEvent('download');await button.click();expect((await secondEvent).suggestedFilename(),'Unchanged issue must have the same persisted filename on every click').toBe(download.suggestedFilename());await expect(button).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as {pngCanvasCalls:number}).pngCanvasCalls)).toBe(2);
  await page.setViewportSize({width:390,height:844});await expect(button).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.setViewportSize({width:1280,height:900});
  const glyphs=await page.evaluate(()=>(window as unknown as {pngGlyphs:{text:string;font:string}[]}).pngGlyphs);
  expect(glyphs.some(item=>item.text===state.issueTitle&&item.font.includes('ComicToonsExportDisplay'))).toBe(true);
  expect(glyphs.filter(item=>item.font.includes('ComicToonsExportDisplay')).length).toBeGreaterThan(6);
  expect(await page.evaluate(()=>({added:(window as unknown as {pngFramesAdded:number}).pngFramesAdded,removed:(window as unknown as {pngFramesRemoved:number}).pngFramesRemoved}))).toEqual({added:2,removed:2});
  const expectedFonts=await page.evaluate(async title=>{
    await document.fonts.load('700 40px "Barlow Condensed"');const context=document.createElement('canvas').getContext('2d')!;
    context.font='700 40px "Barlow Condensed"';const brand=context.measureText(title);context.font='700 40px sans-serif';const fallback=context.measureText(title);
    return {brandInkWidth:brand.actualBoundingBoxLeft+brand.actualBoundingBoxRight,fallbackInkWidth:fallback.actualBoundingBoxLeft+fallback.actualBoundingBoxRight};
  },state.issueTitle as string);
  await page.reload();const thirdEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download recap PNG',exact:true}).click();expect((await thirdEvent).suggestedFilename()).toBe(download.suggestedFilename());
  await page.setContent(`<img alt="Actual browser generated manga PNG" style="width:100%;max-width:1080px" src="data:image/png;base64,${bytes.toString('base64')}"/>`);
  const painted=await page.locator('img').evaluate(async element=>{
    const image=element as HTMLImageElement;
    await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    let dark=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]!<180&&pixels[i+1]!<180&&pixels[i+2]!<180)dark++;
    return dark/(canvas.width*canvas.height);
  });
  expect(painted,'The file must contain substantial art and lettering, not an empty canvas').toBeGreaterThan(.08);
  const raster=await page.locator('img').evaluate(element=>{
    const image=element as HTMLImageElement;
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    const dark=(x:number,y:number)=>{const i=(y*canvas.width+x)*4;return pixels[i]!<128&&pixels[i+1]!<128&&pixels[i+2]!<128;};
    let right=0,left=0;for(let y=0;y<canvas.height;y++)for(let x=0;x<20;x++){if(dark(x,y))left++;if(dark(canvas.width-1-x,y))right++;}
    let titleLeft=1080,titleRight=0;for(let y=28;y<72;y++)for(let x=28;x<1052;x++)if(dark(x,y)){titleLeft=Math.min(titleLeft,x);titleRight=Math.max(titleRight,x);}
    return {leftMargin:left/(20*canvas.height),rightMargin:right/(20*canvas.height),titleInkWidth:titleRight-titleLeft+1};
  });
  expect(raster.rightMargin,'The actual PNG must retain white right padding').toBeLessThan(.01);expect(raster.leftMargin).toBeLessThan(.01);
  expect(Math.abs(raster.titleInkWidth-expectedFonts.brandInkWidth),'Raster title must use Barlow Condensed, not a wide fallback font').toBeLessThan(4);
  expect(Math.abs(raster.titleInkWidth-expectedFonts.fallbackInkWidth)).toBeGreaterThan(30);
  await capture(page,{path:'artifacts/recap-export/browser-png.jpg'});
  await writeFile('artifacts/recap-export/png-proof.json',JSON.stringify({filename:download.suggestedFilename(),recapUrl:persistedUrl,repeatAndReloadFilenameMatches:true,bytes:bytes.length,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),darkPixelRatio:painted,forbiddenRequests:forbidden,raster,expectedFonts,glyphs},null,2));
});

test('EX-ROUTE: a saved /recap/id opens by URL in a fresh browser without studio state or storage',async({browser,request,baseURL,appOrigin})=>{
  await sample(request);const ended=await request.post('/api/end');expect(ended.ok()).toBe(true);const links=await ended.json();
  const id=links.recapUrl.split('/').at(-1);
  expect(links.recapUrl).toBe(`/recap/${id}`);
  expect((await(await request.get('/api/state')).json()).recapUrl).toBe(links.recapUrl);
  expect((await(await request.get(`/api/recaps/${id}`)).json()).recapUrl).toBe(links.recapUrl);
  expect((await(await request.post('/api/recaps')).json()).recapUrl).toBe(links.recapUrl);
  await request.post('/api/stop');
  const context=await browser.newContext({baseURL});await routeApp(context,appOrigin);
  try {
    const page=await context.newPage();let studioReads=0;
    await page.route('**/api/state',route=>{studioReads++;return route.abort();});
    await page.goto(`/recap/${id}`);await expect(page.locator('.recap-page .comic-panel')).toHaveCount(6);
    await expect(page.locator('.manga-sample')).toHaveText('Sample Data · Invented chat');
    await expect(page.locator('.studio,.sidebar,.dashboard')).toHaveCount(0);expect(studioReads).toBe(0);
    expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
    await expect(page.getByRole('link',{name:'Download page 1',exact:true})).toBeVisible();
    await page.goto(`/r/${id}`);await expect(page.locator('.recap-page .comic-panel')).toHaveCount(6);
    expect(studioReads,'Legacy URLs stay readable without loading studio state').toBe(0);
    // A saved id also supplies the exact filename when exporting again in studio.
    await page.unroute('**/api/state');await page.goto('/studio');await request.post('/api/ingest',{data:{mode:'sample'}});await request.post('/api/approve', { data: { all: true } });
    await page.reload();const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download recap PNG',exact:true}).click();
    expect((await downloadEvent).suggestedFilename()).toBe(`comictoons-recap-${id}.png`);
  } finally {await context.close();}
});

test('EX-CAPTION: reapproval keeps the first saved recap and PNG under the same story id and filename',async({page,request})=>{
  await mkdir('artifacts/recap-export',{recursive:true});
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});
  await request.post('/api/ingest',{data:{mode:'sample'}});
  const approved=await(await request.post('/api/approve', { data: { all: true } })).json();
  await page.goto('/studio');const button=page.getByRole('button',{name:'Download recap PNG',exact:true});
  const firstEvent=page.waitForEvent('download');await button.click();const first=await firstEvent;await first.saveAs('artifacts/recap-export/caption-before.png');
  const initial=await(await request.get('/api/state')).json();const id=initial.recapUrl.split('/').at(-1);
  const firstSaved=await(await request.get(`/api/recaps/${id}`)).json();
  expect(first.suggestedFilename()).toBe(`comictoons-recap-${id}.png`);
  // Use the real moderation/edit path: return the approval to the desk, edit,
  // then approve again. No test-only approved-caption endpoint is introduced.
  expect((await request.post('/api/undo',{data:{token:approved.undoToken}})).ok()).toBe(true);
  const caption='The key belongs to our crew.';
  expect((await request.post('/api/caption',{data:{panelId:initial.panels[0].id,caption}})).ok()).toBe(true);
  expect((await request.post('/api/approve', { data: { all: true } })).ok()).toBe(true);
  // B2: the edited caption is lettered in its own opening balloon and the panel keeps its first
  // dialogue line. The extra balloon can add a page, and the studio preview shows only the latest
  // page, so the caption's position is checked on the live pages and the preview on its latest page.
  const live=buildMangaPages((await(await request.get('/api/state')).json()).panels);
  expect(live[0]!.panels[0]!.panel.dialogue![0]).toBe(caption);
  expect(live[0]!.panels.filter(frame=>frame.panel.sourceId===initial.panels[0].id).flatMap(frame=>frame.panel.dialogue??[])).toContain(initial.panels[0].dialogue[0]);
  await page.reload();await expect(page.locator('.preview-stage .story-balloon').first()).toHaveText(live.at(-1)!.panels[0]!.panel.dialogue![0]!);
  const secondEvent=page.waitForEvent('download');await button.click();const second=await secondEvent;await second.saveAs('artifacts/recap-export/caption-after.png');
  expect(second.suggestedFilename()).toBe(first.suggestedFilename());
  const saved=await(await request.get(`/api/recaps/${id}`)).json();expect(saved.recapUrl).toBe(initial.recapUrl);expect(saved).toEqual(firstSaved);
  const before=await readFile('artifacts/recap-export/caption-before.png'),after=await readFile('artifacts/recap-export/caption-after.png');
  expect(before.length).toBeGreaterThan(50_000);expect(after.length).toBeGreaterThan(50_000);expect(after.equals(before),'Reapproval exports the first saved story, with identical lettering').toBe(true);
  const firstBalloon=buildMangaPages(firstSaved.panels)[0]!.panels[0]!.panel.dialogue![0]!;
  await page.goto(`/recap/${id}`);await expect(page.locator('.story-balloon').first()).toHaveText(firstBalloon);
  await expect(page.locator('.manga-sample')).toHaveText('Sample Data · Invented chat');
  await capture(page,{path:'artifacts/recap-export/caption-stable.jpg'});
  await writeFile('artifacts/recap-export/caption-proof.json',JSON.stringify({id,recapUrl:saved.recapUrl,beforeFilename:first.suggestedFilename(),afterFilename:second.suggestedFilename(),beforeBytes:before.length,afterBytes:after.length,caption,changedRaster:!after.equals(before)},null,2));
});

test('EX-PERSIST-ERROR: failed recap persistence prevents a download and preserves approval state',async({page,request})=>{
  const state=await sample(request);await page.goto('/studio');await page.route('**/api/recaps',route=>route.fulfill({status:503,json:{error:'The recap could not be saved. Your approved panels are safe.'}}));
  let downloads=0;page.on('download',()=>downloads++);const button=page.getByRole('button',{name:'Download recap PNG',exact:true});await button.click();
  await expect(page.getByRole('alert').filter({hasText:'The recap could not be saved.'})).toBeVisible();await expect(button).toBeEnabled();expect(downloads).toBe(0);
  expect((await(await request.get('/api/state')).json()).panels).toEqual(state.panels);
});

test('EX-BUSY: an undefined mutation result shows retry feedback without starting a PNG download',async({page,request})=>{
  const state=await sample(request);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const fixture=resolve('tests/fixtures/download-noop.ts').replaceAll('\\','/');
  await page.route('**/src/main.tsx',route=>route.fulfill({contentType:'application/javascript',body:`import ${JSON.stringify(`/@fs/${fixture}`)};`}));
  let downloads=0;page.on('download',()=>downloads++);
  await page.goto('/studio');const button=page.getByRole('button',{name:'Download recap PNG',exact:true});await expect(button).toBeEnabled();await button.click();
  await expect(page.locator('.toast')).toContainText('The PNG download did not start. Wait for the current studio action to finish, then try again.');
  await expect(button).toBeEnabled();expect(downloads).toBe(0);expect(errors).toEqual([]);
  expect(await page.evaluate(()=>(window as unknown as {downloadNoopCalls:number}).downloadNoopCalls)).toBe(1);
  expect((await(await request.get('/api/state')).json()).panels).toEqual(state.panels);
  await capture(page,{path:'artifacts/recap-export/download-busy.jpg'});
});

test('EX-CONTINUATION: client PNG includes every continuation page and untrusted edited text safely',async({page,request})=>{
  await page.addInitScript(()=>{
    const serialize=XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString=function(node){
      const result=serialize.call(this,node);
      if(node.nodeType===1&&(node as Element).classList.contains('recap-png-sheet'))Object.assign(window,{recapPngMarkup:result});
      return result;
    };
  });
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});await request.post('/api/ingest',{data:{mode:'sample'}});
  const state=(await(await request.get('/api/state')).json());
  const text=('The next scene carries on. 👩🏽‍🚀 مرحبا <script>window.untrusted=true</script> ').repeat(3).slice(0,280);
  await request.post('/api/caption',{data:{panelId:state.pendingPanels[0].id,caption:text}});await request.post('/api/approve', { data: { all: true } });
  await page.goto('/studio');const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download recap PNG',exact:true}).click();
  const download=await downloadEvent;await download.saveAs('artifacts/recap-export/continuation.png');const bytes=await readFile('artifacts/recap-export/continuation.png');
  expect(bytes.length).toBeGreaterThan(50_000);expect(bytes.readUInt32BE(20)).toBeGreaterThan(1800);
  expect(await page.evaluate(()=>(window as unknown as {untrusted?:boolean}).untrusted)).toBeUndefined();
  await expect(page.getByRole('button',{name:'Download recap PNG',exact:true})).toBeEnabled();
  // Inspect the exact frozen HTML given to SVG, then check those right borders
  // in the actual downloaded raster as well as the live React preview.
  await assertMangaRows(page,1); // Studio intentionally shows only the latest page.
  const markup=await page.evaluate(()=>(window as unknown as {recapPngMarkup:string}).recapPngMarkup);
  await page.setViewportSize({width:1080,height:1350});
  await page.setContent(`<style>html,body{margin:0}</style>${markup}`);
  await page.evaluate(()=>scrollTo(0,0));
  const grids=await assertMangaRows(page);
  expect(grids.every(grid=>grid.left>=0&&grid.right<=bytes.readUInt32BE(16)&&grid.rows.every(row=>row.top>=0&&row.bottom<=bytes.readUInt32BE(20))),'Raster probes must lie inside the actual PNG').toBe(true);
  await page.setContent(`<img src="data:image/png;base64,${bytes.toString('base64')}"/>`);
  const edgeInk=await page.locator('img').evaluate(async(element,grids)=>{
    const image=element as HTMLImageElement;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    return grids.flatMap(grid=>grid.rows.map(row=>{
      const x=Math.round(grid.right)-4,y=Math.ceil(row.top)+5,height=Math.floor(row.bottom)-y-5;
      const pixels=context.getImageData(x,y,5,height).data;let dark=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]===255&&pixels[i]!<128&&pixels[i+1]!<128&&pixels[i+2]!<128)dark++;
      return dark/(pixels.length/4);
    }));
  },grids);
  for(const ink of edgeInk)expect(ink,'Every raster row has a panel border at the right page edge').toBeGreaterThan(.1);
  await writeFile('artifacts/recap-export/continuation-rows.json',JSON.stringify({grids,edgeInk},null,2));
  await page.setViewportSize({width:620,height:1240});
  await page.locator('img').evaluate(image=>Object.assign((image as HTMLImageElement).style,{maxWidth:'600px',maxHeight:'1200px',width:'auto',height:'auto'}));
  await page.evaluate(()=>scrollTo(0,0));
  await capture(page,{path:'artifacts/recap-export/continuation-rows.jpg'});
});

test('EX-ERROR: missing local art fails visibly, preserves approved panels and releases the export control',async({page,request})=>{
  const state=await sample(request);await page.goto('/studio');await expect(page.locator('.preview-stage img').first()).toBeVisible();
  await page.route('**/art/generated/**',route=>route.fulfill({status:503,body:'Unavailable'}));
  let downloads=0;page.on('download',()=>downloads++);
  const button=page.getByRole('button',{name:'Download recap PNG',exact:true});await button.click();
  await expect(page.getByText('An illustration or font could not load. Try the PNG download again.',{exact:true})).toBeVisible();
  await expect(button).toBeEnabled();expect(downloads).toBe(0);expect((await(await request.get('/api/state')).json()).panels).toEqual(state.panels);
});
