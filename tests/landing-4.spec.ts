import { expect, test, type Page } from '@playwright/test';

// LANDING-4: between 721 and 1279px the two-column comic book squeezed page panels below base.css's 259px caption
// rule, hiding their caption boxes. A single centred column (capped at 640px) across that band keeps panels wide
// enough for their lettering, while the phone layout (<=720px) and the wide desktop layout (>=1280px) stay put.

const TITLES = ['Critical Mess', 'Frame Perfect', 'Batter Days'];

async function openPage(page: Page, width: number) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/settings', route => route.request().method() === 'POST' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.goto('/ui.html#/');
  const tabs = page.getByRole('tablist', { name: 'Sample streams' }).getByRole('tab');
  await expect(tabs).toHaveCount(3, { timeout: 30_000 });
  return tabs;
}

async function readBook(page: Page) {
  await page.locator('#ct-set-panel .ct-part__leaves').scrollIntoViewIfNeeded();
  return page.locator('#ct-set-panel .ct-part__leaves').evaluate(list => {
    const box = (el: Element) => el.getBoundingClientRect();
    const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && box(el).width > 0;
    const panels = [...list.querySelectorAll('.ct-page .ct-panel')];
    const captions = panels.map(panel => panel.querySelector('.ct-caption')).filter((el): el is Element => !!el);
    const bubbles = panels.map(panel => panel.querySelector('.ct-bubble')).filter((el): el is Element => !!el);
    return {
      columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
      narrowest: Math.min(...panels.map(panel => box(panel).width)),
      captionCount: captions.length,
      bubbleCount: bubbles.length,
      hiddenCaptions: captions.filter(el => !shown(el)).length,
      hiddenBubbles: bubbles.filter(el => !shown(el)).length,
    };
  });
}

for (const width of [721, 900, 1080, 1200, 1279, 1280, 1440]) {
  test(`LANDING-4 at ${width}: every page panel keeps its caption and bubble visible`, async ({ page }) => {
    const tabs = await openPage(page, width);
    for (const title of TITLES) {
      await tabs.filter({ hasText: title }).click();
      await expect(tabs.filter({ hasText: title })).toHaveAttribute('aria-selected', 'true');
      const book = await readBook(page);
      expect(book.hiddenCaptions).toBe(0);
      expect(book.hiddenBubbles).toBe(0);
      expect(book.captionCount).toBeGreaterThan(0);
      expect(book.bubbleCount).toBeGreaterThan(0);
      expect(book.narrowest).toBeGreaterThanOrEqual(260);
      expect(book.columns).toBe(width < 1280 ? 1 : 2);
    }
  });
}

test('LANDING-4 at 390: the book stays a single column on the phone layout', async ({ page }) => {
  const tabs = await openPage(page, 390);
  await tabs.filter({ hasText: TITLES[0] }).click();
  await expect(tabs.filter({ hasText: TITLES[0] })).toHaveAttribute('aria-selected', 'true');
  const book = await readBook(page);
  expect(book.columns).toBe(1);
});
