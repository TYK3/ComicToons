import {useState,type KeyboardEvent} from 'react';
import {ViewerStage} from '../components/ViewerStage';
import {Panel} from '../components/Panel';
import {ReaderBar} from '../components/ReaderBar';
import {useAdapter,useUi,useLoad} from '../data/store';
import {useStudioMode} from '../data/StudioSession';
import {href} from '../router';
import '../styles/workspaces.css';

/** Audience interactions remain separate from producer controls and clean OBS output. */
export function Audience(){
  const ui=useUi(),adapter=useAdapter(),{mode}=useStudioMode();
  const [view,setView]=useState<'air'|'catchup'>('air'),[open,setOpen]=useState(false),[message,setMessage]=useState('');
  const [minutes,setMinutes]=useState(15);
  const version=JSON.stringify(ui.studio.panels.map(panel=>[panel.id,panel.caption,panel.imageUrl]));
  const {data,error,retry}=useLoad(()=>adapter.getCatchup(minutes),[adapter,minutes,version]);
  const arrival=ui.sampleSimulation?.arrival;
  const tabs=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const next=event.key==='Home'?'air':event.key==='End'?'catchup':view==='air'?'catchup':'air';
    setView(next);document.getElementById(`audience-tab-${next}`)?.focus();
  };
  return <div className="ct-audience" data-workspace={mode}>
    <ReaderBar look={false} backLabel={`${mode==='sample'?'Sample':'Live'} Studio`}><span>{mode==='sample'?'Sample':'Live'} audience view</span></ReaderBar>
    <a className="ct-skip" href="#ct-main">Skip to audience view</a><main id="ct-main" className="ct-audience__main">
      <header className="ct-audience__heading"><div><h1 className="ct-display">{ui.studio.streamTitle||'Waiting for the stream'}</h1><p>{mode==='sample'?'Simulated audience · no messages go to Twitch':'Released comic moments from this Studio'}</p></div>
        {mode==='sample'&&<button className="ct-btn" disabled={!ui.studio.panels.length} onClick={()=>{adapter.simulateSampleArrival?.();setView('catchup');}}>Join as a new viewer</button>}</header>
      <div className="ct-audience__switches">
        <div role="tablist" aria-label="Audience view" className="ct-preview-views" onKeyDown={tabs}>
          {([['air','On air'],['catchup','Catch-up']] as const).map(([id,label])=><button key={id} id={`audience-tab-${id}`} role="tab" tabIndex={view===id?0:-1} aria-selected={view===id} aria-controls={`audience-${id}`} onClick={()=>setView(id)}>{label}</button>)}
        </div>
        <button className="ct-btn ct-btn--sm" aria-expanded={open} aria-controls="audience-interactions" onClick={()=>setOpen(value=>!value)}>{open?'Hide interactions':'Show chat & votes'}</button>
      </div>
      <div className="ct-audience__layout" data-interactions={open}>
        <section className="ct-audience__player" aria-label="Stream screen">
          <div className="ct-audience__badge">{ui.studio.status==='ended'?'Stream ended':ui.studio.panels.length?'On air':'Waiting'}{mode==='sample'&&` · ${ui.sampleSimulation?.viewers??0} simulated viewers`}</div>
          <div id="audience-air" role="tabpanel" aria-labelledby="audience-tab-air" hidden={view!=='air'}>
            {ui.studio.hidden?<p className="ct-audience__waiting">The comic overlay is hidden by the streamer.</p>:!ui.studio.panels.length?<p className="ct-audience__waiting">{mode==='sample'?'Run the demo in Sample Studio to see the stream unfold.':'Approved comic moments will appear after the streamer releases them.'}</p>:<ViewerStage/>}
          </div>
          <section id="audience-catchup" className="ct-newcomer" role="tabpanel" aria-labelledby="audience-tab-catchup" hidden={view!=='catchup'}>
            <h2 className="ct-display">{arrival?`Welcome, ${arrival.name}`:'Previously on…'}</h2>
            <label className="ct-field">Catch-up window<select aria-label="Catch-up window" className="ct-select" name="catchup-window" value={minutes} onChange={event=>setMinutes(Number(event.target.value))}>{[5,15,30].map(value=><option key={value} value={value}>Last {value} minutes</option>)}</select></label>
            {error?<div role="alert"><p>Couldn’t load catch-up. {error}</p><button className="ct-btn" onClick={retry}>Retry catch-up</button></div>:!data?<p role="status">Loading catch-up…</p>:ui.studio.hidden?<p>The comic overlay is hidden by the streamer.</p>:data.panels.length?<div className="ct-newcomer__panels">{data.panels.map(panel=><Panel key={panel.id} panel={panel} tags={false}/>)}</div>:<p>No released panels in this window. Try a longer window or return to Studio.</p>}
          </section>
        </section>
        <aside id="audience-interactions" className="ct-audience__chat" aria-label="Audience interactions" hidden={!open}>
          <h2>Chat & interactions</h2>
          {ui.participation.poll?<section aria-label="Audience vote"><h3>Vote for the dialogue</h3>{ui.participation.poll.choices.map(choice=><p key={choice.key}>{adapter.castSampleVote?<button className="ct-btn ct-btn--sm" onClick={()=>adapter.castSampleVote?.(choice.key)}>Vote !{choice.key}</button>:<strong>!{choice.key}</strong>} {choice.caption} · {choice.votes} votes</p>)}<p>{ui.participation.poll.total} votes</p></section>:<p>{mode==='sample'?'No vote is open. The guided demo opens one automatically.':'No vote is open.'}</p>}
          {ui.participation.lastPoll&&<p role="status">Chat chose: {ui.participation.lastPoll.caption}</p>}
          {ui.participation.prediction&&<section aria-label="Audience prediction"><h3>{ui.participation.prediction.title}</h3>{ui.participation.prediction.outcomes.map(outcome=><p key={outcome.title}>{outcome.title} · {outcome.users} viewers {ui.participation.prediction?.status==='active'&&adapter.castSamplePrediction&&<button className="ct-btn ct-btn--sm" onClick={()=>adapter.castSamplePrediction?.(outcome.title)}>Back {outcome.title}</button>}</p>)}</section>}
          {mode==='sample'&&<form onSubmit={event=>{event.preventDefault();adapter.sendSampleChat?.(message);setMessage('');}}><label className="ct-field">Sample chat<input name="sample-chat" autoComplete="off" value={message} maxLength={400} onChange={event=>setMessage(event.target.value)} placeholder="Say hello, !1, !ink or !previously…"/></label><button className="ct-btn ct-btn--sm" disabled={!message.trim()}>Send sample chat</button></form>}
          {mode==='live'&&<p>Vote by typing the shown command in this channel’s Twitch chat. No messages are sent from this page.</p>}
          <ol aria-label="Audience chat">{ui.chat.slice(-12).map(line=><li key={line.id}><strong>{line.user}</strong> {line.text}</li>)}</ol>{!ui.chat.length&&<p>Waiting for chat…</p>}
        </aside>
      </div>
      <div className="ct-row"><a className="ct-btn" href={href('/overlay')}>Overlay preview</a><a className="ct-btn" href={href('/issues')}>Library</a></div>
    </main>
  </div>;
}
