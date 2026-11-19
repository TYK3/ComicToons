import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// IMPORT-UI-1 r1 (verdict-import-ui-1.md): no sideways scroll after an import, with the longest channel name Twitch
// allows (25 characters), and the reader takes focus, keeps Tab inside and closes on Escape back to its opener.
const CLIP_URL = 'https://clips.twitch.tv/ImportWireClip-1';
const LONG_CHANNEL = 'importwirefake_25chars_xy';
const SHOTS = process.env.IMPORT_UI_R1_SHOTS;
const THUMB_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOosDkBRAwQCgAoXgXxPgnaUgAAAABJRU5ErkJggg==', 'base64');

/** Makes a comic from the fake clip; the import answer's channel is swapped for a 25-character one. */
async function importClip(page: Page, width: number) {
  expect(LONG_CHANNEL).toHaveLength(25);
  await page.route('https://static-cdn.jtvnw.net/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: THUMB_PNG }));
  await page.route('**/api/import', async route => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    // Three panels, so the card's auto-fill panel grid (minmax(min(100%,320px),1fr)) is in play; one panel uses its own rule.
    const panels = (body.panels as { id: string }[] | undefined) ?? [];
    const three = panels.length ? [0, 1, 2].map(i => ({ ...panels[i % panels.length], id: `${panels[i % panels.length].id}-r1-${i}` })) : panels;
    await route.fulfill({ response, json: { ...body, channel: LONG_CHANNEL, panels: three } });
  });
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/#/studio');
  const card = page.locator('section[aria-labelledby="ct-import-title"]');
  await card.scrollIntoViewIfNeeded();
  await card.getByLabel('Twitch VOD, clip or channel link').fill(CLIP_URL);
  // A made-up chat log (test handles only), so the panels carry chat bubbles.
  await card.getByLabel('Chat log (optional, .txt or .json)').setInputFiles({ name: 'test-chat.txt', mimeType: 'text/plain',
    buffer: Buffer.from('[00:00:01] comictoons_test<1>: what a fight\n[00:00:03] comictoons_test<2>: he actually did it\n[00:00:05] comictoons_test<3>: clip that\n') });
  await card.getByRole('button', { name: 'Make comic' }).click();
  await expect(card.locator('.ct-import-panels > li').first()).toBeVisible();
  await expect(card.locator('.ct-import-panels > li img').first()).toHaveJSProperty('complete', true);
  return card;
}

for (const width of [320, 360, 390, 1280]) {
  test(`IMPORT-UI-1 r1: after an import with a 25-character channel, nothing is wider than its row or the page (${width}px)`, async ({ page }) => {
    const card = await importClip(page, width);
    const add = card.getByRole('button', { name: new RegExp(`^Add to #${LONG_CHANNEL}`) });
    await expect(add).toBeVisible();
    await page.mouse.move(1, 1); // no hover lift (.ct-btn:hover translates by 2 px) while measuring
    await expect.poll(() => card.locator('.ct-import-row > *').evaluateAll(els => els.map(e => getComputedStyle(e).transform).filter(t => t !== 'none'))).toEqual([]);
    // Every button and field in the card's rows stays inside its row (and the row inside the card).
    const offenders = await card.locator('.ct-import-row').evaluateAll(rows => rows.flatMap(row => {
      const r = row.getBoundingClientRect(), c = row.closest('.ct-card__body')!.getBoundingClientRect();
      const out = r.right > c.right + 0.5 ? [`row R${r.right.toFixed(1)} > card body R${c.right.toFixed(1)}`] : [];
      for (const item of Array.from(row.children)) {
        const b = item.getBoundingClientRect();
        if (b.left < r.left - 0.5 || b.right > r.right + 0.5) out.push(`${item.tagName.toLowerCase()}.${item.className} "${(item.textContent ?? '').trim().slice(0, 12)}…" L${b.left.toFixed(1)} R${b.right.toFixed(1)} outside row L${r.left.toFixed(1)} R${r.right.toFixed(1)}`);
      }
      return out;
    }));
    expect(offenders, 'items outside their row').toEqual([]);
    // The text box and the chapter title fill their fields (the input width rule).
    for (const field of [card.getByLabel('Twitch VOD, clip or channel link'), card.getByLabel('Chapter title')]) {
      const box = (await field.boundingBox())!, label = (await field.locator('xpath=ancestor::label[1]').boundingBox())!;
      expect(Math.abs(box.width - label.width), 'field fills its label').toBeLessThanOrEqual(1);
    }
    // Panels stay inside the panel grid (minmax(min(100%,320px),1fr)).
    const grid = (await card.locator('.ct-import-preview .ct-import-panels').boundingBox())!;
    for (const panel of await card.locator('.ct-import-preview .ct-import-panel').all()) {
      const box = (await panel.boundingBox())!;
      expect(box.x + box.width, 'panel inside the grid').toBeLessThanOrEqual(grid.x + grid.width + 0.5);
    }
    // The card keeps its words in the rail under the art (placeImportBubbles rail:true).
    const zones = await card.locator('.ct-import-preview .ct-bubble').evaluateAll(els => els.map(e => e.getAttribute('data-zone')));
    expect(zones.length, 'the chat log gives the panels bubbles').toBeGreaterThan(0);
    expect(zones.every(zone => zone === 'rail'), 'every card bubble sits in the rail').toBe(true);
    expect(await card.locator('.ct-import-preview .ct-import-panel').count(), 'three panels in the grid').toBe(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `document scrollWidth at a ${width} viewport`).toBe(width);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await card.screenshot({ path: `${SHOTS}/r1-${width}-after-import.png` }); }
  });
}

for (const how of ['click', 'Enter'] as const) {
  test(`IMPORT-UI-1 r1: the reader takes focus, traps Tab, and Escape closes it back to the opener (${how})`, async ({ page }) => {
    const card = await importClip(page, 1280);
    const open = card.getByRole('button', { name: 'Open in reader' });
    if (how === 'click') await open.click(); else { await open.focus(); await page.keyboard.press('Enter'); }
    const reader = page.getByRole('dialog', { name: /panel/ });
    await expect(reader).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Close reader' }), 'focus starts on Close').toBeFocused();
    const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog][aria-modal=true]'));
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await inDialog(), `Tab ${i + 1} stays in the reader`).toBe(true); }
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); expect(await inDialog(), `Shift+Tab ${i + 1} stays in the reader`).toBe(true); }
    if (SHOTS && how === 'click') { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/r1-1280-reader-open.png` }); }
    await page.keyboard.press('Escape');
    await expect(reader, 'Escape closes the reader').toBeHidden();
    await expect(open, 'focus is back on the opener').toBeFocused();
  });
}
