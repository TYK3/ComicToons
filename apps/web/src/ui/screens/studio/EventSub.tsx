/**
 * EventSub status chip for the Studio toolbar (T3 REQUEST 6), and the revoked or failed warning under it.
 * Reads GET /api/participation/eventsub through the adapter and hears bus 'eventsub-revoked'.
 * Four states the streamer acts on: connected, partial, failed, revoked (plus off and connecting).
 */
import { useEffect, useRef, useState } from 'react';
import { EVENTSUB_TYPES, eventSubFeature, eventSubHealth, type EventSubHealth, type EventSubRevocation, type EventSubStatus } from '../../data/adapter';
import { useAdapter, useUi, useUiEvents } from '../../data/store';
import { Sample } from '../../components/Brand';

const LABEL: Record<EventSubHealth, string> = { off: 'Off', connecting: 'Connecting', connected: 'Connected', partial: 'Partial', failed: 'Failed', revoked: 'Revoked' };
const TOTAL = EVENTSUB_TYPES.length;

const REASON: Record<string, string> = {
  authorization_revoked: 'Twitch access was withdrawn',
  user_removed: 'the Twitch account is no longer available',
  version_removed: 'Twitch retired this event version',
  notification_failures_exceeded: 'Twitch gave up after too many failed deliveries',
};
const reason = (status: string) => REASON[status] ?? `Twitch ended it (${status.replace(/_/g, ' ')})`;
const features = (types: string[]) => [...new Set(types.map(eventSubFeature))];
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

function summary(health: EventSubHealth, status: EventSubStatus): string {
  switch (health) {
    case 'connected': return `All ${TOTAL} Twitch events are arriving: chat, raids, cheers, votes, predictions, hype trains and Ink me.`;
    case 'partial': return `${status.subscribed.length} of ${TOTAL} are arriving. ${list(features(status.failed.map(entry => entry.type)))} ${features(status.failed.map(entry => entry.type)).length === 1 ? 'is' : 'are'} missing, so ${features(status.failed.map(entry => entry.type)).length === 1 ? 'it doesn’t' : 'they don’t'} reach the comic.`;
    case 'failed': return status.lastError ?? 'Twitch didn’t accept the event subscriptions. Nothing live reaches the comic.';
    case 'revoked': return `${reason(status.revoked.at(-1)?.status ?? '')}. Live events stopped reaching the comic.`;
    case 'connecting': return 'Opening the event connection to Twitch…';
    default: return 'Sign in to Twitch to get raids, cheers, votes and chat as they happen.';
  }
}

/** Toolbar tool: label, chip button and a details panel. */
export function EventSubTool() {
  const ui = useUi();
  const adapter = useAdapter();
  const status = ui.eventsub;
  const health = eventSubHealth(status);
  const [open, setOpen] = useState(false);
  const [heard, setHeard] = useState('');
  const sample = adapter.kind === 'mock';
  useUiEvents(['eventsub-revoked'], event => { if (event.name === 'eventsub-revoked') setHeard(`Twitch withdrew ${eventSubFeature((event.data as EventSubRevocation).type)}.`); });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const count = health === 'off' || health === 'connecting' ? '' : `${status.subscribed.length}/${TOTAL}`;
  return <div className="ct-tool ct-tool--events" ref={root}>
    <p className="ct-tool__label">Twitch events {sample && <Sample/>}</p>
    <div className="ct-tool__row">
      <button type="button" className="ct-evs" data-health={health} aria-expanded={open} aria-controls="ct-evs-details" onClick={() => setOpen(value => !value)}>
        <span className="ct-evs__mark" aria-hidden="true">{health === 'failed' ? '×' : health === 'revoked' ? '!' : ''}</span>
        <span className="ct-evs__label">{LABEL[health]}</span>
        {count && <span className="ct-evs__count">{count}</span>}
        <span className="ct-sr">EventSub, {LABEL[health]}{count ? `, ${status.subscribed.length} of ${TOTAL} subscriptions` : ''}. Show details.</span>
      </button>
    </div>
    <p className="ct-sr" role="status" aria-live="polite">{heard}</p>
    {open && <div id="ct-evs-details" className="ct-evs__pop" role="region" aria-label="Twitch event subscriptions">
      <p className="ct-evs__head"><strong>EventSub: {LABEL[health]}</strong>{sample && <Sample/>}</p>
      <p className="ct-note">{summary(health, status)}</p>
      {health !== 'off' && <ul className="ct-evs__list">
        {features(EVENTSUB_TYPES.map(entry => entry.type)).map(feature => {
          const types = EVENTSUB_TYPES.filter(entry => entry.feature === feature).map(entry => entry.type);
          const revoked = status.revoked.some(entry => types.includes(entry.type));
          const failed = status.failed.find(entry => types.includes(entry.type));
          const on = types.every(type => status.subscribed.includes(type));
          const word = revoked ? 'Withdrawn' : failed ? 'Missing' : on ? 'On' : health === 'connecting' ? 'Waiting' : 'Off';
          return <li key={feature} data-on={on || undefined}><span>{feature}</span><span className="ct-evs__state">{word}</span>{failed && <span className="ct-evs__why">{failed.error}</span>}</li>;
        })}
      </ul>}
      {health !== 'off' && <p className="ct-note">{status.notifications} events received · {status.reconnects} {status.reconnects === 1 ? 'reconnect' : 'reconnects'}</p>}
      <EventSubActions health={health} onDone={() => setOpen(false)}/>
    </div>}
  </div>;
}

function EventSubActions({ health, onDone }: { health: EventSubHealth; onDone?: () => void }) {
  const adapter = useAdapter();
  if (health === 'connected' || health === 'connecting' || health === 'off') return null;
  return <div className="ct-row">
    <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => { onDone?.(); void adapter.connectTwitch(); }}>Sign in to Twitch again</button>
    {health !== 'revoked' && <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => void adapter.getEventSub()}>Check again</button>}
  </div>;
}

/** Every EventSub feature, chat first when EventSub carries it (no IRC transport on the live source). */
const missing = (chatOverEventSub: boolean) => `${chatOverEventSub ? 'Chat, raids' : 'Raids'}, cheers, votes and Ink me`;

/**
 * Full-width warning while any subscription is revoked, or (BANNERS, report-token-expiry.md REQUEST 4, case C2)
 * while every subscription failed and Live chat is on. Recovery is a fresh Twitch sign-in, which restarts EventSub.
 */
export function EventSubBanner() {
  const ui = useUi();
  const adapter = useAdapter();
  const status = ui.eventsub;
  const health = eventSubHealth(status);
  if (ui.twitch.state === 'connecting') return null;
  if (health === 'failed' && ui.studio.source.requested === 'twitch') {
    // The reason is the server's own (lastError, else the first per-subscription error); nothing is guessed.
    const why = status.lastError || status.failed.find(entry => entry.error)?.error || 'Twitch didn’t accept the event subscriptions.';
    return <div className="ct-banner ct-banner--paper ct-banner--warn" role="status" aria-live="polite">
      <span className="ct-banner__sign" aria-hidden="true">!</span>
      <p><strong>Twitch isn’t sending live events.</strong> {why} {missing(!ui.studio.source.transport)} don’t reach the comic. Approved panels and the overlay are safe. {adapter.kind === 'mock' && <Sample/>}</p>
      <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => void adapter.connectTwitch()}>Sign in to Twitch again</button>
      <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => void adapter.getEventSub()}>Check again</button>
      <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => void adapter.useSampleData()}>Use Sample data</button>
    </div>;
  }
  if (health !== 'revoked') return null;
  const lost = features(status.revoked.map(entry => entry.type));
  return <div className="ct-banner ct-banner--paper ct-banner--warn" role="status" aria-live="polite">
    <span className="ct-banner__sign" aria-hidden="true">!</span>
    <p><strong>Twitch stopped sending live events.</strong> {reason(status.revoked.at(-1)?.status ?? '')}, so {lost.length >= 6 ? 'chat, raids, votes and Ink me' : list(lost).toLowerCase()} no longer reach the comic. Approved panels and the overlay are safe. {adapter.kind === 'mock' && <Sample/>}</p>
    <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => void adapter.connectTwitch()}>Sign in to Twitch again</button>
    <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => void adapter.useSampleData()}>Use Sample data</button>
  </div>;
}
