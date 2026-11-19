import {ViewerStage} from '../components/ViewerStage';
import {href,type Route} from '../router';
import {useStudioMode} from '../data/StudioSession';
import {useUi} from '../data/store';
import '../styles/overlay.css';

/** The OBS output uses the same stage and release animations as Studio On air. */
export function Overlay({route}:{route:Route}){
  const {mode}=useStudioMode(),ui=useUi(),clean=route.params.get('obs')==='1';
  const label=mode==='sample'?'Sample':'Live';
  return <div className="ct-overlay-root" data-clean={clean||undefined} data-backdrop={!clean||route.params.get('bg')==='1'||undefined}>
    {!clean&&<header className="ct-overlay-controls"><a className="ct-btn" href={href('/studio?obs=0')}>← Back to {label} Studio</a><strong>{label} overlay</strong><a className="ct-btn" href={href('/audience?obs=0')}>Viewer screen</a><a className="ct-btn" href={href('/overlay?obs=1')}>Clean OBS output</a></header>}
    {!clean&&(!ui.studio.panels.length||ui.studio.hidden)&&<p className="ct-overlay-status">{ui.studio.hidden?'Overlay hidden. Return to Studio and choose Show overlay.':`Waiting for released ${label} panels. Return to Studio to start.`}</p>}
    <main className="ct-audience-output"><ViewerStage/></main>
  </div>;
}
