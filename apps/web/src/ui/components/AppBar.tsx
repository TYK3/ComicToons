import { isSampleSource } from '@comictoons/core';
import { timecode } from '../../types';
import { studioPhase, useAdapter, useUi } from '../data/store';
import { href } from '../router';
import { Logo, Sample } from './Brand';
import {useStudioMode} from '../data/StudioSession';
import { chatSourceChip, connectionBanner, readConnection } from '../screens/studio/live';

const NAV = [
  { name: 'studio', label: 'Studio', path: '/studio' },
  { name: 'flow', label: 'Story flow', path: '/flow' },
  { name: 'director', label: 'Director', path: '/director' },
  { name: 'overlay', label: 'Overlay', path: '/overlay' },
  { name: 'issues', label: 'Library', path: '/issues' },
  { name: 'catchup', label: 'Catch-up', path: '/catchup', extra: true },
  { name: 'output', label: 'Outputs', path: '/output', extra: true },
];

export function AppBar({ current, onEnd }: { current: string; onEnd?: () => void }) {
  const ui = useUi();
  const adapter = useAdapter();
  const {mode}=useStudioMode();
  const liveReady=mode==='live'&&studioPhase(ui)==='empty'&&ui.studio.source.connection==='stopped';
  const { studio } = ui;
  const phase = studioPhase(ui);
  const connection = readConnection(ui, adapter);
  return <header className="ct-appbar ct-on-ink">
    <Logo/>
    <nav aria-label="Main">
      {NAV.filter(item=>['studio','issues'].includes(item.name)).map(item => <a key={item.name} href={href(item.path,{workspace:mode})} aria-current={current === item.name ? 'page' : undefined}>{item.label}</a>)}
      <details className="ct-studio-more"><summary>More</summary><div>{NAV.filter(item=>!['studio','issues','output'].includes(item.name)).map(item=><a key={item.name} href={href(item.path,{workspace:mode})}>{item.label}</a>)}<a href={href('/audience',{workspace:mode})}>Audience view</a><a href={href('/connect')}>Twitch setup</a>{onEnd&&<button type="button" className="ct-btn ct-btn--sm" onClick={onEnd}>End stream</button>}</div></details>
    </nav>
    <div className="ct-appbar__right">
      {/* UI3: say what the studio is doing, and no stream clock until there is a stream to time. */}
      {liveReady ? <span className="ct-chip ct-hide-sm">Live chat ready</span> : phase === 'loading' ? <span className="ct-chip ct-hide-sm">Loading…</span>
        : phase === 'error' ? <span className="ct-chip ct-hide-sm">Not connected</span>
          : connection === 'lost' ? <span className="ct-chip ct-hide-sm">Connection lost</span>
            : connection === 'reconnecting' ? <span className="ct-chip ct-hide-sm">Reconnecting…</span>
              // UI-LIVE-B #7: the same words as the Channel card and the Chat card (chatSourceChip).
              // STREAM-END-1: once EventSub stream.offline has ended the session, drop the glowing
              // ct-live styling along with the text, or the chip keeps looking Live.
              : <span className={`ct-chip ct-hide-sm${studio.source.connection === 'ended' ? '' : ' ct-live'}`} data-chip="source"><span className="ct-dot" aria-hidden="true"/>{chatSourceChip(studio.source)}</span>}
      {!liveReady&&(adapter.kind === 'mock' || isSampleSource(studio.source)) && <span className="ct-hide-sm"><Sample ink/></span>}
      {(phase === 'ready' || phase === 'empty') && <span className="ct-appbar__clock ct-hide-sm" aria-label="Stream time">{timecode(studio.elapsed)} / {timecode(studio.duration)}</span>}
      <button type="button" className="ct-btn ct-btn--panic ct-btn--sm ct-panic-top" aria-pressed={studio.hidden} onClick={() => void adapter.panicHide(!studio.hidden)}>
        <span aria-hidden="true">■</span>{studio.hidden ? 'Show overlay' : 'Panic hide'}
      </button>
    </div>
  </header>;
}

/**
 * UI-LIVE-B: Connection lost / Reconnecting, driven by the adapter's `connection` (the live contract).
 * A polite live region, so a screen reader hears the drop and the recovery without losing its place.
 */
export function ConnectionBanner() {
  const ui = useUi();
  const adapter = useAdapter();
  const connection = readConnection(ui, adapter);
  const copy = connectionBanner(connection);
  return <div className="ct-live-region" role="status" aria-live="polite">
    {copy && <div className="ct-banner ct-on-ink" data-connection={connection}>
      <p><strong>{copy.title}</strong> {copy.body}</p>
      {copy.retry ? <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.refresh()} disabled={ui.busy === 'refresh'}>Reconnect</button>
        : <span className="ct-spin" aria-hidden="true"/>}
    </div>}
  </div>;
}
