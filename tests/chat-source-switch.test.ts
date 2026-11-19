import assert from 'node:assert/strict';
import test from 'node:test';
import {ChatSource} from '../apps/server/src/ingest/source.ts';
import type {ChatAdapter} from '../apps/server/src/ingest/irc.ts';
import type {StreamEvent} from '../packages/core/src/index.ts';

function harness() {
  let clock = 1000;
  const emitted: StreamEvent[] = [];
  const adapters: Parameters<ChatAdapter['start']>[0][] = [];
  const source = new ChatSource({change() {}, event: event => emitted.push(event)}, () => ({
    start(callbacks) {adapters.push(callbacks);}, stop() {},
  }), () => clock);
  source.start('approved_test');
  return {source, emitted, emit: (event: StreamEvent, index = adapters.length - 1) => adapters[index].event(event),
    status: (value: Parameters<Parameters<ChatAdapter['start']>[0]['status']>[0]) => adapters.at(-1)!.status(value),
    advance: (ms: number) => {clock += ms;}};
}
const raid = (id = 'raid-message'): StreamEvent => ({id, t: 1, type: 'raid', from: 'TestChannel', viewers: 15});

test('IRC raid and generic non-chat events forward once without chat filters or liveness changes', () => {
  const {source, emitted, emit} = harness();
  try {
    emit(raid()); emit(raid());
    emit({id: 'cheer-message', t: 2, type: 'cheer', text: '!ink'});
    assert.deepEqual(emitted, [raid(), {id: 'cheer-message', t: 2, type: 'cheer', text: '!ink'}]);
    assert.equal(source.state.received, 0);
    assert.equal(source.state.active, 'sample');
    assert.equal(source.diagnostics.rateEntries, 0);
  } finally {source.close();}
});

test('IRC raids are suppressed while EventSub is active and stale adapter generations stay fenced', () => {
  const {source, emitted, emit} = harness();
  try {
    source.setEventSubChat(true); emit(raid());
    assert.equal(emitted.length, 0);
    source.setEventSubChat(false); emit(raid());
    assert.deepEqual(emitted, [raid()]);
    source.start('another_channel');
    emit(raid('stale'), 0);
    assert.equal(emitted.length, 1);
    source.sample(); emit(raid('after-sample'));
    assert.equal(emitted.length, 1);
  } finally {source.close();}
});


const chat = (id: string | undefined, text = id ?? 'same words', user = 'viewer'): StreamEvent => ({id, t: 1, type: 'chat', user, text});

test('IRC-only admission counts unique messages once and retains the existing 500 ms payload debounce', () => {
  const {source, emit, emitted, advance} = harness();
  try {
    emit(chat('one')); emit(chat('one'));
    emit(chat('another-id', 'one'));
    advance(501); emit(chat('two'));
    assert.deepEqual(emitted.map(event => event.id), ['one', 'two']);
    assert.equal(source.state.received, 2);
  } finally {source.close();}
});

test('EventSub admits chat while IRC stays buffered, and overlaps in both arrival orders count once', () => {
  const {source, emit, emitted} = harness();
  try {
    emit(chat('before-switch'));
    source.setEventSubChat(true);
    source.acceptEventSub(chat('before-switch'));
    emit(chat('irc-first')); source.acceptEventSub(chat('irc-first'));
    source.acceptEventSub(chat('eventsub-first')); emit(chat('eventsub-first'));
    source.acceptEventSub(chat('eventsub-first'));
    assert.deepEqual(emitted.map(event => event.id), ['before-switch', 'irc-first', 'eventsub-first']);
    assert.equal(source.state.received, 3);
    source.setEventSubChat(false);
    assert.equal(emitted.length, 3);
    assert.equal(source.state.received, 3);
  } finally {source.close();}
});

test('falling back flushes IRC-only gap messages in order once and excludes EventSub deliveries', () => {
  const {source, emit, emitted, advance} = harness();
  try {
    source.setEventSubChat(true);
    source.acceptEventSub(chat('shared')); emit(chat('shared'));
    advance(50); emit(chat('gap-one'));
    advance(50); emit(chat('gap-two')); emit(chat('gap-two'));
    assert.equal(source.state.received, 1);
    source.setEventSubChat(false); source.setEventSubChat(false);
    emit(chat('gap-one'));
    assert.deepEqual(emitted.map(event => event.id), ['shared', 'gap-one', 'gap-two']);
    assert.equal(source.state.received, 3);
  } finally {source.close();}
});

test('id-less cross-source duplicates debounce for five seconds across switches in both directions', () => {
  const {source, emit, emitted, advance} = harness();
  try {
    emit(chat(undefined)); advance(1500);
    source.setEventSubChat(true); source.acceptEventSub(chat(undefined));
    assert.equal(source.state.received, 1);
    advance(3501); source.acceptEventSub(chat(undefined));
    assert.equal(source.state.received, 2, 'a new message outside the five-second window is allowed');
    emit(chat(undefined)); source.setEventSubChat(false);
    assert.equal(source.state.received, 2);
    assert.equal(emitted.length, 2);
  } finally {source.close();}
});

test('an id learned from a duplicate id-less message prevents later replay beyond the payload window', () => {
  const {source, emit, emitted, advance} = harness();
  try {
    emit(chat(undefined)); source.setEventSubChat(true);
    source.acceptEventSub(chat('learned-id', 'same words'));
    advance(6000); source.acceptEventSub(chat('learned-id', 'same words'));
    source.setEventSubChat(false); emit(chat('learned-id', 'same words'));
    assert.equal(emitted.length, 1); assert.equal(source.state.received, 1);
  } finally {source.close();}
});

test('privacy controls from either transport apply immediately once, bypass throttling and purge standby', () => {
  const {source, emit, emitted} = harness();
  try {
    source.setEventSubChat(true);
    emit(chat('private-gap', 'private words', 'opted-out'));
    emit(chat('optout-irc', '!noink', 'opted-out'));
    source.acceptEventSub(chat('optout-eventsub', '!optout', 'opted-out'));
    emit(chat('optout-repeat', '!noink', 'opted-out'));
    source.acceptEventSub(chat('excluded', 'must not appear', 'opted-out'));
    for (let index=0; index<61; index++)source.acceptEventSub(chat(`ordinary-${index}`, `line ${index}`, `viewer-${index}`));
    const removal: StreamEvent = {...chat('deletion-irc'), withdraw: 'message', targetId: 'ordinary-0'};
    emit(removal); source.acceptEventSub({...removal, id: 'deletion-eventsub'});
    source.acceptEventSub(chat('private-two', 'another private line', 'other-user'));
    source.acceptEventSub(chat('optout-two', '!noink', 'other-user'));
    source.setEventSubChat(false);
    source.acceptEventSub(chat('inactive-optout', '!noink', 'third-user'));
    emit(chat('withdrawn-replay', '!ink', 'third-user'));
    emit(chat('ordinary-0'));
    assert.equal(emitted.filter(event => /^!(?:noink|optout)$/.test(event.text ?? '')).length, 3);
    assert.equal(emitted.filter(event => event.withdraw === 'message').length, 1);
    assert.equal(emitted.some(event => event.id==='private-gap'||event.id==='excluded'), false);
    assert.equal(source.state.received, 60, 'privacy events do not increment ordinary chat received');
    assert.equal(source.diagnostics.standbyEntries, 0);
  } finally {source.close();}
});

test('EventSub chat is ignored in sample mode and IRC statuses cannot demote a subscribed source', () => {
  const {source, emit, emitted, status} = harness();
  try {
    source.sample(); source.setEventSubChat(true);
    source.acceptEventSub(chat('sample-ignored')); emit(chat('stale-ignored'));
    assert.equal(emitted.length, 0); assert.equal(source.state.received, 0);
    source.start('approved_test');
    source.acceptEventSub(chat('live')); status('disconnected');
    assert.equal(source.state.active, 'twitch'); assert.equal(source.state.received, 1);
  } finally {source.close();}
});

test('standby is bounded to 200 recent messages and expires after ten seconds', () => {
  const {source, emit, emitted, advance} = harness();
  try {
    source.setEventSubChat(true);
    for(let index=0;index<250;index++)emit(chat(`buffer-${index}`));
    assert.equal(source.diagnostics.standbyEntries, 200);
    advance(10_001); source.tick(); source.setEventSubChat(false);
    assert.equal(emitted.length, 0); assert.equal(source.diagnostics.standbyEntries, 0);
  } finally {source.close();}
});


test('id-less overlap observations survive a return to the original IRC source', () => {
  const {source, emit, emitted, advance} = harness();
  try {
    emit(chat(undefined)); advance(1500); source.setEventSubChat(true);
    source.acceptEventSub(chat(undefined)); emit(chat(undefined)); source.setEventSubChat(false);
    assert.equal(emitted.length, 1); assert.equal(source.state.received, 1);
  } finally {source.close();}
});


test('EventSub activation cannot bypass the existing fail-closed opt-out capacity', () => {
  const {source, emit} = harness();
  try {
    for(let index=0;index<4097;index++)emit(chat(`privacy-${index}`, '!noink', `user-${index}`));
    assert.equal(source.diagnostics.deniedUsers, 4096);
    source.setEventSubChat(true); source.acceptEventSub(chat('blocked-after-cap'));
    assert.equal(source.state.active, 'sample'); assert.equal(source.state.received, 0);
    source.start('approved_test'); source.acceptEventSub(chat('still-blocked'));
    assert.equal(source.state.active, 'sample'); assert.equal(source.state.received, 0);
  } finally {source.close();}
});

test('B2 user withdrawals purge standby immediately without opting out or counting as chat',()=>{
  const {source,emitted,emit}=harness();
  try{
    source.setEventSubChat(true);
    emit({id:'queued-user',t:1,type:'chat',user:'viewer',text:'earlier queued line'});
    const clear:StreamEvent={id:'clear-user',t:2,type:'chat',withdraw:'user',targetUser:'viewer',banDuration:600};
    source.acceptEventSub(clear);emit(clear);
    assert.equal(emitted.length,1);
    assert.equal(source.state.received,0);
    source.setEventSubChat(false);
    assert.equal(emitted.length,1,'cleared standby line never replays');
    emit({id:'after-user',t:3,type:'chat',user:'viewer',text:'later chat remains eligible'});
    assert.equal(source.state.received,1);
    assert.equal(emitted.at(-1)?.id,'after-user');
  }finally{source.close();}
});
