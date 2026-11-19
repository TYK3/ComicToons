import { useRef, useState, type KeyboardEvent } from 'react';
import type { LookId } from '../../data/adapter';
import { useAdapter, useLoad, useUi } from '../../data/store';
import { ComicPage } from '../../components/ComicPage';
import { LookArt, Panel, PanelTags } from '../../components/Panel';
import { Sample } from '../../components/Brand';
import { Arrow } from '../../components/Icons';
import { RetryButton, ScreenState } from '../../components/ScreenState';
import { href } from '../../router';
import { loadSampleSets, type SampleSet } from './sampleSets';
import { LookSwatches, lookChrome } from './LookSwatches';
import '../../styles/pages.css';
import '../../styles/readers.css';

/**
 * LANDING-2 "What it makes": three Sample streams (one per fixture), and for the one picked, the complete set it makes:
 * the Catch-up a raider sees mid-stream, the comic book bound when the stream ends, and the manga series.
 * Built from the same parts the readers use (Panel, LookArt, ComicPage and the reader classes in readers.css), fed
 * static Sample data from one loader (./sampleSets.ts). Every set is labelled Sample.
 */
export function SampleSets() {
  const adapter = useAdapter();
  const look = useUi().studio.look;
  const sets = useLoad(() => loadSampleSets(adapter, look), [adapter, look]);
  const [at, setAt] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = sets.data ?? [];
  const picked = list[Math.min(at, list.length - 1)];
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = list.length - 1;
    const next = event.key === 'ArrowRight' ? (at >= last ? 0 : at + 1) : event.key === 'ArrowLeft' ? (at <= 0 ? last : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    setAt(next);
    tabs.current[next]?.focus();
  };
  if (sets.error) return <ScreenState kind="error" compact className="ct-sets__state" title="The Sample sets didn’t load" actions={<>
    <RetryButton onRetry={() => { void adapter.refresh().finally(sets.retry); }} busy={sets.retrying}/>
    <a className="ct-btn" href={href('/studio')}>Open Studio</a>
  </>}><p>{sets.error} Check ComicToons is running on the studio computer, then try again.</p></ScreenState>;
  if (!sets.data) return <div className="ct-sets__tabs" aria-busy="true">
    <p className="ct-sr" role="status" aria-live="polite">Loading the Sample sets…</p>
    {[0, 1, 2].map(index => <div key={index} className="ct-sets__tab ct-skel" aria-hidden="true"/>)}
  </div>;
  if (!picked) return <ScreenState kind="empty" compact className="ct-sets__state" title="No Sample sets to show" actions={<a className="ct-btn ct-btn--ink" href={href('/studio')}>Open Studio</a>}>
    <p>The Sample streams have no approved panels here. Open the Studio and approve a few panels to see what a stream makes.</p>
  </ScreenState>;
  return <div className="ct-sets" data-look={look} style={lookChrome(look)}>
    <LookSwatches/>
    <div className="ct-sets__tabs" role="tablist" aria-label="Sample streams" onKeyDown={onKey} data-count={list.length}>
      {list.map((set, index) => <button key={set.id} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`ct-set-tab-${set.fixtureId}`}
        aria-selected={set === picked} aria-controls="ct-set-panel" tabIndex={set === picked ? 0 : -1} className="ct-sets__tab" onClick={() => setAt(index)}>
        <span className="ct-sets__thumb"><LookArt panel={set.comicBook.cover} look={look} eager/></span>
        <span className="ct-sets__name">{set.title}</span>
        <span className="ct-sets__by"><span>@{set.channel}</span><Sample/></span>
      </button>)}
    </div>
    <div className="ct-sets__panel" role="tabpanel" id="ct-set-panel" aria-labelledby={`ct-set-tab-${picked.fixtureId}`} data-set={picked.fixtureId}>
      <p className="ct-sets__intro"><Sample label="Sample set"/> <span>Made from the Sample stream “{picked.streamTitle}” by @{picked.channel}. The streamer, chat and art are all made up.</span></p>
      <CatchUpPart set={picked}/>
      <BookPart set={picked} look={look}/>
      <SeriesPart set={picked} look={look}/>
    </div>
  </div>;
}

function PartHead({ id, when, title, text, to, open }: { id: string; when: string; title: string; text: string; to: string; open: string }) {
  return <header className="ct-part__head">
    <p className="ct-part__when">{when}</p>
    <h3 id={id} className="ct-display ct-part__title">{title}</h3>
    <p className="ct-part__text">{text}</p>
    <a className="ct-btn ct-btn--sm ct-part__open" href={href(to)}>{open}<Arrow/></a>
  </header>;
}

/** The Catch-up screen's body (Readers.tsx CatchUp): Previously on…, the raid line and the last three panels. */
function CatchUpPart({ set }: { set: SampleSet }) {
  const { catchup } = set;
  return <section className="ct-part ct-part--catchup" aria-labelledby="ct-part-catchup">
    <PartHead id="ct-part-catchup" when="During the stream" title="Catch-up" text="Raiders and latecomers get the story so far in three panels, without leaving the stream." to="/catchup" open="Open the Catch-up screen"/>
    <div className="ct-part__frame ct-catchup">
      <div className="ct-catchup__head">
        <p className="ct-kicker">Just got here? <Sample/></p>
        <p className="ct-display ct-part__prev">Previously on…</p>
      </div>
      {catchup.raidLine && <p className="ct-catchup__raid">{catchup.raidLine}</p>}
      <ol className="ct-catchup__row" data-count={Math.min(3, catchup.panels.length)}>
        {catchup.panels.map((panel, index) => <li key={panel.id}><Panel panel={panel} tags={false} eager/>{index === 0 && <PanelTags panel={panel} className="ct-part__tags"/>}<p className="ct-catchup__cap"><span className="ct-catchup__n" aria-hidden="true">{index + 1}</span>{panel.caption}</p></li>)}
      </ol>
      <p className="ct-part__foot">@{catchup.channel} · last {catchup.minutes} minutes · {catchup.panels.length} approved panels</p>
    </div>
  </section>;
}

/** The comic book (Readers.tsx Book): the cover, every page, and the back page. */
function BookPart({ set, look }: { set: SampleSet; look: LookId }) {
  const { cover, pages } = set.comicBook;
  const leaves = pages.length + 2;
  // LANDING-3 MF2: the back page shows the book's last panel as its art, so it reads as a back cover, not an empty card.
  const endArt = pages.at(-1)?.at(-1) ?? cover;
  return <section className="ct-part ct-part--book" aria-labelledby="ct-part-book">
    <PartHead id="ct-part-book" when="When the stream ends" title="Comic book" text={`The whole stream, bound into ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} with a cover and a back page.`} to={`/book/${set.id}`} open="Read the full comic book"/>
    <ol className="ct-part__leaves" data-count={leaves} aria-label={`${set.title}: cover, ${pages.length} pages and the back page`}>
      <li><article className="ct-book__cover ct-part__cover" aria-label={`Cover: ${set.title}`}>
        <LookArt panel={cover} look={look}/>
        <div className="ct-book__mast"><span className="ct-book__brand">ComicToons</span><span className="ct-book__no">No. 1</span></div>
        <p className="ct-book__title">{set.title}</p>
        <p className="ct-book__by">Starring @{set.channel} and chat</p>
        {cover.sfx && <span className="ct-sfx ct-book__sfx" aria-hidden="true">{cover.sfx}</span>}
        <span className="ct-book__sample">Sample issue</span>
      </article></li>
      {pages.map((page, index) => <li key={index}><ComicPage panels={page} number={index + 1}/></li>)}
      <li><div className="ct-book__end ct-part__end"><span className="ct-book__endart" aria-hidden="true"><LookArt panel={endArt} look={look}/></span><p className="ct-display">The end</p><p>Drawn live from chat.<br/>Every panel approved by @{set.channel}.</p><Sample/></div></li>
    </ol>
  </section>;
}

/** The manga series (Readers.tsx Series): one episode per chapter of the stream, each opening on its highlight. */
function SeriesPart({ set, look }: { set: SampleSet; look: LookId }) {
  const { volumes } = set.manga;
  return <section className="ct-part ct-part--series" aria-labelledby="ct-part-series">
    <PartHead id="ct-part-series" when="Stream after stream" title="Manga series" text={`${volumes.length === 1 ? 'One episode' : `${volumes.length} episodes`}, one for each chapter of the stream. Each opens on the moment chat liked most.`} to={`/series/${set.id}`} open="Read the full series"/>
    <ol className="ct-part__episodes" data-count={volumes.length}>
      {volumes.map(volume => <li key={volume.number} className="ct-part__episode">
        <div className="ct-part__ephead">
          <span className="ct-part__epart"><LookArt panel={volume.highlight} look={look}/></span>
          <span>
            <span className="ct-episode__no">Episode {volume.number} · {volume.chapter}</span>
            <h4 className="ct-episode__title">{volume.title}</h4>
          </span>
        </div>
        {volume.pages.map((page, index) => <ComicPage key={index} panels={page} number={index + 1} className="ct-part__page"/>)}
        <p className="ct-note">Highlight: “{volume.highlight.caption}”{volume.highlight.chosenBy ? ` · chat chose it, ${volume.highlight.chosenBy.votes} votes` : ''}</p>
      </li>)}
    </ol>
  </section>;
}
