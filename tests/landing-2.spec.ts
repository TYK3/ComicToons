import { expect, test, type Page } from '@playwright/test';

// LANDING-2: a moving Festival background behind the hero, three Sample streams (one per fixture) and, for each,
// the complete set it makes: Catch-up, comic book and manga series. All of it labelled Sample.

const SETS = [
  { fixture: 'tabletop-night', title: 'Critical Mess' },
  { fixture: 'speedrun-fail', title: 'Frame Perfect' },
  { fixture: 'irl-cooking', title: 'Batter Days' },
];

async function emptyCells(page: Page) {
  return page.evaluate(() => {
    const grids = ['.ct-sets__tabs', '#ct-set-panel .ct-catchup__row', '#ct-set-panel .ct-reader-previews'];
    const bad: string[] = [];
    for (const selector of grids) {
      const grid = document.querySelector(selector);
      if (!grid) { bad.push(`${selector}: missing`); continue; }
      const cells = [...grid.children].filter(cell => getComputedStyle(cell).display !== 'none' && !cell.classList.contains('ct-sr'));
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
      // LANDING-3: a leaf can span the whole row (the back page of an odd-leaf book), so count the column slots used.
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
      const column = (grid.getBoundingClientRect().width - gap * (columns - 1)) / columns;
      const slots = cells.reduce((sum, cell) => sum + Math.max(1, Math.round((cell.getBoundingClientRect().width + gap) / (column + gap))), 0);
      const lastRow = slots % columns;
      if (!cells.length) bad.push(`${selector}: no cells`);
      if (columns > 1 && lastRow !== 0 && slots > columns) bad.push(`${selector}: ${cells.length} cells in ${columns} columns`);
      for (const cell of cells) { const box = cell.getBoundingClientRect(); if (box.width < 40 || box.height < 40) bad.push(`${selector}: empty cell`); }
    }
    return bad;
  });
}

async function expectCompleteSet(page: Page, fixture: string) {
  const panel = page.locator('#ct-set-panel');
  await expect(panel).toHaveAttribute('data-set', fixture);
  await expect(panel.locator('.ct-sets__intro')).toContainText('Sample set');
  await expect(panel.getByRole('heading', { name: 'Catch-up', level: 3 })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Comic book', level: 3 })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Manga series', level: 3 })).toBeVisible();
  await expect(panel.locator('.ct-catchup__row > li')).toHaveCount(3);
  await expect(panel.locator('.ct-catchup__raid')).toContainText('raided with');
  await expect(panel.locator('.ct-reader-preview')).toHaveCount(2);
  await expect(panel.locator('.ct-part__leaves, .ct-part__episodes, .ct-page')).toHaveCount(0);
  await expect(panel.getByRole('link',{name:'Read full comic book',exact:true})).toHaveAttribute('href',`#/book/sample-${fixture}?workspace=sample`);
  await expect(panel.getByRole('link',{name:'Read full manga series',exact:true})).toHaveAttribute('href',`#/series/sample-${fixture}?workspace=sample`);
}

for (const width of [1440, 1080, 390]) {
  test(`LANDING-2 at ${width}: three Sample streams, a complete set, no empty cells`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/ui.html#/');
    const tabs = page.getByRole('tablist', { name: 'Sample streams' }).getByRole('tab');
    await expect(tabs).toHaveCount(3, { timeout: 30_000 });
    for (const [index, set] of SETS.entries()) await expect(tabs.nth(index)).toContainText(set.title);
    await expectCompleteSet(page, SETS[0]!.fixture);
    expect(await emptyCells(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('LANDING-2 every Sample stream opens its own complete set', async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/ui.html#/');
  const tabs = page.getByRole('tablist', { name: 'Sample streams' }).getByRole('tab');
  await expect(tabs).toHaveCount(3, { timeout: 30_000 });
  for (const [index, set] of SETS.entries()) {
    await tabs.nth(index).click();
    await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expectCompleteSet(page, set.fixture);
    expect(await emptyCells(page)).toEqual([]);
  }
});

test('LANDING-2 Sample stream tabs follow the arrow keys', async ({ page }) => {
  await page.goto('/ui.html#/');
  const tabs = page.getByRole('tablist', { name: 'Sample streams' }).getByRole('tab');
  await expect(tabs).toHaveCount(3, { timeout: 30_000 });
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
});

test('LANDING-2 hero background drifts on transform only, and stops for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/ui.html#/');
  const row = page.locator('.ct-drift__row').first();
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  const moving = await row.evaluate(el => { const s = getComputedStyle(el); return { name: s.animationName, play: s.animationPlayState }; });
  expect(moving.name).toMatch(/^ct-drift-x/);
  expect(moving.play).toBe('running');
  const before = await row.evaluate(el => getComputedStyle(el).transform);
  await page.waitForTimeout(600);
  expect(await row.evaluate(el => getComputedStyle(el).transform)).not.toBe(before);
  // The drift is behind the hero and never moves it.
  const heroBox = await page.locator('.ct-drift').evaluate(el => el.parentElement!.getBoundingClientRect().height);
  await page.waitForTimeout(400);
  expect(await page.locator('.ct-drift').evaluate(el => el.parentElement!.getBoundingClientRect().height)).toBe(heroBox);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await row.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});
