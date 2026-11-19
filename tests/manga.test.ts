import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMangaPages, buildIssue, fixtures } from '../packages/core/src/index.ts';
import { Studio } from '../apps/server/src/studio.ts';
import { renderExport } from '../apps/server/src/export.ts';

test('MS-PAGES: three-to-six-panel pages preserve every approved source without duplicates or invented fillers', () => {
  for (let count = 0; count <= 20; count++) {
    const source = Array.from({length: count}, (_, index) => ({id: `p-${index}`, caption: `Context ${index}`, at: index}));
    const before = JSON.stringify(source);
    const pages = buildMangaPages(source);
    assert.equal(JSON.stringify(source), before);
    assert.deepEqual(pages.flatMap(page => page.panels.map(item => item.panel.id)), source.map(panel => panel.id));
    for (const page of pages) {
      assert.ok(page.panels.length >= (count < 3 ? count : 3) && page.panels.length <= 6);
      assert.equal(page.panels.filter(item => item.hero).length, 1);

      assert.deepEqual(page.panels.map(item => item.order), page.panels.map((_, index) => index + 1));
    }
  }
});

test('MS-PEAK: emotional peak stays after setup in a stable chronological story', () => {
  const source = [
    {id: 'setup', caption: 'A quiet beginning', at: 0},
    {id: 'tension', caption: 'A boss approaches', at: 20},
    {id: 'peak', caption: 'The clutch comeback lands', mood: 'triumphant', sfx: 'POW!', at: 40},
    {id: 'ending', caption: 'The crew celebrates', at: 60},
  ];
  const page = buildMangaPages(source)[0]!;
  assert.equal(page.heroId, 'peak');
  assert.deepEqual(page.panels.map(item => item.panel.id), ['setup', 'tension', 'peak', 'ending']);
  assert.ok(page.summary.length <= 34 && !page.summary.includes('\n'));
  assert.equal(buildMangaPages(source.slice(0, 1))[0]!.heroId, 'setup');
});

test('MS-EXPORT: standalone and PNG documents share the hero, sequence and exact approved panel count', async () => {
  const studio = new Studio();
  studio.state.panels = buildIssue(fixtures[0]!).panels;
  const expected = buildMangaPages(studio.state.panels)[0]!;
  const {html, shareHtml} = await renderExport(studio.state);
  for (const document of [html, shareHtml]) {
    assert.ok(document.includes(`data-hero-id="${expected.heroId}"`));
    assert.equal((document.match(/class="comic-panel panel"/g) ?? []).length, 4);
    assert.equal((document.match(/<div class="manga-cell"[^>]*data-hero="true"/g) ?? []).length, 1);
    assert.ok(document.includes('Sample Data') && document.includes(expected.summary));
    assert.ok(!/data-lettering-kind/.test(document.match(/<div class="art panel-art">[\s\S]*?<\/div>/)?.[0] ?? ''));
    const sourceIds = [...document.matchAll(/data-source-id="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(sourceIds, expected.panels.map(item => item.panel.id));
  }
});
