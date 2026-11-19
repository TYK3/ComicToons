import { assertLettering } from './lettering';
import {capture as screenshot} from './screenshot';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }];

test('populated dashboard, overlay, and recap reflow and have no serious or critical axe findings', async ({ page, request, baseURL }) => {
  await mkdir('artifacts/ui-after', { recursive: true });
  const externalRequests: string[] = [];
  const allowedOrigin = new URL(baseURL!).origin;
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== allowedOrigin) externalRequests.push(request.url()); });
  await request.post('/api/replay', { data: { fixtureId: 'tabletop-night', speed: 60, style: 'risograph' } });
  await expect.poll(async () => (await (await request.get('/api/state')).json()).pendingPanels.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  await request.post('/api/approve', { data: { all: true } });
  const report: Record<string, unknown> = {};
  async function capture(view: string, route: string) {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(route);
      await expect(page.locator('.comic-panel').first()).toBeVisible();
      await expect(page.locator('.comic-panel').first()).toHaveAttribute('data-provider', 'storyboard');
      const art = page.locator('.comic-panel .panel-art > img');
      expect(await art.evaluateAll(images => images.every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0 && (!!img.closest('.story-panel') || (img as HTMLImageElement).naturalWidth === 1280)))).toBeTruthy();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => Array.from(document.fonts).some(font => font.family.includes('DM Sans') && font.status === 'loaded'))).toBeTruthy();
      const undersized = await page.locator('p, label, .field-label, .speech-bubble, .panel-caption').evaluateAll(nodes => nodes.flatMap(node => {
        if (!node.getBoundingClientRect().width || !node.getBoundingClientRect().height) return [];
        const minimum = node.matches('label, .field-label') ? 12 : 14;
        const size = Number.parseFloat(getComputedStyle(node).fontSize);
        return size < minimum ? [{ text: node.textContent?.trim().slice(0, 70), size, minimum }] : [];
      }));
      expect(undersized, 'Body text must be at least 14px; labels at least 12px.').toEqual([]);
      await assertLettering(page);
      await screenshot(page,{ path: `artifacts/ui-after/${view}-${viewport.width}x${viewport.height}.png`, fullPage: true, animations: 'disabled', omitBackground: view === 'overlay' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      if (view === 'recap') await expect(page.locator('.manga-summary')).toBeHidden();
      const result = await new AxeBuilder({ page }).analyze();
      report[`${view}-${viewport.width}`] = result.violations;
      await writeFile('artifacts/ui-after/axe-results.json', JSON.stringify(report, null, 2));
      expect(result.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical'), JSON.stringify(result.violations, null, 2)).toEqual([]);
      if (view === 'overlay') expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    }
  }
  await capture('dashboard', '/dashboard');
  await capture('overlay', '/overlay');
  const response = await request.post('/api/end');
  expect(response.ok()).toBeTruthy();
  const { recapUrl, shareUrl } = await response.json();
  await capture('recap', recapUrl);
  const standaloneUrl = shareUrl.replace(/share\.png$/, 'index.html');
  for (const viewport of [viewports[0]!, viewports[2]!]) {
    await page.setViewportSize(viewport);
    await page.goto(standaloneUrl);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.art img').first()).toHaveAttribute('src', /^data:image\/(webp|png);base64,/);
    expect(await page.locator('.art img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0 && (!!img.closest('.story-panel') || (img as HTMLImageElement).naturalWidth === 1280)))).toBeTruthy();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.edition')).toContainText('3 APPROVED MOMENTS');
    await assertLettering(page);
    await screenshot(page,{ path: `artifacts/ui-after/standalone-${viewport.width}x${viewport.height}.png`, fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    const result = await new AxeBuilder({ page }).analyze();
    report[`standalone-${viewport.width}`] = result.violations;
    expect(result.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical'), JSON.stringify(result.violations, null, 2)).toEqual([]);
  }
  const share = await request.get(shareUrl);
  expect(share.ok()).toBeTruthy();
  const png = await share.body();
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile('artifacts/ui-after/share-card.png', png);
  const licenses = await request.get(shareUrl.replace(/share\.png$/, 'FONT-LICENSES.txt'));
  expect(licenses.ok()).toBeTruthy();
  expect(await licenses.text()).toContain('SIL OPEN FONT LICENSE');
  await writeFile('artifacts/ui-after/axe-results.json', JSON.stringify(report, null, 2));
  expect(externalRequests, 'Demo assets and fonts must be served locally.').toEqual([]);
});
