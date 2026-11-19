import {expect,test} from '@playwright/test';

for(const width of [390,721,900,1080,1280])test(`landing reader previews fit at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.goto('/ui.html#/');
  const tabs=page.getByRole('tablist',{name:'Sample streams'}).getByRole('tab');
  await expect(tabs).toHaveCount(3);
  for(let at=0;at<3;at++){
    await tabs.nth(at).click();
    await expect(page.locator('#ct-set-panel .ct-reader-preview')).toHaveCount(2);
    await expect(page.locator('#ct-set-panel .ct-page')).toHaveCount(0);
    const links=page.locator('#ct-set-panel .ct-reader-previews a');
    await expect(links).toHaveCount(2);
    for(const box of await links.evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect())))expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
