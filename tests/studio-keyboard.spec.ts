import {capture} from './screenshot';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let step = 0; step < 90; step++) {
    if (await target.evaluate(node => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Control not reachable by keyboard: ${await target.textContent()}`);
}

test('keyboard-only studio: edit, reject/undo, approve, live controls, hide, and export', async ({ page, request }) => {
  await mkdir('artifacts/ui-after/states', { recursive: true });
  await request.post('/api/stop');
  await page.goto('/dashboard');
  const state = async () => (await request.get('/api/state')).json();
  await tabTo(page, page.getByRole('button', { name: '1×', exact: true }));
  await page.keyboard.press('Enter');
  const start = page.getByRole('button', { name: 'Start replay', exact: true });
  await tabTo(page, start);
  await capture(page,{ path: 'artifacts/ui-after/states/keyboard-focus.png', fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('approval-queue').locator('.queue-card').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Edit caption/ }).first()).toBeEnabled();
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name: 'Edit caption' })).toBeVisible();
  const caption = page.getByRole('textbox', { name: 'Caption', exact: true });
  await tabTo(page, caption);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('A keyboard-edited adventure begins.');
  await capture(page,{ path: 'artifacts/ui-after/states/edit-dialog.png', fullPage: true, animations: 'disabled' });
  await tabTo(page, page.getByRole('button', { name: 'Save changes', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Edit caption/ }).first()).toBeFocused();
  await expect.poll(async () => (await state()).pendingPanels[0]?.caption).toBe('A keyboard-edited adventure begins.');

  const pendingBefore = (await state()).pendingPanels.length;
  await page.keyboard.press('r');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeVisible();
  await expect.poll(async () => (await state()).pendingPanels.length).toBe(pendingBefore - 1);
  await capture(page,{ path: 'artifacts/ui-after/states/reject-undo-toast.png', fullPage: true, animations: 'disabled' });
  await tabTo(page, undo);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state()).pendingPanels.length).toBe(pendingBefore);
  await expect(page.getByRole('button', { name: /Approve strip/ }).first()).toBeEnabled();
  await page.keyboard.press('a');
  await expect.poll(async () => (await state()).panels.length).toBeGreaterThan(0);

  for (const speed of [10, 1, 60]) {
    await tabTo(page, page.getByRole('button', { name: `${speed}×`, exact: true }));
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await state()).speed).toBe(speed);
    expect((await state()).panels.length).toBeGreaterThan(0);
  }
  const approval = page.getByRole('switch', { name: 'Approval required' });
  await tabTo(page, approval);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await state()).approvalMode).toBe(false);
  await expect(approval).toBeEnabled();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await state()).approvalMode).toBe(true);

  await tabTo(page, page.getByRole('button', { name: /Hide overlay/ }));
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state()).panels.length).toBe(0);
  await tabTo(page, page.getByRole('button', { name: 'Start replay', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('approval-queue').locator('.queue-card').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Approve strip/ }).first()).toBeEnabled();
  await page.keyboard.press('a');
  await expect.poll(async () => (await state()).panels.length).toBeGreaterThan(0);
  await tabTo(page, page.getByRole('button', { name: /End stream/ }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/recap\/[a-z0-9-]+$/, { timeout: 35_000 });
  await expect(page.getByRole('link', { name: /Download.*share|Download.*card/i }).first()).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Your recap issue is ready to share.');
});
