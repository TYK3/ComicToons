import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { LOOKS, type IssueView } from '../data/adapter';
import { useAdapter, useLoad, useUi } from '../data/store';
import { ReaderBar } from '../components/ReaderBar';
import { ComicPage, toPages } from '../components/ComicPage';
import { comicScenes } from '../data/lettering';
import { LookArt, Panel } from '../components/Panel';
import { Arrow } from '../components/Icons';
import { Sample } from '../components/Brand';
import { RetryButton, ScreenState } from '../components/ScreenState';
import { downloadBlob } from '../export';
import { href, type Route } from '../router';
import {useStudioMode} from '../data/StudioSession';
import { useReveal } from '../motion';
import '../styles/pages.css';
import '../styles/readers.css';

const DEFAULT_ISSUE = 'sample-tabletop-night';

/** The current Look travels with every read, so a server can render or describe the issue in it. */
function useIssue(requestedId?:string) {
  const adapter = useAdapter();
  const {mode}=useStudioMode();
  const studio=useUi().studio;
  const id=requestedId??studio.recapUrl?.split('/').pop()??(mode==='sample'?DEFAULT_ISSUE:'');
  const look = studio.look;
  return useRetry(useLoad(() => adapter.getIssue(id, look), [adapter, id, look]));
}
/** Try again asks the adapter to reconnect first (GET /api/state), then loads the page again. */
function useRetry<T extends { retry: () => void }>(load: T): T & { tryAgain: () => void } {
  const adapter = useAdapter();
  return { ...load, tryAgain: () => { void adapter.refresh().finally(load.retry); } };
}

/** UI3: skeletons only (no art, no titles), with a polite "Loading the recap…" for screen readers. */
function Loading({ label }: { label: string }) {
  return <div className="ct-reader__loading" aria-busy="true">
    <p className="ct-sr" role="status" aria-live="polite">{label}…</p>
    <div className="ct-skel ct-skel--title" aria-hidden="true"/><div className="ct-reader__skels" aria-hidden="true">{[0, 1].map(index => <div key={index} className="ct-skel ct-skel--page"/>)}</div>
  </div>;
}
/** m17 + UI3: readers land here too, so besides Try again the way out is the home page and the Sample series. */
function Failed({ text, what = 'That issue', onRetry, retrying, level = 1 }: { text: string; what?: string; onRetry: () => void; retrying: boolean; level?: 1 | 2 }) {
  const {mode}=useStudioMode();
  return <ScreenState kind="error" level={level} title={`${what} didn’t load`} actions={<>
    <RetryButton onRetry={onRetry} busy={retrying}/>
    <a className="ct-btn" href={href('/')}>Go to the home page</a>
    <a className="ct-btn ct-btn--ghost" href={href('/issues')}>Open {mode==='sample'?'Sample':'Live'} issues</a>
  </>}>
    <p>{text}</p>
    <p>Check your connection, then try again. If the studio computer is off, the comic comes back when it is on.</p>
  </ScreenState>;
}
/** UI3: an issue that was bound before any panel was approved. Nothing to read, so say how to get panels into it. */
function EmptyIssue({ issue, what }: { issue: IssueView; what: string }) {
  return <ScreenState kind="empty" level={1} title={`No panels in ${what} yet`} actions={<>
    <a className="ct-btn ct-btn--ink" href={href('/studio')}>Open the studio</a>
    <a className="ct-btn" href={href('/output')}>Bind it again</a>
  </>}>
    <p>{issue.title ? `“${issue.title}”` : 'This issue'} was bound before any panel was approved, so there is nothing to read or save.</p>
    <p>Approve a few panels in the studio, then bind the issue again from Outputs.</p>
  </ScreenState>;
}
function Shell({ title, children, back, backLabel, look = true }: { title?: ReactNode; children: ReactNode; back?: string; backLabel?: string; look?: boolean }) {
  return <div className="ct-reader"><a className="ct-skip" href="#ct-main">Skip to the comic</a><ReaderBar back={back} backLabel={backLabel} look={look}>{title}</ReaderBar><main id="ct-main" className="ct-reader__main">{children}</main></div>;
}

/** Recap: the issue at a glance, with every way to read or share it. */
export function Recap({ route }: { route: Route }) {
  const ui = useUi();
  const adapter = useAdapter();
  const { data, error, retrying, tryAgain } = useIssue(route.id);
  const root = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState('');
  useReveal(root, [data]);
  if (error) return <Shell look={false} back="/" backLabel="Home"><Failed text={error} what="That recap" onRetry={tryAgain} retrying={retrying}/></Shell>;
  if (!data) return <Shell><Loading label="Loading the recap"/></Shell>;
  if (!data.panels.length) return <Shell title={<span className="ct-reader__crumb">Recap</span>}><EmptyIssue issue={data} what="this recap"/></Shell>;
  const pages = toPages(comicScenes(data.panels));
  const save = async (page: number | 'cover' | 'back') => {
    const name = page === 'cover' ? 'The cover' : page === 'back' ? 'The back page' : `Page ${page + 1}`;
    setExporting(`Drawing ${name.toLowerCase()}…`);
    try { const png = await adapter.exportPagePng(data, page, ui.studio.look); downloadBlob(png.blob, png.filename); setExporting(`${name} saved as a PNG in the ${LOOKS.find(look => look.id === png.look)?.name ?? png.look} Look.`); }
    catch (cause) { setExporting(cause instanceof Error ? cause.message : 'Export failed.'); }
  };
  return <Shell title={<span className="ct-reader__crumb">Recap</span>}>
    <div ref={root} className="ct-recap">
      <header className="ct-recap__head">
        <div className="ct-recap__cover" data-reveal="slam"><LookArt panel={data.panels[0]!} look={ui.studio.look} eager/>{data.sample && <span className="ct-recap__stamp">Sample</span>}</div>
        <div className="ct-recap__meta" data-reveal="up">
          <p className="ct-kicker">@{data.channel}{data.date && ` · ${data.date}`} · “{data.streamTitle}”</p>
          <h1 className="ct-display">{data.title}</h1>
          <p className="ct-recap__facts">{data.panels.length} panels · {pages.length} {pages.length === 1 ? 'page' : 'pages'} · approved live by the streamer</p>
          <div className="ct-recap__acts">
            <a className="ct-btn ct-btn--ink" href={href(`/book/${data.id}`)}>Read the collected book <Arrow/></a>
            <a className="ct-btn" href={href(`/read/${data.id}`)}>Read the episode</a>
            <a className="ct-btn" href={href(`/series/${data.id}`)}>Chapters & episodes</a>
          </div>
          <div className="ct-recap__png" role="group" aria-label="Save the book as PNG">
            <button type="button" className="ct-btn ct-btn--sm" onClick={() => void save('cover')}>Save cover as PNG</button>
            <button type="button" className="ct-btn ct-btn--sm" onClick={() => void save('back')}>Save back page as PNG</button>
          </div>
          <p className="ct-note">{data.storyPanels ? "One complete story: read its episode or browse the same pages in the collected book." : "One comic/manga story, organised into episodes and chapters for a collected book."}</p>
          <p className="ct-note" role="status" aria-live="polite">{exporting || 'PNGs use the Look you have picked, with the speech bubbles and sound effects.'}</p>
        </div>
      </header>
      <section className="ct-recap__pages" aria-label="Pages">
        {pages.map((page, index) => <div key={index} className="ct-recap__page" data-reveal="up" data-delay={String((index % 2) * 90)}>
          <ComicPage panels={page} number={index + 1}/>
          <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => void save(index)}>Save page {index + 1} as PNG</button>
        </div>)}
      </section>
    </div>
  </Shell>;
}

/** A11Y-fix #5: when the focused button in `host` goes disabled (or focus fell to the page), focus the first enabled control in `host`. */
function useHandOff(host: RefObject<HTMLElement | null>, key: unknown) {
  const was = useRef(false);
  useEffect(() => {
    const box = host.current;
    if (!box) return;
    const enter = () => { was.current = true; };
    // Leaving for somewhere else clears it; a blur caused by the button going disabled does not.
    const leave = (event: FocusEvent) => { was.current = box.contains(event.relatedTarget as Node | null) || Boolean((event.target as HTMLButtonElement).disabled); };
    box.addEventListener('focusin', enter);
    box.addEventListener('focusout', leave);
    return () => { box.removeEventListener('focusin', enter); box.removeEventListener('focusout', leave); };
  });
  useEffect(() => {
    const box = host.current;
    if (!box || !was.current) return;
    const active = document.activeElement as HTMLButtonElement | null;
    if (active && active !== document.body && box.contains(active) && !active.disabled) return;
    if (active && active !== document.body && !box.contains(active)) { was.current = false; return; }
    box.querySelector<HTMLElement>('button:not(:disabled),a[href]')?.focus();
  }, [host, key]);
}

/** Comic book: cover, pages two at a time on wide screens, one at a time on phones. */
export function Book({ route }: { route: Route }) {
  const { data, error, retrying, tryAgain } = useIssue(route.id);
  const look = useUi().studio.look;
  const [at, setAt] = useState(0);
  const [wide, setWide] = useState(() => typeof matchMedia === 'undefined' || matchMedia('(min-width: 900px)').matches);
  useEffect(() => {
    const query = matchMedia('(min-width: 900px)');
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const total = data ? toPages(comicScenes(data.panels)).length + 2 : 0;
  const step = wide ? 2 : 1;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A11Y-fix #6: arrows inside a form control or radio group (the Look picker) belong to that control.
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest?.('input,textarea,select,[contenteditable],[role=radiogroup],[role=radio],[role=slider],[role=listbox]')) return;
      if (event.key === 'ArrowRight') setAt(value => Math.min(total - 1, value + (value === 0 && wide ? 1 : step)));
      if (event.key === 'ArrowLeft') setAt(value => Math.max(0, value - step));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [total, step, wide]);
  // A11Y-fix #5: Back or Next goes disabled at either end. If it had focus, hand focus to the other one.
  const pager = useRef<HTMLElement>(null);
  useHandOff(pager, at);
  if (error) return <Shell look={false} back="/" backLabel="Home"><Failed text={error} what="That comic book" onRetry={tryAgain} retrying={retrying}/></Shell>;
  if (!data) return <Shell><Loading label="Loading the comic book"/></Shell>;
  if (!data.panels.length) return <Shell title={<span className="ct-reader__crumb">{data.title}</span>} back={`/recap/${data.id}`} backLabel="Recap"><EmptyIssue issue={data} what="this comic book"/></Shell>;
  const pages = toPages(comicScenes(data.panels));
  const leaves: ReactNode[] = [
    <BookCover key="cover" issue={data}/>,
    ...pages.map((page, index) => <ComicPage key={index} panels={page} number={index + 1}/>),
    <div key="end" className="ct-book__end"><span className="ct-art ct-book__endart" data-look={look} data-tone="grey" aria-hidden="true"/><p className="ct-display">The end</p><p>Drawn live from chat{data.date && ` on ${data.date}`}.<br/>Every panel approved by @{data.channel}.</p>{data.sample && <Sample/>}</div>,
  ];
  // Spread: cover alone, then pairs (1–2, 3–4 …).
  const start = wide ? (at === 0 ? 0 : at % 2 === 1 ? at : at - 1) : at;
  const shown = wide && start !== 0 ? leaves.slice(start, start + 2) : [leaves[start]];
  const label = shown.length === 2 ? `Pages ${start}–${Math.min(start + 1, total - 1)} of ${total - 1}` : start === 0 ? 'Cover' : start === total - 1 ? 'Back page' : `Page ${start} of ${total - 2}`;
  const prev = () => setAt(Math.max(0, wide ? (start <= 1 ? 0 : start - 2) : start - 1));
  const next = () => setAt(Math.min(total - 1, wide ? (start === 0 ? 1 : start + 2) : start + 1));
  return <Shell title={<span className="ct-reader__crumb">{data.title}</span>} back={`/recap/${data.id}`} backLabel="Recap">
    <div className="ct-book">
      <div className="ct-book__spread" data-count={shown.length} aria-live="polite" aria-label={label}>{shown}</div>
      <nav className="ct-book__nav" aria-label="Pages" ref={pager}>
        <button type="button" className="ct-btn" onClick={prev} disabled={start === 0}><Arrow dir="left"/>Back</button>
        <span className="ct-book__where">{label}</span>
        <button type="button" className="ct-btn ct-btn--ink" onClick={next} disabled={start + shown.length >= total}>Next<Arrow/></button>
      </nav>
      <p className="ct-note ct-book__hint">Use the arrow keys to turn pages.</p>
    </div>
  </Shell>;
}

function BookCover({ issue }: { issue: IssueView }) {
  const ui = useUi();
  const lead = issue.panels.find(panel => panel.sfx) ?? issue.panels[0]!;
  return <article className="ct-book__cover" aria-label={`Cover: ${issue.title}`}>
    <LookArt panel={lead} look={ui.studio.look} eager/>
    <div className="ct-book__mast"><span className="ct-book__brand">ComicToons</span><span className="ct-book__no">No. 1{issue.date && <> · <span className="ct-nowrap">{issue.date}</span></>}</span></div>
    <h1 className="ct-book__title">{issue.title}</h1>
    <p className="ct-book__by">Starring @{issue.channel} and chat</p>
    {lead.sfx && <span className="ct-sfx ct-book__sfx" aria-hidden="true">{lead.sfx}</span>}
    {issue.sample && <span className="ct-book__sample">Sample issue</span>}
  </article>;
}

/**
 * Manga series, from GET /api/series/:id: one episode per chapter of this stream, each opening on its highlight.
 * The wire has no channel, date or per-channel list (GAP), so none is shown.
 */
export function Series({ route }: { route: Route }) {
  const adapter = useAdapter();
  const ui = useUi();
  const {mode}=useStudioMode();
  const id = route.id ?? ui.studio.recapUrl?.split('/').pop() ?? (mode==='sample'?DEFAULT_ISSUE:'');
  const look = ui.studio.look;
  const { data, error, retrying, tryAgain } = useRetry(useLoad(() => adapter.getSeries(id, look), [adapter, id, look]));
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, [data]);
  const episodeNav = useRef<HTMLDivElement>(null);
  useHandOff(episodeNav, at);
  if (error) return <Shell look={false} back="/" backLabel="Home"><Failed text={error} what="That series" onRetry={tryAgain} retrying={retrying}/></Shell>;
  if (!data) return <Shell><Loading label="Loading the series"/></Shell>;
  const episode = data.episodes[Math.min(at, data.episodes.length - 1)];
  return <Shell title={<span className="ct-reader__crumb">Series</span>} back={`/recap/${data.id}`} backLabel="Recap">
    <div className="ct-series" ref={root}>
      <header className="ct-series__head" data-reveal="up">
        <p className="ct-kicker">Chapters & episodes {data.sample && <Sample/>}</p>
        <h1 className="ct-display">{data.title}</h1>
        {episode && <p className="ct-series__lede">{data.episodes.length === 1 ? 'One complete story' : `${data.episodes.length} episodes`}. Read every scene in order, from the opening to the resolution.</p>}
      </header>
      {!episode ? <ScreenState kind="empty" title="No episodes yet" actions={<>
        <a className="ct-btn ct-btn--ink" href={href('/studio')}>Open the studio</a>
        <a className="ct-btn" href={href('/output')}>Bind it again</a>
      </>}>
        <p>A chapter collects episodes, and this one has no approved pages yet.</p>
        <p>Approve panels in the studio, then bind the issue again from Outputs.</p>
      </ScreenState>
        : <div className="ct-series__layout">
          <ol className="ct-episodes" aria-label="Episodes">
            {data.episodes.map((entry, index) => <li key={entry.number}>
              <button type="button" className="ct-episode" aria-current={index === at || undefined} onClick={() => setAt(index)}>
                <span className="ct-episode__art"><LookArt panel={entry.highlight} look={look}/></span>
                <span className="ct-episode__no">Episode {entry.number} · {entry.chapter}</span>
                <span className="ct-episode__title">{entry.title}</span>
                <span className="ct-episode__meta">{entry.panels.length} {entry.panels.length === 1 ? 'panel' : 'panels'}</span>
              </button>
            </li>)}
          </ol>
          <section className="ct-series__episode" aria-labelledby="ct-episode-title">
            <h2 id="ct-episode-title" className="ct-display">Episode {episode.number}</h2>
            <div className="ct-manga-pages">{toPages(comicScenes(episode.panels)).map((page, index) => <ComicPage key={index} panels={page} number={index + 1} title={index === 0 ? episode.title : undefined}/>)}</div>
            <p className="ct-note">Highlight: “{episode.highlight.caption}”{episode.highlight.chosenBy ? ` · chat chose it, ${episode.highlight.chosenBy.votes} votes` : ''}{episode.highlight.cameo ? ` · cameo by @${episode.highlight.cameo}` : ''}</p>
            <div className="ct-row" ref={episodeNav}>
              <button type="button" className="ct-btn" disabled={at === 0} onClick={() => setAt(at - 1)}><Arrow dir="left"/>Previous</button>
              <button type="button" className="ct-btn ct-btn--ink" disabled={at >= data.episodes.length - 1} onClick={() => setAt(at + 1)}>Next episode<Arrow/></button>
              <a className="ct-btn ct-btn--ghost" href={href(`/read/${data.id}`)}>Read the whole stream</a>
            </div>
          </section>
        </div>}
    </div>
  </Shell>;
}

/** Manga reader: one long vertical strip, made for phones. */
export function Reader({ route }: { route: Route }) {
  const [pageSize, setPageSize] = useState(4);
  const { data, error, retrying, tryAgain } = useIssue(route.id);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      if (bar.current) bar.current.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    };
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, [data]);
  if (error) return <Shell look={false} back="/" backLabel="Home"><Failed text={error} what="That episode" onRetry={tryAgain} retrying={retrying}/></Shell>;
  if (!data) return <Shell><Loading label="Loading the episode"/></Shell>;
  if (!data.panels.length) return <Shell title={<span className="ct-reader__crumb">{data.title}</span>} back={`/series/${data.id}`} backLabel="Series"><EmptyIssue issue={data} what="this episode"/></Shell>;
  const storyPages = toPages(comicScenes(data.storyPanels ?? data.panels), pageSize);
  return <Shell title={<span className="ct-reader__crumb">{data.title}</span>} back={`/series/${data.id}`} backLabel="Series">
    <div className="ct-progress" aria-hidden="true"><div ref={bar}/></div>
    <article className="ct-strip" aria-label={`${data.title}, ${storyPages.length} pages`}>
      <header className="ct-strip__head">
        <p className="ct-kicker">@{data.channel}{data.date && ` · ${data.date}`} {data.sample && <Sample/>}</p>
        <h1 className="ct-display">{data.title}</h1>
        <p>From the stream “{data.streamTitle}”.</p>
      </header>
      <p className="ct-note">{storyPages.length} pages · {(data.storyPanels ?? data.panels).length} scenes · {data.storyPanels ? 'A complete Sample story' : 'Your approved stream moments'}</p>
      <label className="ct-field ct-reader-density">Panels per page<select aria-label="Panels per page" value={pageSize} onChange={event=>setPageSize(Number(event.target.value))}>{[4,5,6].map(n=><option key={n}>{n}</option>)}</select></label>
      <div className="ct-manga-pages">{storyPages.map((page, index) => <ComicPage key={index} panels={page} number={index + 1}/>)}</div>
      <footer className="ct-strip__end">
        <p className="ct-display">The end</p>
        <p>{data.storyPanels ? "Every adventure deserves an ending. Thanks for reading." : `More stories when @${data.channel} goes live again.`}</p>
        <div className="ct-row"><a className="ct-btn ct-btn--ink" href={href(`/series/${data.id}`)}>All episodes</a><a className="ct-btn" href={href(`/book/${data.id}`)}>Collected book</a></div>
      </footer>
    </article>
  </Shell>;
}

/** Catch-up: for viewers and raiders who just arrived. */
export function CatchUp({ route }: { route: Route }) {
  const adapter = useAdapter();
  const ui = useUi();
  const [minutes, setMinutes] = useState(() => Number(route.params.get('minutes')) || 15);
  const releasedVersion = JSON.stringify(ui.studio.panels.map(panel => [panel.id, panel.imageUrl, panel.caption]));
  const { data, error, retrying, tryAgain } = useRetry(useLoad(() => adapter.getCatchup(minutes), [adapter, minutes, releasedVersion]));
  return <Shell title={<span className="ct-reader__crumb">Catch-up</span>}>
    <div className="ct-catchup">
      <header className="ct-catchup__head">
        <p className="ct-kicker">Just got here? {(data?.sample ?? adapter.kind === 'mock') && <Sample/>}</p>
        <h1 className="ct-display">Previously on…</h1>
        <div className="ct-catchup__pick">
          <span id="ct-mins">How much did you miss?</span>
          <div className="ct-seg" role="radiogroup" aria-labelledby="ct-mins">
            {[5, 15, 30].map(value => <button key={value} type="button" role="radio" aria-checked={minutes === value} onClick={() => setMinutes(value)}>{value} min</button>)}
          </div>
        </div>
      </header>
      {error ? <Failed text={error} what="The catch-up" onRetry={tryAgain} retrying={retrying} level={2}/>
        : !data ? <div className="ct-catchup__row" aria-busy="true"><p className="ct-sr" role="status" aria-live="polite">Loading the catch-up…</p>{[0, 1, 2].map(index => <div key={index} className="ct-skel ct-skel--panel" aria-hidden="true"/>)}</div>
        : !data.panels.length ? <ScreenState kind="empty" title="Nothing to catch up on yet" actions={<>
          {minutes < 30 && <button type="button" className="ct-btn ct-btn--ink" onClick={() => setMinutes(30)}>Show the last 30 min</button>}
          <a className="ct-btn" href={href('/')}>Go to the home page</a>
        </>}>
          <p>No panels were approved in the last {minutes} minutes{minutes < 30 ? '. A longer window may find some' : ''}.</p>
          <p>Streaming? Approve a panel in the studio and it shows up here for anyone who just arrived.</p>
        </ScreenState> : <>
        {data.raidLine && <p className="ct-catchup__raid">{data.raidLine}</p>}
        <ol className="ct-catchup__row" data-count={Math.min(3, data.panels.length)}>
          {data.panels.map((panel, index) => <li key={panel.id}><Panel panel={panel}/><p className="ct-catchup__cap"><span className="ct-catchup__n" aria-hidden="true">{index + 1}</span>{panel.caption}</p></li>)}
        </ol>
        <div className="ct-row ct-catchup__acts">
          {data.channel && <a className="ct-btn ct-btn--ink" href={`https://www.twitch.tv/${data.channel}`} target="_blank" rel="noopener noreferrer">Back to the stream on Twitch</a>}
          <a className="ct-btn" href={href(ui.studio.recapUrl??'/issues')}>{ui.studio.recapUrl?'Read the full issue':'Browse saved issues'}</a>
        </div>
      </>}
    </div>
  </Shell>;
}
