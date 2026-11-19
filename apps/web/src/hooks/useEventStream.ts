import {useEffect,useRef,useState} from 'react';

/** The slice of EventSource-like behaviour createEventStreamSession needs from a transport. */
export type StreamTransport={
  onopen:(()=>void)|null;
  onerror:(()=>void)|null;
  addEventListener(name:string,listener:(event:MessageEvent)=>void):void;
  close():void;
};

export type EventStreamIntervals={
  /** Silence (no bytes and no named event) longer than this is treated as a dead stream. */
  watchdogMs?:number;
  /** How often the watchdog checks for silence. */
  checkEveryMs?:number;
  /** Delay before each reconnect attempt, given the attempts made since the last success. */
  backoffMs?:(attempt:number)=>number;
};

export const DEFAULT_WATCHDOG_MS=25000;
export const DEFAULT_CHECK_EVERY_MS=1000;
export const defaultBackoffMs=(attempt:number)=>Math.min(1000*2**attempt,10000);

/**
 * A fetch-based stand-in for the browser's EventSource. Unlike EventSource, it hands every chunk
 * it reads - including heartbeat comment lines such as ": hb" - to onActivity, which is what the
 * watchdog in createEventStreamSession needs to tell "idle but connected" apart from "nothing is
 * coming through any more" (a dev-proxy that doesn't close the socket when the API dies: see
 * reports/2026-10-31-keys-1.md Part 2).
 */
export function createFetchEventSource(path:string,onActivity:()=>void):StreamTransport{
  const handlers=new Map<string,((event:MessageEvent)=>void)[]>();
  const controller=new AbortController();
  let closed=false;
  const transport:StreamTransport={
    onopen:null,onerror:null,
    addEventListener(name,listener){handlers.set(name,[...(handlers.get(name)??[]),listener]);},
    close(){closed=true;controller.abort();},
  };
  (async()=>{
    try{
      const response=await fetch(path,{headers:{accept:'text/event-stream'},signal:controller.signal});
      if(!response.ok||!response.body)throw new Error(`events ${response.status}`);
      transport.onopen?.();
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
      for(;;){
        const {done,value}=await reader.read();
        if(done)throw new Error('stream ended');
        onActivity();
        buffer+=decoder.decode(value,{stream:true});
        let cut:number;
        while((cut=buffer.indexOf('\n\n'))>=0){
          const block=buffer.slice(0,cut);buffer=buffer.slice(cut+2);
          const name=/^event: (.*)$/m.exec(block)?.[1];const data=/^data: (.*)$/m.exec(block)?.[1];
          if(name&&data!==undefined)for(const listener of handlers.get(name)??[])listener(new MessageEvent(name,{data}));
        }
      }
    }catch{
      if(closed)return;
      transport.onerror?.();
    }
  })();
  return transport;
}

export type EventStreamSession={start():void;stop():void};

/**
 * Owns one transport plus the liveness watchdog and the reconnect backoff. Framework-free, so it
 * can be driven by a fake transport and fake timers in tests; useEventStream below is the thin
 * React binding over it.
 */
export function createEventStreamSession(
  path:string,
  onMessage:(event:MessageEvent)=>void,
  eventNames:readonly string[],
  setError:(error:boolean)=>void,
  intervals:EventStreamIntervals={},
  connect:(path:string,onActivity:()=>void)=>StreamTransport=createFetchEventSource,
):EventStreamSession{
  const watchdogMs=intervals.watchdogMs??DEFAULT_WATCHDOG_MS;
  const checkEveryMs=intervals.checkEveryMs??DEFAULT_CHECK_EVERY_MS;
  const backoffMs=intervals.backoffMs??defaultBackoffMs;
  let transport:StreamTransport|undefined;
  let watchdog:ReturnType<typeof setInterval>|undefined;
  let reconnectTimer:ReturnType<typeof setTimeout>|undefined;
  let lastActivity=0;
  let attempt=0;
  let stopped=true;
  // True from the moment a drop is reported until the next connection attempt starts: without this,
  // the watchdog interval would see the same silence on every check and call drop() again each time,
  // which kept pushing the already-scheduled reconnect further back and it never actually fired.
  let dropped=false;
  const touch=()=>{lastActivity=Date.now();};
  const scheduleReconnect=()=>{
    if(stopped)return;
    reconnectTimer=setTimeout(open,backoffMs(attempt++));
  };
  const drop=()=>{
    if(dropped)return;
    dropped=true;
    transport?.close();
    setError(true);
    scheduleReconnect();
  };
  function open(){
    if(stopped)return;
    transport?.close();
    dropped=false;
    touch();
    const next=connect(path,touch);
    transport=next;
    next.onopen=()=>{attempt=0;touch();setError(false);};
    next.onerror=drop;
    for(const name of eventNames)next.addEventListener(name,event=>{touch();setError(false);onMessage(event);});
  }
  return{
    start(){
      stopped=false;
      open();
      watchdog=setInterval(()=>{if(!stopped&&!dropped&&Date.now()-lastActivity>watchdogMs)drop();},checkEveryMs);
    },
    stop(){
      stopped=true;
      clearInterval(watchdog);
      clearTimeout(reconnectTimer);
      transport?.close();
    },
  };
}

export function useEventStream(path:string,onMessage:(event:MessageEvent)=>void,eventNames:readonly string[]=['state','stream-event'],intervals?:EventStreamIntervals){
  const handler=useRef(onMessage);handler.current=onMessage;
  const [error,setError]=useState(false);
  const names=eventNames.join('|');
  useEffect(()=>{
    const session=createEventStreamSession(path,event=>handler.current(event),names.split('|'),setError,intervals);
    session.start();
    return()=>session.stop();
  },[path,names,intervals]);
  return {error};
}
