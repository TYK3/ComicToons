import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import type { StudioState } from '../apps/web/src/types';
import { capture } from './screenshot';

const evidence = 'artifacts/editor-multipanel';
const state = async (request: APIRequestContext): Promise<StudioState> => (await request.get('/api/state')).json();
const queue = (page: Page) => page.getByTestId('approval-queue');
const card = (page: Page) => queue(page).locator('.queue-card');
const selector = (page: Page, number: number) => queue(page).getByRole('button', { name: new RegExp(`^Review panel ${number}:`) });
const editor = (page: Page) => page.getByRole('textbox', { name: 'Caption', exact: true });
const edit = (page: Page) => queue(page).getByRole('button', { name: /Edit caption/ });

async function prepare(request: APIRequestContext) {
  expect((await request.post('/api/stop')).ok()).toBeTruthy();
  expect((await request.post('/api/settings', { data: { approvalMode: true } })).ok()).toBeTruthy();
  expect((await request.post('/api/replay', { data: { fixtureId: 'tabletop-night', speed: 60 } })).ok()).toBeTruthy();
  await expect.poll(async () => (await state(request)).status, { timeout: 30_000 }).toBe('ready');
  const result = await state(request);
  expect(result.pendingPanels).toHaveLength(4);
  expect(new Set(result.pendingPanels.map(panel => panel.id)).size).toBe(4);
  expect(result.pendingPanels[2]!.id).not.toBe(result.pendingPanels.at(-1)!.id);
  return result;
}

// Every browser test records console/page errors; validation calls use APIRequestContext.
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
});
test.afterEach(async ({ page }, info) => {
  const errors = browserErrors.get(page) ?? [];
  await writeFile(`${evidence}/${info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-console.json`, JSON.stringify(errors, null, 2));
  expect(errors, 'No browser console or page errors').toEqual([]);
});

test.describe('editor multipanel real API regression', () => {
  test.beforeAll(async ({ request }) => { await prepare(request); });
  for (const number of [2, 3, 4]) {
    test(`MP-${number}: panel ${number === 4 ? 'last (4)' : number} selection, artwork, caption target and focus`, async ({ page, request }) => {
      const before = await state(request);
      const target = before.pendingPanels[number - 1]!;
      await page.goto('/studio');
      await expect(selector(page, number)).toBeVisible();
      // Reach the labelled control through ordinary keyboard navigation.
      await selector(page, number - 1).focus();
      await page.keyboard.press('Tab');
      await expect(selector(page, number)).toBeFocused();
      await page.keyboard.press(number === 3 ? 'Space' : 'Enter');
      await expect(selector(page, number)).toHaveAttribute('aria-pressed', 'true');
      await expect(card(page)).toHaveAttribute('data-panel-id', target.id);
      await expect(card(page).getByRole('heading')).toHaveText(target.caption);
      await expect(card(page).locator('img')).toHaveAttribute('src', target.storyBeats?.[0]?.imageUrl ?? target.imageUrl);
      await expect(card(page).locator('img')).toHaveAttribute('alt', target.storyBeats?.[0]?.scene ?? target.altText);
      expect(await card(page).locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await page.keyboard.press('e');
      await expect(editor(page)).toHaveValue(target.caption);
      const caption = `Panel ${number}: an individually edited sample moment.`;
      await editor(page).fill(caption);
      await capture(page, { path: `${evidence}/panel-${number}-dialog.jpg` });
      const response = page.waitForResponse(response => response.url().endsWith('/api/caption') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      const saved = await response;
      expect(saved.ok()).toBeTruthy();
      expect(saved.request().postDataJSON()).toEqual({ panelId: target.id, caption });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(edit(page)).toBeFocused();
      await expect(card(page).getByRole('heading')).toHaveText(caption);
      const after = await state(request);
      expect(after.pendingPanels).toEqual(before.pendingPanels.map(panel => panel.id === target.id ? { ...panel, caption } : panel));
      expect(after.panels).toEqual(before.panels);
      await expect(card(page).locator('img')).toHaveAttribute('src', target.storyBeats?.[0]?.imageUrl ?? target.imageUrl);
      await queue(page).scrollIntoViewIfNeeded();
      await capture(page, { path: `${evidence}/panel-${number}-edited.jpg` });
      // Cancel also returns focus and leaves the persisted caption unchanged.
      await edit(page).click();
      await expect(editor(page)).toHaveValue(caption);
      await editor(page).fill('Discard this draft');
      await page.keyboard.press('Escape');
      await expect(edit(page)).toBeFocused();
      expect((await state(request)).pendingPanels.find(panel => panel.id === target.id)?.caption).toBe(caption);
    });
  }
});

test.describe('editor multipanel adversarial QA', () => {
  test('MP-QA-input: validation, unsafe content, rapid selection and duplicate save', async ({ page, request }) => {
    const before = await prepare(request);
    const target = before.pendingPanels[2]!;
    for (const [data, status] of [
      [{ panelId: target.id, caption: '' }, 400],
      [{ panelId: target.id, caption: '   ' }, 409],
      [{ panelId: '', caption: 'Valid text' }, 400],
      [{ panelId: 'missing-panel', caption: 'Valid text' }, 409],
      [{ panelId: target.id, caption: 'x'.repeat(281) }, 400],
    ] as const) {
      const response = await request.post('/api/caption', { data });
      expect(response.status()).toBe(status);
    }
    expect((await state(request)).pendingPanels).toEqual(before.pendingPanels);
    await page.goto('/studio');
    await expect(selector(page, 4)).toBeVisible();
    // Synchronous clicks exercise consecutive React updates without timing sleeps.
    await queue(page).getByRole('group', { name: 'Pending panels' }).evaluate(group => {
      const buttons = group.querySelectorAll('button');
      for (const index of [3, 1, 0, 3, 2]) buttons[index]!.click();
    });
    await expect(card(page)).toHaveAttribute('data-panel-id', target.id);
    await edit(page).click();
    for (const input of ['', '   ']) {
      await editor(page).fill(input);
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    }
    const unsafe = '<script>bad</script> A sample me@example.com & "quoted"';
    await editor(page).fill(unsafe);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let posts = 0;
    await page.route('**/api/caption', async route => { posts++; await held; await route.continue(); });
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    await save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect.poll(() => posts).toBe(1);
    release();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const focusTarget = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        editButton: active?.matches('.edit-caption-button') ?? false,
        approvalQueue: active?.matches('.approval-queue') ?? false,
        activeElement: active instanceof HTMLElement ? active.outerHTML.slice(0, 300) : String(active),
      };
    });
    expect(focusTarget.editButton || focusTarget.approvalQueue, `Unexpected focus return target: ${JSON.stringify(focusTarget)}`).toBe(true);
    const caption = 'bad A sample [redacted] & "quoted"';
    await expect(card(page).getByRole('heading')).toHaveText(caption);
    expect((await state(request)).pendingPanels).toEqual(before.pendingPanels.map(panel => panel.id === target.id ? { ...panel, caption } : panel));
    expect(posts).toBe(1);
    await expect(card(page).locator('script')).toHaveCount(0);
  });

  test('MP-QA-queue: selected reject/undo, polling removal, approve-all, focus and replay', async ({ page, request }) => {
    const before = await prepare(request);
    const target = before.pendingPanels[2]!;
    await page.goto('/studio');
    await selector(page, 3).click();
    await expect(card(page)).toHaveAttribute('data-panel-id', target.id);
    // Removing an earlier panel must not change the selected identity on polling.
    const removed = await (await request.post('/api/reject', { data: { panelId: before.pendingPanels[0]!.id } })).json();
    await expect(queue(page).getByRole('group').getByRole('button')).toHaveCount(3);
    await expect(card(page)).toHaveAttribute('data-panel-id', target.id);
    await edit(page).click();
    await editor(page).fill('Keep this draft bound to panel 3');
    await request.post('/api/reject', { data: { panelId: target.id } });
    await expect(page.getByRole('alert')).toContainText('This panel is no longer waiting for review.');
    await expect(editor(page)).toHaveValue('Keep this draft bound to panel 3');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(edit(page)).toBeFocused();
    const fallback = before.pendingPanels[1]!;
    await expect(card(page)).toHaveAttribute('data-panel-id', fallback.id);
    // Arrival/reorder via undo preserves the current selection, rather than its index.
    await request.post('/api/undo', { data: { token: removed.undoToken } });
    await expect(queue(page).getByRole('group').getByRole('button')).toHaveCount(3);
    await expect(card(page)).toHaveAttribute('data-panel-id', fallback.id);
    await selector(page, 3).click();
    const last = before.pendingPanels[3]!;
    await expect(card(page)).toHaveAttribute('data-panel-id', last.id);
    await page.keyboard.press('r');
    await expect(card(page)).toHaveAttribute('data-panel-id', before.pendingPanels[0]!.id);
    expect((await state(request)).pendingPanels.map(panel => panel.id)).toEqual([before.pendingPanels[0]!.id, fallback.id]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(selector(page, 3)).toBeVisible();
    expect((await state(request)).pendingPanels.at(-1)!.id).toBe(last.id);
    await selector(page, 3).click();
    await page.keyboard.press('a');
    await expect(card(page)).toHaveCount(0);
    expect((await state(request)).panels.map(panel => panel.id)).toEqual([before.pendingPanels[0]!.id, fallback.id, last.id]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(selector(page, 3)).toBeVisible();
    await selector(page, 3).click();
    await edit(page).click();
    await editor(page).fill('Do not move this draft onto the next replay');
    // External publish empties the queue while editing; closing has a stable fallback.
    const approved = await (await request.post('/api/approve', { data: { all: true } })).json();
    await expect(page.getByRole('alert')).toContainText('This panel is no longer waiting for review.');
    await page.keyboard.press('Escape');
    await expect(queue(page)).toBeFocused();
    await request.post('/api/undo', { data: { token: approved.undoToken } });
    await expect(selector(page, 3)).toBeVisible();
    await selector(page, 3).click();
    await edit(page).click();
    await editor(page).fill('Old replay draft');
    await request.post('/api/replay', { data: { fixtureId: 'speedrun-fail', speed: 1 } });
    await expect(page.getByRole('alert')).toContainText('This panel is no longer waiting for review.');
    await expect(editor(page)).toHaveValue('Old replay draft');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(edit(page)).toBeFocused();
    await expect(card(page)).toHaveAttribute('data-panel-id', 'speedrun-fail-panel-0');
  });

  test('MP-QA-resize: four panel controls and art remain usable at 390 and desktop, with axe review', async ({ page, request }) => {
    const before = await prepare(request);
    await page.goto('/studio');
    const results: Record<string, unknown> = {};
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      for (const number of [2, 3, 4]) {
        await selector(page, number).click();
        await expect(card(page)).toHaveAttribute('data-panel-id', before.pendingPanels[number - 1]!.id);
        await expect(card(page).locator('img')).toBeVisible();
        await expect(card(page).locator('img')).toHaveAttribute('src', before.pendingPanels[number - 1]!.storyBeats?.[0]?.imageUrl ?? before.pendingPanels[number - 1]!.imageUrl);
        await expect(edit(page)).toBeVisible();
        await expect(queue(page).getByRole('button', { name: 'Reject panel', exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      const controls = await queue(page).getByRole('group').getByRole('button').evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, height: rect.height };
      }));
      expect(controls).toHaveLength(4);
      expect(controls.every(rect => rect.left >= 0 && rect.right <= viewport.width && rect.height >= 44)).toBeTruthy();
      await queue(page).scrollIntoViewIfNeeded();
      await capture(page, { path: `${evidence}/resize-${viewport.width}.jpg` });
      const axe = await new AxeBuilder({ page }).analyze();
      results[String(viewport.width)] = axe.violations;
      expect(axe.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([]);
      await edit(page).click();
      await expect(editor(page)).toHaveValue(before.pendingPanels[3]!.caption);
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await page.keyboard.press('Escape');
      await expect(edit(page)).toBeFocused();
    }
    await writeFile(`${evidence}/axe-results.json`, JSON.stringify(results, null, 2));
  });
});
