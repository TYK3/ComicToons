import type { LookId, UiPanel } from '../data/adapter';
import { Panel } from './Panel';
import {comicPageGroups} from '../data/pagination';

/** One printed page: up to six panels in a layout chosen by count. Gutters are paper; the page edge is ink. */
export function ComicPage({ panels, number, look, title, className = '' }: { panels: UiPanel[]; number?: number; look?: LookId; title?: string; className?: string }) {
  const layout = panels.length >= 6 ? 'six' : panels.length === 5 ? 'five' : panels.length === 4 ? 'four' : panels.length === 3 ? 'three' : panels.length === 2 ? 'two' : 'one';
  return <article className={`ct-page ${className}`} data-layout={layout} data-complete={panels.length===1&&panels[0]?.provenance?.provider.startsWith('scene-')||undefined} aria-label={title ?? (number ? `Page ${number}` : 'Comic page')}>
    {title && <h3 className="ct-page__title">{title}</h3>}
    <div className="ct-page__grid">
      {panels.slice(0, 6).map((panel, index) => <Panel key={panel.id} panel={panel} look={look} tags={false} className={`ct-page__p${index + 1}`}/>)}
    </div>
    {number !== undefined && <p className="ct-page__num" aria-hidden="true">{number}</p>}
  </article>;
}

export const toPages = comicPageGroups;
