import {expect, test} from '@playwright/test';

// The overlay is fed by /api/events; the 800ms /api/state poll only runs until the stream is up or while it is down.
test('OVERLAY-POLL: overlay skips state polling while the event stream is healthy and resumes it on stream errors', async ({page}) => {
  let stateRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/state') stateRequests += 1; });
  await page.goto('/overlay');
  // The Playwright server is shared: an earlier spec may have ended the stream or hidden the overlay, in which case the page shows only
  // its (screen-reader) "Overlay hidden" heading. All three states render the OBS landmark, which is what polling needs.
  await expect(page.getByRole('main', {name: 'ComicToons OBS overlay'}).or(page.getByText('Waiting for approved moments')).or(page.locator('.comic-panel').first())).toBeAttached();
  await page.waitForTimeout(1000);
  const healthyStart = stateRequests;
  await page.waitForTimeout(3000);
  expect(stateRequests - healthyStart).toBeLessThanOrEqual(1);

  await page.route('**/api/events', route => route.abort('connectionrefused'));
  await page.goto('/overlay');
  await page.waitForTimeout(1000);
  const brokenStart = stateRequests;
  await page.waitForTimeout(3000);
  expect(stateRequests - brokenStart).toBeGreaterThanOrEqual(2);
});
