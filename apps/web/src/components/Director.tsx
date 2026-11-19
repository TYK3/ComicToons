import { useCallback, useEffect, useState } from 'react';
import './director.css';

// Streamer director mode (S4): a phone page to approve or reject the oldest waiting panel.
type Card = { id: string; caption: string; dialogue: string[]; imageUrl: string; altText: string; cameo?: string; voters?: number };
type View = { enabled: boolean; pending: Card[]; pendingCount: number; approvedCount: number; log: { action: string; panelId: string; by: string; via: string }[] };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'That did not work. Try again.');
  return data;
}

export function Director() {
  const [view, setView] = useState<View | null>(null);
  const [message, setMessage] = useState('');
  const [offline, setOffline] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const refresh = useCallback(async () => {
    try { setView(await call<View>('/api/participation/director')); setOffline(false); } catch { setOffline(true); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1500); return () => window.clearInterval(timer); }, [refresh]);
  const card = view?.pending[0];
  const decide = (action: 'approve' | 'reject') => {
    if (!card) return;
    call(`/api/participation/director/${action}`, { panelId: card.id })
      .then(() => setMessage(action === 'approve' ? 'Approved. It is on the overlay.' : 'Rejected. It will not be shown.'))
      .catch((error: Error) => setMessage(error.message)).finally(() => void refresh());
  };
  const panicHide = () => {
    if (!confirmHide) { setConfirmHide(true); return; }
    setConfirmHide(false);
    call('/api/stop', {}).then(() => setMessage('Stopped. Nothing new will reach the overlay.')).catch((error: Error) => setMessage(error.message));
  };
  return (
    <main id="main-content" className="pc-director">
      <header className="pc-director__top">
        <h1>Director</h1>
        {view?.enabled && <p className="pc-director__count" aria-live="polite">{view.pendingCount} waiting · {view.approvedCount} on air</p>}
      </header>
      {offline && <p className="pc-director__msg" role="alert">Can’t reach ComicToons. Is the studio running?</p>}
      {view && !view.enabled && <p className="pc-director__msg">Director mode is switched off. Set COMICTOONS_FLAG_DIRECTOR=1 and restart ComicToons.</p>}
      {view?.enabled && (card ? <section className="pc-director__card" aria-label="Oldest waiting panel">
        <figure>
          <img src={card.imageUrl} alt={card.altText}/>
          <figcaption>
            <span className="pc-director__caption">{card.caption}</span>
            {card.dialogue[0] && <span className="pc-director__line">“{card.dialogue[0]}”</span>}
            {(card.cameo || card.voters) && <span className="pc-director__meta">{card.cameo ? 'Channel-point cameo' : ''}{card.cameo && card.voters ? ' · ' : ''}{card.voters ? `${card.voters} voted` : ''}</span>}
          </figcaption>
        </figure>
        <div className="pc-director__actions">
          <button type="button" className="pc-director__btn pc-director__btn--yes" onClick={() => decide('approve')}>Approve</button>
          <button type="button" className="pc-director__btn" onClick={() => decide('reject')}>Reject</button>
        </div>
      </section> : <p className="pc-director__msg">No panel is waiting. New ones appear here as chat draws them.</p>)}
      {message && <p className="pc-director__msg" role="status">{message}</p>}
      {view?.enabled && <>
        <button type="button" className="pc-director__panic" onClick={panicHide} aria-describedby="pc-panic-help">{confirmHide ? 'Tap again to stop' : 'Panic: stop the comic'}</button>
        <p id="pc-panic-help" className="pc-director__help">Stops the comic and clears the overlay at once. Mods can also type !ink yes or !ink no in chat.</p>
      </>}
    </main>
  );
}
