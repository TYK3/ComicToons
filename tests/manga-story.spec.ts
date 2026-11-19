import {expect, test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {buildIssue, fixtures, buildMangaPages} from '../packages/core/src/index.ts';
import {illustrateIssue} from '../apps/server/src/pipeline/library.ts';
import type {StudioState} from '../apps/server/src/studio.ts';
import {renderExport} from '../apps/server/src/export.ts';
import {assertLettering} from './lettering';
import {capture} from './screenshot';
import {assertMangaRows} from './manga-rows';

const evidence = 'artifacts/manga-story';
function sample(id: string): StudioState {
  const fixture = fixtures.find(item => item.id === id)!;
  return {status:'ended', fixtureId:id, speed:60, style:'noir', approvalMode:true,
    streamTitle:fixture.streamTitle, issueTitle:fixture.streamTitle, elapsed:1440, duration:1440, pendingPanels:[],
    panels:illustrateIssue(buildIssue(fixture), 'noir').panels};
}

for (const id of ['tabletop-night','speedrun-fail','irl-cooking']) test(`STORY-${id}: connected scenes, in-art chat and dialogue, readable mobile and complete export`, async ({page}) => {
  const state = sample(id);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/state', route => route.fulfill({json:state}));
  await page.route('**/api/recaps/story', route => route.fulfill({json:state}));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1920,height:1080});
  await page.goto('/overlay');
  await expect(page.locator('.story-panel')).toHaveCount(6);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
  await assertLettering(page);
  expect(await page.locator('.story-panel').evaluateAll(panels => panels.map(panel => Number(panel.getAttribute('data-story-frame'))))).toEqual([0,1,2,3,4,5]);
  await expect(page.locator('.lettering-rail, .art-provenance, .panel-meta')).toHaveCount(0);
  const bounds = await page.locator('.manga-page').boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1080);
  await mkdir(evidence,{recursive:true});
  await capture(page,{path:`${evidence}/${id}-page.jpg`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.goto('/recap/story');
  await expect(page.locator('.story-panel')).toHaveCount(6);
  await page.evaluate(async () => Promise.all([...document.images].map(image => image.decode())));
  await assertLettering(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const violations = (await new AxeBuilder({page}).analyze()).violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
  expect(violations).toEqual([]);
  await capture(page,{path:`${evidence}/${id}-mobile.jpg`,fullPage:true});
  const documents = await renderExport(state);
  for (const html of [documents.html, documents.shareHtml]) {
    await page.setContent(html);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
    await expect(page.locator('.story-panel')).toHaveCount(6);
    await assertLettering(page);
    expect(await page.locator('.panel-art img').evaluateAll(images => images.every(image => image.getAttribute('src')?.startsWith('data:image/png;base64,')))).toBe(true);
  }
  expect(errors).toEqual([]);
  await writeFile(`${evidence}/${id}.json`,JSON.stringify({frames:6,chronology:[0,1,2,3,4,5],violations,errors},null,2));
});

test('STORY-CONTINUATION: long selected comments continue onto real pages, never large caption cards', async ({page}) => {
  const state = sample('tabletop-night');
  const line = 'One more try! 👩🏽‍🚀 مرحبا بالأصدقاء! '.repeat(12);
  state.panels[0]!.dialogue = [line];
  const pages = buildMangaPages(state.panels);
  expect(pages.length).toBeGreaterThan(1);
  const {shareHtml} = await renderExport(state);
  await page.setViewportSize({width:1080,height:1350});
  await page.setContent(shareHtml);
  await page.evaluate(async () => {await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode()));});
  await expect(page.locator('.manga-page')).toHaveCount(pages.length);
  await expect(page.locator('.lettering-rail')).toHaveCount(0);
  await assertLettering(page);
  const continuation = page.locator('.story-panel[data-story-frame="0"] .story-balloon');
  expect((await continuation.allTextContents()).join('')).toBe(line);
  const rows = await assertMangaRows(page);
  const png = await page.screenshot({fullPage:true});
  await mkdir(evidence,{recursive:true});
  await writeFile(`${evidence}/continuation.png`,png);
  await writeFile(`${evidence}/continuation-rows.json`,JSON.stringify(rows,null,2));
});
