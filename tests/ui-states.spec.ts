import {capture} from './screenshot';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';

test('all views explain empty, loading, error, and offline states', async ({ context, request }) => {
  test.setTimeout(180_000);
  await mkdir('artifacts/ui-after/states', { recursive: true });
  await request.post('/api/stop');
  const empty = { ...await (await request.get('/api/state')).json(), status: 'idle' };
  const findings: Record<string, unknown> = {};
  for (const view of ['dashboard', 'overlay', 'recap']) {
    for (const mode of ['empty', 'loading', 'error', 'offline']) {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 1080 }]) {
      const page = await context.newPage();
      await page.setViewportSize(viewport);
      let release = () => {};
      const hold = new Promise<void>(resolve => { release = resolve; });
      await page.route(/\/api\/(state|recaps\/[^/]+)$/, async route => {
        if (mode === 'loading') {
          await hold;
          await route.fulfill({ json: empty }).catch(() => {});
        } else if (mode === 'error') await route.fulfill({ status: 503, json: { error: 'The ink press needs a moment. Please retry.' } });
        else if (mode === 'offline') await route.abort('internetdisconnected');
        else await route.fulfill({ json: empty });
      });
      await page.goto(view === 'recap' ? '/r/state-preview' : `/${view}`);
      if (mode === 'loading') {
        if (view === 'overlay') await expect(page.getByText('Opening the story…')).toBeVisible();
        else await expect(page.getByTestId('loading-skeleton')).toBeVisible();
      } else if (mode === 'empty') {
        await expect(page.getByTestId('loading-skeleton')).toHaveCount(0);
        await expect(page.locator('.comic-panel')).toHaveCount(0);
        if (view === 'overlay') await expect(page.getByText('Waiting for approved moments')).toBeVisible();
        if (view === 'recap') await expect(page.getByRole('heading', { name: 'A blank page. A new beginning.' })).toBeVisible();
      } else if (view === 'recap') await expect(page.getByRole('heading', { name: 'This issue is taking a detour.' })).toBeVisible();
      else await expect(page.getByRole('alert').first()).toBeVisible();
      await capture(page,{ path: `artifacts/ui-after/states/${view}-${mode}-${viewport.width}x${viewport.height}.png`, fullPage: true, animations: 'disabled', omitBackground: view === 'overlay' });
      const axe = await new AxeBuilder({ page }).analyze();
      findings[`${view}-${mode}-${viewport.width}`] = axe.violations;
      await writeFile('artifacts/ui-after/states/axe-results.json', JSON.stringify(findings, null, 2));
      expect(axe.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical'), JSON.stringify(axe.violations, null, 2)).toEqual([]);
      release();
      await page.close();
      }
    }
  }
});
