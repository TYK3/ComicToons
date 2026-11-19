import {test,expect} from '@playwright/test';
test('source flow exposes the evidence gap, editable 4–6 panel plans and local drafts',async({page})=>{
  await page.goto('/ui.html#/flow');
  await expect(page.getByRole('heading',{name:'How this page gets made'})).toBeVisible();
  await expect(page.getByText('Scene reconstruction is waiting for footage and speech analysis.')).toBeVisible();
  await expect(page.locator('.ct-flow__board > li')).toHaveCount(6);
  await page.getByLabel('Panels',{exact:true}).selectOption('4');
  await expect(page.locator('.ct-flow__board > li')).toHaveCount(4);
  await page.getByLabel('Title',{exact:true}).fill('A reviewed moment');
  await page.getByRole('button',{name:'Save draft locally'}).click();
  await page.getByLabel('Title',{exact:true}).fill('Temporary');
  await page.getByRole('button',{name:'Restore draft'}).click();
  await expect(page.getByLabel('Title',{exact:true})).toHaveValue('A reviewed moment');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
