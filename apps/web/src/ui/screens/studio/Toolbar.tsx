import {useState} from 'react';
import {ConnectButton} from '../../components/TwitchConnect';
import {StudioModeSwitch} from '../../components/StudioModeSwitch';
import {useStudioMode} from '../../data/StudioSession';
import {useAdapter,useUi} from '../../data/store';
import {href} from '../../router';
import {SampleDemo,type AudienceTool} from './SampleDemo';

/** One persistent row: source, playback and the in-page audience drawer. */
export function Toolbar({previewOpen,onPreview,onTool}:{previewOpen:boolean;onPreview:()=>void;onTool:(tool:AudienceTool)=>void}){
  const ui=useUi(),adapter=useAdapter(),{mode}=useStudioMode();
  const [simulationOpen,setSimulationOpen]=useState(false),[error,setError]=useState('');
  const sample=mode==='sample',running=ui.sampleSimulation?.guided;
  const paused=ui.sampleSimulation?.paused;
  const runDemo=(fixtureId?:string)=>{
    setError('');if(!previewOpen)onPreview();
    void adapter.startSampleDemo?.(fixtureId).catch(cause=>setError(cause instanceof Error?cause.message:'Could not start the demo.'));
  };
  return <section className="ct-toolbar" aria-label="Studio controls">
    <div className="ct-toolbar__primary">
      <StudioModeSwitch/>
      {sample?<>
        <label className="ct-stream-select"><span className="ct-sr">Sample stream</span><select id="ct-stream" aria-label="Sample stream" className="ct-select" value={ui.studio.fixtureId} onChange={event=>{if(event.target.value==='jynxzi-qa')void adapter.replay(event.target.value);else runDemo(event.target.value);}}>{ui.fixtures.map(fixture=><option key={fixture.id} value={fixture.id}>{fixture.streamTitle}</option>)}</select></label>
        <button className="ct-btn ct-btn--ink ct-btn--sm" type="button" aria-label={running?'Pause demo':paused?'Resume demo':'Run the stream demo'} onClick={()=>{if(running)adapter.stopSampleDemo?.();else if(paused){adapter.resumeSampleDemo?.();if(!previewOpen)onPreview();}else runDemo();}}>{running?'Pause demo':paused?'Resume demo':'Run demo'}</button>
        <button className="ct-btn ct-btn--sm ct-simulator-toggle" type="button" role="switch" aria-label="Viewer simulator" aria-checked={simulationOpen} aria-controls="ct-simulator" onClick={()=>setSimulationOpen(value=>!value)}><span className="ct-control-full">Simulate viewers</span><span className="ct-control-short">Simulator</span><span aria-hidden="true">{simulationOpen?'▴':'▾'}</span></button>
        <details className="ct-replay-menu"><summary>Replay settings</summary><div className="ct-replay-menu__body"><p className="ct-note">Run demo handles releases and audience activity automatically. Restart replay below to review panels yourself.</p><button className="ct-btn ct-btn--sm" onClick={()=>runDemo()}>Restart guided demo</button><div className="ct-seg" role="radiogroup" aria-label="Replay speed">{([1,10,60] as const).map(speed=><button key={speed} type="button" role="radio" aria-checked={ui.studio.speed===speed} onClick={()=>void adapter.setSpeed(speed)}>{speed}×</button>)}</div><button className="ct-btn ct-btn--sm" onClick={()=>void adapter.replay(ui.studio.fixtureId)}>Restart replay</button><button className="ct-btn ct-btn--sm" onClick={()=>adapter.pauseReplay?.()} disabled={running||!ui.sampleReplay?.revealed||ui.sampleReplay.revealed>=ui.sampleReplay.total}>{ui.sampleReplay?.running?'Pause replay':'Resume replay'}</button></div></details>
      </>:<><span className="ct-toolbar__channel">{ui.studio.source.channel?`#${ui.studio.source.channel}`:'Choose a Twitch channel below'}</span>{ui.twitch.state==='connected'?<a className="ct-btn ct-btn--sm" href={href('/connect')}>Twitch account</a>:<ConnectButton/>}</>}
      <button className="ct-btn ct-btn--sm ct-preview-toggle" aria-label={previewOpen?'Hide On air':'Show On air'} aria-expanded={previewOpen} aria-controls="ct-audience-sidebar" onClick={onPreview}><span className="ct-control-full">{previewOpen?'Hide On air':'Show On air'}</span><span className="ct-control-short">On air</span><span aria-hidden="true">◧</span></button>
    </div>
    {sample&&simulationOpen&&<SampleDemo onView={()=>{setSimulationOpen(false);if(!previewOpen)onPreview();}} onTool={tool=>{setSimulationOpen(false);onTool(tool);}}/>}
    {sample&&ui.studio.status==='ended'&&ui.studio.recapUrl&&<a className="ct-note ct-finished-issue" href={href(ui.studio.recapUrl)}>Read the finished Sample issue</a>}
    {error&&<p className="ct-note" role="status">{error}</p>}
  </section>;
}
