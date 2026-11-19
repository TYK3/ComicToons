import {resolveMangaTheme,mangaThemes,type MangaTheme} from '@comictoons/core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildMangaPages, mangaStyles, panelSourceLabel, type ComicPanel } from '@comictoons/core';
import type { StudioState } from './studio.ts';
import { chooseLook } from './recaps.ts';

const root = resolve(import.meta.dirname, '../../..');
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
const imageSource = (value: string) => /^data:image\/(?:svg\+xml|png|webp|jpeg)(?:;charset=utf-8)?(?:;base64)?,/i.test(value) ? escape(value) : '';
const stamp = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

function panelCard(panel: ComicPanel, order: number) {
  const image = imageSource(panel.imageUrl);
  if (panel.atlas) return `<article class="comic-panel story-panel panel" data-panel-id="${escape(panel.id)}" data-source-id="${escape(panel.sourceId ?? panel.id)}" data-provider="storyboard" data-story-frame="${panel.atlas.frame}" data-story-style="${escape(panel.provenance?.style ?? '')}" data-lettering-placement="in-art"><div class="art panel-art">${image ? `<img src="${image}" alt="${escape(panel.altText)}"/>` : '<span>Artwork unavailable.</span>'}</div><div class="story-lettering">${panel.dialogue.map((line, index) => `<p class="story-balloon ${index ? 'story-chat' : ''}" data-lettering-kind="dialogue" dir="auto">${escape(line)}</p>`).join('')}${panel.sfx ? `<span class="story-sfx" data-lettering-kind="sfx">${escape(panel.sfx)}</span>` : ''}</div><span class="story-transcript">${escape(panel.caption)}</span></article>`;
  return `<article class="comic-panel panel" data-panel-id="${escape(panel.id)}" data-provider="${escape(panel.provenance?.provider ?? '')}" data-asset="${escape(panel.provenance?.asset ?? '')}" data-lettering-placement="caption-rail"><div class="art panel-art">${image ? `<img src="${image}" alt="${escape(panel.altText)}"/>` : '<span>Artwork unavailable. The story is still here.</span>'}</div><div class="lettering-rail"><div class="panel-meta"><span class="panel-number" data-lettering-kind="number">${String(order).padStart(2, '0')}</span><time class="panel-time" data-lettering-kind="timestamp">${stamp(panel.at)}</time>${panel.sfx ? `<span class="panel-sfx" data-lettering-kind="sfx">${escape(panel.sfx)}</span>` : ''}</div>${panel.dialogue.map(line => `<p class="speech-bubble" data-lettering-kind="dialogue" dir="auto">${escape(line)}</p>`).join('')}<p class="panel-caption" data-lettering-kind="caption" dir="auto">${escape(panel.caption)}</p></div></article>`;
}
function mangaPages(panels: ComicPanel[],theme?:MangaTheme) {
  const pages = buildMangaPages(panels);
  return `<div class="manga-pages" data-manga-theme="${resolveMangaTheme(theme)}">${pages.map(page => `<section class="manga-page" data-manga-page="${page.number}" data-panel-count="${page.panels.length}" data-hero-id="${escape(page.heroId)}" aria-label="Manga story page ${page.number}"><header class="manga-heading"><span class="manga-sample">${escape(panelSourceLabel(page.panels.map(item=>item.panel)))}</span><span>COMICTOONS / ORIGINAL STORY</span></header><h2 class="manga-summary">${page.summary}</h2><div class="manga-grid" role="list" aria-label="Story reading order, left to right then down">${page.panels.map(item => `<div class="manga-cell" data-reading-order="${item.order}" data-hero="${item.hero}" data-source-id="${escape(item.panel.sourceId ?? item.panel.id)}" role="listitem" style="--manga-span:${item.span}">${panelCard(item.panel, item.order)}</div>`).join('')}</div><footer class="manga-footer"><span>ORIGINAL MANGA &middot; APPROVED MOMENTS</span><span>${page.number} / ${pages.length}</span></footer></section>`).join('')}</div>`;
}
/** Renders the edition in the snapshot's Look, or in an explicit `look` when one is given
 * (an unknown Look is an error). */
export async function renderExport(state: StudioState, options: {look?: string} = {}): Promise<{html: string; shareHtml: string; fontLicenses: string}> {
  const look = chooseLook(state, options.look);
  const [displayFont, bodyFont, displayLicense, bodyLicense] = await Promise.all([
    readFile(resolve(root, 'node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2')),
    readFile(resolve(root, 'node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2')),
    readFile(resolve(root, 'node_modules/@fontsource/barlow-condensed/LICENSE'), 'utf8'),
    readFile(resolve(root, 'node_modules/@fontsource/dm-sans/LICENSE'), 'utf8'),
  ]);
  const fonts = `@font-face{font-family:Barlow;src:url(data:font/woff2;base64,${displayFont.toString('base64')}) format('woff2');font-weight:700;font-display:block}@font-face{font-family:DM;src:url(data:font/woff2;base64,${bodyFont.toString('base64')}) format('woff2');font-weight:400;font-display:block}`;
  const images = new Map<string, Promise<string>>();
  function embed(value: string) {
    if (!images.has(value)) images.set(value, (async () => {
      const asset = /^\/art\/generated\/(panel-[a-z0-9-]+\.(webp|png))$/.exec(value);
      if (!asset) return value;
      const bytes = await readFile(resolve(root, 'fixtures/art/generated', asset[1]!));
      return `data:image/${asset[2]};base64,${bytes.toString('base64')}`;
    })());
    return images.get(value)!;
  }
  const panels = await Promise.all(state.panels.map(async panel => ({...panel,
    imageUrl: await embed(panel.imageUrl),
    storyBeats: panel.storyBeats ? await Promise.all(panel.storyBeats.map(async beat => ({...beat, imageUrl: await embed(beat.imageUrl)}))) : undefined,
  })));
  const sourceLabel=escape(panelSourceLabel(panels));
  const editionLabel=escape(mangaThemes.find(theme=>theme.id===look)!.name.toUpperCase());
  const title = escape(state.issueTitle || state.streamTitle || 'A stream worth retelling');
  const content = mangaPages(panels,look);
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title} · ComicToons</title><style>${fonts}*{box-sizing:border-box}html,body{margin:0;background:#f6f1e7;color:#211e2b;font-family:DM,sans-serif}h1{font-family:Barlow,sans-serif;font-size:clamp(32px,5vw,58px);line-height:1.05;overflow-wrap:anywhere;margin:20px 0}.masthead{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;border-bottom:2px solid #211e2b;padding-bottom:12px;font-size:14px}.masthead strong{font-family:Barlow,sans-serif;font-size:30px}.edition,.footer{font-size:14px;line-height:1.6;margin:16px 0}.magazine{max-width:1160px;margin:auto;padding:28px}.share{width:min(1080px,100%);min-height:1350px;padding:28px}.actions a{display:inline-block;margin-top:18px;padding:12px;background:#211e2b;color:#fff9ec}.footer{border-top:2px solid #211e2b;padding-top:12px}${mangaStyles}@media(max-width:600px){.magazine,.share{padding:16px}}</style></head>`;
  const masthead = `<header class="masthead"><strong>comictoons.</strong><span>THE STREAM RECAP COMIC · ${sourceLabel}</span></header><h1>${title}</h1>`;
  const footer = `<footer class="footer">MADE LIVE. REMEMBERED IN INK. · ${sourceLabel}</footer>`;
  const html = `${head}<body><main class="magazine">${masthead}<p class="edition">${panels.length} APPROVED MOMENTS · ${editionLabel}</p>${content}${footer}<nav class="actions" aria-label="Issue actions"><a href="share.png" download>Save this issue’s share card ↓</a></nav></main></body></html>`;
  const shareHtml = `${head}<body><main class="share">${masthead}<p class="edition">${panels.length} APPROVED ${panels.length === 1 ? 'PANEL' : 'PANELS'} · ${sourceLabel}</p>${content}${footer}</main></body></html>`;
  return {html, shareHtml, fontLicenses: `BARLOW CONDENSED\n${displayLicense}\n\nDM SANS\n${bodyLicense}`};
}