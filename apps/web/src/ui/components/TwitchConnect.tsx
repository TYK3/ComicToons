import { useEffect, useRef, useState } from 'react';
import { canUseChannelFeatures } from '../data/adapter';
import { useAdapter, useUi } from '../data/store';
import { twitchErrorCopy } from '../data/twitch-copy';
import { ChatGlyph } from './Icons';
import { chatSourceChip, isKeyless } from '../screens/studio/live';

/** UI-HEAD #4: a computer with no Twitch app set up. Nothing failed: sign-in just can't start here yet. */
export const KEYLESS_TITLE = 'Twitch sign-in isn’t set up on this computer.';
export const KEYLESS_BODY = 'ComicToons runs on Sample data until a Twitch app’s client ID and secret are added to the studio’s .env file (see .env.example) and the studio is restarted.';

/** The only purple element in the product. */
export function ConnectButton({ wide = false }: { wide?: boolean }) {
  const { twitch } = useUi();
  const adapter = useAdapter();
  const connecting = twitch.state === 'connecting';
  // A keyless computer can't start a sign-in, so the button says why instead of failing.
  const keyless = isKeyless(twitch);
  return <button type="button" className={`ct-btn ct-btn--twitch${wide ? ' ct-btn--wide' : ''}`} aria-disabled={connecting || keyless || undefined} aria-busy={connecting || undefined}
    aria-describedby={keyless ? 'ct-keyless-note' : undefined} onClick={() => { if (!connecting && !keyless) void adapter.connectTwitch(); }}>
    {connecting ? <span className="ct-spin" aria-hidden="true"/> : <ChatGlyph/>}
    {connecting ? 'Waiting for Twitch…' : 'Connect with Twitch'}
  </button>;
}

/** Signed-in account button with a small disclosure (Disconnect). A11Y-fix #4: a plain disclosure, not role=menu. */
function AccountMenu() {
  const { twitch } = useUi();
  const adapter = useAdapter();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Once disconnected this button goes; if focus fell to the page, hand it to Connect with Twitch.
  const refocus = () => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) document.querySelector<HTMLElement>('.ct-tool--channel .ct-btn--twitch')?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape from inside the panel hands focus back to the button that opened it.
      if (root.current?.contains(document.activeElement)) trigger.current?.focus();
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return <div className="ct-menu" ref={root} onBlur={event => { if (open && event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" className="ct-account" aria-expanded={open} aria-controls="ct-account-menu" onClick={() => setOpen(value => !value)}>
      <span className="ct-dot" aria-hidden="true"/>@{twitch.login}<span className="ct-sample">Sample</span><span aria-hidden="true">▾</span>
    </button>
    {open && <div className="ct-menu__list" id="ct-account-menu">
      <button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); void adapter.disconnectTwitch().then(refocus, () => undefined); }}>Disconnect Twitch</button>
    </div>}
  </div>;
}

/** Channel group of the studio toolbar: the D1c Connect with Twitch states. */
export function ChannelGroup() {
  const ui = useUi();
  const adapter = useAdapter();
  const { twitch, studio } = ui;
  const live = studio.source.active === 'twitch';
  // UI-LIVE-B #7: the same words as the header chip (chatSourceChip), whether or not you're signed in.
  const chip = chatSourceChip(studio.source);
  const keyless = isKeyless(twitch);
  const status = twitch.state === 'connecting' ? 'Waiting for Twitch. Finish signing in on the Twitch tab.'
    : twitch.state === 'connected' ? `Connected to Twitch as @${twitch.login}. ${chip}.${canUseChannelFeatures(twitch) ? '' : ' Ink me is off because this channel is not an Affiliate or Partner yet.'}`
      : keyless ? `${KEYLESS_TITLE} ${chip}.` : '';
  return <div className="ct-tool ct-tool--channel">
    <p className="ct-tool__label">Channel <span className="ct-tool__hint">
      {twitch.state === 'connecting' ? 'Finish signing in on the Twitch tab.'
        : twitch.state === 'connected' ? (canUseChannelFeatures(twitch) ? `Connected. ${chip}.` : <span className="ct-hintchip">Ink me is off: needs Affiliate</span>)
          : <span id={keyless ? 'ct-keyless-note' : undefined}>{keyless ? 'Sign-in isn’t set up on this computer. ' : ''}{live ? `${chip}, read without signing in.` : chip === 'Sample data' ? 'Sample data until you connect.' : `${chip}.`}</span>}
    </span></p>
    <div className="ct-tool__row">
      {twitch.state === 'connected' ? <>
        <AccountMenu/>
        <div className="ct-seg" role="radiogroup" aria-label="Chat source">
          <button type="button" role="radio" aria-checked={live} onClick={() => void adapter.useLiveChat()}>Live chat</button>
          <button type="button" role="radio" aria-checked={!live} onClick={() => void adapter.useSampleData()}>Sample</button>
        </div>
      </> : <>
        <ConnectButton/>
        {twitch.state === 'connecting' && <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => void adapter.cancelConnect()}>Cancel</button>}
      </>}
    </div>
    <p className="ct-sr" role="status" aria-live="polite">{status}</p>
  </div>;
}

/**
 * W4, reconciled with item 9: the ink 'Try again' is a secondary outline button that re-checks the sign-in
 * (checkTwitch, GET /api/twitch/status). It never starts OAuth, so the purple Connect stays the single primary.
 */
export function TryAgain({ small = false }: { small?: boolean }) {
  const { busy } = useUi();
  const adapter = useAdapter();
  const checking = busy === 'twitch-check';
  return <button type="button" className={`ct-btn${small ? ' ct-btn--sm' : ''}`} aria-busy={checking || undefined} disabled={checking} onClick={() => void adapter.checkTwitch()}>{checking ? 'Checking…' : 'Try again'}</button>;
}

/** Full-width sign-in error banner (role=alert). The purple Connect stays in the toolbar; here only the ink Try again and Dismiss. */
export function TwitchErrorBanner() {
  const { twitch } = useUi();
  const adapter = useAdapter();
  if (twitch.state !== 'error') return null;
  // UI-HEAD #4: on a keyless computer no sign-in was tried, so don't say one failed.
  if (isKeyless(twitch)) return <div className="ct-banner ct-banner--paper" role="status" aria-live="polite" data-keyless>
    <p><strong>{KEYLESS_TITLE}</strong> {KEYLESS_BODY}</p>
    <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => adapter.dismissTwitchError()}>Dismiss</button>
  </div>;
  // BANNERS: the heading follows the reason the server reported (data/twitch-copy.ts), so a session that ended mid-stream no longer reads as an unfinished sign-in.
  const copy = twitchErrorCopy(twitch.error);
  return <div className="ct-banner ct-banner--paper" role="status" aria-live="polite">
    <p><strong>{copy.heading}</strong> {copy.detail}</p>
    <TryAgain small/>
    <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => adapter.dismissTwitchError()}>Dismiss</button>
  </div>;
}

/** Shown wherever a feature needs Affiliate or Partner (Ink me, Twitch polls, predictions). */
export function AffiliateNotice({ feature, fallback }: { feature: string; fallback?: string }) {
  const { twitch } = useUi();
  return <div className="ct-notice" id={`ct-aff-${feature.replace(/\W+/g, '-').toLowerCase()}`}>
    <span className="ct-notice__mark" aria-hidden="true">!?</span>
    <p><strong>{feature} needs an Affiliate or Partner channel.</strong> Twitch only lets Affiliates and Partners use this, and @{twitch.login ?? 'your channel'} isn’t one yet. {fallback ?? 'Everything else still works: live chat, raids, and chat votes with !1, !2 and !3.'} <a className="ct-inline-link" href="https://help.twitch.tv/s/article/joining-the-affiliate-program" target="_blank" rel="noopener noreferrer">How to become an Affiliate</a></p>
  </div>;
}
