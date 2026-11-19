import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIrc,TwitchIrcAdapter} from '../apps/server/src/ingest/irc.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {createApp} from '../apps/server/src/app.ts';
import {renderExport} from '../apps/server/src/export.ts';
import {chatSourceLabel,panelSourceLabel,type StreamEvent} from '../packages/core/src/index.ts';
import {ircFixture} from './ingest-fixture.ts';

test('IRC-PARSE: tagged, split and batched IRC preserves Unicode, ignores wrong channels and escapes untrusted text',()=>{
  const source=ircFixture();const events:StreamEvent[]=[];
  source.adapter.start({event:event=>events.push(event),status:()=>{}});source.welcome();
  const message=Buffer.from('@id=one;user-id=u :a!a@a PRIVMSG #approved_test :مرحبا 👩🏽‍🚀 <script>hi</script>\r\n');
  const cut=message.indexOf(Buffer.from('👩'))+2;source.feed(message.subarray(0,cut));source.feed(message.subarray(cut));
  source.feed(':a!a@a PRIVMSG #another :wrong room\r\nBAD FRAME\r\n');
  assert.equal(events.length,1);assert.equal(events[0]!.text,'مرحبا 👩🏽‍🚀 hi');
  assert.equal(parseIrc('@display-name=A\\sB :a PRIVMSG #room :hello')?.tags['display-name'],'A B');
  for(const line of ['','bad frame','PRIVMSG #room :bad\0','PRIVMSG #room :\uFFFD'])assert.equal(parseIrc(line),undefined);
  source.adapter.stop();
});

test('IRC-READONLY: transport emits only auth, capability, join and PONG control frames',()=>{
  const source=ircFixture();const statuses:string[]=[];
  source.adapter.start({event:()=>{},status:status=>statuses.push(status)});source.welcome();source.feed('PING :tmi.twitch.tv\r\n');
  assert.deepEqual(source.sent,['PASS oauth:mock_read_only\r\n','NICK sample_bot\r\n','CAP REQ :twitch.tv/tags twitch.tv/commands\r\n','JOIN #approved_test\r\n','PONG :tmi.twitch.tv\r\n']);
  assert.deepEqual(statuses,['connecting','empty']);assert.ok(source.sent.every(frame=>!/^PRIVMSG|^WHISPER/.test(frame)));
  source.adapter.stop();
});

test('IRC-AUTH: absent credentials never open a socket; auth rejection is a redacted status',()=>{
  let opened=0;const statuses:string[]=[];
  new TwitchIrcAdapter({channel:'approved_test',transport:()=>{opened++;throw new Error('not called');}}).start({event:()=>{},status:status=>statuses.push(status)});
  assert.equal(opened,0);assert.deepEqual(statuses,['unauthenticated']);
  const source=ircFixture();source.adapter.start({event:()=>{},status:status=>statuses.push(status)});source.open();
  source.feed(':tmi.twitch.tv NOTICE * :Login authentication failed\r\n');
  assert.equal(statuses.at(-1),'unauthenticated');assert.equal(source.closed,1);
  assert.ok(!JSON.stringify(statuses).includes('oauth:'));
});

test('INGEST-INSTANT: selecting unavailable Twitch supplies four reviewable sample moments synchronously',()=>{
  const studio=new Studio();
  const state=studio.useSource('twitch','approved_test');
  assert.equal(state.source?.reason,'unauthenticated');assert.equal(state.source?.active,'sample');
  assert.equal(state.pendingPanels.length,4);assert.equal(state.panels.length,0);assert.equal(chatSourceLabel(state.source),'Sample Data');
  assert.ok(!(state instanceof Promise),'Fallback returns the prepared sample synchronously');
  assert.ok(!JSON.stringify(state).includes('oauth:'));studio.close();
});

test('INGEST-CACHE: live reception, disconnect and retry preserve sample approvals and the live draft separately',()=>{
  let clock=1000;const connections:ReturnType<typeof ircFixture>[]=[];
  const studio=new Studio({now:()=>clock,adapterFactory:()=>{const connection=ircFixture(()=>clock);connections.push(connection);return connection.adapter;}});
  studio.replay('tabletop-night');const id=studio.state.pendingPanels[0]!.id;studio.caption(id,'The approved sample edit.');studio.moderate('approve');
  const approved=structuredClone(studio.state.panels);
  studio.useSource('twitch','approved_test');const first=connections[0]!;
  assert.equal(studio.state.source?.active,'sample');first.welcome();assert.equal(studio.state.source?.active,'sample');
  first.chat('m1','A real-shaped simulated line.');
  assert.equal(studio.state.source?.active,'twitch');assert.equal(studio.state.pendingPanels.length,1);
  assert.equal(chatSourceLabel(studio.state.source),'Simulated IRC · Sample Data');
  const draftId=studio.state.pendingPanels[0]!.id;
  first.drop();assert.deepEqual(studio.state.panels,approved);assert.equal(studio.state.source?.reason,'disconnected');
  first.chat('late','Must be ignored.');assert.deepEqual(studio.state.panels,approved);
  studio.useSource('twitch','approved_test');const second=connections[1]!;second.welcome();clock+=1000;second.chat('m2','A second simulated line.');
  assert.equal(studio.state.pendingPanels[0]!.id,draftId);assert.equal(studio.state.pendingPanels[0]!.dialogue.length,2);
  studio.useSource('sample');assert.deepEqual(studio.state.panels,approved);second.chat('late2','Never publish after switch.');assert.deepEqual(studio.state.panels,approved);
  studio.close();
});

test('INGEST-EMPTY: zero-message connection stays on samples; quiet live chat stays live (RAID-SAMPLE-1)',()=>{
  let clock=0;const source=ircFixture(()=>clock);
  const studio=new Studio({adapterFactory:()=>source.adapter,now:()=>clock});
  studio.useSource('twitch','approved_test');source.welcome();clock=90_000;studio.tick();
  assert.equal(studio.state.source?.active,'sample');assert.equal(studio.state.pendingPanels.length,4);
  source.chat('one','A chat line.');assert.equal(studio.state.source?.active,'twitch');
  const live=structuredClone(studio.state.pendingPanels);
  clock+=60_000;studio.tick();assert.equal(studio.state.source?.active,'twitch');assert.equal(studio.state.source?.reason,undefined);
  assert.deepEqual(studio.state.pendingPanels,live);studio.close();
});

test('INGEST-BOUNDS: duplicate IDs, burst messages and stale callbacks cannot grow the review queue without bound',()=>{
  const source=ircFixture();const studio=new Studio({adapterFactory:()=>source.adapter});
  studio.useSource('twitch','approved_test');source.welcome();
  for(let index=0;index<2000;index++)source.chat(`message-${index}`,`Selected line ${index}`);
  source.chat('message-1999','duplicate');
  assert.equal(studio.state.source?.received,60);assert.equal(studio.state.pendingPanels.length,1);assert.equal(studio.state.pendingPanels[0]!.dialogue.length,4);
  for(let index=0;index<4200;index++)source.chat(`optout-${index}`,'!noink',`denied-${index}`);
  source.chat('after-ledger-full','Must not bypass an earlier opt-out.');
  assert.equal(studio.state.source?.active,'sample');assert.ok(!JSON.stringify(studio.state).includes('Must not bypass'));
  studio.stop();source.chat('after-stop','Must stay hidden.');assert.equal(studio.state.status,'stopped');assert.equal(studio.state.panels.length,0);assert.equal(studio.state.pendingPanels.length,0);
  studio.close();
});

test('INGEST-PRIVACY: opt-out removes included chat, invalidates undo and beats later opt-in',()=>{
  const source=ircFixture();const studio=new Studio({adapterFactory:()=>source.adapter});
  studio.useSource('twitch','approved_test');source.welcome();source.chat('one','A private test line.','u');
  const approved=studio.moderate('approve');assert.equal(studio.state.panels.length,1);
  source.chat('out','!noink','u');assert.ok(!JSON.stringify(studio.state).includes('A private test line.'));
  assert.throws(()=>studio.undo(approved.undoToken),/expired/);
  source.chat('in','!ink','u');source.chat('blocked','Do not include me.','u');
  assert.equal(studio.state.source?.active,'sample');assert.ok(!JSON.stringify(studio.state).includes('Do not include me.'));studio.close();
});

test('INGEST-09 CLEARMSG: a single deleted message id is removed from its panel without touching the rest',()=>{
  const source=ircFixture();const studio=new Studio({adapterFactory:()=>source.adapter});
  studio.useSource('twitch','approved_test');source.welcome();
  source.chat('msg-del','The deleted line.','u');source.chat('keep','The kept line.','u');
  const approval=studio.moderate('approve');
  assert.equal(studio.state.panels.length,1);assert.deepEqual(studio.state.panels[0]!.dialogue,['The deleted line.','The kept line.']);
  source.feed('@login=u;target-msg-id=msg-del :tmi.twitch.tv CLEARMSG #approved_test :The deleted line.\r\n');
  assert.ok(!JSON.stringify(studio.state).includes('The deleted line.'));
  assert.deepEqual(studio.state.panels[0]!.dialogue,['The kept line.']);
  assert.throws(()=>studio.undo(approval.undoToken),/expired/);
  studio.close();
});

test('INGEST-API: safe bootstrap, failed auth fallback and transport injection expose no credential endpoint',async()=>{
  const app=createApp();
  try {
    const original=(await app.inject('/api/state')).json();
    const snapshot=(await app.inject('/api/ingest/sample')).json();assert.equal(snapshot.pendingPanels.length,4);
    assert.deepEqual((await app.inject('/api/state')).json(),original,'Sample preload is read-only');
    assert.equal((await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch'}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test',token:'mock-not-a-real-secret'}})).statusCode,400);
    const response=await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
    assert.equal(response.statusCode,200);assert.equal(response.json().source.reason,'unauthenticated');assert.equal(response.json().pendingPanels.length,4);
  } finally {await app.close();}
});

test('INGEST-LABELS: source provenance persists through live/fallback exported pages without invented live dialogue',async()=>{
  const source=ircFixture(()=>0,false);const studio=new Studio({adapterFactory:()=>source.adapter});
  studio.useSource('twitch','approved_test');source.welcome();source.chat('one','<b>Observed chat only.</b>');studio.moderate('approve');
  assert.equal(panelSourceLabel(studio.state.panels),'Live chat · Original illustration');
  const live=await renderExport(studio.state);assert.ok(live.html.includes('Live chat'));assert.ok(!live.html.includes('Invented chat'));assert.ok(live.html.includes('Observed chat only.'));
  studio.useSource('sample');studio.moderate('approve');
  const sample=await renderExport(studio.state);assert.ok(sample.html.includes('Sample Data'));assert.ok(!sample.html.includes('Observed chat only.'));studio.close();
});
