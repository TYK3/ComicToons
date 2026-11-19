import {expect,test} from './app-fixture';
import {type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { LibraryEntry } from '../apps/server/src/pipeline/library.ts';
import type { StudioState } from '../apps/server/src/studio.ts';
import { renderExport } from '../apps/server/src/export.ts';
import { buildMangaPages } from '../packages/core/src/index.ts';
import { assertLettering } from './lettering';

const evidence = 'artifacts/manga-summary';
const manifest = JSON.parse(readFileSync(new URL('../fixtures/art/generated/manifest.json', import.meta.url), 'utf8')) as LibraryEntry[];
function sample(count: number): StudioState {
  return {status: 'ended', fixtureId: 'tabletop-night', speed: 60, style: 'risograph', approvalMode: true,
    streamTitle: 'The crew makes a comeback', issueTitle: 'A moment worth keeping', elapsed: 1440, duration: 1440, pendingPanels: [],
    panels: manifest.slice(0, count).map((entry, index) => ({id: `manga-${index}`, at: index * 60,
      caption: index === 2 ? 'The clutch comeback lands.' : `Quiet context ${index + 1}.`,
      dialogue: [`A sample line for panel ${index + 1}.`], scene: entry.sceneSummary, characters: entry.characters,
      mood: index === 2 ? 'triumphant' : 'calm', sfx: index === 2 ? 'POW!' : 'HUSH', imageUrl: `/art/generated/${entry.file}`,
      altText: entry.sceneSummary, lettering: entry.lettering, provenance: {provider: 'library', asset: entry.file, style: entry.style, fallback: false}}))};
}
async function loaded(page: Page) {
  await page.locator('.manga-page').first().waitFor();
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.querySelectorAll<HTMLImageElement>('.panel-art img')].map(image => image.decode())); });
}
async function signature(page: Page) {
  return page.locator('.manga-page').first().evaluate(root => ({
    hero: root.getAttribute('data-hero-id'), summary: root.querySelector('.manga-summary')?.textContent,
    ids: [...root.querySelectorAll('.manga-cell')].map(cell => cell.getAttribute('data-source-id')),
    assets: [...root.querySelectorAll('.comic-panel')].map(panel => panel.getAttribute('data-story-frame') ?? panel.getAttribute('data-asset')),
  }));
}
async function geometry(page: Page, count: number) {
  await loaded(page);
  const root = page.locator('.manga-page').first();
  await expect(root.locator('.manga-cell')).toHaveCount(count);
  await expect(root.locator('[data-hero="true"]')).toHaveCount(1);
  await expect(root.locator('.manga-sample')).toContainText('Sample Data');
  const cells = await root.locator('.manga-cell').evaluateAll(nodes => nodes.map(node => {
    const bounds = node.getBoundingClientRect();
    const art = node.querySelector('.panel-art')!.getBoundingClientRect();
    return {order: Number(node.getAttribute('data-reading-order')), left: bounds.left, top: bounds.top, area: art.width * art.height};
  }));
  expect(cells.map(cell => cell.order)).toEqual(Array.from({length: count}, (_, index) => index + 1));
  expect(cells.every(cell => cell.area > 0)).toBe(true);
  for (let index = 1; index < cells.length; index++) {
    const prior = cells[index - 1]!, next = cells[index]!;
    expect(next.top + 1 >= prior.top).toBe(true);
    if (Math.abs(next.top - prior.top) < 1) expect(next.left > prior.left).toBe(true);
  }
  const summary = await root.locator('.manga-summary').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return {lines: range.getClientRects().length, fits: node.scrollWidth <= node.clientWidth};
  });
  expect(summary.lines).toBe(0); // Editorial banners are removed from the manga page.
  expect(await root.locator('p').evaluateAll(nodes => nodes.every(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 14)), 'Manga body text stays at least 14px').toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertLettering(page);
  return signature(page);
}
async function screenshot(page: Page, name: string) {
  const pixels = await page.screenshot({type: 'jpeg', quality: 65, fullPage: true, animations: 'disabled'});
  const encoded = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/jpeg;base64,${base64}`; await image.decode();
    const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .65).split(',')[1]!;
  }, pixels.toString('base64'));
  await writeFile(`${evidence}/${name}.jpg`, Buffer.from(encoded, 'base64'));
}

for (const count of [3, 4, 5, 6]) test(`MS-${count}: chronological panels and protected legacy art match all three surfaces for ${count} panels`, async ({ page }) => {
  await mkdir(evidence, {recursive: true});
  const state = sample(count);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.route('**/api/state', route => route.fulfill({json: state}));
  await page.route('**/api/recaps/manga-preview', route => route.fulfill({json: state}));
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/overlay');
  const expected = await geometry(page, count);
  expect(expected.hero).toBe('manga-2');
  const onAir = await page.locator('.manga-page').boundingBox();
  expect(onAir!.y).toBeGreaterThanOrEqual(0);
  expect(onAir!.height).toBeGreaterThan(0); // Legacy art retains expanding text; new story fit has separate coverage.
  await page.setViewportSize({width: 1280, height: 1000});
  await page.goto('/recap/manga-preview');
  expect(await geometry(page, count)).toEqual(expected);
  const documents = await renderExport(state);
  for (const html of [documents.html, documents.shareHtml]) {
    await page.setContent(html);
    expect(await geometry(page, count)).toEqual(expected);
  }
  expect(errors).toEqual([]);
  await writeFile(`${evidence}/ms-${count}-consistency.json`, JSON.stringify({count, expected, errors}, null, 2));
});

test('MS-MOBILE: narrow pages keep full RTL/emoji dialogue, SFX and captions outside every protected face', async ({ page }) => {
  const state = sample(6);
  for (const panel of state.panels) panel.dialogue = ['Everyone gets a full line. '.repeat(5), 'مرحبا بالأصدقاء! 🎉🧑🏽‍🚀🌈'];
  await page.setViewportSize({width: 390, height: 844});
  await page.route('**/api/state', route => route.fulfill({json: state}));
  await page.route('**/api/recaps/manga-preview', route => route.fulfill({json: state}));
  for (const url of ['/studio', '/overlay', '/recap/manga-preview']) {
    await page.goto(url); await loaded(page); await assertLettering(page);
    await expect(page.locator('.manga-cell')).toHaveCount(6);
    const cells = await page.locator('.manga-cell').evaluateAll(nodes => nodes.map(node => ({width: node.getBoundingClientRect().width, top: node.getBoundingClientRect().top})));
    expect(cells.every(cell => cell.width > 0 && cell.width <= 390)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const {shareHtml} = await renderExport(state);
  await page.setContent(shareHtml); await loaded(page); await assertLettering(page);
  const findings = (await new AxeBuilder({page}).analyze()).violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
  expect(findings).toEqual([]);
  await mkdir(evidence, {recursive: true});
  await writeFile(`${evidence}/mobile-axe.json`, JSON.stringify(findings, null, 2));
});

test('MS-LIVE-EXPORT: real approval, recap alias, standalone and PNG carry the same complete manga page', async ({ page, request }) => {
  await mkdir(evidence, {recursive: true});
  await request.post('/api/stop');
  await request.post('/api/settings', {data: {approvalMode: true}});
  expect((await request.post('/api/replay', {data: {fixtureId: 'tabletop-night', speed: 60, style: 'noir'}})).ok()).toBe(true);
  await expect.poll(async () => (await (await request.get('/api/state')).json()).status, {timeout: 30_000}).toBe('ready');
  expect((await request.post('/api/approve', { data: { all: true } })).ok()).toBe(true);
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/overlay');
  const shotCount = buildMangaPages((await (await request.get('/api/state')).json()).panels)[0]!.panels.length;
  const expected = await geometry(page, shotCount);
  await screenshot(page, 'overlay-1920');
  const response = await request.post('/api/end');
  expect(response.ok(), await response.text()).toBe(true);
  const links = await response.json();
  const id = links.recapUrl.split('/').at(-1)!;
  await page.setViewportSize({width: 1280, height: 1000});
  await page.goto(`/recap/${id}`);
  expect(await geometry(page, shotCount)).toEqual(expected);
  await screenshot(page, 'recap-1280');
  const html = await request.get(`/exports/${id}/index.html`);
  expect(html.ok()).toBe(true);
  await page.setContent(await html.text());
  expect(await geometry(page, shotCount)).toEqual(expected);
  const png = await (await request.get(links.shareUrl)).body();
  expect(links.pageUrls).toHaveLength(buildMangaPages((await (await request.get('/api/state')).json()).panels).length);
  for (const [index,url] of (links.pageUrls as string[]).entries()) {
    expect(url).toMatch(new RegExp(`/page-${index + 1}\\.png$`));
    const pagePng = await request.get(url);
    expect(pagePng.ok()).toBe(true);
    expect(pagePng.headers()['content-type']).toContain('image/png');
    expect((await pagePng.body()).length).toBeGreaterThan(50_000);
  }
  expect(png.length).toBeGreaterThan(50_000);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(1080);
  const saved = await (await request.get(`/api/recaps/${id}`)).json();
  const {shareHtml} = await renderExport(saved);
  await page.setViewportSize({width: 1080, height: 1350});
  await page.setContent(shareHtml); await loaded(page);
  expect(await geometry(page, shotCount)).toEqual(expected);
  const fullHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
  expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(fullHeight);
  await writeFile(`${evidence}/share.png`, png);
  await writeFile(`${evidence}/real-export.json`, JSON.stringify({expected, bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), fullHeight}, null, 2));
});
