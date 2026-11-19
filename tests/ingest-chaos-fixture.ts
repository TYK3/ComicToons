import {TwitchIrcAdapter,type IrcTransportFactory,type IrcSchedule} from '../apps/server/src/ingest/irc.ts';
import {EventEmitter} from 'node:events';

const LIVENESS_PING='PING :tmi.twitch.tv\r\n',PONG_REPLY=':tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv\r\n';
/** Deterministic local sockets and time; never falls through to a real endpoint.
 * With `pong` set, a socket answers the client's own liveness PING as Twitch would
 * (on the next virtual tick); `delays` records every delay the adapter schedules. */
export function chaosSource() {
  let time=0,sequence=0;
  const jobs=new Map<number,{at:number;run:()=>void}>();
  const delays:number[]=[];const options={pong:false};
  const queue=(run:()=>void,delay:number)=>{const id=++sequence;jobs.set(id,{at:time+delay,run});return ()=>{jobs.delete(id);};};
  const schedule:IrcSchedule=(run,delay)=>{delays.push(delay);return queue(run,delay);};
  const sockets:{handlers:Parameters<IrcTransportFactory>[0];sent:string[];closed:boolean}[]=[];
  const transport:IrcTransportFactory=handlers=>{
    const socket={handlers,sent:[] as string[],closed:false};sockets.push(socket);
    return {write:frame=>{socket.sent.push(frame);if(options.pong&&frame===LIVENESS_PING)queue(()=>{if(!socket.closed)handlers.data(PONG_REPLY);},0);},close:()=>{socket.closed=true;}};
  };
  const now=()=>time;
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:()=>({username:'sample_bot',token:'oauth:mock_read_only'}),transport,now,schedule,simulated:true});
  const latest=()=>sockets.at(-1)!;
  return {adapter,now,schedule,transport,sockets,delays,get jobs(){return jobs.size;},
    get pong(){return options.pong;},set pong(on:boolean){options.pong=on;},
    advance(ms:number){const target=time+ms;for(;;){const next=[...jobs].filter(([,job])=>job.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;jobs.delete(next[0]);time=next[1].at;next[1].run();}time=target;},
    welcome(){latest().handlers.open();latest().handlers.data(':tmi.twitch.tv 001 sample_bot :Welcome\r\n');},
    feed(chunk:string|Buffer){latest().handlers.data(chunk);},
    chat(id:string,text:string,user='viewer1'){latest().handlers.data(`@id=${id};user-id=${user};mod=0 :sample!sample@sample PRIVMSG #approved_test :${text}\r\n`);},
    drop(){latest().handlers.close();},fail(){latest().handlers.error();},
  };
}

/** Models the actual transport's socket timeout contract using virtual time. */
export class QuietIrcSocket extends EventEmitter {
  readonly sent:string[]=[];
  readonly idleTimeouts:number[]=[];
  closed=false;
  /** When set, the client's own liveness PING is answered with a PONG on the next virtual tick. */
  answerPing=false;
  private cancelIdle?:()=>void;
  constructor(private schedule:IrcSchedule){super();}
  setTimeout(ms:number,listener?:()=>void){
    this.cancelIdle?.();this.cancelIdle=undefined;this.idleTimeouts.push(ms);
    if(listener)this.on('timeout',listener);
    if(ms>0)this.cancelIdle=this.schedule(()=>{this.emit('timeout');},ms);
    return this;
  }
  write(frame:string){
    this.sent.push(frame);
    if(this.answerPing&&frame===LIVENESS_PING)this.schedule(()=>{if(!this.closed)this.emit('data',PONG_REPLY);},0);
    return true;
  }
  destroy(){this.closed=true;this.cancelIdle?.();return this;}
}
