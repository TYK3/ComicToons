import {useEffect,useState} from 'react';
import {chatSourceLabel,chatTransportLabel,isSampleSource,type ChatSourceState} from '@comictoons/core';
import type {Studio} from '../hooks/useStudio';
import {Button} from './ui';

/** BANNER-RAID-1: quiet chat stays Live (RAID-SAMPLE-1), so "gone quiet" is a client-side window: no new line for this long. */
export const CHAT_QUIET_MS=60_000;

/** BANNER-RAID-1: true while real live chat has read a line and this page has seen no new one for `quietMs`. */
function useLiveChatQuiet(source:ChatSourceState|undefined,quietMs:number){
  const received=source?.received??0;
  const [mark,setMark]=useState(()=>({received,at:Date.now()}));
  if(mark.received!==received)setMark({received,at:Date.now()});
  const [now,setNow]=useState(mark.at);
  const due=mark.at+quietMs;
  const watching=source?.active==='twitch'&&!source.simulated&&source.connection==='live'&&received>0;
  useEffect(()=>{
    if(!watching)return;
    const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,due-Date.now()));
    return ()=>clearTimeout(timer);
  },[watching,due]);
  return watching&&now-mark.at>=quietMs;
}

export function ChatSourceControl({studio,quietAfterMs=CHAT_QUIET_MS}:{studio:Studio;quietAfterMs?:number}) {
  const [channel,setChannel]=useState('');
  const source=studio.state.source;
  const quiet=useLiveChatQuiet(source,quietAfterMs);
  const reason=source?.reason;
  const transport=chatTransportLabel(source);
  const explanation=source?.active==='twitch'
    ? (source.simulated?'Simulated IRC messages. This is Sample Data.'
      // BANNER-RAID-1: a quiet spell stays Live; say so instead of "chat is arriving".
      :quiet?`Chat has gone quiet after ${source.received} ${source.received===1?'line':'lines'}. Still live: new messages are read as they arrive.`
      :'Read-only chat is arriving. Artwork is illustrative, not a video capture.')
    : reason==='paused'?'Live ingest paused'
    : reason==='unauthenticated'?'Live chat access is not configured. Sample Data is ready.'
    : reason==='unreachable'?'Twitch could not be reached. Sample Data is ready.'
    : reason==='disconnected'?'Chat disconnected. Sample Data is ready.'
    // CHAT-BANNER-1: once a line has been received, Sample Data while still asking for Twitch is not "no chat yet".
    : source?.requested==='twitch'&&(source.received??0)>0?`Chat has gone quiet after ${source.received} ${source.received===1?'line':'lines'}. Showing Sample Data until the next message.`
    : source?.requested==='twitch'?'No chat messages yet. Showing Sample Data while we wait.'
    :'Curated sample stories, ready without a connection.';
  return <section className="chat-source-control" aria-label="Chat source">
    <div className="chat-source-status"><span className="chat-source-heading" data-testid="source-heading"><strong data-testid="source-label">{chatSourceLabel(source)}</strong>{transport&&<span className="chat-source-transport" data-testid="source-transport" title="Chat connection">{` · ${transport}`}</span>}</span><p role="status" aria-live="polite">{explanation}</p></div>
    {source?.active==='twitch'&&!!source.throttled&&<p className="chat-source-throttle" data-testid="throttle-notice" role="status" aria-live="polite">Chat is busier than ComicToons reads: {source.throttled} chat {source.throttled===1?'line':'lines'} skipped on this connection (limit 60 per second). Opt-outs and deletions are never skipped.</p>}
    <div className="chat-source-actions"><label htmlFor="twitch-channel">Twitch channel<input id="twitch-channel" value={channel} onChange={event=>setChannel(event.target.value.replace(/^#/,''))} maxLength={25} autoComplete="off" spellCheck={false} placeholder="channel_name"/></label>
      <Button disabled={!!studio.busy||!channel.trim()} onClick={()=>void studio.mutate('/api/ingest',{mode:'twitch',channel:channel.trim().toLowerCase()}).catch(()=>{})}>Try read-only Twitch</Button>
      <Button variant="primary" disabled={!!studio.busy||!studio.sampleReady} aria-pressed={isSampleSource(source)} onClick={()=>void studio.useSampleData().catch(()=>{})}>Use Sample Data now</Button>
    </div>
  </section>;
}
