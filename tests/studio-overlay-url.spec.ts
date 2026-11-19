import { test, expect } from '@playwright/test';

// DOCS-2: the classic Studio hands the streamer the OBS Browser Source URL. OBS must load
// ui.html#/overlay (the only overlay page that shows running chat votes), so "Copy overlay URL",
// the "OBS overlay" nav link and "Preview overlay" must all point there, not at the classic /overlay.
test('DOCS-2 STUDIO-OVERLAY-URL: the classic Studio copies and links ui.html#/overlay for OBS', async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  });
  await page.goto('/dashboard');
  const origin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'Copy overlay URL', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Overlay URL copied');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([`${origin}/ui.html#/overlay`]);
  await expect(page.getByRole('link', { name: 'OBS overlay' })).toHaveAttribute('href', '/ui.html#/overlay');
  await expect(page.getByRole('link', { name: /Preview overlay/ })).toHaveAttribute('href', '/ui.html#/overlay');
});
