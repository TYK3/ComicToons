import { useId, useState } from 'react';
import { useAdapter, useUi } from '../data/store';
import { parseTwitchChannel, readingOtherChannel } from '../data/channel';
import { chatStateText } from '../screens/studio/live';
import { href } from '../router';
import '../styles/channel-picker.css';
import {useStudioMode} from '../data/StudioSession';

export function PublicChannelPicker({openStudio = false}: {openStudio?: boolean}) {
  const {twitch, studio} = useUi();
  const adapter = useAdapter();
  const {setMode}=useStudioMode();
  const id = useId();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const connected = twitch.state === 'connected';
  const other = readingOtherChannel(studio.source, twitch);
  const start = async (own = false) => {
    setError('');
    try {
      const channel = own ? twitch.login! : parseTwitchChannel(input);
      setBusy(true);
      await adapter.useLiveChat(channel,true);
      setMode('live');
      if (openStudio) window.location.assign(href('/studio',{workspace:'live'}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open this channel. Try again.');
    } finally { setBusy(false); }
  };
  return <form className="ct-channel-picker" aria-label="Read another channel" onSubmit={event => {event.preventDefault(); if (connected && !busy) void start();}}>
    <label className="ct-field" htmlFor={id}>Read another channel
      <input id={id} type="text" value={input} onChange={event => {setInput(event.target.value); setError('');}} placeholder="twitch.tv/channel or username" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={200} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={!!error}/>
    </label>
    <div className="ct-channel-picker__actions">
      <button type="submit" className="ct-btn ct-btn--ink ct-btn--sm" disabled={!connected || busy || !input.trim()} aria-busy={busy}>{busy ? 'Opening chat…' : 'Read chat'}</button>
      {other && connected && <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" disabled={busy} onClick={() => void start(true)}>Use my channel</button>}
      {studio.source.requested === 'twitch' && studio.source.channel && <button type="button" className="ct-btn ct-btn--ghost ct-btn--sm" disabled={busy} onClick={() => void adapter.useSampleData().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not stop reading.'))}>Stop reading</button>}
    </div>
    <p className="ct-note" id={`${id}-help`}>{connected ? 'Read public chat only. This does not capture video, create images or post messages. Streamer controls stay on your own channel.' : 'Connect Twitch, then enter a public channel to read its chat. Video capture is a separate action.'}</p>
    {studio.source.requested === 'twitch' && <p className="ct-channel-picker__status" role="status">{studio.source.channel?<>Reading #{studio.source.channel}{other ? ' · read-only' : ''} · {chatStateText(studio.source)}</>:'Choose a Twitch channel to start reading.'}</p>}
    <a className="ct-note" href={href('/flow')}>See how chat becomes a page →</a>
    {error && <p className="ct-channel-picker__error" id={`${id}-error`} role="alert">{error}</p>}
  </form>;
}
