import {useAdapter,useUi} from '../../data/store';
import {href} from '../../router';
import '../../styles/workspaces.css';

export type AudienceTool='chat'|'votes'|'cameos'|'predictions'|'settings';
export function SampleDemo({onView,onTool}:{onView:()=>void;onTool:(tool:AudienceTool)=>void}){
  const adapter=useAdapter(),ui=useUi();
  const simulation=ui.sampleSimulation;
  return <section className="ct-simulator" id="ct-simulator" aria-label="Sample stream simulator">
    <div className="ct-simulator__actions">
      <button className="ct-btn ct-btn--sm" type="button" disabled={!ui.studio.panels.length} onClick={()=>{adapter.simulateSampleArrival?.();onView();}}>Simulate viewer joining</button>
      <button className="ct-btn ct-btn--sm" type="button" disabled={!ui.studio.panels.length} onClick={()=>{adapter.simulateSampleRaid?.();onView();}}>Simulate a raid · 42 viewers</button>
      <button className="ct-btn ct-btn--sm" onClick={()=>onTool('votes')}>Try voting</button>
      <button className="ct-btn ct-btn--sm" onClick={()=>onTool('predictions')}>Try predictions</button>
      <button className="ct-btn ct-btn--sm" onClick={()=>onTool('cameos')}>Try a cameo</button>
      <a className="ct-head-link" href={href('/audience',{workspace:'sample'})} target="_blank" rel="noreferrer">Open viewer screen ↗</a>
    </div>
    <p className="ct-note" role="status">{simulation?.viewers??0} simulated viewers · {simulation?.events.at(-1)?.text??'Join a viewer or try an interaction, then watch On air.'}</p>
    {!!simulation?.events.length&&<details className="ct-simulator__history"><summary>Activity</summary><ol aria-label="Stream activity">{simulation.events.map(event=><li key={event.id}>{event.text}</li>)}</ol></details>}
  </section>;
}
