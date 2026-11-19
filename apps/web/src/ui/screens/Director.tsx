import { useEffect, useState } from 'react';
import { isSampleSource } from '@comictoons/core';
import { timecode } from '../../types';
import { studioPhase, useAdapter, useUi } from '../data/store';
import { RetryButton, ScreenState } from '../components/ScreenState';
import { Logo, Sample } from '../components/Brand';
import { Panel } from '../components/Panel';
import { LookSwitch } from '../components/LookSwitch';
import { ConnectionBanner } from '../components/AppBar';
import { inkQueueWaiting, nextUpPanel, readNextUpId } from './studio/live';
import { href } from '../router';
import '../styles/director.css';

/** Director: the studio on a phone propped beside the keyboard. Big targets, one decision at a time. */
export function Director() {
  const ui = useUi();
  const adapter = useAdapter();
  const { studio, participation } = ui;
  // UI-LIVE-B #4: show the panel a mod's !ink yes would approve (server nextUp), so Approve here acts on the same one.
  const next = nextUpPanel(studio);
  const serverPicked = !!next && readNextUpId(studio) === next.id && studio.pendingPanels[0]?.id !== next.id;
  const [said, setSaid] = useState('');
  const [undo, setUndo] = useState<string | undefined>();
  useEffect(() => { if (!undo) return; const timer = setTimeout(() => setUndo(undefined), 6000); return () => clearTimeout(timer); }, [undo]);
  // m11: going auto puts panels on air unseen, so it takes a second tap within four seconds.
  const [confirmAuto, setConfirmAuto] = useState(false);
  useEffect(() => { if (!confirmAuto) return; const timer = setTimeout(() => setConfirmAuto(false), 4000); return () => clearTimeout(timer); }, [confirmAuto]);
  const toggleEditor = () => {
    if (studio.approvalMode && !confirmAuto) { setConfirmAuto(true); setSaid('Tap again to put panels straight on air.'); return; }
    setConfirmAuto(false);
    void adapter.setApprovalMode(!studio.approvalMode);
    setSaid(studio.approvalMode ? 'Auto: panels go straight on air.' : 'Every panel waits for you.');
  };
  const decide = async (kind: 'approve' | 'reject') => {
    if (!next) return;
    const result = kind === 'approve' ? await adapter.approve(next.id) : await adapter.reject(next.id);
    setUndo(result.undoToken);
    setSaid(kind === 'approve' ? 'On air.' : 'Rejected.');
  };
  const onAir = studio.panels.at(-1);
  // UI3: loading, error (the studio never answered) and empty (no panels yet) never show made-up panels or numbers.
  const phase = studioPhase(ui);
  const panic = <button type="button" className="ct-btn ct-btn--panic ct-director__panic" aria-pressed={studio.hidden} onClick={() => void adapter.panicHide(!studio.hidden)}>
    {studio.hidden ? 'Overlay hidden · tap to show' : 'Panic hide overlay'}
  </button>;
  return <div className="ct-director">
    <header className="ct-director__bar ct-on-ink">
      <Logo/>
      {phase === 'loading' ? <span className="ct-chip">Loading…</span> : phase === 'error' ? <span className="ct-chip">Offline</span>
        : <span className="ct-chip"><span className="ct-dot" aria-hidden="true"/>{timecode(studio.elapsed)}</span>}
      {/* UI-LIVE-B #7: SAMPLE only while the chat really is sample data (or the mock). */}
      {(adapter.kind === 'mock' || isSampleSource(studio.source)) && <Sample ink/>}
      {studio.hidden && <span className="ct-director__hidden" role="status">Hidden</span>}
      <a className="ct-btn ct-btn--back ct-btn--sm" href={href('/studio')} aria-label="Full studio"><span className="ct-director__wide">Full studio</span><span className="ct-director__narrow" aria-hidden="true">Studio</span></a>
    </header>
    {phase !== 'error' && <ConnectionBanner/>}
    {phase === 'error' ? <main className="ct-director__main" id="ct-main">
      <ScreenState kind="error" level={1} title="Can’t reach your studio" actions={<>
        <RetryButton onRetry={() => void adapter.refresh()} busy={ui.busy === 'refresh'}/>
        <a className="ct-btn" href={href('/studio')}>Full studio</a>
      </>}>
        <p>{ui.error || 'ComicToons couldn’t reach the studio server on this computer.'}</p>
        <p>Check ComicToons is still running on your streaming computer, then try again. Need the overlay gone right now? Hide the ComicToons source in OBS.</p>
      </ScreenState>
    </main> : phase === 'loading' ? <main className="ct-director__main" id="ct-main" aria-busy="true">
      {panic}
      <ScreenState kind="loading" compact title="Loading the director"><p>Getting the latest panels from your studio…</p></ScreenState>
      <div className="ct-director__tiles" aria-hidden="true">{[0, 1, 2, 3].map(index => <div key={index} className="ct-tile ct-skel"/>)}</div>
    </main> : <main className="ct-director__main" id="ct-main">
      {panic}

      <section className="ct-director__next" aria-labelledby="ct-dir-next">
        <h1 id="ct-dir-next" className="ct-kicker" data-next-up={next?.id}>{next ? `Next up · ${studio.pendingPanels.length} waiting` : 'Nothing waiting'}</h1>
        {next ? <>
          <Panel panel={next} eager/>
          <p className="ct-director__cap">{next.caption}</p>
          {(next.cameo || serverPicked || participation.rules.modApprove) && <p className="ct-note">{next.cameo ? `Cameo for @${next.cameo}. ` : ''}{serverPicked ? (next.cameo ? 'Cameos come first, ahead of older panels. ' : 'The studio puts this one ahead of older panels. ') : ''}{participation.rules.modApprove ? 'A mod’s !ink yes approves this one.' : ''}</p>}
          <div className="ct-director__decide">
            <button type="button" className="ct-btn" onClick={() => void decide('reject')} disabled={ui.busy === 'reject'}>Reject</button>
            <button type="button" className="ct-btn ct-btn--ink" onClick={() => void decide('approve')} disabled={ui.busy === 'approve'}>Approve</button>
          </div>
        </> : phase === 'empty' ? <div className="ct-director__empty">
          <p className="ct-director__idle">No panels yet. Once chat gets going, each new panel lands here for a yes or no.</p>
          <p className="ct-note">Not live yet? Start the Sample replay to practise, with made-up chat.</p>
          <button type="button" className="ct-btn ct-btn--ink" onClick={() => void adapter.replay(studio.fixtureId || ui.fixtures[0]?.id || '')} disabled={ui.busy === 'replay' || !ui.fixtures.length}>{ui.busy === 'replay' ? 'Starting…' : 'Start the Sample replay'}</button>
        </div> : <p className="ct-director__idle">The writer is watching chat. You’ll feel a new panel land here.</p>}
        {undo && <button type="button" className="ct-btn ct-btn--ghost" onClick={() => { void adapter.undo(undo); setUndo(undefined); setSaid('Undone.'); }}>Undo last decision</button>}
        <p className="ct-sr" role="status" aria-live="polite">{said}</p>
      </section>

      <section className="ct-director__tiles" aria-label="Quick controls">
        <div className="ct-tile">
          <p className="ct-kicker">Chat vote</p>
          {participation.poll ? <>
            <p className="ct-tile__big">{participation.poll.total} votes</p>
            <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.endPoll()}>End vote</button>
          </> : <>
            {phase === 'empty' && <p className="ct-note">A vote needs a panel first.</p>}
            <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => void adapter.startPoll()} disabled={phase === 'empty'}>Start a vote</button>
          </>}
        </div>
        <div className="ct-tile">
          <p className="ct-kicker">Catch-up</p>
          <p className="ct-tile__big">{studio.panels.length} panels</p>
          <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.playCatchup()} disabled={!studio.panels.length}>Play it</button>
        </div>
        <div className="ct-tile">
          <p className="ct-kicker">Ink me queue</p>
          {/* UI-LIVE-B #3: redemptions plus chat !ink cameos still waiting. */}
          <p className="ct-tile__big" data-ink-waiting>{inkQueueWaiting(participation)} waiting</p>
          <a className="ct-btn ct-btn--sm" href={href('/studio')}>Open</a>
        </div>
        <div className="ct-tile">
          <p className="ct-kicker">Editor</p>
          <p className="ct-tile__big">{studio.approvalMode ? 'You approve' : 'Auto'}</p>
          <button type="button" className="ct-btn ct-btn--sm" aria-pressed={studio.approvalMode} data-confirm={confirmAuto || undefined} onClick={toggleEditor}>{!studio.approvalMode ? 'Approve each' : confirmAuto ? 'Tap again: go auto' : 'Go auto'}</button>
        </div>
      </section>

      <section className="ct-director__look" aria-label="Look"><LookSwitch/></section>

      <section className="ct-director__onair" aria-labelledby="ct-dir-onair">
        <h2 id="ct-dir-onair" className="ct-kicker">On air now</h2>
        {studio.hidden ? <p className="ct-director__idle">Hidden from viewers.</p> : onAir ? <Panel panel={onAir} lettering tags={false}/> : <p className="ct-director__idle">Nothing on air yet.</p>}
      </section>
    </main>}
  </div>;
}
