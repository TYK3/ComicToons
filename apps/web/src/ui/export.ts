import { panelArtUrl, panelArtRect } from './data/sampleStories';
import { comicScenes, letteringPocket, sfxPocket } from './data/lettering';
import {comicPageGroups} from './data/pagination';
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

type Tone = 'grey' | 'colour';
type Paint = (ctx: CanvasRenderingContext2D, w: number, h: number, tone: Tone) => void;
/** Artwork is already painted in its palette, including in downloaded PNGs. */
export const RECIPE: Record<MangaThemeId, { filter: (tone: Tone) => string; paper: Paint; grade: Paint }> =
  Object.fromEntries(mangaThemes.map(theme => [theme.id, {
    filter: () => 'none',
    paper: (ctx: CanvasRenderingContext2D, w: number, h: number) => { ctx.fillStyle = theme.palette.paper; ctx.fillRect(0, 0, w, h); },
    grade: () => {},
  }])) as unknown as Record<MangaThemeId, { filter: (tone: Tone) => string; paper: Paint; grade: Paint }>;

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
  if (count >= 5) { const h = (usable - GAP * 2) / 3; return Array.from({length: count}, (_, i) => [PAD + (i % 2) * (half + GAP), top + Math.floor(i / 2) * (h + GAP), half, h]); }
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
export const SFX_COLOURS: Record<MangaThemeId, { fill: string; stroke: string }> = Object.fromEntries(mangaThemes.map(theme => [theme.id, { fill: theme.palette.sfx, stroke: theme.palette.sfxStroke ?? INK }])) as unknown as Record<MangaThemeId, { fill: string; stroke: string }>;

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

/** Draw the selected painted scene, keeping the complete composition visible. */
function drawArt(ctx: CanvasRenderingContext2D, image: HTMLImageElement, panel: UiPanel, look: MangaThemeId, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.fillStyle = mangaThemes.find(theme => theme.id === look)!.palette.paper;
  ctx.fillRect(x, y, w, h);
  const [rx, ry, rw, rh] = panelArtRect(panel);
  const sw = image.naturalWidth * rw; const sh = image.naturalHeight * rh;
  const sx = image.naturalWidth * rx; const sy = image.naturalHeight * ry;
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale; const dh = sh * scale;
  ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(image, sx, sy, sw, sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/** Shared source-coordinate pockets keep HTML and downloaded lettering inside the art. */
function drawLetteredPanel(ctx: CanvasRenderingContext2D, image: HTMLImageElement, panel: UiPanel, look: MangaThemeId, x: number, y: number, w: number, h: number) {
  if(panel.art.lettered){drawArt(ctx,image,panel,look,x,y,w,h);return;}
  const pocket = letteringPocket(panel);
  drawArt(ctx, image, panel, look, x, y, w, h);
  const sfxZone = sfxPocket(panel);
  if (panel.sfx && sfxZone) {
    const [, , rw, rh] = panelArtRect(panel);
    const sw = image.naturalWidth * rw; const sh = image.naturalHeight * rh;
    const scale = Math.min(w / sw, h / sh); const dw = sw * scale; const dh = sh * scale;
    drawSfx(ctx, panel.sfx, look, x + (w-dw)/2 + dw*(sfxZone.x+sfxZone.width)/100,
      y + (h-dh)/2 + dh*(sfxZone.y+sfxZone.height)/100, Math.min(dw*.06,dh*sfxZone.height/100));
  }
  if (pocket && panel.dialogue.length === 1) {
    const [, , rw, rh] = panelArtRect(panel); const sw = image.naturalWidth * rw; const sh = image.naturalHeight * rh;
    const scale = Math.min(w / sw, h / sh); const dw = sw * scale; const dh = sh * scale;
    const dx = x + (w - dw) / 2; const dy = y + (h - dh) / 2;
    const b = pocket; const bx = dx + dw * b.x / 100; const by = dy + dh * b.y / 100;
    const bw = dw * b.width / 100; const bh = dh * b.height / 100;
    ctx.fillStyle='#fff';ctx.strokeStyle=INK;ctx.lineWidth=2;
    ctx.beginPath();
    if(panel.art.replaceBubble)ctx.roundRect(bx,by,bw,bh,Math.min(bw,bh)*.18);
    else ctx.ellipse(bx+bw/2,by+bh/2,bw/2,bh/2,0,0,Math.PI*2);
    ctx.fill();ctx.stroke();
    if(!panel.art.replaceBubble){ctx.beginPath();ctx.moveTo(bx+bw*.65,by+bh*.94);ctx.lineTo(bx+bw*.76,by+bh+7);ctx.lineTo(bx+bw*.8,by+bh*.8);ctx.fill();ctx.stroke();}
    let fontSize = Math.max(8, dw * .025);
    let lines: string[];
    do {
      ctx.font=`bold ${fontSize}px ${LETTER}`;
      lines=wrap(ctx,panel.dialogue[0]!.toUpperCase(),bw*.8,1000);
      if (lines.length * fontSize * 1.05 <= bh * .78) break;
      fontSize -= .5;
    } while (fontSize > 7);
    ctx.fillStyle=INK;ctx.textAlign='center';ctx.textBaseline='middle';
    lines.forEach((line,i)=>ctx.fillText(line,bx+bw/2,by+bh/2+(i-(lines.length-1)/2)*fontSize*1.05));
    return;
  }
  if (panel.dialogue.length) throw new Error('This panel needs a reviewed in-picture lettering layout before export.');
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
  const images = await Promise.all(panels.slice(0, 6).map(panel => load(panelArtUrl(panel, look))));
  cells(images.length).forEach(([x, y, w, h], index) => {
    const panel = panels[index]!;
    ctx.save(); ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
    drawLetteredPanel(ctx, images[index]!, panel, look, x, y, w, h);
    ctx.restore();
    ctx.lineWidth = 6; ctx.strokeStyle = INK; ctx.strokeRect(x, y, w, h);
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
  drawArt(ctx, await load(panelArtUrl(lead, look)), lead, look, PAD, 220, W - PAD * 2, 560);
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
  const panels = comicPageGroups(comicScenes(issue.panels))[page]??[];
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
