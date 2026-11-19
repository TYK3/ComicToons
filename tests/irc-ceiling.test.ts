import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitchIrcAdapter,MAX_WAIT_MS,type IrcSchedule,type IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';

/** Fifteen minutes, written out independently of the MAX_WAIT_MS export so a
 * change to that constant's value cannot also change what the test expects. */
const FIFTEEN_MINUTES_MS=15*60_000;

/** Virtual time only: every scheduled delay is recorded and nothing waits on a real clock or socket. */
function virtualClock(){
  let time=0,sequence=0;
  const jobs=new Map<number,{at:number;run:()=>void}>();
  const delays:number[]=[];
  const schedule:IrcSchedule=(run,delay)=>{
    delays.push(delay);
    const id=++sequence;jobs.set(id,{at:time+delay,run});
    return ()=>{jobs.delete(id);};
  };
  return {now:()=>time,schedule,delays,
    get jobs(){return jobs.size;},
    advance(ms:number){
      const target=time+ms;
      for(;;){
        const next=[...jobs].filter(([,job])=>job.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
        if(!next)break;
        jobs.delete(next[0]);time=next[1].at;next[1].run();
      }
      time=target;
    }};
}

/** With `pong.on`, the fake answers the client's own liveness PING (asynchronously,
 * as a server would), so a quiet but healthy link survives long virtual gaps. */
function harness(pong={on:false}){
  const clock=virtualClock();
  const sockets:{handlers:Parameters<IrcTransportFactory>[0];closed:boolean}[]=[];
  const transport:IrcTransportFactory=handlers=>{
    const socket={handlers,closed:false};sockets.push(socket);
    return {write:frame=>{if(pong.on&&frame==='PING :tmi.twitch.tv\r\n')clock.schedule(()=>{if(!socket.closed)handlers.data(':tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv\r\n');},0);},
      close:()=>{socket.closed=true;}};
  };
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:()=>({username:'sample_bot',token:'oauth:mock_read_only'}),
    transport,now:clock.now,schedule:clock.schedule,simulated:true});
  return {clock,sockets,adapter};
}

test('IRC-CEILING-CONST: the documented ceiling constant is fifteen minutes',()=>{
  assert.equal(MAX_WAIT_MS,FIFTEEN_MINUTES_MS);
});

test('IRC-CEILING-WATCHDOG: a server PING cadence slower than seven-and-a-half minutes clips the next watchdog gap to fifteen minutes, never the uncapped double',()=>{
  const pong={on:true};const {clock,sockets,adapter}=harness(pong);
  adapter.start({event:()=>{},status:()=>{}});
  try{
    sockets[0]!.handlers.open();
    sockets[0]!.handlers.data(':tmi.twitch.tv 001 sample_bot :Welcome\r\n');
    sockets[0]!.handlers.data('PING :tmi.twitch.tv\r\n');
    clock.advance(599_999); // just under a ten-minute server cadence, so this PING beats the bootstrap watchdog
    sockets[0]!.handlers.data('PING :tmi.twitch.tv\r\n');
    // Uncapped, the next gap would be roughly 2 * 600_000 = 1_200_000ms; the ceiling clips it.
    assert.equal(clock.delays.at(-1),FIFTEEN_MINUTES_MS);
    assert.ok(clock.delays.every(delay=>delay<=FIFTEEN_MINUTES_MS),`every scheduled delay must stay at or under the ceiling, got ${clock.delays}`);
    // Once the link goes truly silent, the liveness deadline (60 s idle + 15 s) closes it long before that clipped gap.
    pong.on=false;
    clock.advance(74_999);assert.equal(sockets[0]!.closed,false);
    clock.advance(1);assert.equal(sockets[0]!.closed,true,'a silent welcomed link is closed by the liveness deadline, inside the ceiling');
  }finally{adapter.stop();}
});

test('IRC-CEILING-GIVEUP: a continuously failing reconnect gives up well inside the fifteen-minute ceiling and reports a clear status',()=>{
  const {clock,sockets,adapter}=harness();
  const statuses:{status:string;retrying?:boolean}[]=[];
  adapter.start({event:()=>{},status:(status,retrying)=>statuses.push({status,retrying})});
  const startedAt=clock.now();
  try{
    for(const delay of [1000,2000,4000]){
      sockets.at(-1)!.handlers.close();
      const count=sockets.length;
      clock.advance(delay-1);assert.equal(sockets.length,count);
      clock.advance(1);assert.equal(sockets.length,count+1);
    }
    sockets.at(-1)!.handlers.close();
    assert.equal(clock.jobs,0,'the adapter must stop scheduling further reconnects once it gives up');
    assert.ok(clock.now()-startedAt<FIFTEEN_MINUTES_MS,`gave up after ${clock.now()-startedAt}ms, which must stay under the ceiling`);
    assert.equal(statuses.at(-1)!.status,'disconnected');
    assert.equal(statuses.at(-1)!.retrying,undefined);
    assert.ok(clock.delays.every(delay=>delay<=FIFTEEN_MINUTES_MS));
  }finally{adapter.stop();}
});

test('IRC-EPISODE-BOOTSTRAP: a half-open bootstrap stall of repeated unwelcomed sockets gives up fifteen minutes after the first failure, not three uncapped ten-minute attempts',()=>{
  const {clock,sockets,adapter}=harness();
  const statuses:{status:string;retrying?:boolean}[]=[];
  adapter.start({event:()=>{},status:(status,retrying)=>statuses.push({status,retrying})});
  try{
    clock.advance(600_000);assert.equal(sockets[0]!.closed,true,'the first, unmeasured bootstrap stall still gets the full uncapped ten minutes');
    const firstFailureAt=clock.now();
    clock.advance(999);assert.equal(sockets.length,1);
    clock.advance(1);assert.equal(sockets.length,2);
    clock.advance(599_999);assert.equal(sockets[1]!.closed,false);
    clock.advance(1);assert.equal(sockets[1]!.closed,true,'the second bootstrap stall is still inside the episode budget, so it also gets ten minutes');
    clock.advance(1999);assert.equal(sockets.length,2);
    clock.advance(1);assert.equal(sockets.length,3);
    clock.advance(296_999);assert.equal(sockets[2]!.closed,false);
    clock.advance(1);assert.equal(sockets[2]!.closed,true,'the third bootstrap wait must be clipped to whatever is left of the episode budget');
    assert.equal(clock.now()-firstFailureAt,FIFTEEN_MINUTES_MS,'the episode must give up at exactly fifteen minutes after its first failure');
    assert.equal(clock.jobs,0,'no further reconnect is scheduled once the episode budget is spent');
    assert.equal(sockets.length,3,'no fourth socket is opened after the episode gives up');
    assert.equal(statuses.filter(item=>item.retrying).length,2);
    assert.deepEqual(statuses.at(-1),{status:'unreachable',retrying:undefined});
  }finally{adapter.stop();}
});

test('IRC-EPISODE-FASTFAIL: an ordinary continuously-erroring reconnect still gives up after three attempts, unaffected by the episode ceiling',()=>{
  const {clock,sockets,adapter}=harness();
  const statuses:{status:string;retrying?:boolean}[]=[];
  adapter.start({event:()=>{},status:(status,retrying)=>statuses.push({status,retrying})});
  const startedAt=clock.now();
  try{
    for(const delay of [1000,2000,4000]){
      sockets.at(-1)!.handlers.error();
      const count=sockets.length;
      clock.advance(delay-1);assert.equal(sockets.length,count);
      clock.advance(1);assert.equal(sockets.length,count+1);
    }
    sockets.at(-1)!.handlers.error();
    assert.equal(clock.jobs,0);
    assert.ok(clock.now()-startedAt<FIFTEEN_MINUTES_MS,`gave up after ${clock.now()-startedAt}ms, which must stay under the ceiling`);
    assert.equal(statuses.filter(item=>item.retrying).length,3);
    assert.deepEqual(statuses.at(-1),{status:'unreachable',retrying:undefined});
  }finally{adapter.stop();}
});

test('IRC-EPISODE-RECOVERY: a welcomed, stable link resets the episode so a later stall gets a fresh fifteen-minute budget',()=>{
  const {clock,sockets,adapter}=harness();
  const statuses:{status:string;retrying?:boolean}[]=[];
  adapter.start({event:()=>{},status:(status,retrying)=>statuses.push({status,retrying})});
  try{
    clock.advance(600_000);assert.equal(sockets[0]!.closed,true); // first failure, starts an episode
    clock.advance(1000); // backoff fires, reopens
    sockets[1]!.handlers.data(':tmi.twitch.tv 001 sample_bot :Welcome\r\n'); // welcomes and authenticates
    clock.advance(60_001);
    sockets[1]!.handlers.data('PING :tmi.twitch.tv\r\n'); // sixty continuous healthy seconds refills the budget
    clock.advance(74_999);assert.equal(sockets[1]!.closed,false);
    clock.advance(1);assert.equal(sockets[1]!.closed,true,'the recovered link goes silent and the liveness deadline closes it');
    const secondFailureAt=clock.now();
    clock.advance(999);assert.equal(sockets.length,2);
    clock.advance(1);assert.equal(sockets.length,3);
    clock.advance(599_999);assert.equal(sockets[2]!.closed,false);
    clock.advance(1);assert.equal(sockets[2]!.closed,true);
    clock.advance(1999);assert.equal(sockets.length,3);
    clock.advance(1);assert.equal(sockets.length,4);
    clock.advance(296_999);assert.equal(sockets[3]!.closed,false);
    clock.advance(1);assert.equal(sockets[3]!.closed,true);
    assert.equal(clock.now()-secondFailureAt,FIFTEEN_MINUTES_MS,'a reset episode must take the full fifteen minutes from its own first failure, not the earlier, already-recovered one');
    assert.equal(clock.jobs,0);
    assert.deepEqual(statuses.at(-1),{status:'unreachable',retrying:undefined});
  }finally{adapter.stop();}
});
