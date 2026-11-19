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
// r3: a theme may grade with its own grade wash (Festival's teal grade); otherwise the grade is its wash.
const gradeStops = (palette: { wash: { start: string; mid: string; end: string }; grade: unknown }) => (palette.grade as { wash?: { start: string; mid: string; end: string } }).wash ?? palette.wash;
const wash = (id: string) => { const { start, mid, end } = gradeStops(mangaThemes.find((theme) => theme.id === id)!.palette); return `linear-gradient(145deg,${start} 0%,${mid} 50%,${end} 100%)`; };

// M2: colour art is graded by the theme's own wash, as a soft-light layer at about 35%.
test('R2-GRADE-CSS: every theme, festival included, grades colour art with its own wash at 35% soft-light', () => {
  for (const theme of mangaThemes) {
    const grade = (theme.palette as unknown as { grade?: object }).grade;
    const { blend, opacity } = (grade ?? {}) as { blend?: string; opacity?: number };
    assert.deepEqual({ blend, opacity }, { blend: 'soft-light', opacity: 0.35 }, `${theme.id} palette.grade`);
    const rule = new RegExp(`\\.ct-art\\[data-look=${theme.id}\\]:not\\(\\[data-tone=grey\\]\\)::after(?:,[^{]*)?\\{([^}]*)\\}`).exec(lookStyles);
    assert.ok(rule, `${theme.id} has a colour grade layer`);
    const body = rule[1]!;
    assert.ok(body.includes(`background:${wash(theme.id)}`), `${theme.id} grade uses its own wash`);
    assert.match(body, /mix-blend-mode:soft-light/, `${theme.id} grade blend`);
    assert.match(body, /opacity:0?\.35\b/, `${theme.id} grade opacity`);
    assert.match(body, /position:absolute/); assert.match(body, /inset:0/); assert.match(body, /pointer-events:none/);
    assert.notEqual(theme.palette.tint, null, `${theme.id} has a tint (no tint:null)`);
    const { start, mid, end } = theme.palette.tint ?? { start: '', mid: '', end: '' };
    assert.ok(new Set([start, mid, end]).size === 3 && ![start, mid, end].includes('#ffffff'), `${theme.id} tint is a real three-stop gradient, not flat white`);
    assert.ok(new RegExp(`\\.ct-art\\[data-look=${theme.id}\\](?:,[^{]*)?\\{background:linear-gradient\\(145deg,${start} 0%,${mid} 50%,${end} 100%\\)\\}`).test(lookStyles), `${theme.id} paper is its tint`);
  }
  // The colour filter is one recipe for all four, so the wash is what tells them apart.
  const filters = mangaThemes.map((theme) => new RegExp(`\\.ct-art\\[data-look=${theme.id}\\]>img(?:,[^{]*)?\\{filter:([^}]*)\\}`).exec(lookStyles)?.[1]);
  assert.equal(new Set(filters).size, 1, 'one colour filter for all themes');
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

test('R2-GRADE-EXPORT: the PNG export grades colour art with the same wash layer, and paints a tint for festival too', () => {
  for (const theme of mangaThemes) {
    const recipe = RECIPE[theme.id];
    assert.equal(typeof recipe.grade, 'function', `${theme.id} recipe has a grade step`);
    const ctx = fakeContext();
    recipe.grade!(ctx as unknown as CanvasRenderingContext2D, 100, 80, 'colour');
    const { start, mid, end } = gradeStops(theme.palette);
    const gradient = ctx.ops.find((op) => op[0] === 'gradient')?.[1];
    assert.deepEqual(gradient, [[0, start], [0.5, mid], [1, end]], `${theme.id} grade gradient is the wash`);
    assert.ok(ctx.ops.some((op) => op[0] === 'gco' && op[1] === 'soft-light'), `${theme.id} soft-light`);
    assert.ok(ctx.ops.some((op) => op[0] === 'alpha' && op[1] === 0.35), `${theme.id} 35%`);
    assert.ok(ctx.ops.some((op) => op[0] === 'fillRect'), `${theme.id} grade is painted`);
    const grey = fakeContext();
    recipe.grade!(grey as unknown as CanvasRenderingContext2D, 100, 80, 'grey');
    assert.equal(grey.ops.length, 0, `${theme.id} grey art keeps its wash only`);
    const paper = fakeContext();
    recipe.paper(paper as unknown as CanvasRenderingContext2D, 100, 80, 'colour');
    assert.ok(paper.ops.some((op) => op[0] === 'gradient'), `${theme.id} colour paper is a tint gradient, not flat white`);
    assert.doesNotMatch(recipe.filter('colour'), /sepia|hue-rotate/, `${theme.id} colour filter is the shared one`);
  }
  assert.match(read('apps/web/src/ui/export.ts'), /recipe\.grade\(lctx,/, 'drawArt runs the grade step');
});

test('R2-BALLOON: balloon text keeps 4.5:1 or better on its fill in every theme', () => {
  for (const theme of mangaThemes) assert.ok(contrast(theme.palette.balloon.text, theme.palette.balloon.fill) >= 4.5, theme.id);
  // The grade layer sits inside .ct-art only; balloons and captions are its siblings, so it never covers them.
  assert.match(read('apps/web/src/ui/components/Panel.tsx'), /<LookArt[^>]*\/>\s*\{lettering && panel\.caption/);
});

// Verdict item 4: the exported recap HTML draws SFX as fill over a stroke and a hard shadow.
test('R2-SFX-CONTRAST: SFX fill vs its stroke and shadow is at least 4.5:1 in the exported recap, every theme', () => {
  const low: string[] = [];
  for (const theme of mangaThemes) {
    const rule = new RegExp(`\\[data-manga-theme=${theme.id}\\] \\.story-sfx\\{color:(#[0-9a-f]{6});-webkit-text-stroke-color:(#[0-9a-f]{6});text-shadow:1px 2px (#[0-9a-f]{6})\\}`).exec(mangaThemeStyles);
    assert.ok(rule, `${theme.id} story-sfx rule`);
    const [, fill, stroke, shadow] = rule;
    for (const [name, other] of [['stroke', stroke!], ['shadow', shadow!]] as const) if (contrast(fill!, other) < 4.5) low.push(`${theme.id} recap sfx fill/${name} ${contrast(fill!, other).toFixed(2)}`);
  }
  assert.deepEqual(low, [], 'exported recap SFX pairs under 4.5:1');
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
  assert.match(picker, /linear-gradient\(90deg,\$\{a1\},\$\{a2\},\$\{a3\}\)/, 'bar uses the three accent stops');
  const css = strip(read('apps/web/src/ui/styles/lookpicker.css'));
  assert.match(css, /\.ct-look__bar\{[^}]*height:6px/);
  assert.doesNotMatch(css, /radial-gradient/);
});
