import { buildMangaPages } from '../packages/core/src/index.ts';
import { renderExport } from '../apps/server/src/export.ts';
import { assertLettering } from './lettering';
import {capture} from './screenshot';
import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('keyless replay → approval → overlay → recap and PNG', async ({ page, context, request }) => {
  await mkdir('artifacts', { recursive: true });
  await request.post('/api/stop');
  await page.goto('/dashboard');
  await expect(page.getByRole('button', { name: /Start replay/ })).toBeVisible();
  await page.locator('#fixture').selectOption('tabletop-night');
  await page.getByRole('button', { name: /Start replay/ }).click();
  const approve = page.getByRole('button', { name: /Approve strip/ });
  await expect(approve).toBeEnabled({ timeout: 35_000 });
  const overlay = await context.newPage();
  await overlay.setViewportSize({ width: 1920, height: 1080 });
  await overlay.goto('/overlay');
  await expect(overlay.locator('.comic-panel')).toHaveCount(0);
  await approve.click();
  await expect(page.locator('.comic-panel').first()).toBeVisible();
  await expect.poll(async () => (await (await request.get('/api/state')).json()).pendingPanels.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(approve).toBeEnabled();
  await approve.click();
  const approvedCount = buildMangaPages((await (await request.get('/api/state')).json()).panels).at(-1)!.panels.length;
  await expect(page.locator('.preview-stage .comic-panel')).toHaveCount(approvedCount);
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await capture(page,{ path: 'artifacts/dashboard.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page,{ path: 'artifacts/dashboard-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await expect(overlay.locator('.comic-panel')).toHaveCount(approvedCount);
  await overlay.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  expect(await overlay.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await capture(overlay,{ path: 'artifacts/overlay-1920x1080.png', omitBackground: true, animations: 'disabled' });

  const recapDocuments: string[] = [];
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && /\/recap\//.test(request.url())) recapDocuments.push(request.url());
  });
  // The studio owns this redirect. A competing goto races location.assign.
  const recapNavigation = page.waitForURL(/\/recap\//, { timeout: 35_000 });
  await page.getByRole('button', { name: /End stream/ }).click();
  await recapNavigation;
  const state = await (await request.get('/api/state')).json();
  await expect(page).toHaveURL(state.recapUrl);
  expect(recapDocuments).toHaveLength(1);
  await expect(page.locator('.comic-panel').first()).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await capture(page,{ path: 'artifacts/recap.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page,{ path: 'artifacts/recap-mobile.png', fullPage: true, animations: 'disabled' });
  const share = await request.get(state.shareUrl);
  expect(share.ok()).toBeTruthy();
  const png = await share.body();
  expect(png.length).toBeGreaterThan(1000);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile('artifacts/share-card.png', png);
  const exportPreview = await context.newPage();
  await exportPreview.setViewportSize({ width: 1080, height: 1350 });
  await exportPreview.setContent((await renderExport(state)).shareHtml);
  await exportPreview.evaluate(() => document.fonts.ready);
  await assertLettering(exportPreview);
  const requiredHeight = await exportPreview.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20), 'Actual API PNG must contain the full lettering document, without a 1350px crop.').toBeGreaterThanOrEqual(requiredHeight);
  await exportPreview.close();

  await request.post('/api/stop');
  await expect(overlay.locator('.comic-panel')).toHaveCount(0);
});
