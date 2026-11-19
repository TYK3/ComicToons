import { useEffect, useState, useRef } from 'react';
import { Radio, WifiOff } from 'lucide-react';
import { buildMangaPages } from '@comictoons/core';
import type { Studio } from '../hooks/useStudio';
import type { Panel } from '../types';
import { MangaPage } from './MangaPage';
import {overlayState,overlayPanels} from '../lib/overlay-state';
import {useEventStream} from '../hooks/useEventStream';
import type {StudioState} from '../types';
import type {CatchupData} from './CatchUp';
import {InkPanel} from './OutputPage';
import './overlay.css';

export function Overlay({ studio }: { studio: Studio }) {
  const [visible, setVisible] = useState<Panel[]>([]);
  const [exiting, setExiting] = useState(false);
  const [streamState,setStreamState]=useState<StudioState>();
  const [catchup,setCatchup]=useState<CatchupData>();
  const initialized=useRef(false);
  const firstFrame=useRef<StudioState | undefined>(undefined);
  const {error:streamError}=useEventStream('/api/events',event=>{try{
    const next=JSON.parse(event.data) as StudioState;
    if(initialized.current){setStreamState(next);return;}
    firstFrame.current=next;
    // Reconcile the opening SSE frame with the studio's initial snapshot;
    // subsequent updates come directly from the event stream.
    if(!studio.loading){initialized.current=true;setStreamState(studio.state);}
  }catch{/* Ignore malformed transport frames. */}},['state']);
  useEffect(()=>{if(!initialized.current&&firstFrame.current&&!studio.loading){initialized.current=true;setStreamState(studio.state);}},[studio.loading,studio.state]);
  // Once the state stream is live and the studio is healthy, skip the poll; resume it on any stream or studio error.
  const {pausePolling}=studio;
  useEffect(()=>{pausePolling(!!streamState&&!streamError&&!studio.error);return()=>pausePolling(false);},[pausePolling,streamState,streamError,studio.error]);
  useEventStream('/api/comics/events',event=>{try{setCatchup(JSON.parse(event.data));}catch{/* Ignore malformed transport frames. */}},['catchup']);
  useEffect(()=>{if(!catchup)return;const timer=setTimeout(()=>setCatchup(undefined),12000);return()=>clearTimeout(timer);},[catchup]);
  const state=overlayState(streamState,studio.state);
  const panels = state.status==='stopped'?[]:overlayPanels(state.panels);
  // Frames on the newest manga page (one approved panel can fill several frames), not approved panels.
  const onAirCount = buildMangaPages(panels).at(-1)?.panels.length ?? 0;
  const signature = panels.map(panel => panel.id).join('|');
  useEffect(() => {
    if (panels.length) { setVisible(panels); setExiting(false); return; }
    if (!visible.length) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setVisible([]); return; }
    setExiting(true);
    const timeout = setTimeout(() => { setVisible([]); setExiting(false); }, 160);
    return () => clearTimeout(timeout);
  // Polls do not replay the entrance animation for unchanged panel identities.
  }, [signature]);
  if(state.overlayHidden||state.status==='stopped')return <main className="overlay manga-overlay" aria-label="ComicToons OBS overlay"><h1 className="sr-only">Overlay hidden</h1></main>;
  if(catchup)return <main className="overlay s3-overlay" aria-label="ComicToons OBS overlay"><h1 className="s3-prev">PREVIOUSLY ON…</h1><div className="sr-only" role="status">Catch-up: {catchup.panelCount} approved moments</div>{catchup.raidLine&&<p className="s3-raid">{catchup.raidLine}</p>}<section className="s3-overlay-panels" aria-label="Catch-up panels">{overlayPanels(catchup.panels).map((p,i)=><InkPanel key={p.id} panel={p} number={i+1}/>)}{!overlayPanels(catchup.panels).length&&<p>No approved moments in this time range.</p>}</section><footer>{catchup.channel} · last {catchup.minutes} minutes · {catchup.panelCount} approved panels</footer></main>;
  return <main className="overlay manga-overlay" aria-label="ComicToons OBS overlay"><h1 className="sr-only">Previously on this stream</h1>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{studio.offline ? 'Overlay connection lost. Reconnecting.' : `${onAirCount} comic ${onAirCount === 1 ? 'frame' : 'frames'} on screen.`}</div>
    {visible.length ? <section className={`overlay-strip ${exiting ? 'is-exiting' : ''}`} style={{maxWidth: onAirCount === 5 ? 740 : 880}} aria-label="Previously on this stream">
      <MangaPage panels={visible} latest theme={state.mangaTheme}/>
      {studio.error && <div className="overlay-connection" role="alert"><WifiOff size={14}/>{studio.offline ? 'Reconnecting · last approved moments' : 'Studio unavailable · last approved moments'}</div>}
    </section> : <div className={`overlay-waiting ${studio.offline ? 'overlay-error' : ''} ${studio.state.status === 'stopped' && !studio.error ? 'sr-only' : ''}`} role={studio.error ? 'alert' : 'status'}>
      {studio.offline ? <WifiOff size={16}/> : <Radio size={16}/>}{studio.loading ? 'Opening the story…' : studio.error ? 'Studio disconnected · reconnecting' : studio.state.status === 'stopped' ? 'Overlay hidden · ready when you are' : 'Waiting for approved moments'}
    </div>}
  </main>;
}
