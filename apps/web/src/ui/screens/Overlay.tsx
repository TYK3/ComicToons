import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CatchupEvent, HypeSplashEvent, UiPanel } from '../data/adapter';
import { studioPhase, useUi, useUiEvents } from '../data/store';
import { HYPE_SPLASH_MS, HypeSplash } from '../components/HypeSplash';
import { LookArt, Panel } from '../components/Panel';
import { slam } from '../motion';
import type { Route } from '../router';
import '../styles/overlay.css';

/**
 * OBS browser source: 1920×1080, transparent. Add it as a Browser Source at that size.
 * `?bg=1` paints a Sample stream behind it for previews; `?catchup=1` shows the catch-up sequence.
 * `?freeze=1` (screenshots only) keeps the catch-up and the hype-train splash up instead of timing them out.
 */
export function Overlay({ route }: { route: Route }) {
  const ui = useUi();
  const { studio, participation } = ui;
  const stage = useRef<HTMLDivElement>(null);
  const lead = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, x: 0, y: 0, pinned: false });
  const [catchup, setCatchup] = useState<CatchupEvent | null>(() => route.params.get('catchup') === '1' ? { reason: 'raid', raider: 'mapleglitch', viewers: 42, panelIds: [] } : null);
  const backdrop = route.params.get('bg') === '1';

  useLayoutEffect(() => {
    const measure = () => {
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      // m13: a portrait preview (bg=1 on a phone) sits at the top with the note right under it, not letterboxed.
      const pinned = backdrop && window.innerWidth <= 640;
      setFit({ scale, x: (window.innerWidth - 1920 * scale) / 2, y: pinned ? 16 : (window.innerHeight - 1080 * scale) / 2, pinned });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [backdrop]);
  const [splash, setSplash] = useState<HypeSplashEvent | null>(null);
  // HYPE-SPLASH: the catch-up always wins. A catch-up clears any splash, and a splash never shows while it plays.
  useUiEvents(['catchup', 'hype-splash'], event => {
    if (event.name === 'catchup') { setCatchup(event.data); setSplash(null); }
    if (event.name === 'hype-splash') setSplash(event.data);
  });
  // route.params is a new object on every render (the adapter re-renders once a second), so the timers key on the
  // flag itself. Keyed on route.params they restarted every second and the catch-up and splash never timed out.
  const frozen = route.params.get('freeze') === '1';
  useEffect(() => {
    if (!splash || frozen) return;
    const timer = setTimeout(() => setSplash(null), HYPE_SPLASH_MS);
    return () => clearTimeout(timer);
  }, [splash, frozen]);
  useEffect(() => {
    if (!catchup || frozen) return;
    const timer = setTimeout(() => setCatchup(null), 9000);
    return () => clearTimeout(timer);
  }, [catchup, frozen]);

  const panels = studio.panels;
  const latest = panels.at(-1);
  const earlier = panels.slice(-3, -1).reverse();
  useEffect(() => { slam(lead.current); }, [latest?.id]);
  const recap: UiPanel[] = catchup?.panelIds.length ? panels.filter(panel => catchup.panelIds.includes(panel.id)) : panels.slice(-3);
  const poll = participation.poll;
  // UI3: loading, error and empty draw nothing on stream (no box, no text: OBS stays clear). Only the preview says why.
  const phase = studioPhase(ui);
  const quiet = phase === 'loading' ? 'Overlay loading. Nothing shows on stream until it is ready.'
    : phase === 'error' ? 'Overlay not connected to the studio. Nothing shows on stream; reconnect from the Studio.'
      : phase === 'empty' ? 'Overlay ready. Nothing shows on stream until you approve a panel.' : '';

  return <div className="ct-overlay-root" data-backdrop={backdrop || undefined}>
    <div className="ct-stage" ref={stage} style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` }} role="region" aria-label="Stream overlay">
      {backdrop && <div className="ct-stage__backdrop" aria-hidden="true">{panels[0] && <LookArt panel={{ ...panels[0], art: { ...panels[0].art, tone: 'colour' } }} look="festival" eager/>}<span>{panels[0] ? 'Sample stream behind the overlay' : 'Your stream behind the overlay'}</span></div>}
      {backdrop && quiet && <p className="ct-stage__state" data-state={phase} aria-hidden="true"><strong>{phase === 'loading' ? 'Loading…' : phase === 'error' ? 'Not connected' : 'Waiting for a panel'}</strong> {quiet.replace(/^[^.]+\. /, '')}</p>}
      {/* m12: in the preview only, say that the overlay is hidden (OBS itself stays blank). */}
      {backdrop && studio.hidden && <p className="ct-stage__hidden" role="status">Overlay hidden</p>}
      {!studio.hidden && <>
        {latest && !catchup && <div className="ct-ov-strip">
          {earlier.length > 0 && <div className="ct-ov-earlier">{earlier.map(panel => <Panel key={panel.id} panel={panel} tags={false} lettering={false}/>)}</div>}
          <div className="ct-ov-lead" ref={lead} key={latest.id}><Panel panel={latest} tags={false} eager/></div>
          <p className="ct-ov-credit">ComicToons{latest.origin !== 'twitch' ? ' · Sample' : ''}{latest.chosenBy ? ` · Chat chose ${latest.chosenBy.pct}%` : ''}</p>
        </div>}
        {poll && !catchup && <div className="ct-ov-poll">
          <p className="ct-ov-poll__q">Chat votes the bubble</p>
          <ol>{poll.choices.map(choice => {
            const pct = poll.total ? Math.round(choice.votes / poll.total * 100) : 0;
            return <li key={choice.key}><span className="ct-ov-poll__key">!{choice.key}</span><span className="ct-ov-poll__text">{choice.caption}</span><span className="ct-ov-poll__pct">{pct}%</span><i style={{ width: `${pct}%` }}/></li>;
          })}</ol>
          <p className="ct-ov-poll__hint">{poll.mode === 'twitch' ? 'Vote in the Twitch poll' : 'Type !1, !2 or !3 in chat'}</p>
        </div>}
        {splash && !catchup && <HypeSplash level={splash.level}/>}
        {catchup && recap.length > 0 && <div className="ct-ov-catchup" role="status">
          <p className="ct-ov-catchup__title">Previously on…</p>
          {catchup.raider && <p className="ct-ov-catchup__raid">Welcome, @{catchup.raider}{catchup.viewers ? ` and ${catchup.viewers} raiders` : ''}! Here’s the story so far.</p>}
          <div className="ct-ov-catchup__row">{recap.map((panel, index) => <div key={panel.id} className="ct-ov-catchup__cell" style={{ animationDelay: `${index * 450}ms` }}><Panel panel={panel} tags={false}/></div>)}</div>
        </div>}
      </>}
    </div>
    {/* One polite line for screen readers in the preview; invisible on stream either way. */}
    <p className="ct-sr" role="status" aria-live="polite">{quiet}</p>
    {backdrop && <p className="ct-overlay-note" style={fit.pinned ? { top: 16 + 1080 * fit.scale + 16, bottom: 'auto' } : undefined}>Preview of the OBS browser source: 1920 × 1080, transparent. Add <code>{location.pathname}#/overlay</code> in OBS.</p>}
  </div>;
}
