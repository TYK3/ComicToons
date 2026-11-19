import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../packages/core/src/index.ts';
import * as exported from '../apps/web/src/ui/export.ts';

// CRIT-NICE: critique-themes4.md N1 (picker tag) and N3 (SFX fill vs its own wash).
const { lookStyles, mangaThemes, mangaThemeStyles } = core;
const SFX_COLOURS = (exported as Record<string, unknown>).SFX_COLOURS as Record<string, { fill: string; stroke: string }>;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => { const [r, g, b] = rgb(hex); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const distance = (a: string, b: string) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

// CRIT-NICE r2 N3: the fill must stand off every stop of its own wash by 1.5:1, the end stop included. With an ink
// stroke that is impossible for Sunset and Lagoon (a fill dark enough for 1.5:1 on the light end stop is under
// 4.5:1 on ink), so those two letter a deep fill over a light stroke, like Festival's classic recap SFX.
// Live .ct-sfx and the PNG stroke in --ink (#0b0b0c); the HTML recap strokes in the palette ink. `sfxStroke` overrides both.
const LIVE_INK = '#0b0b0c';
const sfxStrokeOf = (theme: (typeof mangaThemes)[number]) => (theme.palette as { sfxStroke?: string }).sfxStroke;
test('N1-PICKER-TAG: the picker cards drop the clipped, uninformative "Colour" tag', () => {
  const picker = read('apps/web/src/ui/components/LookPicker.tsx');
  const css = strip(read('apps/web/src/ui/styles/lookpicker.css'));
  assert.doesNotMatch(picker, /ct-look__tone/, 'no tone tag span');
  assert.doesNotMatch(picker, />\s*Colour\s*</, 'no visible "Colour" text');
  assert.doesNotMatch(css, /\.ct-look__tone/, 'no tone tag rule');
  assert.match(picker, /<span className="ct-look__name">\{look\.short\}<\/span>/, 'the name row is the short name only');
  // s6-srv-adapter.spec.ts finds the radios by `^${look.name},`, so the accessible name keeps that start.
  assert.match(picker, /aria-label=\{`\$\{look\.name\}, /, 'accessible name still starts with the Look name and a comma');
  assert.match(css, /\.ct-look__name\{[^}]*min-width:0/, 'the name row may shrink inside the card');
  assert.match(css, /\.ct-look__name\{[^}]*text-overflow:ellipsis/, 'a long name ends in an ellipsis instead of spilling into the next card');
});

test('N3-SFX-DISTINCT: each SFX fill is distinct from every stop of its own wash, and still 4.5:1 on its strokes', () => {
  const fills = new Set<string>();
  for (const theme of mangaThemes) {
    const { sfx, wash, ink, grade } = theme.palette;
    // r2: Sunset and Lagoon letter over their own light stroke (N3-SFX-1.5 below); the others over ink.
    const recapStroke = sfxStrokeOf(theme) ?? ink;
    fills.add(sfx);
    // The plain wash (grey art) and, where a theme has one, its own colour-art grade wash.
    const stops = [wash.start, wash.mid, wash.end, ...(grade.wash ? [grade.wash.start, grade.wash.mid, grade.wash.end] : [])];
    for (const stop of stops) {
      assert.notEqual(sfx.toLowerCase(), stop.toLowerCase(), `${theme.id} sfx is not a wash stop`);
      assert.ok(distance(sfx, stop) >= 90, `${theme.id} sfx ${sfx} vs wash ${stop}: RGB distance ${distance(sfx, stop).toFixed(0)} >= 90`);
    }
    assert.ok(contrast(sfx, wash.mid) >= 1.25, `${theme.id} sfx vs wash mid ${contrast(sfx, wash.mid).toFixed(2)}:1 >= 1.25 (was 1.00)`);
    assert.ok(contrast(sfx, recapStroke) >= 4.5, `${theme.id} sfx on the recap stroke ${contrast(sfx, recapStroke).toFixed(2)}`);
    assert.equal(SFX_COLOURS[theme.id]!.fill, sfx, `${theme.id} PNG export uses the same fill`);
    assert.ok(contrast(sfx, SFX_COLOURS[theme.id]!.stroke) >= 4.5, `${theme.id} PNG sfx on its stroke`);
    assert.ok(lookStyles.includes(`.ct-panel[data-look=${theme.id}] .ct-sfx`) && new RegExp(`\\.ct-panel\\[data-look=${theme.id}\\] \\.ct-sfx(?:,[^{]*)?\\{color:${sfx}[;}]`).test(lookStyles), `${theme.id} live .ct-sfx colour`);
    // Festival's HTML recap keeps its classic rules (#a52b48 on paper, 6.41:1); the other three use the palette fill.
    if (theme.id === 'festival') assert.ok(mangaThemeStyles.includes('[data-manga-theme=festival] .story-sfx{color:#a52b48;'), 'festival recap keeps its classic SFX');
    else assert.ok(mangaThemeStyles.includes(`[data-manga-theme=${theme.id}] .story-sfx{color:${sfx};`), `${theme.id} recap .story-sfx colour`);
  }
  assert.equal(fills.size, mangaThemes.length, 'each theme keeps its own SFX fill');
});

test('N3-SFX-1.5: Sunset and Lagoon SFX fills are 1.5:1 or better on every wash stop and 4.5:1 or better on their stroke, live, recap and PNG', () => {
  for (const id of ['sunset', 'lagoon']) {
    const theme = mangaThemes.find(entry => entry.id === id)!;
    const { sfx, wash, grade } = theme.palette;
    const stroke = sfxStrokeOf(theme);
    for (const [name, stop] of Object.entries({ ...wash, ...(grade.wash ? { gradeStart: grade.wash.start, gradeMid: grade.wash.mid, gradeEnd: grade.wash.end } : {}) })) {
      assert.ok(contrast(sfx, stop) >= 1.5, `${id} sfx ${sfx} vs wash ${name} ${stop}: ${contrast(sfx, stop).toFixed(2)}:1 >= 1.5`);
    }
    assert.ok(stroke, `${id} has its own SFX stroke`);
    assert.ok(contrast(sfx, stroke!) >= 4.5, `${id} sfx on its stroke ${stroke}: ${contrast(sfx, stroke!).toFixed(2)}:1 >= 4.5`);
    assert.deepEqual(SFX_COLOURS[id], { fill: sfx, stroke }, `${id} PNG export letters the same fill over the same stroke`);
    assert.ok(lookStyles.includes(`.ct-panel[data-look=${id}] .ct-sfx{color:${sfx};-webkit-text-stroke-color:${stroke};text-shadow:3px 3px 0 ${stroke}}`), `${id} live .ct-sfx fill, stroke and shadow`);
    assert.ok(mangaThemeStyles.includes(`[data-manga-theme=${id}] .story-sfx{color:${sfx};-webkit-text-stroke-color:${stroke};text-shadow:1px 2px ${stroke}}`), `${id} recap .story-sfx fill, stroke and shadow`);
  }
});

test('N3-SFX-1.5: Festival and Blossom keep their r1 SFX fill over the ink stroke', () => {
  for (const id of ['festival', 'blossom']) {
    const theme = mangaThemes.find(entry => entry.id === id)!;
    assert.equal(sfxStrokeOf(theme), undefined, `${id} keeps the ink strokes`);
    assert.deepEqual(SFX_COLOURS[id], { fill: theme.palette.sfx, stroke: LIVE_INK }, `${id} PNG export unchanged`);
    assert.ok(lookStyles.includes(`.ct-panel[data-look=${id}] .ct-sfx`) && !new RegExp(`\\.ct-panel\\[data-look=${id}\\] \\.ct-sfx(?:,[^{]*)?\\{[^}]*text-stroke`).test(lookStyles), `${id} live stroke stays the base --ink`);
  }
  assert.equal(mangaThemes.find(entry => entry.id === 'festival')!.palette.sfx, '#d6faff');
  assert.equal(mangaThemes.find(entry => entry.id === 'blossom')!.palette.sfx, '#f7f2ff');
});
