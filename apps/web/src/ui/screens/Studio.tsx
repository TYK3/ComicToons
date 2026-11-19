import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { timecode } from '../../types';
import type { OutputMode, UiPanel } from '../data/adapter';
import { studioPhase, useAdapter, useUi } from '../data/store';
import { RetryButton, ScreenState } from '../components/ScreenState';
import { AppBar, ConnectionBanner } from '../components/AppBar';
import { Panel, PanelTags } from '../components/Panel';
import { gridColumns } from '../gridColumns';
import { Sample } from '../components/Brand';
import { TwitchErrorBanner } from '../components/TwitchConnect';
import { href } from '../router';
import { Toolbar } from './studio/Toolbar';
import { EventSubBanner } from './studio/EventSub';
import { ChatCard, InkMeCard, PredictionCard, SafetyCard, VoteCard, useFocusRescue } from './studio/Participation';
import { nextUpPanel } from './studio/live';
import { MakeFromLink } from './studio/MakeFromLink';
import '../styles/studio.css';

const SHORTCUTS_KEY = 'comictoons-ui-keyboard-shortcuts';

type Filter = 'all' | 'waiting' | 'onair';
interface Toast { text: string; token?: string }

export function Studio() {
  const ui = useUi();
  const adapter = useAdapter();
  const { studio } = ui;
  const [filter, setFilter] = useState<Filter>('all');
  const [toast, setToast] = useState<Toast | null>(null);
  const [editing, setEditing] = useState<UiPanel | null>(null);
  const [ending, setEnding] = useState(false);
  const [shortcuts, setShortcuts] = useState(() => {
    try { return localStorage.getItem(SHORTCUTS_KEY) !== 'off'; } catch { return true; }
  });
  const toggleShortcuts = (on: boolean) => {
    setShortcuts(on);
    try { localStorage.setItem(SHORTCUTS_KEY, on ? 'on' : 'off'); } catch { /* this tab only */ }
  };
  // UI-LIVE-B #4: the panel the server says is next (a mod's !ink yes or the A key), not simply the oldest.
  const next = nextUpPanel(studio);

  const rescue = useFocusRescue();
  const grid = useRef<HTMLOListElement>(null);
  const act = async (kind: 'approve' | 'reject', panel = next) => {
    if (!panel) return;
    const result = kind === 'approve' ? await adapter.approve(panel.id) : await adapter.reject(panel.id);
    setToast({ text: kind === 'approve' ? 'Panel is on air.' : 'Panel rejected. It won’t reach the overlay.', token: result.undoToken });
  };
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // A11Y-fix #2: approving or rejecting removes the focused control. Hand focus on rather than drop it to the page.
  const enabled = (element: HTMLElement | null | undefined) => element && !(element as HTMLButtonElement).disabled ? element : null;
  const fromDesk = (kind: 'approve' | 'reject') => {
    rescue(() => enabled(document.querySelector<HTMLElement>('.ct-desk__acts .ct-btn--ink')) ?? document.getElementById('ct-desk-idle'));
    void act(kind);
  };
  const fromCell = (kind: 'approve' | 'reject', panel: UiPanel, index: number) => {
    rescue(() => {
      const cells = [...(grid.current?.querySelectorAll<HTMLButtonElement>('.ct-cell__acts .ct-btn--ink') ?? [])];
      return cells.length ? cells[Math.min(index, cells.length - 1)] : document.querySelector<HTMLElement>('.ct-toast button') ?? document.getElementById('ct-grid-title');
    });
    void act(kind, panel);
  };
  const fromBar = (kind: 'approve' | 'reject') => {
    rescue(() => enabled(document.querySelector<HTMLElement>('.ct-mobilebar .ct-btn:nth-child(2)')) ?? document.querySelector<HTMLElement>('.ct-mobilebar .ct-btn--panic'));
    void act(kind);
  };

  const items = useMemo(() => {
    const tag = (list: UiPanel[], status: 'Waiting' | 'On air') => list.map(panel => ({ panel, status }));
    const waiting = tag(studio.pendingPanels, 'Waiting');
    const onair = tag([...studio.panels].reverse(), 'On air');
    return { all: [...waiting, ...onair], waiting, onair };
  }, [studio.pendingPanels, studio.panels]);
  const shown = items[filter];
  // A11Y-fix #1: A / R / E work page-wide, except while typing or when a dialog is open.
  useEffect(() => {
    if (!next || !shortcuts) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]')) return;
      if (editing || ending || document.querySelector('dialog[open]')) return;
      const key = event.key.toLowerCase();
      if (key !== 'a' && key !== 'r' && key !== 'e') return;
      event.preventDefault();
      const cell = event.target instanceof Element ? event.target.closest('.ct-cell') : null;
      if (cell && cell.getAttribute('data-status') !== 'Waiting') return;
      const index = cell ? [...(grid.current?.children ?? [])].indexOf(cell) : -1;
      const panel = index >= 0 ? shown[index]?.panel : next;
      if (!panel) return;
      if (key === 'e') setEditing(panel);
      else {
        const kind = key === 'a' ? 'approve' : 'reject';
        if (ui.busy !== kind) {
          if (cell) fromCell(kind, panel, index);
          else fromDesk(kind);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, shortcuts, editing, ending, ui.busy, fromDesk, fromCell, shown]);

  // UI3: loading (skeletons), error (the studio never answered: no data, Try again), empty (no stream yet), ready.
  const phase = studioPhase(ui);
  const noStream = phase === 'empty' && studio.status === 'idle';
  const startSample = () => void adapter.replay(studio.fixtureId || ui.fixtures[0]?.id || '');

  return <div className="ct-app ct-studio">
    <a className="ct-skip" href="#ct-main">Skip to panels</a>
    <AppBar current="studio" onEnd={() => setEnding(true)}/>
    {/* UI3: no source, Twitch or Look controls until the studio has answered: they would act on nothing. */}
    {(phase === 'ready' || phase === 'empty') && <>
      <Toolbar/>
      <TwitchErrorBanner/>
      <EventSubBanner/>
    </>}
    {phase !== 'error' && <ConnectionBanner/>}
    {studio.hidden && <div className="ct-banner ct-on-ink ct-banner--hidden" role="status">
      <p><strong>Overlay hidden.</strong> Viewers see nothing from ComicToons until you show it again. Panels keep arriving here.</p>
      <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.panicHide(false)}>Show overlay</button>
    </div>}

    {phase === 'error' ? <main id="ct-main" className="ct-studio__state" tabIndex={-1}>
      <ScreenState kind="error" level={1} title="The studio didn’t answer" actions={<>
        <RetryButton onRetry={() => void adapter.refresh()} busy={ui.busy === 'refresh'}/>
        <a className="ct-btn" href={href('/')}>Go to the home page</a>
      </>}>
        <p>{ui.error || 'ComicToons couldn’t reach the studio server on this computer.'}</p>
        <p>Check the ComicToons window that started the studio is still open, then try again. Nothing on your stream has changed.</p>
      </ScreenState>
    </main> : <div className="ct-studio__layout">
      <main id="ct-main" className="ct-studio__main" tabIndex={-1}>
        {phase === 'loading' && <p className="ct-sr" role="status" aria-live="polite">Loading your studio…</p>}
        <header className="ct-studio__head">
          {studio.issueTitle || phase !== 'ready' ? <div>
            {/* UI-HEAD #8: an idle studio with no panels has no stream yet, even with a Sample title loaded. */}
            <p className="ct-kicker">{noStream ? 'No stream yet' : studio.streamTitle ? `${studio.streamTitle} · Issue in progress` : phase === 'loading' ? 'Loading…' : 'No stream yet'} {!noStream && studio.streamTitle && ui.studio.source.active !== 'twitch' && <Sample/>}</p>
            <h1 className="ct-display">{noStream ? 'Ready when you are' : studio.issueTitle || (phase === 'loading' ? 'Studio' : 'Ready when you are')}</h1>
          </div> : <div><h1 className="ct-display">Studio</h1></div>}
          {/* W3: while loading, no real numbers anywhere. */}
          <dl className="ct-stats" aria-busy={ui.loading || undefined}>
            {([['On air', studio.panels.length], ['Waiting', studio.pendingPanels.length], ['This hour', `${studio.budget.used}/${studio.budget.perHour}`], ['Stream', timecode(studio.elapsed)]] as const).map(([label, value]) =>
              <div key={label}><dt>{label}</dt><dd>{ui.loading ? <><span className="ct-skel ct-skel--stat" aria-hidden="true"/><span className="ct-sr">Loading</span></> : value}</dd></div>)}
          </dl>
        </header>

        {ui.loading ? <LoadingDesk/> : phase === 'empty' ? null : <Desk shortcuts={shortcuts} panel={next} more={studio.pendingPanels.length - 1} approval={studio.approvalMode} busy={ui.busy} modApprove={ui.participation.rules.modApprove}
          onApprove={() => fromDesk('approve')} onReject={() => fromDesk('reject')} onEdit={() => next && setEditing(next)}/>}

        <section className="ct-grid-wrap" aria-labelledby="ct-grid-title">
          <div className="ct-grid-head">
            <h2 id="ct-grid-title" className="ct-display" tabIndex={-1}>Panels</h2>
            <div className="ct-seg ct-filters" role="radiogroup" aria-label="Show panels">
              {([['all', 'All'], ['waiting', 'Waiting'], ['onair', 'On air']] as const).map(([id, label]) =>
                <button key={id} type="button" role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}>{label} <span className="ct-count">{ui.loading ? '–' : items[id].length}</span></button>)}
            </div>
          </div>
          {ui.loading ? <div className="ct-grid" data-count={4}>{[0, 1, 2, 3].map(index => <div key={index} className="ct-skel ct-skel--panel" aria-hidden="true"/>)}</div>
            : shown.length ? <ol ref={grid} className="ct-grid" data-count={shown.length} data-cols={gridColumns(shown.length)} aria-label={`${shown.length} panels`}>
              {shown.map(({ panel, status }, index) => <li key={panel.id} className="ct-cell" data-status={status} data-next={(status === 'Waiting' && panel.id === next?.id) || undefined}>
                <Panel panel={panel} tags={false}/>
                <PanelTags panel={panel} className="ct-cell__tags"/>
                <div className="ct-cell__meta">
                  <p className="ct-cell__time">{status === 'Waiting' && panel.id === next?.id ? <strong>Next up</strong> : status} · {timecode(panel.at)}</p>
                  {status === 'On air' && <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => setEditing(panel)}>Edit caption</button>}
                  {status === 'Waiting' && <div className="ct-cell__acts">
                    <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => fromCell('approve', panel, index)}>Approve</button>
                    <button type="button" className="ct-btn ct-btn--sm" onClick={() => fromCell('reject', panel, index)}>Reject</button>
                  </div>}
                </div>
              </li>)}
            </ol>
              : phase === 'empty' ? <ScreenState kind="empty" compact title="No panels yet" actions={<>
                <button type="button" className="ct-btn ct-btn--ink" onClick={startSample} disabled={ui.busy === 'replay' || !ui.fixtures.length}>{ui.busy === 'replay' ? 'Starting…' : 'Start the Sample replay'}</button>
                <a className="ct-btn" href={href('/connect')}>Connect Twitch</a>
              </>}>
                <p>Go live with Twitch connected and the first big moment from chat lands here for you to approve.</p>
                <p>Not streaming yet? The Sample replay shows how it works, with made-up chat.</p>
              </ScreenState>
              : <p className="ct-empty">{filter === 'waiting' ? 'Nothing waiting. The next moment from chat will appear here.' : 'No panels yet. The first one lands when chat gets going.'}</p>}
        </section>

        <MakeFromLink/>
      </main>

      <SideColumn loading={ui.loading}>
        {ui.loading ? <LoadingSide/> : <>
          <OnAirCard/>
          <VoteCard/>
          <InkMeCard/>
          <PredictionCard/>
          <SafetyCard/>
          <ChatCard/>
          <EditorCard shortcuts={shortcuts} onShortcuts={toggleShortcuts}/>
          <EndCard onEnd={() => setEnding(true)}/>
        </>}
      </SideColumn>
    </div>}

    {phase !== 'error' && <nav className="ct-mobilebar ct-on-ink" aria-label="Quick actions">
      <button type="button" className="ct-btn ct-btn--panic" aria-pressed={studio.hidden} onClick={() => void adapter.panicHide(!studio.hidden)}>{studio.hidden ? 'Show overlay' : 'Panic hide'}</button>
      <button type="button" className="ct-btn" disabled={!next} onClick={() => fromBar('approve')}>Approve</button>
      <button type="button" className="ct-btn ct-btn--ghost-ink" disabled={!next} onClick={() => fromBar('reject')}>Reject</button>
    </nav>}

    {toast && <div className="ct-toast" role="status">
      <span>{toast.text}</span>
      {toast.token && <button type="button" className="ct-btn ct-btn--sm" onClick={() => { void adapter.undo(toast.token!); setToast({ text: 'Undone.' }); }}>Undo</button>}
    </div>}
    {editing && <EditDialog panel={editing} onClose={() => setEditing(null)}/>}
    {ending && <EndDialog onClose={() => setEnding(false)}/>}
  </div>;
}

function Desk({ shortcuts, panel, more, approval, busy, modApprove, onApprove, onReject, onEdit }: { shortcuts: boolean; panel?: UiPanel; more: number; approval: boolean; busy: string; modApprove: boolean; onApprove: () => void; onReject: () => void; onEdit: () => void }) {
  if (!panel) return <section className="ct-desk ct-desk--idle" id="ct-desk-idle" aria-label="Waiting for approval" tabIndex={-1}>
    <span className="ct-desk__pip" aria-hidden="true"/>
    <p><strong>Nothing to review.</strong> The writer is watching chat. The next panel lands here for your OK{approval ? '' : ', or goes straight on air while you’re not the editor'}.</p>
  </section>;
  return <section className="ct-desk" aria-labelledby="ct-desk-title" aria-describedby="ct-desk-keys" tabIndex={-1}>
    <div className="ct-desk__art"><Panel panel={panel} eager/></div>
    <div className="ct-desk__body">
      <p className="ct-kicker" data-next-up={panel.id}>Next up · waiting for you{more > 0 ? ` · ${more} more behind it` : ''}</p>
      <h2 id="ct-desk-title" className="ct-desk__cap">{panel.caption}</h2>
      {panel.cameo && <p className="ct-note">Cameo for @{panel.cameo}.</p>}
      <p className="ct-note">Nothing reaches the overlay until you approve it.{modApprove ? ' A mod’s !ink yes approves this panel and !ink no rejects it.' : ''} <span id="ct-desk-keys">{shortcuts ? 'Keys A, R and E act on the focused waiting panel, or the next-up panel, except while typing or in a dialog.' : 'Keyboard shortcuts are off.'}</span></p>
      <div className="ct-desk__acts">
        <button type="button" className="ct-btn ct-btn--ink" onClick={onApprove} disabled={busy === 'approve'} aria-keyshortcuts="A">Approve <kbd>A</kbd></button>
        <button type="button" className="ct-btn" onClick={onReject} disabled={busy === 'reject'} aria-keyshortcuts="R">Reject <kbd>R</kbd></button>
        <button type="button" className="ct-btn ct-btn--ghost" onClick={onEdit} aria-keyshortcuts="E">Edit caption <kbd>E</kbd></button>
      </div>
    </div>
  </section>;
}

/**
 * W6: on wide screens the side column scrolls inside a sticky box. While more cards sit below the fold it fades out
 * at the bottom (data-more) and says how many, so nothing looks clipped; the fade goes once you reach the end.
 */
function SideColumn({ loading, children }: { loading: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState(0);
  const [stop, setStop] = useState(false);
  useEffect(() => {
    const side = ref.current;
    if (!side) return;
    const update = () => {
      const scrollable = side.scrollHeight - side.clientHeight > 4 && getComputedStyle(side).overflowY !== 'visible';
      const bottom = side.getBoundingClientRect().bottom;
      const hidden = scrollable ? [...side.children].filter(child => child.getBoundingClientRect().top > bottom - 24).length : 0;
      // A11Y-fix #8: a scrolling column with nothing focusable in it (the loading state) takes a Tab stop so keys can scroll it.
      setStop(scrollable && !side.querySelector('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
      setMore(scrollable && side.scrollTop + side.clientHeight < side.scrollHeight - 4 ? Math.max(1, hidden) : 0);
    };
    update();
    side.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(side);
    for (const child of side.children) observer?.observe(child);
    return () => { side.removeEventListener('scroll', update); removeEventListener('resize', update); observer?.disconnect(); };
  }, [loading]);
  return <div className="ct-side-wrap" data-more={more || undefined}>
    <aside ref={ref} className="ct-side" aria-label="On air and audience" aria-busy={loading || undefined} tabIndex={stop ? 0 : undefined}>{children}</aside>
    {more > 0 && <p className="ct-side__more" aria-hidden="true">{more} more {more === 1 ? 'card' : 'cards'} below ↓</p>}
  </div>;
}

function LoadingSide() {
  return <>{['On air', 'Chat votes the bubble', 'Ink me'].map(title => <section key={title} className="ct-card ct-side-card" aria-label={`${title}, loading`}>
    <header className="ct-card__head ct-on-ink"><h2>{title}</h2></header>
    <div className="ct-card__body"><div className="ct-skel ct-skel--panel"/><div className="ct-skel ct-skel--line"/><div className="ct-skel ct-skel--line ct-skel--short"/></div>
  </section>)}</>;
}

function LoadingDesk() {
  return <section className="ct-desk" aria-busy="true" aria-label="Loading the studio">
    <div className="ct-desk__art"><div className="ct-skel ct-skel--panel"/></div>
    <div className="ct-desk__body"><p className="ct-kicker">Loading the studio…</p><div className="ct-skel ct-skel--line"/><div className="ct-skel ct-skel--line ct-skel--short"/></div>
  </section>;
}

function OnAirCard() {
  const ui = useUi();
  const latest = ui.studio.panels.slice(-3).reverse();
  return <section className="ct-card ct-side-card ct-onair" aria-labelledby="ct-onair-title">
    <header className="ct-card__head ct-on-ink"><h2 id="ct-onair-title">On air</h2><a className="ct-head-link" href={href('/overlay')}>Open overlay</a></header>
    <div className="ct-card__body">
      <div className="ct-minipage" data-hidden={ui.studio.hidden || undefined} data-count={latest.length}>
        {ui.studio.hidden ? <p className="ct-minipage__hidden">Hidden from viewers</p>
          : latest.length ? latest.map((panel, index) => <Panel key={panel.id} panel={panel} tags={false} lettering={index === 0} className={index === 0 ? 'ct-mini--lead' : 'ct-mini'}/>)
            : <p className="ct-minipage__hidden">Your first approved panel shows here</p>}
      </div>
      <p className="ct-note">What viewers see in the OBS browser source, in the current Look.</p>
    </div>
  </section>;
}

function EditorCard({ shortcuts, onShortcuts }: { shortcuts: boolean; onShortcuts: (on: boolean) => void }) {
  const ui = useUi();
  const adapter = useAdapter();
  const on = ui.studio.approvalMode;
  return <section className="ct-card ct-side-card" aria-labelledby="ct-editor-title">
    <header className="ct-card__head ct-on-ink"><h2 id="ct-editor-title">You’re the editor</h2></header>
    <div className="ct-card__body">
      <label className="ct-switch">
        <input type="checkbox" role="switch" checked={on} onChange={event => void adapter.setApprovalMode(event.target.checked)}/>
        <span className="ct-switch__track" aria-hidden="true"/>
        <span><strong>{on ? 'Every panel waits for you' : 'Panels go straight on air'}</strong><span className="ct-note"> {on ? 'Approve, reject or edit before viewers see anything.' : 'Panic hide still blanks the overlay at once.'}</span></span>
      </label>
      <label className="ct-switch">
        <input type="checkbox" role="switch" checked={shortcuts} onChange={event => onShortcuts(event.target.checked)}/>
        <span className="ct-switch__track" aria-hidden="true"/>
        <span>Keyboard shortcuts</span>
      </label>
    </div>
  </section>;
}

function EndCard({ onEnd }: { onEnd: () => void }) {
  const ui = useUi();
  const pages = Math.max(1, Math.ceil(ui.studio.panels.length / 4));
  return <section className="ct-card ct-side-card" aria-labelledby="ct-end-title">
    <header className="ct-card__head ct-on-ink"><h2 id="ct-end-title">When the stream ends</h2></header>
    <div className="ct-card__body">
      <p className="ct-note">Your {ui.studio.panels.length} approved panels become a {pages}-page comic issue, a manga series and a catch-up for anyone who missed it.</p>
      <div className="ct-row">
        <a className="ct-btn ct-btn--sm" href={href('/output')}>See the outputs</a>
        <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={onEnd}>End stream…</button>
      </div>
    </div>
  </section>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // A11Y-fix #3: remember the control that opened the dialog and give focus back to it on close.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!opener.current) opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      const back = opener.current;
      if (back?.isConnected && !ref.current?.isConnected) back.focus();
    };
  }, []);
  return <dialog ref={ref} className="ct-dialog" aria-labelledby="ct-dialog-title" onClose={onClose} onCancel={onClose}>
    <div className="ct-dialog__body"><h2 id="ct-dialog-title">{title}</h2>{children}</div>
  </dialog>;
}

function EditDialog({ panel, onClose }: { panel: UiPanel; onClose: () => void }) {
  const adapter = useAdapter();
  const [text, setText] = useState(panel.caption);
  return <Modal title="Edit caption" onClose={onClose}>
    <form method="dialog" className="ct-dialog__form" onSubmit={() => { void adapter.editCaption(panel.id, text.trim() || panel.caption); }}>
      <Panel panel={{ ...panel, caption: text }} tags={false}/>
      <label className="ct-field">Caption<textarea rows={3} value={text} maxLength={140} onChange={event => setText(event.target.value)} autoFocus/></label>
      <p className="ct-note">{140 - text.length} characters left. The overlay updates when you save.</p>
      <div className="ct-dialog__actions">
        <button type="button" className="ct-btn ct-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="ct-btn ct-btn--ink">Save caption</button>
      </div>
    </form>
  </Modal>;
}

function EndDialog({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const adapter = useAdapter();
  const [title, setTitle] = useState(ui.studio.issueTitle);
  const [modes, setModes] = useState<OutputMode[]>(['book', 'series', 'catchup']);
  const toggle = (mode: OutputMode) => setModes(list => list.includes(mode) ? list.filter(entry => entry !== mode) : [...list, mode]);
  return <Modal title="End the stream?" onClose={onClose}>
    <form className="ct-dialog__form" onSubmit={event => { event.preventDefault(); void adapter.endStream(title, modes, ui.studio.look).then(() => { location.hash = href('/output').slice(1); }); }}>
      <p className="ct-note">The overlay stops and your {ui.studio.panels.length} approved panels are bound into what you pick. Waiting panels are dropped.</p>
      <label className="ct-field">Issue title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={60}/></label>
      <fieldset className="ct-checks"><legend>Make</legend>
        {([['book', 'Comic book issue'], ['series', 'Manga series episode'], ['catchup', 'Catch-up for latecomers']] as const).map(([mode, label]) =>
          <label key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={() => toggle(mode)}/>{label}</label>)}
      </fieldset>
      <div className="ct-dialog__actions">
        <button type="button" className="ct-btn ct-btn--ghost" onClick={onClose}>Keep streaming</button>
        <button type="submit" className="ct-btn ct-btn--ink" disabled={!modes.length || ui.busy === 'end'}>End stream and bind</button>
      </div>
    </form>
  </Modal>;
}
