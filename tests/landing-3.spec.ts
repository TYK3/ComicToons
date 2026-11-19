import { expect, test, type Page } from '@playwright/test';

// LANDING-3 (crit-landing-2 MF1-MF4): the comic book reads as two-leaf spreads with its lettering, no leaf stretches
// into a half-blank page, a Look picker sits beside the Sample stream tabs, and panel 1's tags sit under the art.

async function openSet(page: Page, width: number, title: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 900 });
  // The Look picks below stay in this page: the saved setting is answered here, so other specs keep their Look.
  await page.route('**/api/settings', route => route.request().method() === 'POST' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.goto('/ui.html#/');
  const tabs = page.getByRole('tablist', { name: 'Sample streams' }).getByRole('tab');
  await expect(tabs).toHaveCount(3, { timeout: 30_000 });
  await tabs.filter({ hasText: title }).click();
  await expect(tabs.filter({ hasText: title })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#ct-set-panel .ct-reader-previews').scrollIntoViewIfNeeded();
}

test('landing contains two short previews; the book opens only after Read full',async({page})=>{
  await openSet(page,1280,'Frame Perfect');
  await expect(page.locator('#ct-set-panel .ct-reader-preview')).toHaveCount(2);
  await expect(page.locator('#ct-set-panel .ct-page')).toHaveCount(0);
  await page.getByRole('link',{name:'Read full comic book',exact:true}).click();
  await expect(page).toHaveURL(/#\/book\/sample-speedrun-fail/);
  await expect(page.locator('.ct-book__cover')).toBeVisible();
});

test('LANDING-3 MF3: four Look swatches beside the tabs change the What it makes chrome', async ({ page }) => {
  await openSet(page, 1440, 'Critical Mess');
  const picker = page.locator('.ct-makes').getByRole('radiogroup', { name: 'Palette' });
  const swatches = picker.getByRole('radio');
  await expect(swatches).toHaveCount(4);
  for (const box of await swatches.evaluateAll(list => list.map(el => el.getBoundingClientRect()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const picks = ['Sunset glow, colour', 'Lagoon, colour', 'Blossom, colour', 'Festival colour, colour'];
  const fills = new Set<string>();
  const selectedTab = page.locator('.ct-sets__tab[aria-selected=true]');
  for (const name of picks) {
    await picker.getByRole('radio', { name }).click();
    await expect(picker.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
    fills.add(await selectedTab.evaluate(el=>getComputedStyle(el).backgroundColor));
  }
  expect(fills.size).toBe(4);
  // Arrow keys move and apply, like the studio picker.
  await picker.getByRole('radio', { name: 'Festival colour, colour' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(picker.getByRole('radio', { name: 'Sunset glow, colour' })).toBeFocused();
  await expect(picker.getByRole('radio', { name: 'Sunset glow, colour' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Home');
  await expect(picker.getByRole('radio', { name: 'Festival colour, colour' })).toHaveAttribute('aria-checked', 'true');
});

for (const width of [1080, 390]) {
  test(`LANDING-3 MF4 at ${width}: panel 1's tags sit under the art, not on it`, async ({ page }) => {
    await openSet(page, width, 'Critical Mess');
    const first = page.locator('#ct-set-panel .ct-catchup__row > li').first();
    await expect(first.locator('.ct-panel__tags')).toHaveCount(0);
    const tags = first.locator('.ct-part__tags');
    await expect(tags).toContainText('Generated art');
    await expect(tags).toContainText('Sample');
    const [art, line] = await Promise.all([first.locator('.ct-panel').boundingBox(), tags.boundingBox()]);
    expect(line!.y).toBeGreaterThanOrEqual(art!.y + art!.height);
  });
}
