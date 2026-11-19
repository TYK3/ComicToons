import { mkdirSync } from 'node:fs';
import { expect, test, type Request } from '@playwright/test';

// IMPORT-1-WIRE: a streamer pastes a clip link in the Studio, gets a 1-4 panel comic and adds it to their manga series.
// Twitch is the fake in tests/import-wire/serve.ts; the art network is off; nothing may leave loopback.
const CHANNEL = 'importwirefake';
const CLIP_URL = 'https://clips.twitch.tv/ImportWireClip-1';
const SHOTS = process.env.IMPORT_WIRE_SHOTS;
const THUMB_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOosDkBRAwQCgAoXgXxPgnaUgAAAABJRU5ErkJggg==', 'base64');
const apiURL = `http://127.0.0.1:${process.env.COMICTOONS_E2E_API_PORT ?? '4302'}`;
const loopback = (url: string) => { const { protocol, hostname } = new URL(url); return protocol === 'data:' || protocol === 'blob:' || hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'; };

for (const width of [1280, 390]) {
  test(`paste a clip link, get a 1-4 panel comic, add it to the series, all on loopback (${width}px)`, async ({ page, request }) => {
    const seen: string[] = [];
    // The clip thumbnail is on Twitch's CDN (the only form clip-url-1's allow-list keeps); answer it here so the browser
    // never dials out. Answered requests are listed apart from real traffic.
    const cdn: string[] = [];
    await page.route('https://static-cdn.jtvnw.net/**', route => { cdn.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'image/png', body: THUMB_PNG }); });
    page.on('request', (req: Request) => { if (!req.url().startsWith('https://static-cdn.jtvnw.net/')) seen.push(req.url()); });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    // Each width starts from an empty series for the fake channel.
    const before = await request.get(`${apiURL}/api/channel-series/${CHANNEL}`);
    const startChapters = before.ok() ? ((await before.json()) as { series?: { chapters?: unknown[] }; chapters?: unknown[] }) : {};
    const already = (startChapters.series?.chapters ?? startChapters.chapters ?? []).length;

    await page.goto('/#/studio');
    const card = page.locator('section[aria-labelledby="ct-import-title"]');
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole('heading', { name: 'Make a comic from a link' })).toBeVisible();
    await expect(card).toContainText('A video longer than 10 min is cut to its first 10 min, and the result says so.');
    await card.getByLabel('Twitch VOD, clip or channel link').fill(CLIP_URL);
    // A made-up chat log (test handles only), so the panels carry chat bubbles.
    await card.getByLabel('Chat log (optional, .txt or .json)').setInputFiles({ name: 'test-chat.txt', mimeType: 'text/plain',
      buffer: Buffer.from('[00:00:01] comictoons_test<1>: what a fight\n[00:00:03] comictoons_test<2>: he actually did it\n[00:00:05] comictoons_test<3>: clip that\n') });
    // IMPORT-UI-1: the chat log picker and Make comic sit on one row, bottoms aligned.
    const pick = await card.locator('.ct-import-chat input[type=file]').boundingBox(), go = await card.getByRole('button', { name: 'Make comic' }).boundingBox();
    if (width === 1280) expect(Math.abs(pick!.y + pick!.height - (go!.y + go!.height)), 'picker and button bottoms line up').toBeLessThanOrEqual(2);
    await card.getByRole('button', { name: 'Make comic' }).click();

    const panels = card.locator('.ct-import-panels > li');
    await expect(card.locator('.ct-import-preview')).toHaveAttribute('data-import-kind', 'clip');
    const count = await panels.count();
    expect(count, 'one clip makes 1-4 panels').toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(4);
    await expect(card.getByRole('status').first()).toHaveText(`${count} panel${count === 1 ? '' : 's'}.`);
    await expect(panels.first()).toContainText('The boss fight finally lands');
    await expect(panels.first().locator('img')).toHaveJSProperty('complete', true);
    // IMPORT-UI-1: a real manga panel, big enough to read; every word outside the art (Young: no text box covers a face).
    const art = panels.first().locator('figure.ct-import-art img');
    await expect(art).toBeVisible();
    expect(await art.evaluate(img => (img as HTMLImageElement).naturalWidth), 'the panel art actually loaded').toBeGreaterThan(0);
    const artBox = (await art.boundingBox())!;
    expect(artBox.width, 'panel art at least 300 px wide').toBeGreaterThanOrEqual(300);
    await expect(panels.first().locator('.ct-import-rail .ct-bubble').first()).toBeVisible();
    for (const lettering of await card.locator('.ct-import-panel [data-lettering-kind]').all()) {
      const box = (await lettering.boundingBox())!;
      const panelArt = (await lettering.locator('xpath=ancestor::li[1]//figure//img').boundingBox())!;
      const overlaps = box.x < panelArt.x + panelArt.width && panelArt.x < box.x + box.width && box.y < panelArt.y + panelArt.height && panelArt.y < box.y + box.height;
      expect(overlaps, `lettering "${await lettering.textContent()}" stays off the art`).toBe(false);
    }
    // The card lines up with the studio's panel grid (the same main column), at both widths.
    const cardBox = (await card.boundingBox())!, gridBox = (await page.locator('.ct-grid-wrap').boundingBox())!;
    expect(Math.abs(cardBox.x - gridBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(cardBox.x + cardBox.width - (gridBox.x + gridBox.width))).toBeLessThanOrEqual(1);
    // C2 (verdict-import-1-wire.md): no sideways scroll at 390 with the import card and its result shown.
    if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth), 'document scrollWidth at a 390 viewport').toBe(390);
    // Open in reader: the panels at reading size, still lettered outside the art; closes back to the card.
    await card.getByRole('button', { name: 'Open in reader' }).click();
    const reader = page.getByRole('dialog', { name: /panel/ });
    await expect(reader).toBeVisible();
    const readerArt = (await reader.locator('figure.ct-import-art img').first().boundingBox())!;
    expect(readerArt.width).toBeGreaterThanOrEqual(300);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/import-ui-1-reader-${width}.png` });
    await reader.getByRole('button', { name: 'Close reader' }).click();
    await expect(reader).toBeHidden();
    // Repo rule (tests/a11y-fix-keyboard.spec.ts #3): closing a dialog gives focus back to the control that opened it.
    await expect(card.getByRole('button', { name: 'Open in reader' })).toBeFocused();
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await card.screenshot({ path: `${SHOTS}/import-1-wire-${width}-preview.png` }); }

    await card.getByLabel('Chapter title').fill(`Boss fight (${width})`);
    await card.getByRole('button', { name: `Add to #${CHANNEL}’s manga series` }).click();
    await expect(card).toContainText(`Added as chapter ${already + 1}: Boss fight (${width}).`);
    if (SHOTS) { await card.screenshot({ path: `${SHOTS}/import-1-wire-${width}-added.png` }); await page.screenshot({ path: `${SHOTS}/import-1-wire-${width}-page.png`, fullPage: true }); }

    const series = await (await request.get(`${apiURL}/api/channel-series/${CHANNEL}`)).json() as { series?: { chapters: { number: number; title: string }[] }; chapters?: { number: number; title: string }[] };
    const chapters = series.series?.chapters ?? series.chapters ?? [];
    expect(chapters.at(-1)).toMatchObject({ number: already + 1, title: `Boss fight (${width})` });

    const egress = await (await request.get(`${apiURL}/__import-wire/egress`)).json() as { refused: number; attempts: string[]; helixCalls: string[] };
    expect(egress.attempts, 'server: 0 non-loopback dials').toEqual([]);
    expect(egress.refused).toBe(0);
    expect(egress.helixCalls, 'the clip was read from the fake Helix').toContain('GET /helix/clips');
    expect(seen.filter(url => !loopback(url)), 'browser: 0 non-loopback requests').toEqual([]);
    expect(cdn.some(url => url.includes('/ImportWireClip-1/')), 'the panel art is the fake clip thumbnail').toBe(true);
  });
}
