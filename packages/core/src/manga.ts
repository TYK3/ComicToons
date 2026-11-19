import type { StoryBeat, StoryAtlas } from './story.js';
/** A story reads forward. A climax gets room without moving before its setup. */
export interface MangaSource {
  id: string; caption: string; mood?: string; sfx?: string; at?: number;
  dialogue?: string[]; imageUrl?: string; altText?: string; sourceId?: string;
  storyBeats?: StoryBeat[]; storyCaption?: string; atlas?: StoryAtlas; crop?: MangaCrop;
}
/** Framing of one split frame: zoom about a focal point, in percent of the art. */
export interface MangaCrop { shot: number; zoom: number; x: number; y: number }
/** Highest continuation shot with its own CSS rule; later shots reuse the last zoom step. */
const CROP_RULES = 12;
const CROP_POINTS: readonly [number, number][] = [[72, 30], [28, 68], [50, 42]];
/** Shot 0 is the full illustration. Each continuation pushes in on a different
 * part of the same art, so a split panel never repeats an identical frame. */
export function mangaShotCrop(shot: number): MangaCrop {
  if (shot <= 0) return {shot: 0, zoom: 1, x: 50, y: 50};
  const [x, y] = CROP_POINTS[(shot - 1) % CROP_POINTS.length]!;
  return {shot, zoom: Math.round((1.3 + 0.15 * Math.floor((Math.min(shot, CROP_RULES) - 1) / CROP_POINTS.length)) * 100) / 100, x, y};
}
/** Keyed on the frame id suffix so React, standalone HTML and PNG all match. */
const cropStyles = Array.from({length: CROP_RULES}, (_, index) => mangaShotCrop(index + 1)).map(crop =>
  `.manga-page .story-panel[data-panel-id*="-shot-"][data-panel-id$="-${crop.shot}"] .panel-art>img{transform:scale(${crop.zoom});transform-origin:${crop.x}% ${crop.y}%}`).join('\n');
export interface MangaPage<T extends MangaSource> {
  panels: { panel: T; order: number; hero: boolean; span: number }[];
  heroId: string; summary: string; number: number;
}
function peakScore(panel: MangaSource) {
  return (/comeback|clutch|victor|saved|opens|lands|finish|triumph/i.test(panel.caption) ? 8 : 0)
    + (/BOOM|POW|CLACK|KRA|WHOOSH|PAT!/.test(panel.sfx ?? '') ? 3 : 0);
}
/** Split by graphemes, preserving Unicode and every original character. */
export function splitStoryLine(line: string, max = 68): string[] {
  const pieces: string[] = [];
  let chunk = '';
  for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(line)) {
    if ([...chunk].length >= max) { pieces.push(chunk); chunk = ''; }
    chunk += segment;
  }
  if (chunk || !pieces.length) pieces.push(chunk);
  return pieces;
}
/** Dense frames occupy a row. Pair their remaining neighbours in reading order,
 * or widen a lone neighbour, so no preferred span leaves an empty grid cell. */
function rowSpans(frames: readonly MangaSource[]): number[] {
  const size = frames.length;
  const preferred = size === 6 ? [7,5,6,6,8,4] : size === 5 ? [6,6,5,7,12] : size === 4 ? [7,5,5,7] : size === 3 ? [6,6,12] : Array<number>(size).fill(12);
  const spans = preferred.map((span,index) => frames[index]!.atlas && (frames[index]!.dialogue?.join('').length ?? 0) > 100 ? 12 : span);
  for (let index = 0; index < spans.length; index++) {
    if (spans[index] === 12) continue;
    const next = spans[index + 1];
    if (next !== undefined && next < 12) {
      const first = Math.round(12 * spans[index]! / (spans[index]! + next));
      spans[index] = first; spans[++index] = 12 - first;
    } else spans[index] = 12;
  }
  return spans;
}
/** Split frames carry their crop, so callers can tell continuation shots apart. */
export type MangaFrame<T extends MangaSource> = T & { crop?: MangaCrop };
export function buildMangaPages<T extends MangaSource>(source: readonly T[]): MangaPage<MangaFrame<T>>[] {
  const frames: MangaFrame<T>[] = [...source].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).flatMap(panel => {
    if (!panel.storyBeats?.length) return [panel];
    return panel.storyBeats.flatMap((beat, beatIndex) => {
      const lines = beatIndex === 0 && panel.dialogue?.length ? panel.dialogue : beat.dialogue;
      // An edited caption gets its own opening balloon; it never replaces a dialogue line (B2).
      const speech = beatIndex === 0 && panel.storyCaption !== undefined && panel.caption !== panel.storyCaption
        ? [panel.caption, ...lines] : lines;
      // A panel with no dialogue still gets a frame: the opening beat is
      // narrated by the panel caption, later silent beats are art only.
      const lettered = speech.length ? speech : beatIndex === 0 && panel.caption ? [panel.caption] : [];
      const chunks = lettered.flatMap(line => splitStoryLine(line, beat.sfx ? 36 : 68));
      const result: MangaFrame<T>[] = [];
      // At most two compact balloons per frame. Overflow becomes a new frame,
      // then another page: never an expanding card under the illustration.
      for (let index = 0; index < Math.max(chunks.length, 1); index += 2) result.push({...panel,
        id: `${panel.id}-shot-${beatIndex}-${index / 2}`, sourceId: panel.id,
        caption: beat.scene, dialogue: chunks.slice(index, index + 2), altText: beat.scene,
        imageUrl: beat.imageUrl, atlas: {frame: beat.frame, columns: 2, rows: 3},
        crop: mangaShotCrop(index / 2),
        sfx: index === 0 ? beat.sfx : undefined, storyBeats: undefined,
      });
      return result;
    });
  });
  const pages: MangaPage<MangaFrame<T>>[] = [];
  while (frames.length) {
    let size = frames.length > 6 && frames.length < 9 ? frames.length - 3 : Math.min(6, frames.length);
    let spans = rowSpans(frames.slice(0,size));
    // Count the actual filled rows, including lone frames next to a dense one.
    while (spans.reduce((sum,span) => sum + span,0) > 36) {
      spans = rowSpans(frames.slice(0,--size));
    }
    const group = frames.splice(0, size);
    const hero = group.reduce((best, panel) => peakScore(panel) > peakScore(best) ? panel : best, group[0]!);
    pages.push({number: pages.length + 1, heroId: hero.id, summary: 'The story, moment by moment.',
      panels: group.map((panel, index) => ({panel, order: index + 1, hero: panel.id === hero.id, span: spans[index]!})),
    });
  }
  return pages;
}

/** The same geometry is shipped to React, standalone HTML and the PNG document. */
export const mangaStyles = `
.manga-pages{min-width:0;width:100%;color:#211e2b}
.manga-page{container-type:inline-size;min-width:0;background:#f6f1e7;color:#211e2b;border:3px solid #211e2b;padding:clamp(12px,2vw,22px);margin:0 0 20px;box-shadow:5px 5px 0 #211e2b;box-sizing:border-box;font-family:'DM Sans',DM,sans-serif}
.manga-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-bottom:2px solid #211e2b;padding-bottom:10px;font-size:12px;font-weight:700;letter-spacing:.05em}
.manga-sample{display:inline-block;background:#211e2b;color:#fff9ec;padding:5px 8px;letter-spacing:.04em}
.manga-summary{font-family:'Barlow Condensed',Barlow,sans-serif;font-size:clamp(17px,3.3cqw,32px);font-weight:700;line-height:1.3;white-space:nowrap;margin:14px 0 5px;color:#211e2b}
.manga-reading{font-size:14px;line-height:1.5;color:#52465b;margin:0 0 16px}
.manga-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));column-gap:10px;row-gap:22px;align-items:stretch}
.manga-cell{grid-column:span var(--manga-span);min-width:0;display:flex;flex-direction:column;gap:0}
.manga-peak{align-self:flex-start;background:#e8ed8f;color:#211e2b;border:2px solid #211e2b;border-bottom:0;padding:4px 10px;font-size:12px;font-weight:700;letter-spacing:.05em}
.manga-page .comic-panel{width:100%;flex:1;min-width:0;display:flex;flex-direction:column;background:#fffbf0;color:#211e2b;border:2px solid #211e2b;overflow:visible;transform:none;box-sizing:border-box}
.manga-page .panel-art{aspect-ratio:16/9;width:100%;position:relative;overflow:hidden;flex-shrink:0;background:#e2d3bd}
.manga-page .panel-art>img{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:cover}
.manga-page .lettering-rail{display:flex;flex-direction:column;gap:10px;border-top:2px solid #211e2b;padding:12px;background:#fffbf0;color:#211e2b;min-width:0}
.manga-page .panel-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.manga-page .panel-number,.manga-page .panel-time{position:static;inset:auto;display:inline-block;flex-shrink:0;padding:3px;font-size:12px;line-height:1.5;color:#211e2b;background:transparent}
.manga-page .panel-number{border:1px solid #211e2b}
.manga-page .comic-panel .lettering-rail .panel-sfx{position:static;inset:auto;transform:none;margin-left:auto;max-width:100%;font-family:'Barlow Condensed',Barlow,sans-serif;font-size:clamp(22px,3cqw,36px);font-style:italic;font-weight:700;line-height:1.3;padding:4px 8px;color:#211e2b;background:#e8ed8f;border:2px solid #211e2b;box-shadow:2px 2px 0 #211e2b;-webkit-text-stroke:0;text-shadow:none;overflow-wrap:anywhere;box-sizing:border-box}
.manga-page .comic-panel .lettering-rail .speech-bubble{position:static;inset:auto;transform:none;width:100%;max-width:100%;margin:0;padding:8px 10px;border:2px solid #211e2b;border-radius:12px 12px 12px 3px;font-size:14px;font-weight:500;line-height:1.5;white-space:normal;overflow-wrap:anywhere;box-sizing:border-box;color:#211e2b;background:#fffdf7}
.manga-page .speech-bubble::after{display:none}
.manga-page .comic-panel .lettering-rail .panel-caption{margin:0;padding:0;border:0;font-size:14px;font-weight:600;line-height:1.5;overflow-wrap:anywhere;white-space:normal;color:#211e2b;background:transparent}
.manga-page .art-provenance{padding:8px 12px;font-size:12px;line-height:1.5;overflow-wrap:anywhere;color:#52465b;background:#fffbf0}
.manga-footer{border-top:2px solid #211e2b;margin-top:16px;padding-top:10px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px;color:#52465b}
.manga-endmark{display:none}
@container(max-width:540px){.manga-cell{grid-column:1/-1}.manga-summary{font-size:17px}.manga-page .lettering-rail{padding:9px}}
.manga-page{background:#fff;border:0;box-shadow:none;padding:12px;margin:0 0 24px;color:#111}
.manga-heading{border:0;padding:0 0 9px;font-size:11px;letter-spacing:.1em}
.manga-sample{background:none;color:#555;padding:0;font-size:11px}
.manga-summary,.manga-reading,.manga-peak,.manga-endmark{display:none}
.manga-grid{gap:9px;align-items:stretch}
.manga-cell{grid-column:span var(--manga-span);position:relative}
.manga-footer{border:0;margin:0;padding:10px 0 0;font-size:11px;letter-spacing:.05em;color:#555}
.manga-page .story-panel{display:block;position:relative;overflow:hidden;background:#fff;color:#111;border:2px solid #111;min-height:0;aspect-ratio:1.6}
.manga-page .story-panel .panel-art{position:absolute;inset:0;aspect-ratio:auto;background:#fff;overflow:hidden;width:100%;height:100%}
.manga-page .story-panel .panel-art>img.story-atlas{position:absolute;display:block;max-width:none;width:200%;height:300%;object-fit:fill;left:var(--atlas-x);top:var(--atlas-y)}
.story-panel{container-type:inline-size}
.story-panel .story-lettering{position:absolute;inset:0;z-index:2;pointer-events:none;font-family:'Barlow Condensed',Barlow,sans-serif;font-weight:700;color:#111}
.story-panel .story-balloon{position:absolute;inset:auto;left:3%;top:4%;width:36%;margin:0;padding:clamp(6px,1.2cqw,13px);border:2px solid #111;border-radius:48% 44% 46% 42%;background:#fff;color:#111;line-height:1.15;font-size:clamp(14px,2.5cqw,24px);font-weight:700;text-align:center;text-transform:uppercase;overflow-wrap:anywhere;box-sizing:border-box;white-space:pre-wrap}
.story-panel .story-balloon:after{content:'';position:absolute;right:8%;bottom:-9px;width:12px;height:15px;background:#fff;border-bottom:2px solid #111;border-right:2px solid #111;transform:skewY(35deg) rotate(20deg)}
.story-panel .story-chat{top:auto;bottom:4%;left:auto;right:3%;width:33%;font-size:clamp(14px,2.1cqw,20px);border-radius:40% 48% 35% 45%;padding:clamp(6px,1cqw,12px);font-style:italic}
.story-panel .story-chat:after{display:none}
.story-panel .story-sfx{position:absolute;left:4%;bottom:36%;max-width:36%;font-family:'Barlow Condensed',Barlow,sans-serif;font-size:clamp(25px,6cqw,62px);font-style:italic;line-height:1.3;padding:4px;letter-spacing:-.04em;transform:rotate(-10deg);color:#111;-webkit-text-stroke:3px #fff;paint-order:stroke fill;text-shadow:1px 2px #fff;overflow-wrap:anywhere}
.story-panel[data-story-frame="2"] .story-sfx{top:35%;bottom:auto}
.story-panel[data-source-id^="tabletop-night"][data-story-frame="2"] .story-chat{left:3%;right:auto}
.story-panel:is([data-story-frame="0"],[data-story-frame="3"],[data-story-frame="4"]) .story-chat{left:3%;right:auto}
.story-panel .story-transcript{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.manga-cell:has(.story-panel){display:block}
.manga-cell:has(.story-panel) .story-panel{height:100%}
.manga-page:has(.story-panel) .manga-grid{grid-auto-rows:clamp(235px,30cqw,310px)}
.manga-page:has(.story-panel) .manga-cell[data-hero=true]{z-index:1}
.manga-page:has(.story-panel) .manga-cell[data-hero=true] .story-panel{border-width:3px}
@container(max-width:540px){
 .manga-page:has(.story-panel) .manga-grid{grid-auto-rows:auto;gap:8px}
 .manga-page:has(.story-panel) .manga-cell{grid-column:1/-1}
 .manga-page:has(.story-panel) .story-panel{aspect-ratio:1.4;min-height:235px}
 .story-panel .story-balloon{font-size:16px;width:38%;padding:9px;line-height:1.18}
 .story-panel .story-chat{font-size:14px;width:34%;padding:8px}
 .story-panel .story-sfx{font-size:26px;max-width:none;white-space:nowrap;top:41%;bottom:auto}
}
@container(max-width:360px){
 .story-panel .story-balloon{font-size:14px;padding:6px;line-height:1.2}
 .story-panel .story-chat{font-size:14px;padding:6px}
 .story-panel .story-sfx{font-size:24px;top:44%}
}
.story-panel[data-story-style="pop-ink"] .panel-art>img{filter:sepia(.3)}
.story-panel[data-story-style="midnight-noir"] .panel-art>img{filter:grayscale(1)}
${cropStyles}
@media(prefers-reduced-motion:reduce){.manga-page .comic-panel{animation:none}}
${mangaThemeStyles}
`;
import {mangaThemeStyles} from './theme.js';

export interface OutputPanel extends MangaSource { clipUrl?:string; voters?:number; cameo?:string; origin?:string }
export interface BookPage<T extends OutputPanel> { kind:'cover'|'contents'|'chapter'|'peak'|'story'; title:string; panels:T[]; number:number; chapter?:number }
export interface BookChapter { title:string; start:number; end:number; panels:number; cameos:number; page:number }
/** Segments split at five-minute gaps or hour boundaries. A continuous session
 * with distinct timestamps gets an opening and closing chapter. Each source
 * panel belongs to exactly one story page; decorative splashes reference it. */
export function buildBook<T extends OutputPanel>(source:readonly T[],opts:{title?:string}={}) {
  const panels=[...new Map(source.map(p=>[p.id,p])).values()].sort((a,b)=>(a.at??0)-(b.at??0));
  const groups:T[][]=[];
  for(const panel of panels){const group=groups.at(-1);const previous=group?.at(-1);if(!previous||(panel.at??0)-(previous.at??0)>=300||Math.floor((panel.at??0)/3600)!==Math.floor((previous.at??0)/3600))groups.push([panel]);else group!.push(panel);}
  if(groups.length===1&&panels.length>1&&(panels.at(-1)!.at??0)>(panels[0]!.at??0)){const split=panels.findIndex(p=>(p.at??0)>(panels[0]!.at??0));groups.splice(0,1,panels.slice(0,split),panels.slice(split));}
  const title=opts.title||'A stream worth retelling';
  const pages:BookPage<T>[]=[{kind:'cover',title,panels:panels.slice(0,1),number:1},{kind:'contents',title:'Contents',panels:[],number:2}];
  const chapters:BookChapter[]=[];
  for(const [index,group] of groups.entries()){
    const name=`Chapter ${index+1}`;const peak=group.reduce((a,b)=>peakScore(b)>peakScore(a)?b:a);
    chapters.push({title:name,start:group[0]!.at??0,end:group.at(-1)!.at??0,panels:group.length,cameos:group.filter(p=>p.cameo).length,page:pages.length+1});
    pages.push({kind:'chapter',title:name,panels:[group[0]!],number:pages.length+1,chapter:index+1});
    pages.push({kind:'peak',title:'The peak',panels:[peak],number:pages.length+1,chapter:index+1});
    for(let i=0;i<group.length;i+=5)pages.push({kind:'story',title:name,panels:group.slice(i,i+5),number:pages.length+1,chapter:index+1});
  }
  return {title,chapters,pages,panelCount:panels.length};
}
/** One highlight per chapter: highest caption/SFX peak score, earliest wins ties.
 * Episodes use up to four chronological neighbours from that chapter only. */
export function buildSeries<T extends OutputPanel>(source:readonly T[],opts:{title?:string}={}) {
  const book=buildBook(source,opts);const stories=book.pages.filter(p=>p.kind==='story');
  const episodes=book.chapters.map((chapter,index)=>{const group=stories.filter(p=>p.chapter===index+1).flatMap(p=>p.panels);const highlight=group.reduce((a,b)=>peakScore(b)>peakScore(a)?b:a);const at=group.indexOf(highlight);return {number:index+1,title:highlight.caption,highlight,panels:group.slice(Math.max(0,at-1),Math.max(0,at-1)+4),chapter:chapter.title};});
  return {title:book.title,episodes,highlightCount:episodes.length};
}

/**
 * IMPORT-1 (additive, 18:45 ownership OK): a channel's manga series is a list of chapters, each
 * either a live-stream issue or an import (VOD or clip). Every current export above is unchanged.
 */
export type SeriesSourceKind = 'live' | 'vod' | 'clip';
export interface SeriesChapter<T extends OutputPanel = OutputPanel> {
  id: string; title: string; sourceUrl: string; sourceKind: SeriesSourceKind; createdAt: number; panels: T[];
  /** Plain words when only part of the source was used (a clamped VOD). */
  note?: string;
}
export interface ChannelSeries<T extends OutputPanel = OutputPanel> { channel: string; chapters: SeriesChapter<T>[] }
export function emptyChannelSeries<T extends OutputPanel = OutputPanel>(channel: string): ChannelSeries<T> {
  return {channel, chapters: []};
}
/** Pure append: a new chapter joins the end of the list, in the order chapters were added. */
export function appendChapter<T extends OutputPanel>(series: ChannelSeries<T>, chapter: SeriesChapter<T>): ChannelSeries<T> {
  return {...series, chapters: [...series.chapters, chapter]};
}
