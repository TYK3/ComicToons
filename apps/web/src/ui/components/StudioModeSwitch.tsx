import {useEffect,useState} from 'react';
import {useStudioMode} from '../data/StudioSession';
import '../styles/studio-controls.css';

/** Update the switch immediately while its workspace URL changes. */
export function StudioModeSwitch(){
  const {mode,setMode}=useStudioMode();
  const [live,setLive]=useState(mode==='live');
  useEffect(()=>setLive(mode==='live'),[mode]);
  return <label className="ct-source-switch"><span data-active={!live}>Sample</span><input type="checkbox" role="switch" aria-label="Live Twitch" checked={live} onChange={event=>{const next=event.target.checked;setLive(next);setMode(next?'live':'sample');}}/><span className="ct-source-switch__track" aria-hidden="true"/><span data-active={live}>Live</span></label>;
}
