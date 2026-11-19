import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../packages/core/src/index.ts';
import * as exported from '../apps/web/src/ui/export.ts';
import { initialState } from '../apps/web/src/types.ts';

// Namespace imports, so a missing export fails its own test instead of the whole file.
const { lookStyles, mangaThemes, mangaThemeStyles } = core;
const RECIPE = exported.RECIPE as unknown as Record<string, { filter: (tone: 'grey' | 'colour') => string; paper: (...args: unknown[]) => void; grade?: (...args: unknown[]) => void }>;
const SFX_COLOURS = (exported as Record<string, unknown>).SFX_COLOURS as Record<string, { fill: string; stroke: string }> | undefined;
const gridColumnsModule = () => import('../apps/web/src/ui/gridColumns.ts' as string) as Promise<{ gridColumns: (n: number) => number }>;

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
function channel(value: number): number { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function rgb(hex: string): [number, number, number] { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function luminance(hex: string): number { const [r, g, b] = rgb(hex); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
function contrast(a: string, b: string): number { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); }
// Current design: palettes style page furniture and paper; artwork is a painted variant and is never filtered or graded.
test('R2-ART-UNGRADED: every theme leaves its art unfiltered and ungraded, on its own palette paper', () => {
  for (const theme of mangaThemes) {
    assert.ok(lookStyles.includes(`.ct-art[data-look=${theme.id}]{background:${theme.palette.paper}}`), `${theme.id} art sits on its palette paper`);
    assert.ok(lookStyles.includes(`.ct-art[data-look=${theme.id}]>img{filter:none;mix-blend-mode:normal}`), `${theme.id} art image is neither filtered nor blended`);
    assert.ok(lookStyles.includes(`.ct-art[data-look=${theme.id}]::after{content:none}`), `${theme.id} has no colour grade layer`);
    assert.ok(mangaThemeStyles.includes(`.manga-pages[data-manga-theme=${theme.id}] .panel-art::after{content:none}`), `${theme.id} recap pages have no grade layer`);
  }
  const filters = mangaThemes.map((theme) => new RegExp(`\\.ct-art\\[data-look=${theme.id}\\]>img\\{filter:([^;}]*)`).exec(lookStyles)?.[1]);
  assert.deepEqual([...new Set(filters)], ['none'], 'no theme filters its art');
});

type Op = [string, ...unknown[]];
function fakeContext() {
  const ops: Op[] = [];
  const ctx = {
    ops,
    set fillStyle(value: unknown) { ops.push(['fillStyle', value]); },
    set globalCompositeOperation(value: unknown) { ops.push(['gco', value]); },
    set globalAlpha(value: unknown) { ops.push(['alpha', value]); },
    fillRect: (...args: unknown[]) => ops.push(['fillRect', ...args]),
    save: () => ops.push(['save']), restore: () => ops.push(['restore']),
    createLinearGradient: () => { const stops: [number, string][] = []; ops.push(['gradient', stops]); return { addColorStop: (at: number, colour: string) => stops.push([at, colour]) }; },
  };
  return ctx;
}

test('R2-EXPORT-UNGRADED: the PNG export paints the palette paper and never grades or filters the art', () => {
  for (const theme of mangaThemes) {
    const recipe = RECIPE[theme.id];
    assert.equal(recipe.filter('colour'), 'none', `${theme.id} colour art is not filtered`);
    assert.equal(recipe.filter('grey'), 'none', `${theme.id} grey art is not filtered`);
    for (const tone of ['colour', 'grey'] as const) {
      const graded = fakeContext();
      recipe.grade!(graded as unknown as CanvasRenderingContext2D, 100, 80, tone);
      assert.equal(graded.ops.length, 0, `${theme.id} ${tone} art is not graded`);
    }
    const paper = fakeContext();
    recipe.paper(paper as unknown as CanvasRenderingContext2D, 100, 80, 'colour');
    assert.deepEqual(paper.ops.filter((op) => op[0] === 'fillStyle' || op[0] === 'fillRect'), [['fillStyle', theme.palette.paper], ['fillRect', 0, 0, 100, 80]], `${theme.id} paper is the flat palette paper`);
  }
});

test('R2-BALLOON: balloon text keeps 4.5:1 or better on its fill in every theme', () => {
  for (const theme of mangaThemes) assert.ok(contrast(theme.palette.balloon.text, theme.palette.balloon.fill) >= 4.5, theme.id);
  // Lettering is drawn by Panel next to the art (never filtered), so a balloon always sits on its own fill.
  assert.match(read('apps/web/src/ui/components/Panel.tsx'), /<LookArt[^>]*\/>\{pocket && scene\.dialogue\[0\] && <p className=\{`ct-bubble/);
});

// Verdict item 4: SFX letters as fill over a stroke; the live panel and the PNG export both need 4.5:1.
test('R2-SFX-CONTRAST: SFX fill vs its stroke is at least 4.5:1 in the live panel and the PNG export, every theme', () => {
  const low: string[] = [];
  for (const theme of mangaThemes) {
    const rule = new RegExp(`\\.ct-panel\\[data-look=${theme.id}\\] \\.ct-sfx\\{color:(#[0-9a-f]{6});-webkit-text-stroke-color:(#[0-9a-f]{6})\\}`).exec(lookStyles);
    assert.ok(rule, `${theme.id} live .ct-sfx rule`);
    const [, fill, stroke] = rule;
    if (contrast(fill!, stroke!) < 4.5) low.push(`${theme.id} live sfx fill/stroke ${contrast(fill!, stroke!).toFixed(2)}`);
  }
  assert.deepEqual(low, [], 'live SFX pairs under 4.5:1');
  assert.ok(SFX_COLOURS, 'export.ts exports SFX_COLOURS');
  for (const theme of mangaThemes) assert.ok(contrast(SFX_COLOURS[theme.id]!.fill, SFX_COLOURS[theme.id]!.stroke) >= 4.5, `${theme.id} PNG sfx fill/stroke`);
});

// Verdict item 1: no "Pop ink" in the classic UI.
test('R2-POP-INK: the classic studio art-direction card and the classic landing toggle and card no longer say Pop ink', () => {
  for (const file of ['apps/web/src/components/Studio.tsx', 'apps/web/src/components/Landing.tsx']) {
    const source = read(file);
    assert.doesNotMatch(source, /pop ink/i, file);
    assert.match(source, /Festival colour/, file);
  }
});

// Verdict item 3: festival is the default in the classic state and in the pre-rendered html.
test('R2-DEFAULT: classic initial state and both html shells default to festival', () => {
  assert.equal(initialState.mangaTheme, 'festival');
  for (const file of ['apps/web/index.html', 'apps/web/ui.html']) assert.match(read(file), /<html lang="en-GB" data-look="festival">/, file);
});

// Verdict item 6: the S6-srv column rule for any count (14 panels -> 3 columns), with KEYS-1 left as it is.
test('R2-GRID: the S6-srv column rule holds for 1 to 40 panels and the Studio grid uses it, keeping KEYS-1', async () => {
  const { gridColumns } = await gridColumnsModule();
  const rule = (n: number) => n <= 4 ? n : n % 4 === 0 || n % 4 === 3 ? 4 : 3;
  for (let n = 1; n <= 40; n += 1) assert.equal(gridColumns(n), rule(n), `gridColumns(${n})`);
  assert.equal(gridColumns(14), 3);
  const css = strip(read('apps/web/src/ui/styles/studio.css'));
  const columnsFor = (cols: number) => {
    const found = [...css.matchAll(/([^{}]*)\{grid-template-columns:([^}]*)\}/g)].filter(([, selectors]) => selectors!.split(',').some((selector) => selector.trim() === `.ct-grid[data-cols="${cols}"]`)).at(-1);
    if (!found) return undefined;
    return found[2]!.startsWith('minmax(0,720px)') ? 1 : Number(/repeat\((\d+)/.exec(found[2]!)?.[1]);
  };
  for (const cols of [1, 2, 3, 4]) assert.equal(columnsFor(cols), cols, `data-cols ${cols}`);
  assert.doesNotMatch(css, /\.ct-grid\[data-count="\d+"\]\{grid-template-columns/, 'no count-by-count list left that can miss a count');
  const studio = read('apps/web/src/ui/screens/Studio.tsx');
  assert.match(studio, /<ol ref=\{grid\} className="ct-grid" data-count=\{shown\.length\} data-cols=\{gridColumns\(shown\.length\)\}/);
  assert.match(studio, /shown\.map\(\(\{ panel, status \}, index\) =>/, 'KEYS-1 index is still passed through');
});

// M2: each picker card shows its palette in a 6px three-stop bar under the live thumbnail.
test('R2-PICKER-BAR: a 6px three-stop palette bar sits under each live thumbnail', () => {
  const picker = read('apps/web/src/ui/components/LookPicker.tsx');
  assert.match(picker, /<\/span>\s*<span className="ct-look__bar"[^>]*aria-hidden="true"/, 'bar right after the thumbnail');
  assert.match(picker, /linear-gradient\(90deg,\$\{a1\} 0% 33\.33%,\$\{a2\} 33\.33% 66\.66%,\$\{a3\} 66\.66% 100%\)/, 'bar uses the three accent stops');
  const css = strip(read('apps/web/src/ui/styles/lookpicker.css'));
  assert.match(css, /\.ct-look__bar\{[^}]*height:6px/);
  assert.doesNotMatch(css, /radial-gradient/);
});
