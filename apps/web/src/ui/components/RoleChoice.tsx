import {useState} from 'react';
import {useWatch} from '../data/watch';
import '../styles/watch.css';
export function RoleChoice(){
  const {role,choose}=useWatch();const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <section className="ct-role-choice" aria-label="Choose your role"><span>I’m here as a</span><div role="group" aria-label="Streamer or Viewer">{(['streamer','viewer'] as const).map(value=><button type="button" className="ct-btn ct-btn--sm" key={value} aria-pressed={role===value} disabled={busy} onClick={()=>{setBusy(true);void choose(value).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{value==='streamer'?'Streamer':'Viewer'}</button>)}</div><p>{role==='streamer'?'Your own stream, with review and broadcast controls.':'Capture another channel’s video. Choose a duration and page settings before starting.'}</p>{error&&<p role="alert">{error}</p>}</section>;
}
