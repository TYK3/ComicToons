import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../packages/core/src/index.ts';
import * as exported from '../apps/web/src/ui/export.ts';

// THEMES-4 r3 (the lead's ruling on REQUEST 2): Festival grades colour art with a cooler wash built on its teal
// #1da2b3, so it is no longer the closest pair (r2: Festival and Sunset were both warm). The other three keep
// grading with their own wash, and every grade stays soft-light at 35%.
const { lookStyles, mangaThemes } = core;
type Stops = { start: string; mid: string; end: string };
type Palette = { wash: Stops; accent: readonly string[]; grade: { blend: string; opacity: number; wash?: Stops } };
const RECIPE = exported.RECIPE as unknown as Record<string, { grade: (...args: unknown[]) => void }>;
const theme = (id: string) => mangaThemes.find((t) => t.id === id)!;
const palette = (id: string) => theme(id).palette as unknown as Palette;
const gradeOf = (id: string) => palette(id).grade.wash ?? palette(id).wash;
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255); };
const stops = (s: Stops) => [s.start, s.mid, s.end].map(rgb);

// W3C soft-light, then the 35% layer over the base.
const d = (b: number) => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));
const softLight = (b: number, s: number) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d(b) - b));
const levels = [0.15, 0.5, 0.85];
const cube = levels.flatMap((r) => levels.flatMap((g) => levels.map((b) => [r, g, b])));
// Mean RGB distance (0-255) of a fixed colour cube graded by two themes' grade stops: a pixel-free stand-in for
// the same-art screenshot measure in shots-themes4-r3/.
function gradedDistance(a: string, b: string): number {
  const [sa, sb] = [stops(gradeOf(a)), stops(gradeOf(b))];
  let total = 0; let n = 0;
  for (let i = 0; i < 3; i += 1) for (const base of cube) {
    const pa = base.map((v, c) => v * 0.65 + softLight(v, sa[i][c]) * 0.35);
    const pb = base.map((v, c) => v * 0.65 + softLight(v, sb[i][c]) * 0.35);
    total += Math.hypot(...pa.map((v, c) => (v - pb[c]) * 255)); n += 1;
  }
  return total / n;
}

test('R3-FESTIVAL-GRADE: Festival grades colour art with a cool wash that starts on its teal #1da2b3', () => {
  const festival = palette('festival');
  assert.ok(festival.grade.wash, 'festival has its own grade wash');
  assert.equal(festival.grade.wash!.start, '#1da2b3');
  assert.equal(festival.grade.wash!.start, festival.accent[0], 'starts on the festival teal accent');
  const mean = (s: Stops) => stops(s).reduce((acc, c) => acc.map((v, i) => v + c[i] / 3), [0, 0, 0]);
  const [r, , b] = mean(festival.grade.wash!);
  assert.ok(b > r, `festival grade leans cool (mean blue ${b.toFixed(2)} > red ${r.toFixed(2)})`);
  // Fix round: the first r3 try kept an amber end stop and was still the closest pair in the live same-art shot,
  // so every stop must be cool, not just the mean.
  for (const [i, [sr, , sb]] of stops(festival.grade.wash!).entries()) assert.ok(sb > sr, `festival grade stop ${i} is cool (blue > red)`);
  for (const id of ['sunset', 'lagoon', 'blossom']) assert.equal(palette(id).grade.wash, undefined, `${id} keeps grading with its own wash`);
  for (const t of mangaThemes) {
    const grade = (t.palette as unknown as Palette).grade;
    assert.equal(grade.blend, 'soft-light', `${t.id} soft-light`);
    assert.equal(grade.opacity, 0.35, `${t.id} 35%, not 50%`);
  }
});

test('R3-GRADE-CSS-EXPORT: the live ::after layer and the PNG export both paint the Festival teal grade', () => {
  const g = gradeOf('festival');
  assert.equal(g.start, '#1da2b3', 'festival grade is the teal grade, not the warm wash');
  const gradient = `linear-gradient(145deg,${g.start} 0%,${g.mid} 50%,${g.end} 100%)`;
  const rule = new RegExp(`\\.ct-art\\[data-look=festival\\]:not\\(\\[data-tone=grey\\]\\)::after(?:,[^{]*)?\\{([^}]*)\\}`).exec(lookStyles);
  assert.ok(rule, 'festival grade rule');
  assert.ok(rule![1].includes(`background:${gradient}`), 'festival ::after uses the teal grade');
  const wash = palette('festival').wash;
  assert.ok(new RegExp(`\\.ct-art\\[data-look=festival\\]\\[data-tone=grey\\](?:,[^{]*)?\\{background:linear-gradient\\(145deg,${wash.start} 0%,${wash.mid} 50%,${wash.end} 100%\\)\\}`).test(lookStyles), 'grey art keeps the festival wash');
  const ops: unknown[][] = [];
  const ctx = {
    save() {}, restore() {}, fillRect() { ops.push(['fill']); },
    set filter(_v: string) {}, set globalCompositeOperation(_v: string) {}, set globalAlpha(_v: number) {}, set fillStyle(_v: unknown) {},
    createLinearGradient() { const s: unknown[] = []; ops.push(['gradient', s]); return { addColorStop: (o: number, c: string) => s.push([o, c]) }; },
  };
  RECIPE.festival.grade(ctx as unknown as CanvasRenderingContext2D, 100, 80, 'colour');
  assert.deepEqual(ops.find((op) => op[0] === 'gradient')?.[1], [[0, g.start], [0.5, g.mid], [1, g.end]], 'export grade is the teal grade');
});

test('R3-DISTINCT: graded with each theme\'s grade, Festival is not in the closest pair', () => {
  const ids = mangaThemes.map((t) => t.id);
  const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ pair: `${a}-${b}`, distance: gradedDistance(a, b) })));
  pairs.sort((x, y) => x.distance - y.distance);
  const table = pairs.map((p) => `${p.pair} ${p.distance.toFixed(1)}`).join(', ');
  assert.ok(!pairs[0].pair.includes('festival'), `closest pair ${pairs[0].pair} (${table})`);
});
