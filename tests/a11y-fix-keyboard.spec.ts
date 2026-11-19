import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// A11Y-fix keyboard checks on the rebuilt UI (ui.html), driven by the Sample replay (sample data only).
type State = { panels: { id: string }[]; pendingPanels: { id: string }[] };
const state = async (request: APIRequestContext): Promise<State> => (await request.get('/api/state')).json();
const focusedTag = (page: Page) => page.evaluate(() => {
  const active = document.activeElement;
  return !active || active === document.body ? 'BODY' : `${active.tagName}:${active.textContent?.trim().slice(0, 40)}`;
});

async function openStudio(page: Page, request: APIRequestContext) {
  await request.post('/api/stop');
  await request.post('/api/settings', { data: { approvalMode: true } });
  await request.post('/api/replay', { data: { fixtureId: 'tabletop-night', speed: 60 } });
  await page.goto('/ui.html#/studio');
  await expect(page.locator('.ct-desk__acts .ct-btn--ink')).toBeVisible({ timeout: 30_000 });
}

test('#1 page-wide A approves from body and app bar, but typing, dialogs, modifiers and repeat never approve', async ({ page, request }) => {
  await openStudio(page, request);
  await expect.poll(async () => (await state(request)).pendingPanels.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const first = (await state(request)).pendingPanels[0]!.id;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => focusedTag(page)).toBe('BODY');
  await page.keyboard.press('a');
  await expect.poll(async () => (await state(request)).panels.map(panel => panel.id)).toContain(first);

  const second = (await state(request)).pendingPanels[0]!.id;
  const end = page.locator('.ct-appbar').getByRole('button', { name: 'End stream', exact: true });
  await end.focus();
  await expect(end).toBeFocused();
  await page.keyboard.press('a');
  await expect.poll(async () => (await state(request)).panels.map(panel => panel.id)).toContain(second);

  const waiting = (await state(request)).pendingPanels[0]!.id;
  const approved = (await state(request)).panels.map(panel => panel.id);
  const noApproval = async () => {
    await page.waitForTimeout(800);
    const current = await state(request);
    expect(current.panels.map(panel => panel.id)).toEqual(approved);
    expect(current.pendingPanels.map(panel => panel.id)).toContain(waiting);
  };
  for (const key of ['Control+a', 'Alt+a', 'Meta+a', 'Shift+a']) await page.keyboard.press(key);
  await page.locator('body').dispatchEvent('keydown', { key: 'a', repeat: true, bubbles: true });
  await noApproval();

  await page.locator('.ct-desk').getByRole('button', { name: /Edit caption/ }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit caption', exact: true });
  await expect(editDialog).toBeVisible();
  const caption = editDialog.getByRole('textbox', { name: 'Caption', exact: true });
  await caption.fill('Typing here: ');
  await caption.press('a');
  await expect(caption).toHaveValue('Typing here: a');
  await noApproval();
  await editDialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('a');
  await noApproval();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await end.click();
  const endDialog = page.getByRole('dialog', { name: 'End the stream?', exact: true });
  await expect(endDialog).toBeVisible();
  await endDialog.getByRole('heading', { name: 'End the stream?', exact: true }).evaluate(element => { (element as HTMLElement).tabIndex = -1; (element as HTMLElement).focus(); });
  await page.keyboard.press('a');
  await noApproval();
  await page.keyboard.press('Escape');
});

test('#3 closing a dialog gives focus back to the control that opened it', async ({ page, request }) => {
  await openStudio(page, request);
  const edit = page.locator('.ct-desk').getByRole('button', { name: /Edit caption/ });
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Edit caption' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(edit).toBeFocused();

  const end = page.getByRole('button', { name: 'End stream…', exact: true });
  await end.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(end).toBeFocused();
});

test('#2 approving from the grid keeps focus on a control, not the page', async ({ page, request }) => {
  await openStudio(page, request);
  const approve = page.locator('.ct-grid .ct-cell__acts .ct-btn--ink').first();
  await expect(approve).toBeVisible();
  await approve.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  expect(await focusedTag(page)).not.toBe('BODY');
});

test('#5 #6 book: arrows in the Look picker stay there; Next at the end hands focus to Back', async ({ page }) => {
  await page.goto('/ui.html#/book/sample-tabletop-night');
  const where = page.locator('.ct-book__where');
  await expect(where).toHaveText('Cover');
  const look = page.getByRole('radiogroup').first().getByRole('radio', { checked: true });
  await look.focus();
  await page.keyboard.press('ArrowRight');
  await expect(where).toHaveText('Cover');
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.focus();
  for (let turn = 0; turn < 40 && await next.isEnabled(); turn++) await page.keyboard.press('Enter');
  await expect(next).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
});

test('KEYS1 grid focus: A approves the second waiting cell and leaves the first waiting', async ({ page, request }) => {
  await openStudio(page, request);
  await expect.poll(async () => (await state(request)).pendingPanels.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const before = await state(request);
  const first = before.pendingPanels[0]!.id;
  const second = before.pendingPanels[1]!.id;
  const approve = page.locator('.ct-cell[data-status="Waiting"]').nth(1).getByRole('button', { name: 'Approve', exact: true });
  await approve.focus();
  await expect(approve).toBeFocused();
  await page.keyboard.press('a');
  await expect.poll(async () => (await state(request)).panels.map(panel => panel.id)).toContain(second);
  const after = await state(request);
  expect(after.pendingPanels.map(panel => panel.id)).toContain(first);
  expect(after.panels.map(panel => panel.id)).not.toContain(first);
});

test('KEYS1 grid focus: R rejects the second waiting cell and leaves the first waiting', async ({ page, request }) => {
  await openStudio(page, request);
  await expect.poll(async () => (await state(request)).pendingPanels.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const before = await state(request);
  const first = before.pendingPanels[0]!.id;
  const second = before.pendingPanels[1]!.id;
  const approve = page.locator('.ct-cell[data-status="Waiting"]').nth(1).getByRole('button', { name: 'Approve', exact: true });
  await approve.focus();
  await expect(approve).toBeFocused();
  await page.keyboard.press('r');
  await expect.poll(async () => (await state(request)).pendingPanels.map(panel => panel.id)).not.toContain(second);
  const after = await state(request);
  expect(after.pendingPanels.map(panel => panel.id)).toContain(first);
  expect(after.panels.map(panel => panel.id)).not.toContain(second);
  expect(after.panels.map(panel => panel.id)).toEqual(before.panels.map(panel => panel.id));
});

test('KEYS1 grid focus: E edits the second waiting cell rather than the first', async ({ page, request }) => {
  await openStudio(page, request);
  await expect.poll(async () => (await state(request)).pendingPanels.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const second = (await state(request)).pendingPanels[1]!.id;
  const caption = 'KEYS1 second waiting panel edit target';
  expect((await request.post('/api/caption', { data: { panelId: second, caption } })).ok()).toBe(true);
  const cell = page.locator('.ct-cell[data-status="Waiting"]').nth(1);
  await expect(cell).toContainText(caption);
  const approve = cell.getByRole('button', { name: 'Approve', exact: true });
  await approve.focus();
  await expect(approve).toBeFocused();
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog', { name: 'Edit caption', exact: true });
  await expect(dialog).toBeVisible();
  try {
    await expect(dialog.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(caption);
  } finally {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('KEYS1 shortcut switch: defaults on, disables A, and persists across reloads', async ({ page, request }) => {
  await openStudio(page, request);
  const shortcuts = page.getByRole('switch', { name: 'Keyboard shortcuts', exact: true });
  await expect(shortcuts).toBeChecked();
  await shortcuts.focus();
  await shortcuts.press('Space');
  await expect(shortcuts).not.toBeChecked();
  await page.reload();
  await expect(shortcuts).not.toBeChecked();
  await expect(page.locator('.ct-desk__acts .ct-btn--ink')).toBeVisible();
  const before = await state(request);
  const first = before.pendingPanels[0]!.id;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => focusedTag(page)).toBe('BODY');
  await page.keyboard.press('a');
  await page.waitForTimeout(800);
  const disabled = await state(request);
  expect(disabled.panels.map(panel => panel.id)).toEqual(before.panels.map(panel => panel.id));
  expect(disabled.pendingPanels.map(panel => panel.id)).toContain(first);
  await shortcuts.focus();
  await shortcuts.press('Space');
  await expect(shortcuts).toBeChecked();
  await page.reload();
  await expect(shortcuts).toBeChecked();
  await expect(page.locator('.ct-desk__acts .ct-btn--ink')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => focusedTag(page)).toBe('BODY');
  await page.keyboard.press('a');
  await expect.poll(async () => (await state(request)).panels.map(panel => panel.id)).toContain(first);
});
