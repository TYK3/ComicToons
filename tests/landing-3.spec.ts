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
  await page.locator('#ct-set-panel .ct-part__leaves').scrollIntoViewIfNeeded();
}

test('LANDING-3 MF1 + MF2 at 1440: two leaves a row, page panels ≥260px with captions and bubbles, 3/4 cover and back page', async ({ page }) => {
  await openSet(page, 1440, 'Frame Perfect');
  const book = await page.locator('#ct-set-panel .ct-part__leaves').evaluate(list => {
    const box = (el: Element) => el.getBoundingClientRect();
    const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none' && box(el).width > 0;
    const panels = [...list.querySelectorAll('.ct-page .ct-panel')];
    const cover = list.querySelector('.ct-part__cover')!, end = list.querySelector('.ct-part__end')!;
    return {
      columns: getComputedStyle(list).gridTemplateColumns.split(' ').length,
      align: getComputedStyle(list).alignItems,
      leaves: list.children.length,
      narrowest: Math.min(...panels.map(panel => box(panel).width)),
      hiddenLettering: panels.filter(panel => (panel.querySelector('.ct-caption') && !shown(panel.querySelector('.ct-caption'))) || (panel.querySelector('.ct-bubble') && !shown(panel.querySelector('.ct-bubble')))).length,
      cover: box(cover).width / box(cover).height,
      end: box(end).width / box(end).height,
      endArt: box(end.querySelector('.ct-book__endart img')!).width,
      blankBelow: Math.max(...[...list.querySelectorAll('.ct-page')].map(page => box(page).bottom - box([...page.querySelectorAll('.ct-panel')].pop()!).bottom)),
    };
  });
  expect(book.columns).toBe(2);
  expect(book.align).toBe('start');
  expect(book.leaves).toBe(4);
  expect(book.narrowest).toBeGreaterThanOrEqual(260);
  expect(book.hiddenLettering).toBe(0);
  expect(book.cover).toBeCloseTo(0.75, 2);
  expect(book.end).toBeCloseTo(0.75, 2);
  expect(book.endArt).toBeGreaterThan(100);
  expect(book.blankBelow).toBeLessThan(48);
});

test('LANDING-3 MF3: four Look swatches beside the tabs change the What it makes chrome', async ({ page }) => {
  await openSet(page, 1440, 'Critical Mess');
  const picker = page.locator('.ct-makes').getByRole('radiogroup', { name: 'Look' });
  const swatches = picker.getByRole('radio');
  await expect(swatches).toHaveCount(4);
  for (const box of await swatches.evaluateAll(list => list.map(el => el.getBoundingClientRect()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const picks = [['Sunset glow, colour', 'rgb(255, 138, 61)'], ['Lagoon, colour', 'rgb(46, 196, 214)'], ['Blossom, colour', 'rgb(255, 122, 198)'], ['Festival colour, colour', 'rgb(255, 194, 88)']] as const;
  const selectedTab = page.locator('.ct-sets__tab[aria-selected=true]');
  for (const [name, fill] of picks) {
    await picker.getByRole('radio', { name }).click();
    await expect(picker.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
    await expect(selectedTab).toHaveCSS('background-color', fill);
  }
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
    await expect(tags).toContainText('Clip frame');
    await expect(tags).toContainText('Sample');
    const [art, line] = await Promise.all([first.locator('.ct-panel').boundingBox(), tags.boundingBox()]);
    expect(line!.y).toBeGreaterThanOrEqual(art!.y + art!.height);
  });
}
