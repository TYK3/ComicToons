import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { LibraryEntry } from '../apps/server/src/pipeline/library.ts';
const manifest = JSON.parse(readFileSync(new URL('../fixtures/art/generated/manifest.json', import.meta.url), 'utf8')) as LibraryEntry[];
import { assertLettering } from './lettering';
import { capture } from './screenshot';
import { renderExport } from '../apps/server/src/export.ts';
import type { StudioState } from '../apps/server/src/studio.ts';
import type { LetteringMap } from '../packages/core/src/index.ts';

const dialogue = 'Well, that escalated. Everyone held their breath—and then the whole crew cheered together! A comeback worth remembering.';
const rtlDialogue = 'مرحباً بالأصدقاء! هذه لحظة رائعة نريد أن نتذكرها جميعاً. 🎉🧑🏽‍🚀🌈';
const makeState = (start: number): StudioState => ({
  status: 'ended', fixtureId: 'tabletop-night', speed: 60, style: 'risograph', approvalMode: true,
  streamTitle: 'The whole crew, in ink', issueTitle: 'Every face deserves its moment', elapsed: 900, duration: 1440,
  pendingPanels: [], panels: manifest.slice(start, start + 3).map((entry, index) => ({
    id: `lettering-${start + index}`, caption: entry.sceneSummary, dialogue: [dialogue, rtlDialogue], sfx: 'WHOOSH!',
    scene: entry.sceneSummary, characters: entry.characters, mood: entry.mood, altText: entry.sceneSummary,
    imageUrl: `/art/generated/${entry.file}`, at: start * 60 + index * 60,
    lettering: entry.lettering as LetteringMap,
    provenance: { provider: 'library', asset: entry.file, style: entry.style, fallback: false },
  })),
});

for (const width of [390, 1440, 1920]) for (const view of ['studio', 'overlay', 'recap', 'standalone', 'share']) {
  test(`protected art: all 16 assets, ${view}, ${width}px, full RTL and emoji dialogue`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    let state = makeState(0);
    await page.route('**/api/state', route => route.fulfill({ json: state }));
    await page.route('**/api/recaps/lettering', route => route.fulfill({ json: state }));
    await mkdir('artifacts/ui-after/lettering', { recursive: true });
    const seen = new Set<string>();
    for (let start = 0; start < manifest.length; start += 3) {
      state = makeState(start);
      if (view === 'standalone' || view === 'share') {
        const { html, shareHtml } = await renderExport(state);
        await page.setContent(view === 'standalone' ? html : shareHtml);
      } else {
        await page.goto(view === 'studio' ? '/dashboard' : view === 'overlay' ? '/overlay' : '/r/lettering');
      }
      await page.locator('[data-lettering-placement]').first().waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.querySelectorAll<HTMLImageElement>('.panel-art img, .art img')).map(img => img.decode()));
      });
      for (const text of [dialogue, rtlDialogue]) {
        const bubbles = page.locator('[data-lettering-kind="dialogue"]').filter({ hasText: text });
        expect(await bubbles.count()).toBeGreaterThan(0);
        for (const bubble of await bubbles.all()) await expect(bubble).toHaveText(text);
      }
      (await assertLettering(page)).forEach(asset => seen.add(asset));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      if (start === 0 && width !== 1920) await capture(page, { path: `artifacts/ui-after/lettering/${view}-${width}.jpg` });

    }
    expect([...seen].sort()).toEqual(manifest.map(entry => entry.file).sort());
    await writeFile(`artifacts/ui-after/lettering/${view}-${width}-results.json`, JSON.stringify({ width, view, assets: [...seen], dialogue: 'full English + RTL + emoji', violations: [] }, null, 2));
  });
}

test('face protection guard rejects a bubble deliberately moved onto a protected face', async ({ page }) => {
  const state = makeState(0);
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto('/dashboard');
  await page.locator('.speech-bubble').first().waitFor();
  await page.locator('.comic-panel').first().evaluate((panel, face) => {
    const bounds = panel.querySelector('.panel-art')!.getBoundingClientRect();
    const bubble = panel.querySelector<HTMLElement>('.speech-bubble')!;
    Object.assign(bubble.style, {
      position: 'fixed', left: `${bounds.left + face.x / 100 * bounds.width}px`,
      top: `${bounds.top + face.y / 100 * bounds.height}px`, width: '70px', height: '70px', overflow: 'hidden',
    });
  }, manifest[0]!.lettering.faceBox);
  await expect(assertLettering(page)).rejects.toThrow(/overlaps manifest face\/subject/);
});
