import {expect,test} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {capture} from './screenshot';
import {Studio} from '../apps/server/src/studio.ts';
import type {StreamEvent} from '../packages/core/src/index.ts';
import {chaosSource,QuietIrcSocket} from './ingest-chaos-fixture.ts';
import {bindIrcSocket,TwitchIrcAdapter,resetRefillLedgers,type IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';
import {authenticatedIrcFactory} from '../apps/server/src/ingest/source.ts';
import AxeBuilder from '@axe-core/playwright';

// The refill ledger is now keyed by channel (see irc.ts), and every test here reuses
// the channel 'approved_test'; reset it so each test starts with a clean hourly budget.
test.beforeEach(()=>{resetRefillLedgers();});

/** Ten automatic reconnects, each followed by just over a minute of health. */
function recoverTenTimes(source:ReturnType<typeof chaosSource>){
  let firstRefillAt=0;
  for(let outage=0;outage<10;outage++){
    source.advance(60_001);source.feed('PING :tmi.twitch.tv\r\n');
    if(outage===1)firstRefillAt=source.now();
    const count=source.sockets.length;source.drop();source.advance(1000);
    expect(source.sockets).toHaveLength(count+1);source.welcome();
  }
  source.advance(60_001);source.feed('PING :tmi.twitch.tv\r\n');
  return firstRefillAt;
}

test('INGEST-01 hourly refill cap: ten stable reconnects then Sample Data and Live ingest paused, without automatic resumption',async({page})=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();recoverTenTimes(source);
    source.chat('last-live','An invented line before the connection drops.');expect(studio.state.source?.active).toBe('twitch');
    source.drop();expect(source.sockets).toHaveLength(11);expect(source.jobs).toBe(0);
    expect(studio.state.source).toMatchObject({active:'sample',connection:'paused',reason:'paused'});
    expect(studio.state.panels).toHaveLength(0);expect(studio.state.pendingPanels).toHaveLength(4);
    source.sockets.at(-1)!.handlers.data('PING :tmi.twitch.tv\r\n');
    source.advance(3_600_000);expect(source.jobs).toBe(0);expect(source.sockets).toHaveLength(11);
    expect(source.sockets.every(socket=>socket.closed)).toBe(true);
    // TEST-RACE-1: the page must only see this test's Studio. Route the state stream as well as the poll (the
    // /studio page does not open /api/events today, so this is a guard), and wait for the routed state to arrive:
    // the label alone also matches the page's pre-load Sample state, which raced the status check under load.
    await page.route('**/api/state',route=>route.fulfill({json:studio.state}));
    await page.route('**/api/events',route=>route.fulfill({status:200,contentType:'text/event-stream',body:`retry: 600000\nevent: state\ndata: ${JSON.stringify(studio.state)}\n\n`}));
    const routedState=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');
    await page.goto('/studio');await routedState;
    await expect(page.getByTestId('source-label')).toHaveText('Sample Data');
    await expect(page.getByRole('status').filter({hasText:'Live ingest paused'})).toHaveText('Live ingest paused');
    await mkdir('artifacts/ingest-chaos',{recursive:true});
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect((await new AxeBuilder({page}).analyze()).violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
      await capture(page,{path:`artifacts/ingest-chaos/refill-paused-${width}.jpg`});
    }
  }finally{studio.close();}
});

test('INGEST-01b refill ledger outlives the adapter: a cap already spent on one TwitchIrcAdapter instance still refuses the 11th refill on a brand-new instance for the same channel, built via the production factory in source.ts',()=>{
  const source=chaosSource();
  source.adapter.start({event:()=>{},status:()=>{}});source.welcome();
  try{
    recoverTenTimes(source);
    const socketsBefore=source.sockets.length;
    // Mirrors what ChatSource.start()/authenticatedIrcFactory do on every real connect:
    // a fresh TwitchIrcAdapter for the same channel, not the instance that spent the budget.
    const factory=authenticatedIrcFactory(()=>({username:'sample_bot',token:'oauth:mock_read_only'}),source.transport,source.now,source.schedule);
    const second=factory('approved_test');
    const statuses:string[]=[];
    try{
      second.start({event:()=>{},status:status=>statuses.push(status)});
      expect(statuses).toEqual(['paused']);
      expect(source.sockets).toHaveLength(socketsBefore);
    }finally{second.stop();}
  }finally{source.adapter.stop();}
});

test('INGEST-01 rolling refill window: frames do not burn refills and the oldest refill expires exactly at one hour',()=>{
  for(const offset of [-1,0]){
    resetRefillLedgers(); // each offset is its own scenario and must start with a clean budget
    const source=chaosSource(),statuses:string[]=[];
    const callbacks={event:()=>{},status:(status:string)=>statuses.push(status)};
    source.adapter.start(callbacks);source.welcome();
    try{
      const firstRefillAt=recoverTenTimes(source),target=firstRefillAt+3_600_000+offset;
      while(source.now()+60_000<target){source.advance(60_000);source.feed('PING :tmi.twitch.tv\r\n');}
      source.advance(target-source.now());const count=source.sockets.length;source.drop();
      if(offset===-1){
        expect(statuses.at(-1)).toBe('paused');expect(source.jobs).toBe(0);
        source.adapter.start(callbacks);expect(statuses.at(-1)).toBe('paused');expect(source.sockets).toHaveLength(count);
      }else{
        source.advance(999);expect(source.sockets).toHaveLength(count);source.advance(1);expect(source.sockets).toHaveLength(count+1);
        // Capacity expiry permits reconnecting, but does not waive the
        // sixty-second stability rule for the current outage's budget.
        source.welcome();source.advance(59_999);source.drop();const retried=source.sockets.length;
        source.advance(1999);expect(source.sockets).toHaveLength(retried);
        source.advance(1);expect(source.sockets).toHaveLength(retried+1);
      }
    }finally{source.adapter.stop();}
  }
});

test('INGEST-01 Socket reconnect: each sixty-second stable recovery gets a fresh budget, with three exponential retries per failed outage',()=>{
  const source=chaosSource(),events:StreamEvent[]=[];
  source.adapter.start({event:event=>events.push(event),status:()=>{}});source.welcome();
  // Four independently recovered drops must all reconnect after one second.
  source.advance(60_000);
  for(let recovered=0;recovered<4;recovered++){
    const previous=source.sockets.at(-1)!;source.fail();source.drop();
    expect(previous.closed).toBe(true);expect(source.jobs).toBe(1);
    const count=source.sockets.length;source.advance(999);expect(source.sockets).toHaveLength(count);
    source.advance(1);expect(source.sockets).toHaveLength(count+1);source.welcome();
    previous.handlers.data(':old!old@old PRIVMSG #approved_test :stale callback\r\n');
    source.chat(`recovered-${recovered}`,`Recovered outage ${recovered}.`);source.advance(60_000);
  }
  expect(events.map(event=>event.text)).toEqual(Array.from({length:4},(_,index)=>`Recovered outage ${index}.`));
  // A continuously failed outage still stops after exactly three attempts.
  for(const delay of [1000,2000,4000]){
    source.drop();expect(source.jobs).toBe(1);const count=source.sockets.length;
    source.advance(delay-1);expect(source.sockets).toHaveLength(count);
    source.advance(1);expect(source.sockets).toHaveLength(count+1);
  }
  source.drop();expect(source.jobs).toBe(0);source.advance(60_000);expect(source.sockets).toHaveLength(8);
  source.adapter.start({event:()=>{},status:()=>{}});source.welcome();source.drop();source.adapter.stop();
  const count=source.sockets.length;source.advance(60_000);expect(source.sockets).toHaveLength(count);expect(source.jobs).toBe(0);
  // The liveness PING (sent after a silent minute) is the only addition to the read-only set.
  expect(source.sockets.flatMap(socket=>socket.sent).every(frame=>/^(?:(?:PASS|NICK|CAP REQ|JOIN|PONG) |PING :tmi\.twitch\.tv\r\n$)/.test(frame))).toBe(true);
});

test('INGEST-01 Quiet channel: the production socket binding survives two minutes of silence and answers PING',()=>{
  const clock=chaosSource(),sockets:QuietIrcSocket[]=[],statuses:string[]=[];
  let handlers:Parameters<IrcTransportFactory>[0];
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:()=>({username:'sample_bot',token:'oauth:mock_read_only'}),
    now:clock.now,schedule:clock.schedule,simulated:true,transport:callbacks=>{
      handlers=callbacks;const socket=new QuietIrcSocket(clock.schedule);sockets.push(socket);return bindIrcSocket(socket,callbacks);
    }});
  try{
    adapter.start({event:()=>{},status:status=>statuses.push(status)});handlers!.open();
    const socket=sockets[0]!;socket.answerPing=true;socket.emit('data',':tmi.twitch.tv 001 sample_bot :Welcome\r\n');
    clock.advance(60_000);clock.advance(60_000);
    expect(sockets).toHaveLength(1);expect(socket.closed).toBe(false);expect(socket.idleTimeouts).toEqual([0]);
    // A quiet but healthy link: one liveness PING per silent minute, each answered by Twitch.
    expect(socket.sent.filter(frame=>frame==='PING :tmi.twitch.tv\r\n')).toHaveLength(2);
    expect(statuses).toEqual(['connecting','empty']);expect(clock.jobs).toBe(2); // the watchdog and the liveness idle timer
    socket.emit('data','PING :tmi.twitch.tv\r\n');expect(socket.sent.at(-1)).toBe('PONG :tmi.twitch.tv\r\n');
  }finally{adapter.stop();}
  expect(sockets.every(socket=>socket.closed)).toBe(true);expect(clock.jobs).toBe(0);
});

test('INGEST-02 IRC RECONNECT: complete buffered messages and the draft survive the new socket',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.feed('@id=a;user-id=u :a!a@a PRIVMSG #approved_test :Before maintenance.\r\n:tmi.twitch.tv RECONNECT\r\n@id=b;user-id=v :b!b@b PRIVMSG #approved_test :Already buffered.\r\n');
    expect(studio.state.source?.active).toBe('sample');expect(source.jobs).toBe(1);
    source.advance(1000);source.welcome();source.chat('c','After maintenance.','w');
    expect(studio.state.source?.received).toBe(3);expect(studio.state.pendingPanels).toHaveLength(1);
    expect(studio.state.pendingPanels[0]!.dialogue).toEqual(['Before maintenance.','Already buffered.','After maintenance.']);
  }finally{studio.close();}
  expect(source.jobs).toBe(0);
});

test('INGEST-03 Dedup: identical ids and payloads with different ids are suppressed within 500ms',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();source.chat('a','One selected line.');
    source.chat('a','Same id, changed payload.');source.chat('b','One selected line.');
    source.advance(499);source.chat('c','One selected line.');expect(studio.state.source?.received).toBe(1);
    source.advance(1);source.chat('d','One selected line.');expect(studio.state.source?.received).toBe(2);
    source.advance(1000);source.chat('a','Same id, much later.');expect(studio.state.source?.received).toBe(2);
    source.chat('e','One selected line.','another-viewer');expect(studio.state.source?.received).toBe(3);
  }finally{studio.close();}
});

test('INGEST-01 F3 flapping: welcome-then-drop before sixty seconds spends the three-retry budget',()=>{
  const source=chaosSource(),statuses:{status:string;retrying?:boolean}[]=[];
  source.adapter.start({event:()=>{},status:(status,retrying)=>statuses.push({status,retrying})});source.welcome();
  try{
    for(const delay of [1000,2000,4000]){
      source.advance(59_999);source.drop();expect(source.jobs).toBe(1);
      const count=source.sockets.length;source.advance(delay-1);expect(source.sockets).toHaveLength(count);
      source.advance(1);expect(source.sockets).toHaveLength(count+1);source.welcome();
    }
    source.advance(59_999);source.drop();expect(source.jobs).toBe(0);
    expect(source.sockets).toHaveLength(4);expect(statuses.filter(item=>item.retrying)).toHaveLength(3);
    expect(statuses.at(-1)).toEqual({status:'disconnected',retrying:undefined});
    source.advance(600_000);expect(source.sockets).toHaveLength(4);
  }finally{source.adapter.stop();}
});

test('INGEST-01 F3 stability boundary: duplicate welcomes cannot shorten or postpone sixty continuous seconds',()=>{
  const source=chaosSource();source.adapter.start({event:()=>{},status:()=>{}});source.welcome();
  try{
    source.drop();source.advance(1000);source.welcome();
    source.advance(30_000);source.feed(':tmi.twitch.tv 001 sample_bot :Repeated welcome\r\n');
    source.advance(29_999);source.drop();const count=source.sockets.length;
    source.advance(1999);expect(source.sockets).toHaveLength(count);source.advance(1);source.welcome();
    source.advance(30_000);source.feed(':tmi.twitch.tv 001 sample_bot :Repeated welcome\r\n');
    source.advance(30_000);source.drop();const recovered=source.sockets.length;
    source.advance(999);expect(source.sockets).toHaveLength(recovered);source.advance(1);expect(source.sockets).toHaveLength(recovered+1);
    source.welcome();source.adapter.stop();source.advance(600_000);expect(source.jobs).toBe(0);expect(source.sockets).toHaveLength(recovered+1);
  }finally{source.adapter.stop();}
});

test('INGEST-01a bootstrap gap: unwelcomed half-open links still use ten minutes, while welcomed half-open links are cut by the 75 s liveness deadline inside the fifteen-minute episode',()=>{
  const source=chaosSource(),statuses:{status:string;retrying?:boolean}[]=[];
  source.adapter.start({event:()=>{},status:(status,retrying)=>statuses.push({status,retrying})});source.welcome();
  try{
    // Since T25 a welcomed link that goes silent is PINGed after a minute and dropped 15 s later.
    // The episode clipping of ten-minute bootstrap waits is covered by IRC-EPISODE-BOOTSTRAP.
    const firstFailureAt=75_000;
    for(const delay of [1000,2000,4000]){
      const count=source.sockets.length,old=source.sockets.at(-1)!;
      source.advance(74_999);expect(old.closed).toBe(false);expect(old.sent.at(-1)).toBe('PING :tmi.twitch.tv\r\n');
      source.advance(1);expect(old.closed).toBe(true);expect(source.jobs).toBe(1);
      old.handlers.data('PING :tmi.twitch.tv\r\n');expect(source.jobs).toBe(1);
      source.advance(delay-1);expect(source.sockets).toHaveLength(count);source.advance(1);expect(source.sockets).toHaveLength(count+1);source.welcome();
    }
    const old=source.sockets.at(-1)!;
    source.advance(74_999);expect(old.closed).toBe(false);source.advance(1);expect(old.closed).toBe(true);
    expect(source.now()-firstFailureAt).toBeLessThan(900_000);
    expect(source.jobs).toBe(0);expect(source.sockets).toHaveLength(4);
    expect(statuses.filter(item=>item.retrying)).toHaveLength(3);expect(statuses.at(-1)).toEqual({status:'unreachable',retrying:undefined});
    source.advance(600_000);expect(source.sockets).toHaveLength(4);
  }finally{source.adapter.stop();}
  const unwelcomed=chaosSource();unwelcomed.adapter.start({event:()=>{},status:()=>{}});
  try{
    unwelcomed.advance(600_000);expect(unwelcomed.sockets[0]!.closed).toBe(true);expect(unwelcomed.jobs).toBe(1);
    unwelcomed.adapter.stop();unwelcomed.advance(600_000);expect(unwelcomed.jobs).toBe(0);expect(unwelcomed.sockets).toHaveLength(1);
  }finally{unwelcomed.adapter.stop();}
});

test('INGEST-01a measured liveness: complete PING frames renew the gap; malformed bytes and cancelled callbacks cannot keep a socket alive',()=>{
  const clock=chaosSource(),sockets:QuietIrcSocket[]=[],retired:(()=>void)[]=[],statuses:string[]=[];
  let handlers:Parameters<IrcTransportFactory>[0];
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:()=>({username:'sample_bot',token:'oauth:mock_read_only'}),now:clock.now,simulated:true,
    schedule:(run,delay)=>{retired.push(run);return clock.schedule(run,delay);},transport:callbacks=>{
      handlers=callbacks;const socket=new QuietIrcSocket(clock.schedule);sockets.push(socket);return bindIrcSocket(socket,callbacks);
    }});
  try{
    adapter.start({event:()=>{},status:status=>statuses.push(status)});handlers!.open();
    sockets[0]!.answerPing=true;sockets[0]!.emit('data',':tmi.twitch.tv 001 sample_bot :Welcome\r\n');
    clock.advance(240_000);sockets[0]!.emit('data','PING :tmi.twitch.tv\r\n');
    expect(sockets[0]!.sent.at(-1)).toBe('PONG :tmi.twitch.tv\r\n');expect(clock.jobs).toBe(2); // the watchdog and the liveness idle timer
    retired[0]!();retired[1]!();expect(sockets[0]!.closed).toBe(false);expect(clock.jobs).toBe(2);
    clock.advance(240_000);sockets[0]!.emit('data','PING :tmi.twitch.tv\r\n');
    clock.advance(240_000);expect(sockets).toHaveLength(1);expect(sockets[0]!.closed).toBe(false);
    // The link now goes silent: malformed bytes are not lines, so the next liveness PING goes unanswered.
    sockets[0]!.answerPing=false;sockets[0]!.emit('data','bad frame\r\n');sockets[0]!.emit('data','PING :');
    clock.advance(74_999);expect(sockets[0]!.closed).toBe(false);clock.advance(1);expect(sockets[0]!.closed).toBe(true);
    expect(statuses.at(-1)).toBe('unreachable');clock.advance(1000);expect(sockets).toHaveLength(2);
    handlers!.open();sockets[1]!.emit('data',':tmi.twitch.tv 001 sample_bot :Welcome\r\n');
    const stopped=retired.at(-1)!;adapter.stop();stopped();clock.advance(600_000);
    expect(sockets).toHaveLength(2);expect(clock.jobs).toBe(0);expect(sockets.every(socket=>socket.closed)).toBe(true);
    expect(sockets.flatMap(socket=>socket.sent).every(frame=>/^(?:(?:PASS|NICK|CAP REQ|JOIN|PONG) |PING :tmi\.twitch\.tv\r\n$)/.test(frame))).toBe(true);
  }finally{adapter.stop();}
});

test('INGEST-01a healthy five-minute PING: measure the server cadence as twice that interval, and still cut a link that then goes silent at the 75 s liveness deadline',()=>{
  const source=chaosSource();source.pong=true;source.adapter.start({event:()=>{},status:()=>{}});source.welcome();
  try{
    for(let index=0;index<5;index++){
      source.advance(300_000);expect(source.sockets).toHaveLength(1);expect(source.sockets[0]!.closed).toBe(false);
      source.feed('PING :tmi.twitch.tv\r\n');expect(source.sockets[0]!.sent.at(-1)).toBe('PONG :tmi.twitch.tv\r\n');
      expect(source.jobs).toBe(2); // the watchdog and the liveness idle timer
    }
    expect(source.delays.at(-1)).toBe(600_000); // the measured watchdog gap: twice the five-minute cadence
    source.pong=false;
    source.advance(74_999);expect(source.sockets[0]!.closed).toBe(false);source.advance(1);expect(source.sockets[0]!.closed).toBe(true);
    const count=source.sockets.length;source.advance(999);expect(source.sockets).toHaveLength(count);source.advance(1);expect(source.sockets).toHaveLength(count+1);
  }finally{source.adapter.stop();}
  expect(source.jobs).toBe(0);
});

test('INGEST-01a measured cadence: changing PING intervals retune the gap and ordinary frames do not become PING samples',()=>{
  const source=chaosSource();source.adapter.start({event:()=>{},status:()=>{}});source.welcome();
  try{
    source.advance(1000);source.feed('PING :tmi.twitch.tv\r\n');
    source.advance(1000);source.feed('PING :tmi.twitch.tv\r\n'); // interval1000, gap2000
    source.feed('PING :tmi.twitch.tv\r\n'); // zero-time duplicate must not erase the interval
    source.advance(1500);source.feed('PING :tmi.twitch.tv\r\n'); // interval1500, gap3000
    source.advance(2500);source.feed('PING :tmi.twitch.tv\r\n'); // interval2500, gap5000
    source.advance(1000);source.chat('ordinary','A complete server frame, not a cadence sample.');
    source.advance(4999);expect(source.sockets).toHaveLength(1);expect(source.sockets[0]!.closed).toBe(false);
    source.advance(1);expect(source.sockets[0]!.closed).toBe(true);expect(source.jobs).toBe(1);
  }finally{source.adapter.stop();}
});

test('INGEST-04 Empty stream: 60 seconds without messages keeps the socket and labelled fallback ready',async({page})=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();source.advance(60_000);studio.tick();
    expect(studio.state.source).toMatchObject({active:'sample',connection:'empty',received:0});
    expect(studio.state.pendingPanels).toHaveLength(4);expect(source.sockets).toHaveLength(1);expect(source.sockets[0]!.closed).toBe(false);
    await page.route('**/api/state',route=>route.fulfill({json:studio.state}));await page.goto('/studio');
    await expect(page.getByTestId('source-label')).toHaveText('Sample Data');
    await expect(page.getByTestId('approval-queue').getByRole('button',{name:/^Review panel/})).toHaveCount(4);
    source.chat('after-empty','The connection still receives chat.');expect(studio.state.source?.received).toBe(1);
  }finally{studio.close();}
});

test('INGEST-05 Emoji and multi-byte: every split of a UTF-8 frame preserves ZWJ graphemes through drafting',()=>{
  const text='👩🏽‍🚀 👨‍👩‍👧‍👦 🏳️‍🌈 café 日本語';
  const bytes=Buffer.from(`@id=unicode;user-id=u :sample!sample@sample PRIVMSG #approved_test :${text}\r\n`);
  for(let split=1;split<bytes.length;split++){
    const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
    try{
      studio.useSource('twitch','approved_test');source.welcome();source.feed(bytes.subarray(0,split));source.feed(bytes.subarray(split));
      expect(studio.state.source?.received).toBe(1);expect(studio.state.pendingPanels[0]!.dialogue).toEqual([text]);
    }finally{studio.close();}
  }
});

test('INGEST-06 RTL text: short Arabic and Hebrew chat keep automatic direction and fit desktop and mobile panels',async({page})=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();source.chat('arabic','مرحبا يا أصدقاء');source.chat('hebrew','שלום חברים','v');studio.moderate('approve');
    const state=structuredClone(studio.state);
    await page.route('**/api/recaps/chaos-rtl',route=>route.fulfill({json:state}));
    await mkdir('artifacts/ingest-chaos',{recursive:true});
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});await page.goto('/recap/chaos-rtl');
      await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
      for(const text of ['مرحبا يا أصدقاء','שלום חברים']){
        const balloon=page.locator('.story-balloon').filter({hasText:text});await expect(balloon).toHaveText(text);await expect(balloon).toHaveAttribute('dir','auto');
        // scrollHeight includes the intentionally protruding CSS speech tail.
        // Measure every actual text fragment separately from that decoration.
        const bounds=await balloon.evaluate(element=>{
          const box=element.getBoundingClientRect(),panel=element.closest('.story-panel')!.getBoundingClientRect();
          const range=document.createRange();range.selectNodeContents(element);
          const fragments=[...range.getClientRects()];
          return {fits:box.left>=panel.left&&box.right<=panel.right&&box.top>=panel.top&&box.bottom<=panel.bottom,
            textFits:fragments.length>0&&fragments.every(rect=>rect.left>=box.left&&rect.right<=box.right&&rect.top>=box.top&&rect.bottom<=box.bottom),direction:getComputedStyle(element).direction};
        });
        expect(bounds).toEqual({fits:true,textFits:true,direction:'rtl'});
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await capture(page,{path:`artifacts/ingest-chaos/rtl-${width}.jpg`});
    }
  }finally{studio.close();}
});

test('INGEST-07 Raid burst: 1000 messages per simulated minute stay bounded and overload admits at most 60 per second',async()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  const start=performance.now(),heapBefore=process.memoryUsage().heapUsed;
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    // Forty minutes at the required rate, including a full queue plateau.
    const samples:{minute:number;received:number;pending:number;bytes:number;seen:number;rate:number}[]=[];
    for(let minute=0;minute<40;minute++){
      for(let index=0;index<1000;index++){source.chat(`raid-${minute}-${index}`,`Raid line ${minute}/${index}`);source.advance(60);}
      studio.tick();samples.push({minute:minute+1,received:studio.state.source!.received,pending:studio.state.pendingPanels.length,bytes:Buffer.byteLength(JSON.stringify(studio.state)),seen:studio.ingest.diagnostics.seenEntries,rate:studio.ingest.diagnostics.rateEntries});
    }
    expect(studio.state.source?.received).toBe(40_000);expect(studio.state.pendingPanels).toHaveLength(24);
    for(const sample of samples){expect(sample.seen).toBeLessThanOrEqual(1024);expect(sample.rate).toBeLessThanOrEqual(60);expect(sample.bytes).toBeLessThan(50_000);}
    expect(new Set(samples.slice(-8).map(sample=>sample.bytes)).size).toBe(1);
    const before=studio.state.source!.received;
    for(let index=0;index<1000;index++)source.chat(`overload-${index}`,`Overload ${index}`);
    expect(studio.state.source!.received-before).toBeLessThanOrEqual(60);
    source.advance(1500);const boundary=studio.state.source!.received;
    for(let index=0;index<100;index++)source.chat(`boundary-${index}`,`Boundary ${index}`);
    expect(studio.state.source!.received-boundary).toBe(60);
    // Cross a clock-second boundary while the admitted events are only500ms old.
    source.advance(500);const rolling=studio.state.source!.received;
    for(let index=0;index<100;index++)source.chat(`rolling-${index}`,`Rolling ${index}`);
    expect(studio.state.source!.received).toBe(rolling);
    source.advance(500);const expired=studio.state.source!.received;
    for(let index=0;index<100;index++)source.chat(`expired-${index}`,`Expired ${index}`);
    expect(studio.state.source!.received-expired).toBe(60);
    // Privacy commands bypass the saturated content throttle.
    source.chat('saturated-optout','!optout');source.chat('saturated-optin','!ink');source.advance(1000);source.chat('after-optout','Must stay excluded.');
    expect(JSON.stringify(studio.state)).not.toContain('Must stay excluded.');expect(studio.state.pendingPanels).toHaveLength(4);
    await mkdir('artifacts/ingest-chaos',{recursive:true});
    await writeFile('artifacts/ingest-chaos/burst-benchmark.json',JSON.stringify({runtime:process.version,loadMessages:41_300,withdrawalCommands:2,postWithdrawalMessages:1,simulatedMinutes:40,durationMs:performance.now()-start,heapBefore,heapAfter:process.memoryUsage().heapUsed,samples,bounds:studio.ingest.diagnostics,memoryProof:'Retained collections and serialized queue bounded; heap deltas include garbage and do not prove a zero-leak live process.'},null,2));
  }finally{studio.close();}
  expect(studio.ingest.diagnostics.rateEntries).toBe(0);expect(studio.ingest.diagnostics.seenEntries).toBe(0);expect(source.jobs).toBe(0);
});

test('INGEST-08 Malformed frames: invalid lines are discarded, incomplete frames never cross reconnects, and oversize input falls back',()=>{
  const source=chaosSource(),events:StreamEvent[]=[],statuses:string[]=[];
  source.adapter.start({event:event=>events.push(event),status:status=>statuses.push(status)});source.welcome();
  try{
    for(const line of ['bad frame','@missing-prefix','PRIVMSG','PRIVMSG #another :wrong channel',':a!a@a PRIVMSG #approved_test :bad\0text'])source.feed(`${line}\r\n`);
    source.feed(':a!a@a PRIVMSG #approved_test :unfinished');expect(events).toEqual([]);
    source.drop();source.advance(1000);source.welcome();source.feed('tail\r\n');source.chat('good','Recovered after malformed input.');
    expect(events.map(event=>event.text)).toEqual(['Recovered after malformed input.']);
    source.feed('x'.repeat(16_385));expect(statuses.at(-1)).toBe('unreachable');expect(source.sockets.at(-1)!.closed).toBe(true);expect(source.jobs).toBe(0);
  }finally{source.adapter.stop();}
});

test('INGEST-09 Opt-out beats opt-in: self opt-out and moderator CLEARCHAT scrub included text and invalidate undo; only self opt-out is permanent',()=>{
  for(const moderator of [false,true]){
    const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
    try{
      studio.useSource('twitch','approved_test');source.welcome();source.chat('in','!ink','u');source.chat('private','The private selected line.','u');
      const approval=studio.moderate('approve');expect(studio.state.panels).toHaveLength(1);
      if(moderator)source.feed('@target-user-id=u :tmi.twitch.tv CLEARCHAT #approved_test :sample\r\n');else source.chat('out','!optout','u');
      expect(JSON.stringify(studio.state)).not.toContain('The private selected line.');expect(()=>studio.undo(approval.undoToken)).toThrow(/expired/);
      source.chat('rein','!ink','u');source.chat('blocked','Denied even after opt-in.','u');source.chat('other','An unaffected viewer.','v');
      // Young's ruling: a ban or timeout is never an opt-out, so only self opt-out blocks later lines.
      expect(studio.state.pendingPanels).toHaveLength(1);
      expect(studio.state.pendingPanels[0]!.dialogue).toEqual(moderator?['Denied even after opt-in.','An unaffected viewer.']:['An unaffected viewer.']);
    }finally{studio.close();}
  }
});

test('INGEST-09b CLEARMSG: moderator deletion of a single approved line removes only that line, even while the content throttle is saturated',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.chat('msg-del','The deleted line.','u');source.chat('keep','The kept line.','u');
    const approval=studio.moderate('approve');
    expect(studio.state.panels).toHaveLength(1);expect(studio.state.panels[0]!.dialogue).toEqual(['The deleted line.','The kept line.']);
    for(let index=0;index<100;index++)source.chat(`burst-${index}`,`Burst ${index}`);
    source.feed('@login=u;target-msg-id=msg-del :tmi.twitch.tv CLEARMSG #approved_test :The deleted line.\r\n');
    expect(JSON.stringify(studio.state)).not.toContain('The deleted line.');
    expect(studio.state.panels[0]!.dialogue).toEqual(['The kept line.']);
    expect(()=>studio.undo(approval.undoToken)).toThrow(/expired/);
  }finally{studio.close();}
});

test('INGEST-10 Late opt-out: drafting and fallback archives are purged so switching back cannot resurrect a line',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();source.chat('private','Late withdrawal during drafting.','u');
    expect(studio.state.pendingPanels[0]!.dialogue).toEqual(['Late withdrawal during drafting.']);
    // A drop (not quiet chat, which stays Live since RAID-SAMPLE-1) is what archives the live draft.
    source.drop();expect(studio.state.source?.active).toBe('sample');source.advance(1000);source.welcome();
    source.chat('out','!optout','u');source.chat('in','!ink','u');source.chat('blocked','Must never return.','u');source.chat('other','Safe replacement.','v');
    expect(studio.state.source?.active).toBe('twitch');expect(studio.state.pendingPanels).toHaveLength(1);
    expect(studio.state.pendingPanels[0]!.dialogue).toEqual(['Safe replacement.']);
    expect(JSON.stringify(studio.state)).not.toContain('Late withdrawal');expect(JSON.stringify(studio.state)).not.toContain('Must never return.');
  }finally{studio.close();}
});

// Group 3 (Step 6 S2): Twitch moderation, notices, raids, RECONNECT and the
// fifteen-minute ceiling. Frames follow https://dev.twitch.tv/docs/chat/irc/.
const ROOM_CLEAR='@room-id=12345678;tmi-sent-ts=1642715695392 :tmi.twitch.tv CLEARCHAT #approved_test\r\n';

test('INGEST-11 NOTICE: ordinary notices keep the socket with one redacted log line; documented login failures are terminal',()=>{
  const warnings:string[]=[],original=console.warn;console.warn=(...args:unknown[])=>{warnings.push(args.join(' '));};
  try{
    const source=chaosSource(),statuses:string[]=[],events:StreamEvent[]=[];
    source.adapter.start({event:event=>events.push(event),status:status=>statuses.push(status)});source.welcome();
    source.feed('@msg-id=slow_on :tmi.twitch.tv NOTICE #approved_test :This room is now in slow mode. You may send messages every 10 seconds.\r\n');
    source.feed('@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #approved_test :This channel does not exist or has been suspended.\r\n');
    expect(source.sockets).toHaveLength(1);expect(source.sockets[0]!.closed).toBe(false);expect(statuses).toEqual(['connecting','empty']);
    source.chat('after','Still connected.');expect(events.map(event=>event.text)).toEqual(['Still connected.']);
    expect(warnings).toEqual(['[irc] NOTICE msg-id=slow_on; staying connected','[irc] NOTICE msg-id=msg_channel_suspended; staying connected']);
    source.adapter.stop();
    const rejected=chaosSource(),final:string[]=[];
    rejected.adapter.start({event:()=>{},status:status=>final.push(status)});rejected.sockets[0]!.handlers.open();
    rejected.feed(':tmi.twitch.tv NOTICE * :Login authentication failed\r\n');
    expect(final.at(-1)).toBe('unauthenticated');expect(rejected.sockets[0]!.closed).toBe(true);expect(rejected.jobs).toBe(0);
    expect(warnings).toHaveLength(3);expect(warnings.join('\n')).not.toContain('oauth:');
  }finally{console.warn=original;}
});

test('INGEST-12 Whole-room CLEARCHAT: every earlier line, across reconnects, is dropped from drafts and moments; the approved panel stays; not an opt-out',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    for(let s=0;s<40;s++){source.chat(`base-${s}`,`baseline line ${s}`,`viewer-${s%8}`);source.advance(1000);}
    for(let i=0;i<4;i++){source.chat(`kekw-${i}`,'KEKW',`fan-${i}`);source.advance(500);}
    const bucket=studio.state.pendingPanels.find(panel=>panel.sfx!=='SURGE!')!;
    const approval=studio.moderate('approve',bucket.id);
    source.drop();source.advance(1000);source.welcome();source.chat('late','Line on the replacement socket.','viewer-1');
    expect(studio.state.pendingPanels.some(panel=>panel.sfx==='SURGE!')).toBe(true);
    const published=structuredClone(studio.state.panels);expect(published.map(panel=>panel.id)).toEqual([bucket.id]);
    source.feed(ROOM_CLEAR);
    // Young's ruling: the published panel is never wiped by a room-wide clear.
    expect(studio.state.panels).toEqual(published);
    expect(studio.state.pendingPanels).toEqual([]);
    const pending=JSON.stringify(studio.state.pendingPanels);
    for(const text of ['baseline line','KEKW','Line on the replacement socket.'])expect(pending).not.toContain(text);
    expect(()=>studio.undo(approval.undoToken)).toThrow(/expired/);
    source.advance(1000);source.chat('after','Fresh chat after the clear.','viewer-1');
    expect(studio.state.pendingPanels.at(-1)!.dialogue).toEqual(['Fresh chat after the clear.']);
  }finally{studio.close();}
});

test('INGEST-13 Targeted CLEARCHAT: a ban or timeout removes only that user\'s lines; CLEARMSG still removes one line',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.chat('x1','Timed-out viewer line.','87654321');source.chat('y1','Bystander line.','v');source.chat('y2','Deleted bystander line.','v');
    source.feed('@ban-duration=350;room-id=1;target-user-id=87654321;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #another :ronni\r\n');
    expect(JSON.stringify(studio.state)).toContain('Timed-out viewer line.');
    source.feed('@ban-duration=350;room-id=1;target-user-id=87654321;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test :ronni\r\n');
    expect(studio.state.pendingPanels[0]!.dialogue).toEqual(['Bystander line.','Deleted bystander line.']);
    source.feed('@login=v;room-id=;target-msg-id=y2;tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #approved_test :Deleted bystander line.\r\n');
    expect(studio.state.pendingPanels[0]!.dialogue).toEqual(['Bystander line.']);
    // Young's ruling: a ban or timeout is never an opt-out; the user's later chat is still eligible.
    source.chat('x2','Timed-out viewer returns.','87654321');expect(JSON.stringify(studio.state)).toContain('Timed-out viewer returns.');
  }finally{studio.close();}
});

test('INGEST-14 Raid USERNOTICE: msg-id=raid becomes a raid StreamEvent in the EventSub normaliser shape',()=>{
  const source=chaosSource(),events:StreamEvent[]=[];
  source.adapter.start({event:event=>events.push(event),status:()=>{}});source.welcome();
  try{
    source.advance(4000);
    source.feed('@badge-info=;badges=turbo/1;color=#9ACD32;display-name=TestChannel;emotes=;id=3d830f12-795c-447d-af3c-ea05e40fbddb;login=testchannel;mod=0;msg-id=raid;msg-param-displayName=TestChannel;msg-param-login=testchannel;msg-param-viewerCount=15;room-id=33332222;subscriber=0;system-msg=15\\sraiders\\sfrom\\sTestChannel\\shave\\sjoined\\n!;tmi-sent-ts=1507246572675;turbo=1;user-id=123456;user-type= :tmi.twitch.tv USERNOTICE #approved_test\r\n');
    source.feed('@id=sub-1;msg-id=resub;login=ronni :tmi.twitch.tv USERNOTICE #approved_test :Great stream -- keep it up!\r\n');
    expect(events).toEqual([{id:'3d830f12-795c-447d-af3c-ea05e40fbddb',t:4,type:'raid',from:'TestChannel',viewers:15}]);
  }finally{source.adapter.stop();}
});

test('INGEST-15 RECONNECT: the old socket closes, a new one re-authenticates and rejoins after backoff, and stale frames are fenced',()=>{
  const source=chaosSource(),events:StreamEvent[]=[],statuses:{status:string;retrying?:boolean}[]=[];
  source.adapter.start({event:event=>events.push(event),status:(status,retrying)=>statuses.push({status,retrying})});source.welcome();
  try{
    source.advance(60_000);source.feed(':tmi.twitch.tv RECONNECT\r\n');
    const old=source.sockets[0]!;expect(old.closed).toBe(true);expect(statuses.at(-1)).toEqual({status:'disconnected',retrying:true});
    source.advance(999);expect(source.sockets).toHaveLength(1);source.advance(1);expect(source.sockets).toHaveLength(2);
    source.welcome();
    expect(source.sockets[1]!.sent).toEqual(['PASS oauth:mock_read_only\r\n','NICK sample_bot\r\n','CAP REQ :twitch.tv/tags twitch.tv/commands\r\n','JOIN #approved_test\r\n']);
    old.handlers.data('@id=stale;user-id=u :a!a@a PRIVMSG #approved_test :From the retired socket.\r\n');
    source.chat('fresh','From the new socket.');expect(events.map(event=>event.text)).toEqual(['From the new socket.']);
    // A second RECONNECT before sixty stable seconds backs off further.
    source.advance(10_000);source.feed(':tmi.twitch.tv RECONNECT\r\n');
    source.advance(1999);expect(source.sockets).toHaveLength(2);source.advance(1);expect(source.sockets).toHaveLength(3);
    // After sixty stable seconds a maintenance RECONNECT starts again at one second.
    source.welcome();source.advance(60_000);source.feed('PING :tmi.twitch.tv\r\n');source.feed(':tmi.twitch.tv RECONNECT\r\n');
    source.advance(999);expect(source.sockets).toHaveLength(3);source.advance(1);expect(source.sockets).toHaveLength(4);
  }finally{source.adapter.stop();}
  expect(source.jobs).toBe(0);
});

test('INGEST-16 Fifteen-minute ceiling: a slow measured PING cadence cannot stretch the watchdog beyond fifteen minutes',()=>{
  const source=chaosSource();source.pong=true;source.adapter.start({event:()=>{},status:()=>{}});source.welcome();
  try{
    source.advance(1000);source.feed('PING :tmi.twitch.tv\r\n');
    source.advance(540_000);source.feed('PING :tmi.twitch.tv\r\n'); // nine-minute interval would mean an eighteen-minute gap
    expect(source.delays.at(-1)).toBe(900_000);expect(source.delays.every(delay=>delay<=900_000)).toBe(true);
    // A silent link is cut by the liveness deadline long before that clipped gap.
    source.pong=false;
    source.advance(74_999);expect(source.sockets[0]!.closed).toBe(false);
    source.advance(1);expect(source.sockets[0]!.closed).toBe(true);expect(source.jobs).toBe(1);
    source.advance(1000);expect(source.sockets).toHaveLength(2);
  }finally{source.adapter.stop();}
  expect(source.jobs).toBe(0);
});

// Step 6 S3 and S5 follow-ups (T9). Young's ruling (31 Oct, 02:14): a room-wide
// CLEARCHAT drops the cleared lines from drafts and moments, is not an opt-out,
// and never wipes a panel that is already published.
const clearMsg=(id:string)=>`@login=u;room-id=1;target-msg-id=${id};tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #approved_test :deleted\r\n`;

test('INGEST-17 Room-wide CLEARCHAT: cleared lines leave drafts and moments, published panels stay exactly as they were; not an opt-out',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.chat('pub-1','Published before the clear.','u1');studio.moderate('approve');
    const published=structuredClone(studio.state.panels);expect(published).toHaveLength(1);
    source.advance(61_000);
    source.chat('draft-1','Pending draft line.','u2');
    source.chat('k1','KEKW','fan-a');source.advance(500);source.chat('k2','KEKW','fan-b');source.advance(500);
    expect(JSON.stringify(studio.state.pendingPanels)).toContain('Pending draft line.');
    source.feed(ROOM_CLEAR);
    expect(studio.state.panels).toEqual(published);
    expect(studio.state.pendingPanels).toEqual([]);
    // The detector still saw k1 and k2, but a moment opened after the clear never cites them.
    source.chat('k3','KEKW','fan-c');
    const all=()=>[...studio.state.panels,...studio.state.pendingPanels];
    const cited=all().flatMap(panel=>panel.sources??[]);
    expect(cited).toContain('k3');expect(cited).not.toContain('k1');expect(cited).not.toContain('k2');
    expect(studio.state.panels).toEqual(published);
    // Not an opt-out: the same viewer's later chat is still eligible.
    source.chat('back','Back after the clear.','u2');
    expect(JSON.stringify(studio.state.pendingPanels)).toContain('Back after the clear.');
    // A later single deletion still reaches the published panel.
    source.feed(clearMsg('pub-1'));
    expect(JSON.stringify(studio.state)).not.toContain('Published before the clear.');
  }finally{studio.close();}
});

test('INGEST-18 CLEARMSG emptied panel: deleting every line removes an approved panel and a moment panel instead of leaving blanks',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.chat('e1','First deleted line.','u');source.chat('e2','Second deleted line.','v');
    const approval=studio.moderate('approve');expect(studio.state.panels).toHaveLength(1);
    source.feed(clearMsg('e1'));expect(studio.state.panels[0]!.dialogue).toEqual(['Second deleted line.']);
    source.feed(clearMsg('e2'));
    expect(studio.state.panels).toEqual([]);
    expect(JSON.stringify(studio.state)).not.toContain('deleted line.');
    expect(()=>studio.undo(approval.undoToken)).toThrow(/expired/);
    source.advance(61_000);
    for(const [id,user] of [['m1','fan-a'],['m2','fan-b'],['m3','fan-c']] as const){source.chat(id,'KEKW',user);source.advance(500);}
    const moment=()=>studio.state.pendingPanels.find(panel=>panel.sfx==='SURGE!');
    expect(moment()?.sources).toEqual(['m1','m2','m3']);
    for(const id of ['m1','m2','m3'])source.feed(clearMsg(id));
    // With nothing live left the source shows Sample Data; no panel may still cite a deleted line.
    expect(moment()).toBeUndefined();
    expect([...studio.state.panels,...studio.state.pendingPanels].flatMap(panel=>panel.sources??[]).filter(id=>/^[em]\d$/.test(id))).toEqual([]);
    source.chat('after','After the deletions.','u');
    expect(studio.state.source?.active).toBe('twitch');
    // Switching back restores the live archive: no blank or emptied panel comes back with it.
    expect(studio.state.panels).toEqual([]);
    expect(studio.state.pendingPanels.map(panel=>panel.dialogue)).toEqual([['After the deletions.']]);
    expect(JSON.stringify(studio.state)).not.toContain('deleted line.');
  }finally{studio.close();}
});

test('INGEST-18b CLEARMSG queued message: a line held in the IRC standby queue, or not yet arrived, is never drafted once deleted',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();studio.ingest.setEventSubChat(true);
    source.chat('q1','Queued then deleted.','u');source.chat('q2','Queued and kept.','v');
    expect(studio.ingest.diagnostics.standbyEntries).toBe(2);expect(studio.state.pendingPanels).toEqual([]);
    source.feed(clearMsg('q1'));expect(studio.ingest.diagnostics.standbyEntries).toBe(1);
    source.feed(clearMsg('q3'));
    studio.ingest.setEventSubChat(false);
    source.chat('q3','Deleted before it arrived.','w');
    expect(studio.state.pendingPanels.map(panel=>panel.dialogue)).toEqual([['Queued and kept.']]);
    const json=JSON.stringify(studio.state);
    expect(json).not.toContain('Queued then deleted.');expect(json).not.toContain('Deleted before it arrived.');
  }finally{studio.close();}
});

test('INGEST-19 Throttle notice: chat skipped by the 60-per-second limit is counted and shown to the operator; privacy controls are never skipped',async({page})=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    for(let index=0;index<50;index++)source.chat(`calm-${index}`,`Calm line ${index}`);
    expect(studio.state.source?.received).toBe(50);expect(studio.state.source?.throttled??0).toBe(0);
    for(let index=0;index<50;index++)source.chat(`flood-${index}`,`Flood line ${index}`);
    // Ten more fit the one-second window; the other forty are skipped and counted.
    expect(studio.state.source).toMatchObject({active:'twitch',received:60,throttled:40});
    await page.route('**/api/state',route=>route.fulfill({json:studio.state}));await page.goto('/studio');
    const notice=page.getByTestId('throttle-notice');
    await expect(notice).toBeVisible();await expect(notice).toHaveAttribute('role','status');
    await expect(notice).toContainText('40 chat lines skipped');await expect(notice).toContainText('60 per second');
    await expect(notice).toContainText('Opt-outs and deletions are never skipped');
    await mkdir('artifacts/tmp/ingest-chaos',{recursive:true});
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await expect(notice).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect((await new AxeBuilder({page}).analyze()).violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
      await notice.scrollIntoViewIfNeeded();await page.screenshot({path:`artifacts/tmp/ingest-chaos/throttle-notice-${width}.png`});
    }
    // A saturated window still lets an opt-out through, and it is not counted as skipped.
    source.chat('flood-extra','Still flooding.');expect(studio.state.source?.throttled).toBe(41);source.chat('flood-optout','!optout');source.advance(1000);source.chat('after-flood-optout','Must stay excluded.');
    expect(JSON.stringify(studio.state)).not.toContain('Must stay excluded.');expect(studio.state.source?.throttled).toBe(41);
    // Switching to Sample Data clears the count and never shows the notice.
    studio.useSource('sample');expect(studio.state.source?.throttled??0).toBe(0);
    await page.reload();await expect(page.getByTestId('source-label')).toHaveText('Sample Data');await expect(page.getByTestId('throttle-notice')).toHaveCount(0);
  }finally{studio.close();}
});
