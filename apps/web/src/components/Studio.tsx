import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Toggle from '@radix-ui/react-toggle';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowDownToLine, ArrowUpRight, BookOpen, Check, ChevronRight, Copy, ExternalLink, Eye, Keyboard, Layers3, Palette, Pencil, Play, Radio, RotateCcw, ShieldCheck, Square, WandSparkles, WifiOff, X } from 'lucide-react';
import type { Panel, StudioState } from '../types';
import { timecode } from '../types';
import type { Studio as StudioController } from '../hooks/useStudio';
import { Brand, Button, EmptyArt, Tip, useNotify } from './ui';
import { MangaPage } from './MangaPage';
import {ChatSourceControl} from './ChatSource';
import {MangaThemeControl} from './MangaThemeControl';
import {chatSourceLabel,isSampleSource} from '@comictoons/core';
import {OutputModes} from './OutputModes';
import {ParticipationPanel} from './ParticipationPanel';

function Sidebar({ recapUrl, sample = true }: { recapUrl?: string; sample?: boolean }) {
  return <aside className="sidebar">
    <Brand/>
    <nav aria-label="Studio navigation">
      <a href="/studio" className="nav-link nav-active" aria-current="page"><Radio size={19}/><span>Live studio</span></a>
      <a href={recapUrl || '#recap-builder'} className="nav-link"><BookOpen size={19}/><span>Recap issue</span></a>
      <a href="/ui.html#/overlay" target="_blank" rel="noreferrer" className="nav-link"><ExternalLink size={19}/><span>OBS overlay</span></a>
    </nav>
    <div className="sidebar-bottom">
      <span className="demo-badge"><span/>{sample ? 'KEYLESS DEMO' : 'READ-ONLY CHAT'}</span>
      <p>Made live.<br/><em>Remembered in ink.</em></p>
      <div className="creator"><span className="creator-avatar">P</span><div>ComicToons studio<span>{sample ? 'AI comic art. Invented chat.' : 'Live chat. Original illustrations.'}</span></div></div>
    </div>
  </aside>;
}

function ConnectionBanner({ studio }: { studio: StudioController }) {
  if (!studio.error) return null;
  return <div className="connection-banner" role="alert"><WifiOff size={20}/><div><strong>{studio.offline ? 'The studio is reconnecting.' : 'That change couldn’t be saved.'}</strong><p>{studio.error}</p></div><Button variant="ghost" onClick={() => void studio.refresh()}>Retry</Button></div>;
}

function Transport({ studio, fixtureId, setFixtureId, speed, setSpeed, style }: {
  studio: StudioController; fixtureId: string; setFixtureId: (id: string) => void;
  speed: number; setSpeed: (speed: number) => void; style: string;
}) {
  const notify = useNotify();
  const { state, busy, fixtures } = studio;
  const playing = state.status === 'replaying';
  async function changeSpeed(next: number) {
    setSpeed(next);
    if (playing) {
      try { await studio.mutate('/api/settings', { speed: next }); notify({ message: `Replay speed set to ${next}×.` }); } catch { /* Shown in connection banner. */ }
    }
  }
  async function start() {
    try {
      await studio.mutate('/api/replay', { fixtureId, speed, style });
      notify({ message: 'Replay rolling. Your first moment is on its way.' });
    } catch { /* Shown in connection banner. */ }
  }
  return <section className="transport" aria-label="Replay controls">
    <div className="fixture-field"><label htmlFor="fixture">Sample stream</label><select id="fixture" value={fixtureId} onChange={e => setFixtureId(e.target.value)} disabled={!!busy}>
      {(fixtures.length ? fixtures : [{ id: 'tabletop-night', streamTitle: 'Tabletop night' }]).map(f => <option key={f.id} value={f.id}>{f.streamTitle}</option>)}
    </select></div>
    <div className="speed-field"><span className="field-label" id="speed-label">Replay speed</span><div className="speed-segmented" role="group" aria-labelledby="speed-label">
      {[1, 10, 60].map(value => <button key={value} aria-pressed={speed === value} disabled={!!busy} onClick={() => void changeSpeed(value)}>{value}×</button>)}
    </div></div>
    <Button variant="primary" className="start-replay" loading={busy === '/api/replay'} disabled={!!busy || studio.offline} onClick={() => void start()}>
      {playing ? <RotateCcw size={17}/> : <Play size={17} fill="currentColor"/>}{playing ? 'Restart replay' : 'Start replay'}
    </Button>
  </section>;
}

function LivePreview({ studio, onCopy }: { studio: StudioController; onCopy: () => void }) {
  const { state, loading } = studio;
  const panels = state.panels;
  const progress = state.duration ? Math.min(100, (state.elapsed || 0) / state.duration * 100) : 0;
  return <section className="live-preview" aria-labelledby="preview-title">
    <div className="preview-toolbar"><h2 id="preview-title"><span className={`status-dot ${panels.length ? 'is-live' : ''}`}/>On-air comic</h2><div className="preview-format">OBS browser source <span>1920 × 1080</span></div></div>
    <div className={`preview-stage ${panels.length ? 'has-panels' : ''}`} aria-live="polite" aria-atomic="false" aria-busy={loading}>
      {loading ? <div className="preview-loading skeleton" data-testid="loading-skeleton" role="status"><div/><div/><div/><span>Opening your studio…</span></div> : panels.length ? <>
        <MangaPage panels={panels} latest theme={state.mangaTheme}/>
        <div className="strip-colophon"><span>A LITTLE CONTEXT. A LOT OF CHARACTER.</span><span>COMICTOONS ORIGINAL</span></div>
      </> : <div className="preview-empty"><EmptyArt/><h3>{state.status === 'stopped' ? 'Off air. Still in control.' : 'Your next great panel starts here.'}</h3><p>{state.status === 'stopped' ? 'The overlay is hidden. Start a replay when you’re ready for a new story.' : 'Roll a sample stream. Pick the moments. Give late arrivals a story to step into.'}</p><span className="empty-note"><ShieldCheck size={16}/> Nothing goes live without your approval.</span></div>}
    </div>
    <div className="replay-progress" role="progressbar" aria-label="Stream replay progress" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><span style={{ transform: `scaleX(${progress / 100})` }}/></div>
    <div className="preview-status"><span><span className={`status-dot ${panels.length ? 'is-live' : ''}`}/>{panels.length ? `${state.panels.length} panels on air` : 'Waiting for approved moments'}<span className="replay-time">{timecode(state.elapsed)} / {timecode(state.duration)}</span></span><Tip text="Copy this URL into an OBS Browser Source"><button className="inline-button" onClick={onCopy}><Copy size={15}/>Copy overlay URL</button></Tip></div>
  </section>;
}

function EditCaption({ panel, open, onOpenChange, studio, onReturnFocus }: { panel?: Panel; open: boolean; onOpenChange: (open: boolean) => void; studio: StudioController; onReturnFocus: () => void }) {
  const [caption, setCaption] = useState('');
  const notify = useNotify();
  const available = !!panel && studio.state.pendingPanels.some(candidate => candidate.id === panel.id);
  useEffect(() => { if (open && panel) setCaption(panel.caption); }, [open, panel?.id]);
  async function save() {
    if (!panel || !available || !caption.trim()) return;
    try { await studio.mutate('/api/caption', { panelId: panel.id, caption: caption.trim() }); onOpenChange(false); notify({ message: 'Caption saved. That’s your voice on the page.' }); } catch { /* Keep the dialog open to retry. */ }
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="edit-dialog" onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}>
    <Dialog.Title>Edit caption</Dialog.Title><Dialog.Description>Give this moment your own words. Your changes stay in the approval queue until you publish.</Dialog.Description>
    <label htmlFor="caption-edit">Caption</label><textarea id="caption-edit" value={caption} maxLength={240} onChange={event => setCaption(event.target.value)} rows={4} aria-describedby="caption-count"/>
    <div id="caption-count" className="caption-count">{caption.length} / 240 characters</div>
    {studio.error && <p className="dialog-error" role="alert">{studio.error}</p>}
    {!available && <p className="dialog-error" role="alert">This panel is no longer waiting for review. Close the editor to choose another panel.</p>}
    <div className="dialog-actions"><Dialog.Close asChild><Button>Cancel</Button></Dialog.Close><Button variant="primary" loading={studio.busy === '/api/caption'} disabled={!available || !caption.trim() || !!studio.busy} onClick={() => void save()}><Check size={17}/>Save changes</Button></div>
    <Dialog.Close className="icon-button dialog-close" aria-label="Close caption editor"><X size={20}/></Dialog.Close>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function ApprovalQueue({ studio }: { studio: StudioController }) {
  const notify = useNotify();
  const [editingPanel, setEditingPanel] = useState<Panel>();
  const [selectedId, setSelectedId] = useState<string>();
  const queueRef = useRef<HTMLElement>(null);
  const { state, busy } = studio;
  const pending = state.pendingPanels;
  const selected = pending.find(panel => panel.id === selectedId) ?? pending[0];
  // Keep identity through polling and arrivals; remember the fallback after removal.
  useEffect(() => { setSelectedId(selected?.id); }, [selected?.id]);
  const selectedIndex = pending.findIndex(panel => panel.id === selected?.id);
  function returnFocus() {
    const editButton = queueRef.current?.querySelector<HTMLButtonElement>('.edit-caption-button');
    if (editButton && !editButton.disabled) editButton.focus();
    else queueRef.current?.focus();
  }
  async function approve() {
    if (!selected) return;
    const count = pending.length;
    try {
      const result = await studio.mutate<{ undoToken?: string }>('/api/approve', { all: true });
      notify({ message: `${count === 1 ? 'Panel' : `${count} panels`} approved. Now on air.`, action: result?.undoToken ? { label: 'Undo', run: () => { void studio.mutate('/api/undo', { token: result.undoToken }).then(() => notify({ message: 'Approval undone. Your panels are back on the editor’s desk.' })).catch(() => {}); } } : undefined });
    } catch { /* Banner handles failure. */ }
  }
  async function reject() {
    if (!selected) return;
    try {
      const result = await studio.mutate<{ undoToken?: string }>('/api/reject', { panelId: selected.id });
      notify({ message: 'Panel removed from the queue.', action: result?.undoToken ? { label: 'Undo', run: () => { void studio.mutate('/api/undo', { token: result.undoToken }).then(() => notify({ message: 'Panel restored to the approval queue.' })).catch(() => {}); } } : undefined });
    } catch { /* Banner handles failure. */ }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const element = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || editingPanel || busy || !selected || element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return;
      switch (event.key.toLowerCase()) {
        case 'a': event.preventDefault(); void approve(); break;
        case 'e': event.preventDefault(); setEditingPanel(selected); break;
        case 'r': event.preventDefault(); void reject(); break;
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  return <section ref={queueRef} tabIndex={-1} className="approval-queue" data-testid="approval-queue" aria-labelledby="approval-title">
    <header className="section-title"><div><h2 id="approval-title">The editor’s desk<span className="pending-count">{pending.length}</span></h2><p>{pending.length ? 'A good moment. Ready for your final word.' : 'Good stories are worth the wait.'}</p></div><Tip text="A: approve · E: edit caption · R: reject"><span className="shortcut-hint" tabIndex={0}><Keyboard size={17}/><span>A / E / R</span></span></Tip></header>
    {pending.length > 1 && <div className="queue-selection" role="group" aria-label="Pending panels">{pending.map((panel, index) => <Button key={panel.id} aria-label={`Review panel ${index + 1}: ${panel.caption}`} aria-pressed={selected?.id === panel.id} aria-controls="approval-selected-panel" disabled={!!busy || !!editingPanel} onClick={() => setSelectedId(panel.id)}>Panel {index + 1}</Button>)}</div>}
    {selected ? <div className={`queue-stack ${pending.length > 1 ? 'has-stack' : ''}`}><article id="approval-selected-panel" className="queue-card" data-panel-id={selected.id}>
      <div className="queue-thumbnail"><img src={selected.storyBeats?.[0]?.imageUrl ?? selected.imageUrl} alt={selected.storyBeats?.[0]?.scene ?? selected.altText}/><span>PANEL {selectedIndex + 1} OF {pending.length}</span></div>
      <div className="queue-content"><div className="queue-meta"><span><WandSparkles size={14}/>Moment found</span><span>{timecode(selected.at)}</span></div><h3>{selected.caption}</h3><p>{selected.dialogue[0]}</p><div className="queue-actions">
        <Button variant="primary" loading={busy === '/api/approve'} disabled={!!busy || studio.offline} onClick={() => void approve()}><Check size={17}/>Approve strip<kbd>A</kbd></Button>
        <Button className="edit-caption-button" disabled={!!busy} onClick={() => setEditingPanel(selected)}><Pencil size={16}/>Edit caption<kbd>E</kbd></Button>
        <Tip text="Remove this panel. You can undo it."><button className="icon-button reject-button" disabled={!!busy} onClick={() => void reject()} aria-label="Reject panel"><X size={19}/><kbd>R</kbd></button></Tip>
      </div>{pending.length > 1 && <span className="queue-extra"><Layers3 size={14}/>{pending.length - 1} more {pending.length === 2 ? 'moment' : 'moments'} in this strip</span>}</div>
    </article></div> : <div className="queue-empty"><div className="queue-empty-icon"><Pencil size={24}/></div><div><strong>{state.approvalMode ? 'Your next moment is being written.' : 'The presses are running themselves.'}</strong><p>{state.approvalMode ? 'New panels land here for your review as the stream unfolds.' : 'Auto-publish is on. New moments go straight to the overlay.'}</p></div></div>}
    <EditCaption panel={editingPanel} open={!!editingPanel} onOpenChange={open => { if (!open) setEditingPanel(undefined); }} studio={studio} onReturnFocus={returnFocus}/>
  </section>;
}

function ArtDirection({ style, setStyle, disabled }: { style: string; setStyle: (style: string) => void; disabled: boolean }) {
  return <section className="art-direction"><header className="section-title"><h2><Palette size={18}/>Make it your own</h2></header><Tabs.Root value={style} onValueChange={setStyle}>
    <Tabs.List className="style-tabs" aria-label="Art direction"><Tabs.Trigger value="risograph" disabled={disabled}><span className="style-swatch swatch-pop"><img src="/art/generated/panel-01-stream-start.webp" alt="Festival colour: Nova starts the stream"/></span><strong>Festival colour</strong><span>Warm colour. Big character.</span><Check size={16}/></Tabs.Trigger><Tabs.Trigger value="noir" disabled={disabled}><span className="style-swatch swatch-noir"><img src="/art/generated/panel-08-rainy-chill.webp" alt="Midnight noir: a rainy night with Nova"/></span><strong>Midnight noir</strong><span>All drama. Every detail.</span><Check size={16}/></Tabs.Trigger></Tabs.List>
    <Tabs.Content value="risograph" className="style-description">Risograph warmth, bold outlines, a little beautiful chaos.</Tabs.Content><Tabs.Content value="noir" className="style-description">After-hours ink, moody scenes and a little mystery.</Tabs.Content>
  </Tabs.Root><p className="style-footnote">Applied when you start a new replay.</p></section>;
}

function EditorialControls({ studio, onEnd }: { studio: StudioController; onEnd: () => void }) {
  const notify = useNotify();
  const { state, busy } = studio;
  const savedUrl=state.latestRecapUrl??state.recapUrl;
  const [downloading,setDownloading]=useState(false);
  const downloadingRef=useRef(false);
  async function download() {
    if(downloadingRef.current)return;
    downloadingRef.current=true;setDownloading(true);
    try{
      const {downloadRecapPng}=await import('../lib/recapPng');
      const saved=await studio.mutate<StudioState>('/api/recaps');
      if(!saved)throw new Error('The PNG download did not start. Wait for the current studio action to finish, then try again.');
      await downloadRecapPng(saved);notify({message:'Your manga PNG download has started.'});
    }
    catch(error){notify({message:error instanceof Error?error.message:'The PNG could not be created. Try again.'});}
    finally{downloadingRef.current=false;setDownloading(false);}
  }
  async function approval(value: boolean) {
    try { await studio.mutate('/api/settings', { approvalMode: value }); notify({ message: value ? 'Approval required. You have the final say.' : 'Auto-publish enabled. Pending panels are now live.' }); } catch { /* Banner handles failure. */ }
  }
  async function stop() {
    try { await studio.mutate('/api/stop'); notify({ message: 'Overlay hidden. Your audience sees a clear canvas.' }); } catch { /* Banner handles failure. */ }
  }
  return <>
    <section className="editorial-controls"><div className="approval-toggle-row"><div><h2><ShieldCheck size={18}/>You’re the editor.</h2><p>{state.approvalMode ? 'Every panel waits for your green light.' : 'New panels publish as they’re created.'}</p></div><Toggle.Root className="approval-toggle" role="switch" aria-label="Approval required" aria-checked={state.approvalMode} aria-pressed={undefined} pressed={state.approvalMode} onPressedChange={value => { if (!busy) void approval(value); }} disabled={studio.offline} aria-disabled={!!busy || studio.offline}><span/></Toggle.Root></div><div className="approval-mode-status"><span className={`status-dot ${state.approvalMode ? 'is-live' : 'is-auto'}`}/>{state.approvalMode ? 'Approval required' : 'Auto-publish is on'}</div><Button variant="danger" className="panic-button" aria-label="Panic hide: Hide overlay immediately" disabled={!!busy || studio.offline} loading={busy === '/api/stop'} onClick={() => void stop()}><Square size={15}/>Panic hide</Button></section>
    <section className="recap-builder" id="recap-builder"><div className="recap-builder-heading"><BookOpen size={22}/><ArrowUpRight size={22}/></div><h2>The stream ends.<br/><em>The story stays.</em></h2><p>Turn your approved moments into a recap issue and a shareable comic card.</p><Button variant="primary" disabled={!!busy || state.panels.length === 0 || studio.offline} loading={busy === '/api/end'} onClick={onEnd}><ArrowDownToLine size={17}/>End stream & create recap</Button><Button disabled={!!busy || downloading || state.panels.length === 0 || studio.offline} loading={downloading} onClick={() => void download()}><ArrowDownToLine size={17}/>Download recap PNG</Button>{state.panels.length === 0 && <span>Approve a panel to unlock your issue.</span>}{savedUrl && <a className="recap-existing" href={savedUrl}>Open your latest issue<ChevronRight size={16}/></a>}</section>
  </>;
}

export function Studio({ studio }: { studio: StudioController }) {
  const { state, busy } = studio;
  const savedUrl=state.latestRecapUrl??state.recapUrl;
  const [fixtureId, setFixtureId] = useState('tabletop-night');
  const [speed, setSpeed] = useState(60);
  const [style, setStyle] = useState('risograph');
  const notify = useNotify();
  const running = state.status === 'replaying';
  const demoStarted = useRef(false);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('demo') !== '1' || demoStarted.current || studio.loading) return;
    demoStarted.current = true;
    setStyle(new URLSearchParams(location.search).get('style') === 'noir' ? 'noir' : 'risograph');
    void studio.mutate('/api/replay', { fixtureId: 'tabletop-night', speed: 60, style: new URLSearchParams(location.search).get('style') === 'noir' ? 'noir' : 'risograph' }).catch(() => {});
    history.replaceState(null, '', '/studio');
  }, [studio.loading, studio.mutate]);

  async function copyOverlay() {
    try { await navigator.clipboard.writeText(`${location.origin}/ui.html#/overlay`); notify({ message: 'Overlay URL copied. Add it as an OBS Browser Source.' }); } catch { notify({ message: 'Copy isn’t available here. Open the OBS overlay and copy its address.' }); }
  }
  async function endStream() {
    try {
      const result = await studio.mutate<{ recapUrl?: string }>('/api/end');
      notify({ message: 'Your recap issue is ready to share.' });
      if (result?.recapUrl) {
        try { window.sessionStorage.setItem('comictoons-export-ready', '1'); } catch { /* The download remains available if storage is blocked. */ }
        location.assign(result.recapUrl);
      }
    } catch { /* Banner handles failure. */ }
  }
  return <div className="studio"><Sidebar recapUrl={savedUrl} sample={isSampleSource(state.source)}/><main className="dashboard" id="main-content"><header className="topbar"><div className="studio-status"><span className={`status-dot ${running ? 'is-live' : ''}`}/>{studio.offline ? 'Reconnecting' : running ? 'Replay live' : state.status === 'ended' ? 'Issue published' : 'Studio ready'}<span className="status-divider"/>Demo workspace</div><a href="/ui.html#/overlay" target="_blank" rel="noreferrer"><Eye size={16}/>Preview overlay<ArrowUpRight size={14}/></a></header>
    <div className="page-heading"><div><h1>Live studio</h1><p>{state.streamTitle} · {chatSourceLabel(state.source)} · Your stream, in panels.</p></div><a className="studio-home-link" href="/">Explore ComicToons<ArrowUpRight size={16}/></a></div>
    <ConnectionBanner studio={studio}/>
    <OutputModes/><ParticipationPanel/>
    {state.savedIssueDiffers && savedUrl && <div className="saved-issue-notice" role="status"><strong>Saved issue differs from on-air caption</strong><a href={savedUrl}>Open saved issue<ArrowUpRight size={16}/></a></div>}
    <ChatSourceControl studio={studio}/>
    <Transport studio={studio} fixtureId={fixtureId} setFixtureId={setFixtureId} speed={speed} setSpeed={setSpeed} style={style}/>
    <div className="studio-grid"><div className="main-column"><LivePreview studio={studio} onCopy={() => void copyOverlay()}/><MomentTimeline studio={studio}/><ApprovalQueue studio={studio}/></div><aside className="inspector" aria-label="Art and publishing"><ArtDirection style={style} setStyle={setStyle} disabled={!!busy}/><MangaThemeControl studio={studio}/><EditorialControls studio={studio} onEnd={() => void endStream()}/></aside></div>
    <div className="mobile-actionbar"><Button variant="primary" disabled={!!busy || state.pendingPanels.length === 0} onClick={() => { void studio.mutate<{ undoToken?: string }>('/api/approve', { all: true }).then(result => notify({ message: 'Strip approved. Now on air.', action: result?.undoToken ? { label: 'Undo', run: () => { void studio.mutate('/api/undo', { token: result.undoToken }).then(() => notify({ message: 'Approval undone. Panels returned to your queue.' })).catch(() => {}); } } : undefined })).catch(() => {}); }}><Check size={18}/>Approve strip<span>{state.pendingPanels.length}</span></Button><Tip text="Hide overlay immediately"><button className="icon-button" aria-label="Hide overlay immediately" disabled={!!busy} onClick={() => { void studio.mutate('/api/stop').then(() => notify({ message: 'Overlay hidden.' })).catch(() => {}); }}><Square size={19}/></button></Tip></div>
    <footer className="studio-footer"><span>Made live. Remembered in ink.</span><span>{isSampleSource(state.source) ? 'Original art · Sample Data · Invented chat' : 'Read-only live chat · Original illustrations'}</span></footer>
  </main></div>;
}

function MomentTimeline({ studio }: { studio: StudioController }) {
  const moments = [...studio.state.panels, ...studio.state.pendingPanels].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return <section className="moment-timeline" aria-labelledby="timeline-title"><header><h2 id="timeline-title">Moment timeline</h2><span>{moments.length} detected · {timecode(studio.state.elapsed)}</span></header><div className="timeline-track">{moments.length ? moments.map((panel, i) => <a key={panel.id} href="#approval-title" style={{ left: `${Math.min(96, Math.max(2, (panel.at ?? 0) / (studio.state.duration || 1) * 100))}%` }} aria-label={`Moment ${i + 1} at ${timecode(panel.at)}: ${panel.caption}`}><span/>{timecode(panel.at)}</a>) : <p>Start a replay to discover its first moment.</p>}</div><div className="velocity-sample"><svg viewBox="0 0 600 30" preserveAspectRatio="none" role="img" aria-label="Illustrative fixture chat velocity, with bursts near highlight moments"><path d="M0 27 L30 26 45 23 55 27 70 24 85 10 92 25 120 23 145 26 162 4 170 18 180 8 192 25 230 26 250 20 265 24 280 2 290 22 305 14 320 25 360 24 380 10 390 22 420 25 450 5 460 19 470 12 480 24 520 22 540 26 570 18 600 24" fill="none" stroke="currentColor" strokeWidth="2"/></svg><span>Sample chat velocity · illustrative</span></div></section>;
}
