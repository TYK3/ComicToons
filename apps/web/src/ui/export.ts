/**
 * PNG page export, drawn on a canvas in the browser from the same stills and the same Look recipe as looks.css.
 * No upload and no network: images are the bundled fixture stills already on the page.
 */
import { mangaThemes, resolveMangaTheme, type MangaThemeId } from '@comictoons/core';
import type { IssueView, LookId, PagePng, UiPanel } from './data/adapter';

const W = 1080;
const H = 1350;
const PAD = 36;
const GAP = 18;

function washGradient(ctx: CanvasRenderingContext2D, w: number, h: number, stops: { start: string; mid: string; end: string }) {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, stops.start); gradient.addColorStop(.5, stops.mid); gradient.addColorStop(1, stops.end);
  return gradient;
}

type Tone = 'grey' | 'colour';
type Paint = (ctx: CanvasRenderingContext2D, w: number, h: number, tone: Tone) => void;

/** One recipe per theme, built from the core palette (packages/core/src/theme.ts), drawn as lookStyles paints it.
 * No dots: colour art sits on the flat tint and is then graded by the theme's own wash (palette.grade, soft-light
 * at 35%); grey art sits on the flat wash. The same steps for all four themes, festival included. */
export const RECIPE: Record<MangaThemeId, { filter: (tone: Tone) => string; paper: Paint; grade: Paint }> =
  Object.fromEntries(mangaThemes.map(theme => [theme.id, {
    filter: (tone: Tone) => tone === 'grey' ? 'grayscale(1) contrast(1.15) brightness(1.06)' : 'saturate(1.25) contrast(1.06)',
    paper: (ctx: CanvasRenderingContext2D, w: number, h: number, tone: Tone) => {
      ctx.fillStyle = washGradient(ctx, w, h, tone === 'colour' ? theme.palette.tint : theme.palette.wash); ctx.fillRect(0, 0, w, h);
    },
    grade: (ctx: CanvasRenderingContext2D, w: number, h: number, tone: Tone) => {
      if (tone !== 'colour') return;
      ctx.save();
      ctx.filter = 'none'; ctx.globalCompositeOperation = theme.palette.grade.blend; ctx.globalAlpha = theme.palette.grade.opacity;
      ctx.fillStyle = washGradient(ctx, w, h, theme.palette.grade.wash ?? theme.palette.wash); ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
  }])) as Record<MangaThemeId, { filter: (tone: Tone) => string; paper: Paint; grade: Paint }>;

const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('A panel image did not load.'));
  image.src = url;
});

function cells(count: number): [number, number, number, number][] {
  const inner = W - PAD * 2;
  const top = 120;
  const usable = H - top - 90;
  if (count === 1) return [[PAD, top, inner, usable]];
  if (count === 2) { const h = (usable - GAP) / 2; return [[PAD, top, inner, h], [PAD, top + h + GAP, inner, h]]; }
  const half = (inner - GAP) / 2;
  if (count === 3) { const h = (usable - GAP) / 2; return [[PAD, top, inner, h], [PAD, top + h + GAP, half, h], [PAD + half + GAP, top + h + GAP, half, h]]; }
  const h = (usable - GAP * 2) / 3;
  return [[PAD, top, inner, h], [PAD, top + h + GAP, half, h], [PAD + half + GAP, top + h + GAP, half, h], [PAD, top + (h + GAP) * 2, inner, h]];
}

const INK = '#0b0b0c';
const PAPER = '#fbfaf5';
const DISPLAY = 'Bangers, Impact, sans-serif';
const LETTER = '"Comic Neue", "Comic Sans MS", sans-serif';
const UI = '"Space Grotesk", sans-serif';
/** SFX fill per theme, from the core palette (matches .ct-sfx in lookStyles), over its stroke and shadow: ink, or
 * the palette's light `sfxStroke` (Sunset, Lagoon), so every theme's fill clears 4.5:1 against what it sits on. */
export const SFX_COLOURS: Record<MangaThemeId, { fill: string; stroke: string }> = Object.fromEntries(mangaThemes.map(theme => [theme.id, { fill: theme.palette.sfx, stroke: theme.palette.sfxStroke ?? INK }])) as Record<MangaThemeId, { fill: string; stroke: string }>;
const clamp = (min: number, value: number, max: number) => Math.min(max, Math.max(min, value));

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max = 3) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) { const test = line ? `${line} ${word}` : word; if (ctx.measureText(test).width > width && line) { lines.push(line); line = word; } else line = test; }
  if (line) lines.push(line);
  if (lines.length > max) { lines.length = max; lines[max - 1] = `${lines[max - 1]!.replace(/\s+\S*$/, '')}…`; }
  return lines;
}

/** Fonts used on the canvas are loaded explicitly: a page that never showed Bangers or Comic Neue would otherwise draw fallbacks. */
async function ensureFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  await Promise.allSettled([`64px ${DISPLAY}`, `bold 24px ${LETTER}`, `bold 20px ${UI}`].map(font => document.fonts.load(font)));
  await document.fonts.ready;
}

/** The still in the Look: paper layer, then the image multiplied through the Look's filter (looks.css), then the colour grade. */
function drawArt(ctx: CanvasRenderingContext2D, image: HTMLImageElement, panel: UiPanel, look: MangaThemeId, x: number, y: number, w: number, h: number) {
  const recipe = RECIPE[look];
  const layer = document.createElement('canvas');
  layer.width = Math.round(w); layer.height = Math.round(h);
  const lctx = layer.getContext('2d')!;
  recipe.paper(lctx, layer.width, layer.height, panel.art.tone);
  lctx.globalCompositeOperation = 'multiply';
  lctx.filter = recipe.filter(panel.art.tone);
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const dw = image.naturalWidth * scale; const dh = image.naturalHeight * scale;
  lctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  recipe.grade(lctx, layer.width, layer.height, panel.art.tone);
  ctx.drawImage(layer, x, y);
}

/** Caption box, top left, as .ct-caption. */
function drawCaption(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number) {
  const size = clamp(16, w * .026, 24);
  ctx.font = `bold ${size}px ${LETTER}`; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  const lines = wrap(ctx, text.toUpperCase(), w * .42 - 24);
  const lead = size * 1.2;
  const boxH = lines.length * lead + 16;
  const boxW = Math.max(...lines.map(line => ctx.measureText(line).width)) + 24;
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, boxW, boxH);
  ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.strokeRect(x + 1.5, y + 1.5, boxW - 3, boxH - 3);
  ctx.fillStyle = INK;
  lines.forEach((line, row) => ctx.fillText(line, x + 12, y + 9 + row * lead));
}

/**
 * Speech bubble, as .ct-bubble: white ellipse, ink stroke and hard shadow, a tail, uppercase Comic Neue,
 * at most 46% of the panel wide, placed top right or bottom left like Panel.tsx, with "Generated caption" under the line.
 */
function drawBubble(ctx: CanvasRenderingContext2D, panel: UiPanel, x: number, y: number, w: number, h: number) {
  const text = panel.dialogue[0];
  if (!text) return;
  const size = clamp(16, w * .034, 30);
  const lead = size * 1.15;
  ctx.font = `bold ${size}px ${LETTER}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const lines = wrap(ctx, text.toUpperCase(), w * .46 * .72, 4);
  const label = panel.generatedCaption ? 'GENERATED CAPTION' : '';
  const labelSize = clamp(11, size * .5, 15);
  const textW = Math.max(...lines.map(line => ctx.measureText(line).width), label ? (ctx.font = `bold ${labelSize}px ${UI}`, ctx.measureText(label).width) : 0);
  const textH = lines.length * lead + (label ? labelSize * 1.5 : 0);
  const rx = Math.min(w * .23, textW / 2 / .78 + 6);
  const ry = textH / 2 / .74 + 6;
  const bottomLeft = panel.bubblePlacement === 'bottom-left';
  const cx = bottomLeft ? x + w * .05 + rx : x + w * .95 - rx;
  const cy = bottomLeft ? y + h * .78 - ry : y + h * .07 + ry;
  // Tail: under the bubble (top right) or above it (bottom left), at 26% across like the CSS.
  const tx = bottomLeft ? cx - rx * .48 : cx + rx * .48;
  const tail = (dy: number) => { const base = cy + dy * ry * .82; ctx.moveTo(tx - 12, base); ctx.lineTo(tx + 6 * (bottomLeft ? -1 : 1), base + dy * (22 + ry * .2)); ctx.lineTo(tx + 12, base); ctx.closePath(); };
  const shape = () => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); tail(bottomLeft ? -1 : 1); };
  ctx.save();
  ctx.translate(3, 3); shape(); ctx.fillStyle = INK; ctx.fill(); ctx.translate(-3, -3);
  shape(); ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.fillStyle = INK; ctx.font = `bold ${size}px ${LETTER}`;
  const top = cy - textH / 2 + lead / 2;
  lines.forEach((line, row) => ctx.fillText(line, cx, top + row * lead));
  if (label) { ctx.font = `bold ${labelSize}px ${UI}`; ctx.fillStyle = '#4a4a4f'; ctx.fillText(label, cx, top + lines.length * lead - lead / 2 + labelSize * .9); }
  ctx.restore();
}

/** Sound effect, as .ct-sfx: Bangers, rotated -8°, stroke under the fill, 3px hard shadow in the stroke, Look colour. */
function drawSfx(ctx: CanvasRenderingContext2D, sfx: string, look: MangaThemeId, right: number, baseline: number, size: number) {
  ctx.save();
  ctx.translate(right, baseline); ctx.rotate(-8 * Math.PI / 180);
  ctx.font = `${size}px ${DISPLAY}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${Math.round(size * .04)}px`;
  const shadow = Math.max(3, size * .05);
  const colours = SFX_COLOURS[look];
  ctx.fillStyle = colours.stroke; ctx.fillText(sfx, shadow, shadow);
  ctx.lineWidth = Math.max(4, size * .07); ctx.lineJoin = 'round'; ctx.strokeStyle = colours.stroke; ctx.strokeText(sfx, 0, 0);
  ctx.fillStyle = colours.fill; ctx.fillText(sfx, 0, 0);
  ctx.restore();
}

const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Export failed.')), 'image/png'));
function sheet() {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  return { canvas, ctx: canvas.getContext('2d')! };
}

export async function renderPagePng(panels: UiPanel[], look: MangaThemeId, heading: string, pageNumber: number, sample = true): Promise<Blob> {
  const { canvas, ctx } = sheet();
  await ensureFonts();
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = INK; ctx.font = `64px ${DISPLAY}`; ctx.textBaseline = 'top';
  ctx.fillText(heading.toUpperCase(), PAD, 36);
  const images = await Promise.all(panels.slice(0, 4).map(panel => load(panel.imageUrl)));
  cells(images.length).forEach(([x, y, w, h], index) => {
    const panel = panels[index]!;
    drawArt(ctx, images[index]!, panel, look, x, y, w, h);
    ctx.lineWidth = 6; ctx.strokeStyle = INK; ctx.strokeRect(x, y, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    if (panel.sfx) drawSfx(ctx, panel.sfx, look, x + w * .94, y + h * .82, clamp(40, w * .11, 110));
    drawCaption(ctx, panel.caption, x, y, w);
    drawBubble(ctx, panel, x, y, w, h);
    ctx.restore();
  });
  ctx.fillStyle = INK; ctx.font = `bold 20px ${UI}`; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.fillText(`ComicToons${sample ? ' · Sample' : ''} · page ${pageNumber}`, PAD, H - 56);
  return toPng(canvas);
}

/** The book cover (BookCover in Readers.tsx): lead panel full bleed in the Look, masthead, title, credit, SFX, Sample. */
export async function renderCoverPng(issue: IssueView, look: MangaThemeId): Promise<Blob> {
  const lead = issue.panels.find(panel => panel.sfx) ?? issue.panels[0];
  if (!lead) throw new Error('That issue has no panels yet.');
  const { canvas, ctx } = sheet();
  await ensureFonts();
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
  drawArt(ctx, await load(lead.imageUrl), lead, look, 0, 0, W, H);
  ctx.textBaseline = 'middle';
  // Masthead
  ctx.fillStyle = INK; ctx.fillRect(PAD, PAD, W - PAD * 2, 84);
  ctx.lineWidth = 3; ctx.strokeStyle = PAPER; ctx.strokeRect(PAD + 1.5, PAD + 1.5, W - PAD * 2 - 3, 81);
  ctx.fillStyle = PAPER; ctx.font = `60px ${DISPLAY}`; ctx.textAlign = 'left'; ctx.fillText('COMICTOONS', PAD + 22, PAD + 45);
  ctx.font = `bold 22px ${UI}`; ctx.textAlign = 'right'; ctx.fillText(`NO. 1${issue.date ? ` · ${issue.date.toUpperCase()}` : ''}`, W - PAD - 22, PAD + 43);
  if (issue.sample) {
    ctx.font = `bold 20px ${UI}`; ctx.textAlign = 'left';
    const label = 'SAMPLE ISSUE'; const lw = ctx.measureText(label).width + 28;
    ctx.fillStyle = PAPER; ctx.fillRect(PAD, PAD + 112, lw, 40);
    ctx.setLineDash([8, 6]); ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.strokeRect(PAD + 1.5, PAD + 113.5, lw - 3, 37); ctx.setLineDash([]);
    ctx.fillStyle = INK; ctx.fillText(label, PAD + 14, PAD + 133);
  }
  if (lead.sfx) drawSfx(ctx, lead.sfx, look, W - PAD - 10, 330, 150);
  // Title box, tilted -2° with a hard shadow, then the credit line.
  ctx.font = `150px ${DISPLAY}`; ctx.textAlign = 'left';
  const lines = wrap(ctx, issue.title.toUpperCase(), W - PAD * 2 - 80, 3);
  const lineH = 138;
  const boxW = Math.max(...lines.map(line => ctx.measureText(line).width)) + 56;
  const boxH = lines.length * lineH + 36;
  const by = H - PAD - 96 - boxH;
  ctx.save();
  ctx.translate(PAD + 10, by); ctx.rotate(-2 * Math.PI / 180);
  ctx.fillStyle = INK; ctx.fillRect(10, 10, boxW, boxH);
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, boxW, boxH);
  ctx.lineWidth = 6; ctx.strokeStyle = INK; ctx.strokeRect(3, 3, boxW - 6, boxH - 6);
  ctx.fillStyle = INK; lines.forEach((line, row) => ctx.fillText(line, 28, 18 + lineH / 2 + row * lineH + 6));
  ctx.restore();
  const credit = `Starring @${issue.channel} and chat`;
  ctx.font = `bold 30px ${UI}`;
  const cw = ctx.measureText(credit).width + 32;
  ctx.fillStyle = INK; ctx.fillRect(PAD, H - PAD - 58, cw, 54);
  ctx.fillStyle = PAPER; ctx.fillText(credit, PAD + 16, H - PAD - 31);
  return toPng(canvas);
}

/** The back page (.ct-book__end): "The end" on the Look's paper, with who drew it. */
export async function renderBackPng(issue: IssueView, look: MangaThemeId): Promise<Blob> {
  const { canvas, ctx } = sheet();
  await ensureFonts();
  RECIPE[look].paper(ctx, W, H, 'grey');
  ctx.lineWidth = 12; ctx.strokeStyle = INK; ctx.strokeRect(6, 6, W - 12, H - 12);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const block = (text: string, font: string, cy: number, padX: number, height: number) => {
    ctx.font = font; const bw = ctx.measureText(text).width + padX * 2;
    ctx.fillStyle = PAPER; ctx.fillRect(W / 2 - bw / 2, cy - height / 2, bw, height);
    ctx.fillStyle = INK; ctx.fillText(text, W / 2, cy + 4);
  };
  block('THE END', `200px ${DISPLAY}`, H / 2 - 150, 36, 210);
  block(`Drawn live from chat${issue.date ? ` on ${issue.date}` : ''}.`, `bold 36px ${UI}`, H / 2 + 20, 20, 60);
  block(`Every panel approved by @${issue.channel}.`, `bold 36px ${UI}`, H / 2 + 84, 20, 60);
  if (issue.sample) block('SAMPLE', `bold 24px ${UI}`, H / 2 + 170, 16, 44);
  block('ComicToons', `56px ${DISPLAY}`, H - 110, 20, 72);
  return toPng(canvas);
}

/** Which page to export: a story page by index (four panels each, as ComicPage lays them out), the cover or the back page. */
export type ExportPage = number | 'cover' | 'back';

/** One page of an issue as a PNG, in the Look passed in. A legacy or unknown Look resolves to festival first,
 * so the filename and the returned PagePng.look always carry the theme that was actually drawn. */
export async function exportIssuePage(issue: IssueView, page: ExportPage, look: LookId): Promise<PagePng> {
  const id = resolveMangaTheme(look);
  if (page === 'cover') return { blob: await renderCoverPng(issue, id), look: id, filename: `${issue.id}-cover-${id}.png` };
  if (page === 'back') return { blob: await renderBackPng(issue, id), look: id, filename: `${issue.id}-back-${id}.png` };
  const panels = issue.panels.slice(page * 4, page * 4 + 4);
  if (!panels.length) throw new Error('That page is empty.');
  const blob = await renderPagePng(panels, id, issue.title, page + 1, issue.sample);
  return { blob, look: id, filename: `${issue.id}-page-${page + 1}-${id}.png` };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
