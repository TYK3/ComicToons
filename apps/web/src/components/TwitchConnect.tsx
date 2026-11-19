import {useEffect, useRef, useState} from 'react';
import {clearDirectorKey, listenForDirectorKeyRequired, setDirectorKey} from '../lib/director-key';

interface TwitchStatus {configured: boolean; connected: boolean; login?: string; reason?: string}
/** Minimal sign-in and tab-scoped director access, intentionally unmounted. */
export function TwitchConnect() {
  const [status, setStatus] = useState<TwitchStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyField=useRef<HTMLInputElement>(null);
  const [keyAlert,setKeyAlert]=useState('');
  useEffect(()=>listenForDirectorKeyRequired(setKeyAlert,()=>keyField.current?.focus()),[]);
  const [keyInput, setKeyInput] = useState('');
  const [keyNotice, setKeyNotice] = useState('');
  const denied = new URLSearchParams(window.location.search).get('twitch') === 'denied';
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch('/api/twitch/status', {signal: controller.signal, cache: 'no-store'});
        if (!response.ok) throw new Error();
        const next = await response.json() as TwitchStatus;
        if (active) setStatus(next);
      } catch {if (active) setError('Twitch status is unavailable. Try again.');}
    };
    void poll();
    const timer = window.setInterval(() => {void poll();}, 5000);
    return () => {active = false; controller.abort(); window.clearInterval(timer);};
  }, []);
  async function disconnect() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/twitch/disconnect', {method: 'POST'});
      if (!response.ok) {
        setError(response.status === 401 ? 'Enter the director key to disconnect Twitch.' : 'Twitch could not be disconnected. Try again.');
        return;
      }
      setStatus(await response.json() as TwitchStatus);
    } catch {setError('Twitch could not be disconnected. Try again.');}
    finally {setBusy(false);}
  }
  return <section aria-label="Twitch connection">
    <h2>Connect with Twitch</h2>
    {keyAlert && <p role="alert">{keyAlert}</p>}
    <label>Director key <input ref={keyField} type="password" autoComplete="off" value={keyInput} onChange={event => setKeyInput(event.target.value)}/></label>
    <button type="button" onClick={() => {setDirectorKey(keyInput); setKeyInput(''); setKeyAlert(''); setKeyNotice('Director key saved for this tab.');}}>Save</button>
    <button type="button" onClick={() => {clearDirectorKey(); setKeyInput(''); setKeyNotice('Director key forgotten.');}}>Forget</button>
    {keyNotice && <p role="status">{keyNotice}</p>}
    {denied && <p role="alert">Twitch sign-in was denied. You can try again.</p>}
    <p role="status" aria-live="polite">{!status ? 'Checking Twitch connection…' : !status.configured ? 'Twitch is not configured on this server.' : status.connected ? `Connected as ${status.login}` : 'Connect your Twitch account.'}</p>
    {status?.configured && !status.connected && <a href="/auth/twitch/login">Connect with Twitch</a>}
    {status?.connected && <button type="button" disabled={busy} onClick={() => {void disconnect();}}>{busy ? 'Disconnecting…' : 'Disconnect'}</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
