import type { CSSProperties } from 'react';
import { buildMangaPages, mangaStyles, panelSourceLabel, resolveMangaTheme, type MangaTheme } from '@comictoons/core';
import type { Panel } from '../types';
import { ComicPanel } from './ComicPanel';

export function MangaPage({ panels, latest = false, theme }: { panels: readonly Panel[]; latest?: boolean; theme?: MangaTheme }) {
  const pages = buildMangaPages(panels);
  const shown = latest ? pages.slice(-1) : pages;
  return <div className="manga-pages" data-manga-theme={resolveMangaTheme(theme)}><style>{mangaStyles}</style>{shown.map(page => <section key={page.panels.map(item => item.panel.id).join('|')} className="manga-page" data-manga-page={page.number} data-panel-count={page.panels.length} data-hero-id={page.heroId} aria-label={`Manga summary page ${page.number}`}>
    <header className="manga-heading"><span className="manga-sample">{panelSourceLabel(page.panels.map(item=>item.panel))}</span><span>COMICTOONS / ORIGINAL STORY</span></header>
    <h2 className="manga-summary">{page.summary}</h2>
    <div className="manga-grid" role="list" aria-label="Story reading order, left to right then down">{page.panels.map(item => <div key={item.panel.id} className="manga-cell" data-reading-order={item.order} data-hero={item.hero} data-source-id={item.panel.sourceId ?? item.panel.id} data-shot={item.panel.crop?.shot} role="listitem" style={{ '--manga-span': item.span } as CSSProperties}>
      <ComicPanel panel={item.panel} index={item.order - 1}/>
    </div>)}</div>
    <footer className="manga-footer"><span>ORIGINAL MANGA · APPROVED MOMENTS</span><span>{page.number} / {pages.length}</span></footer>
  </section>)}</div>;
}
