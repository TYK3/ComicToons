import {useEffect,useState} from 'react';
import {useUi,useUiEvents} from '../data/store';
import type {UiSnapshot} from '../data/adapter';
import {Panel} from './Panel';
import '../styles/viewer-stage.css';

/** One presentation for the Studio preview and the standalone audience output. */
export function ViewerStage({preview=false}:{preview?:boolean}){
  const ui=useUi();
  const [eventCue,setEventCue]=useState<UiSnapshot['broadcast']>();
  const [expired,setExpired]=useState('');
  const [hype,setHype]=useState<{level:number;at:number}>();
  const predictionResult=ui.participation.prediction;
  useEffect(()=>{
    if(predictionResult?.status==='resolved')setEventCue({id:`prediction-${predictionResult.id}`,kind:'prediction-result',title:'Prediction resolved',detail:predictionResult.winner,createdAt:Date.now()});
  },[predictionResult?.id,predictionResult?.status,predictionResult?.winner]);
  useUiEvents(['hype-splash'],event=>{if(event.name==='hype-splash')setHype(event.data);});
  useEffect(()=>{if(!hype)return;const timer=setTimeout(()=>setHype(undefined),6000);return()=>clearTimeout(timer);},[hype]);
  useUiEvents(['catchup'],event=>{if(event.name==='catchup')setEventCue({id:`catchup-${Date.now()}`,kind:'catchup',createdAt:Date.now(),title:'Previously on…',panelIds:event.data.panelIds});});
  const cue=ui.broadcast??eventCue;
  useEffect(()=>{if(!cue)return;const timer=setTimeout(()=>setExpired(cue.id),Math.max(0,10000-(Date.now()-cue.createdAt)));return()=>clearTimeout(timer);},[cue?.id]);
  const active=cue&&cue.id!==expired?cue:undefined;
  const catchup=active?.kind==='catchup';
  const released=ui.studio.panels;
  const selected=catchup?released.filter(p=>active.panelIds?.includes(p.id)).slice(-6):released.slice(-3);
  const {poll,prediction}=ui.participation;
  const predictionVisible=prediction&&(prediction.status!=='resolved'||active?.kind==='prediction-result');
  const hidden=ui.studio.hidden&&!preview;
  return <section className={`ct-viewer-stage${preview?' ct-viewer-stage--preview':''}`} aria-label={preview?'Viewer preview':'Viewer output'} data-cue={active?.kind??'panel'} data-hidden={hidden||undefined}>
    {!hidden&&<div className="ct-viewer-content" key={active?.id??selected.at(-1)?.id??'empty'}>
      {hype&&<p className="ct-viewer-banner" role="status">Hype Train · Level {hype.level}</p>}
      {catchup&&<h3 className="ct-viewer-intro">Previously on…</h3>}
      {active?.kind==='stream-end'&&<p className="ct-viewer-banner" role="status"><strong>{active.title}</strong><span>{active.detail}</span></p>}
      {active?.kind==='inkme'&&<p className="ct-viewer-banner" role="status">✦ {active.title}</p>}
      {active?.kind==='vote-result'&&<p className="ct-viewer-banner" role="status"><strong>{active.title}</strong>{active.detail&&<span>{active.detail}</span>}</p>}
      {active?.kind==='prediction-result'&&<p className="ct-viewer-banner" role="status">Prediction result: <strong>{active.detail}</strong></p>}
      {selected.length?<div className="ct-viewer-panels" data-count={selected.length} data-catchup={catchup||undefined}>
        {selected.map((panel,index)=><div key={panel.id} className="ct-viewer-item" style={{animationDelay:`${catchup?index*350:index*100}ms`}}><Panel panel={panel} tags={false} eager/>{panel.cameo&&<p className="ct-viewer-cameo">✦ @{panel.cameo}</p>}</div>)}
      </div>:<p className="ct-viewer-empty">{preview?'Release a panel to see the viewer animation here.':''}</p>}
      {poll&&<section className="ct-viewer-participation" aria-label="Viewer vote"><h3>Chat votes the dialogue</h3>{poll.choices.map(choice=><div key={choice.key} className="ct-viewer-choice"><span>!{choice.key} · {choice.caption}</span><strong>{choice.votes}</strong><i style={{width:`${poll.total?choice.votes/poll.total*100:0}%`}}/></div>)}<p>{poll.total} votes · Type !1, !2 or !3</p></section>}
      {predictionVisible&&<section className="ct-viewer-participation" aria-label="Viewer prediction"><h3>{prediction.title}</h3>{prediction.outcomes.map(outcome=><p key={outcome.title}><strong>{prediction.winner===outcome.title?'✓ ':''}{outcome.title}</strong> · {outcome.users} viewers · {outcome.points} {ui.sampleReplay?'sample ':''}points</p>)}<p>{prediction.status==='resolved'?`Winner: ${prediction.winner}`:'Choose your outcome'}</p></section>}
    </div>}
  </section>;
}
