import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

async function replayControl(page:import('@playwright/test').Page,name:string){
  const menu=page.locator('.ct-replay-menu');
  if(!await menu.evaluate(node=>(node as HTMLDetailsElement).open))await menu.locator('summary').click();
  await page.getByRole('button',{name,exact:true}).click();
  await menu.locator('summary').click();
}


test('sample privacy, raid and bound reader use released panels only',async({page})=>{
  await page.addInitScript(()=>{localStorage.removeItem('comictoons-sample-studio-v1');localStorage.setItem('comictoons-studio-mode-v1','sample');});
  await page.goto('/ui.html#/studio');
  await replayControl(page,'Restart replay');
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(1);
  await replayControl(page,'Pause replay');
  await page.locator('.ct-desk').getByRole('button',{name:/^Release/}).click();
  const message=page.getByRole('textbox',{name:'Act as a sample viewer'});
  await message.fill('!noink');await page.getByRole('button',{name:'Send sample chat',exact:true}).click();
  await page.getByRole('tab',{name:'Settings',exact:true}).click();await expect(page.getByText('1 viewer has opted out',{exact:true})).toBeVisible();
  await page.getByRole('switch',{name:'Viewer simulator',exact:true}).check();await page.getByRole('button',{name:'Simulate a raid · 42 viewers',exact:true}).click();
  await expect(page.locator('.ct-onair .ct-viewer-intro')).toHaveText('Previously on…');
  await expect(page.getByText(/Last catch-up: raid from @SampleCrew with 42 viewers/)).toBeVisible();
  await page.locator('.ct-studio-more summary').click();
  await page.getByRole('button',{name:'End stream',exact:true}).click();
  await page.getByRole('button',{name:'End stream and bind',exact:true}).click();
  await expect(page).toHaveURL(/#\/output/);
  const link=await page.locator('.ct-share input').inputValue();
  await page.goto(link.replace('/recap/','/read/'));
  await expect(page.locator('.ct-manga-pages .ct-panel')).toHaveCount(1);
});

test('Jynxzi sample shows all six panels and a face-clear in-picture quote on phone and desktop',async({page})=>{
  await page.addInitScript(()=>{localStorage.removeItem('comictoons-sample-studio-v1');localStorage.setItem('comictoons-studio-mode-v1','sample');});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/ui.html#/studio');
  await page.getByLabel('Sample stream',{exact:true}).selectOption('jynxzi-qa');
  await page.locator('.ct-replay-menu summary').click();
  await page.locator('[aria-label="Replay speed"] [role=radio]').filter({hasText:'60×'}).click();
  await page.locator('.ct-replay-menu summary').click();
  await expect(page.locator('.ct-grid .ct-cell')).toHaveCount(6,{timeout:15000});
  await page.getByRole('button',{name:'Accept all waiting (6)',exact:true}).click();
  await expect(page.locator('.ct-grid .ct-cell[data-status="On air"]')).toHaveCount(6);
  await mkdir('artifacts/qa/studio',{recursive:true});
  const reaction=page.locator('.ct-grid [data-panel-id*="jynxzi"]').filter({has:page.locator('.ct-bubble--replacement')});
  await expect(reaction).toHaveCount(1);
  await reaction.locator('img').evaluate(image=>(image as HTMLImageElement).decode());
  await reaction.screenshot({path:'artifacts/qa/studio/jynxzi-dialogue.jpg',type:'jpeg',quality:85});
  for(const width of [1242,696,390]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.evaluate(()=>{document.querySelector('.ct-side')!.scrollTop=0;window.scrollTo(0,0);});
    await page.screenshot({path:`artifacts/qa/studio/studio-${width}.jpg`,type:'jpeg',quality:85});
  }
});
