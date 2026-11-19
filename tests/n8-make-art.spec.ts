import { expect, test, type Route } from '@playwright/test';

// N8: on a slow connection the landing page's "What it makes" art showed an empty box, because it was lazy-loaded
// and only asked for once scrolled to. LANDING-2 replaced the three cards with the Sample sets; the same guarantee
// now covers the Sample set's Catch-up panels, the first art in the set. Every image request is held here (a route
// delay), so the art is still loading when the panel is checked.

test('N8 Sample set Catch-up art: asked for up front and the box is filled while it loads', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const held: Route[] = [];
  const asked: string[] = [];
  await page.route('**/*', route => {
    if (route.request().resourceType() !== 'image') return route.continue();
    asked.push(route.request().url());
    held.push(route);
  });
  await page.goto('/ui.html#/');
  const box = page.locator('#ct-set-panel .ct-catchup__row > li').first();
  const img = box.locator('.ct-art > img');
  await expect(img).toHaveCount(1, { timeout: 30_000 });

  // Eager: the panel is far below the fold at 390 px, yet its art is requested before any scroll.
  await expect(img).toHaveAttribute('loading', 'eager');
  const src = await img.evaluate(el => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src);
  await expect.poll(() => asked.some(url => url === src || url.split('?')[0] === src.split('?')[0]), { timeout: 10_000 }).toBe(true);

  await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const loading = await img.evaluate(el => {
    const image = el as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    const style = getComputedStyle(image);
    return { complete: image.complete && image.naturalWidth > 0, width: rect.width, height: rect.height, ratio: image.width / image.height, fill: style.backgroundImage, colour: style.backgroundColor };
  });
  // Still loading, but the box keeps the art's shape and shows the Festival placeholder, not a blank.
  expect(loading.complete).toBe(false);
  expect(loading.width).toBeGreaterThan(280);
  expect(Math.abs(loading.width / loading.height - loading.ratio)).toBeLessThan(0.05);
  expect(loading.fill).toContain('linear-gradient');
  expect(loading.colour).not.toBe('rgba(0, 0, 0, 0)');
  await box.screenshot({ path: 'artifacts/n8/sample-catchup-loading.png' });

  // Let the art through: it lands on top of the placeholder and covers it.
  await page.unroute('**/*');
  for (const route of held.splice(0)) await route.continue().catch(() => undefined);
  await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { timeout: 30_000 }).toBe(true);
  await box.screenshot({ path: 'artifacts/n8/sample-catchup-loaded.png' });
});
