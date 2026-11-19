import { useEffect, useState, type ReactNode } from 'react';
import { isSampleSource } from '@comictoons/core';
import { LookPicker } from '../../components/LookPicker';
import { LookSwitch } from '../../components/LookSwitch';
import { ChannelGroup } from '../../components/TwitchConnect';
import { useAdapter, useUi } from '../../data/store';
import { EventSubTool } from './EventSub';

/** True while the media query matches (W8: the phone toolbar folds). */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** On phones the replay and source controls fold away so the first screen shows the review desk (W8). */
function Fold({ fold, summary, children }: { fold: boolean; summary: ReactNode; children: ReactNode }) {
  if (!fold) return <>{children}</>;
  return <details className="ct-tool__fold"><summary>{summary}</summary><div className="ct-tool__foldbody">{children}</div></details>;
}

/** D1a top toolbar: Channel | Twitch events | Replay | Look. Sticky under the app bar on desktop, stacked on small screens. */
export function Toolbar() {
  const ui = useUi();
  const adapter = useAdapter();
  const { studio, fixtures } = ui;
  const sample = isSampleSource(studio.source) && studio.source.active !== 'twitch';
  const phone = useMedia('(max-width: 640px)');
  return <section className="ct-toolbar" aria-label="Studio controls">
    <ChannelGroup/>
    <EventSubTool/>
    <div className="ct-tool ct-tool--replay">
      <Fold fold={phone} summary={sample ? <>Replay settings <span className="ct-sample">Sample</span></> : <>Live chat <span className="ct-tool__hint">#{studio.source.channel}</span></>}>
      {sample ? <>
        <p className="ct-tool__label"><label htmlFor="ct-stream">Sample stream</label> <span className="ct-sample">Sample</span></p>
        <div className="ct-tool__row">
          <select id="ct-stream" className="ct-select" value={studio.fixtureId} onChange={event => void adapter.replay(event.target.value)}>
            {fixtures.map(fixture => <option key={fixture.id} value={fixture.id}>{fixture.streamTitle}</option>)}
          </select>
          <div className="ct-seg" role="radiogroup" aria-label="Replay speed">
            {([1, 10, 60] as const).map(speed => <button key={speed} type="button" role="radio" aria-checked={studio.speed === speed} onClick={() => void adapter.setSpeed(speed)}>{speed}×</button>)}
          </div>
          <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.replay(studio.fixtureId)} disabled={ui.busy === 'replay'}>Restart replay</button>
        </div>
      </> : <>
        <p className="ct-tool__label">Live chat <span className="ct-tool__hint">#{studio.source.channel}</span></p>
        <div className="ct-tool__row ct-tool__stats">
          <span><strong>{studio.source.received}</strong> messages read</span>
          <span><strong>{studio.budget.used}/{studio.budget.perHour}</strong> panels this hour</span>
          <span>Clips: <strong>{studio.clips ?? 0}</strong></span>
          {studio.source.simulated && <span className="ct-sample">Sample</span>}
        </div>
      </>}
      </Fold>
    </div>
    <div className="ct-tool ct-tool--look">{phone ? <LookSwitch/> : <LookPicker/>}</div>
  </section>;
}
