// Today's ComicToons ingest code driven by the fake Twitch (imports only, no edits):
// the IRC adapter (apps/server/src/ingest/irc.ts) over a plain local socket, and the
// EventSub normaliser (packages/core normalizeTwitchEvent) fed with the fake's frames.
// These run for real. Behaviour that does not exist yet is marked fixme with its id.
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {test} from 'node:test';
import {normalizeTwitchEvent, type StreamEvent} from '@comictoons/core';
import {bindIrcSocket, TwitchIrcAdapter, type IrcStatus, type IrcTransportFactory} from '../../apps/server/src/ingest/irc.ts';
import {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import {EventSubTestClient, FAKE_PORT, fixme, helix, waitUntil} from './helpers.ts';

/** The adapter's transport seam, pointed at the fake's plain IRC port on 127.0.0.1. */
const localTransport = (port: number): IrcTransportFactory => handlers => bindIrcSocket(connect({host: '127.0.0.1', port}, handlers.open), handlers);

async function adapterRun(run: (ctx: {fake: FakeTwitch; events: StreamEvent[]; statuses: IrcStatus[]; adapter: TwitchIrcAdapter}) => Promise<void>, token?: (fake: FakeTwitch) => string) {
  const fake = await new FakeTwitch({port: FAKE_PORT}).start();
  const events: StreamEvent[] = [], statuses: IrcStatus[] = [];
  const secret = token ? token(fake) : fake.issueUserToken(['chat:read']).access_token;
  const adapter = new TwitchIrcAdapter({channel: fake.broadcaster.login, transport: localTransport(fake.urls.ircPort),
    authenticate: () => ({username: fake.broadcaster.login, token: `oauth:${secret}`})});
  adapter.start({event: e => events.push(e), status: s => statuses.push(s)});
  try { await run({fake, events, statuses, adapter}); } finally { adapter.stop(); await fake.stop(); }
}

test('IRC adapter authenticates against the fake, joins, and reads PRIVMSG / CLEARMSG / CLEARCHAT', () => adapterRun(async ({fake, events, statuses}) => {
  await waitUntil(() => statuses.includes('empty'), 3000, 'adapter welcome');
  await fake.waitForLog(e => e.kind === 'irc.join' && e.detail.channel === fake.broadcaster.login, 3000);
  const {id} = fake.chat('viewer_one', 'the dragon sneezes');
  await waitUntil(() => events.length === 1, 3000, 'chat event');
  assert.equal(events[0]!.type, 'chat');
  assert.equal(events[0]!.id, id);
  assert.equal(events[0]!.text, 'the dragon sneezes');
  assert.equal(events[0]!.user, fake.user('viewer_one').id);
  fake.deleteMessage('viewer_one', id, 'the dragon sneezes');
  await waitUntil(() => events.length === 2, 3000, 'CLEARMSG withdrawal');
  assert.equal(events[1]!.withdraw, 'message');
  assert.equal(events[1]!.targetId, id);
  const earlier = fake.chat('viewer_one', 'earlier line removed by timeout');
  const bystander = fake.chat('viewer_two', 'bystander line remains');
  await waitUntil(() => events.length === 4, 3000, 'chat before targeted CLEARCHAT');
  fake.clearChat('viewer_one', 600);
  await waitUntil(() => events.length === 5, 3000, 'CLEARCHAT earlier-line withdrawal');
  assert.equal(events[4]!.withdraw, 'message');
  assert.equal(events[4]!.targetId, earlier.id);
  assert.ok(!events.some(event => event.withdraw === 'message' && event.targetId === bystander.id), 'other viewers are not cleared');
  assert.ok(!events.some(event => event.text === '!optout'), 'a timeout is not a permanent self opt-out');
  const later = fake.chat('viewer_one', 'same viewer returns after timeout');
  await waitUntil(() => events.length === 6, 3000, 'later chat from the cleared viewer');
  assert.equal(events[5]!.type, 'chat');
  assert.equal(events[5]!.id, later.id);
  assert.equal(events[5]!.text, 'same viewer returns after timeout');
  assert.equal(events[5]!.user, fake.user('viewer_one').id);
  assert.ok(!fake.irc.inbound.some(i => i.command === 'PRIVMSG'), 'the adapter never posts to chat');
}));

test('IRC adapter reports unauthenticated on "Login authentication failed"', () => adapterRun(async ({statuses}) => {
  await waitUntil(() => statuses.includes('unauthenticated'), 3000, 'unauthenticated status');
}, () => 'expiredorinvalidtoken'));

test('IRC adapter reconnects after a server RECONNECT and keeps reading chat', () => adapterRun(async ({fake, events, statuses}) => {
  await waitUntil(() => statuses.includes('empty'), 3000, 'first welcome');
  fake.irc.reconnect(20);
  await waitUntil(() => statuses.filter(s => s === 'empty').length >= 2, 5000, 'second welcome after RECONNECT (1 s backoff)');
  await fake.waitForLog(e => e.kind === 'irc.join' && Number(e.detail.client) >= 2, 3000);
  fake.chat('viewer_two', 'back again');
  await waitUntil(() => events.some(e => e.text === 'back again'), 3000, 'chat after reconnect');
}));

test('EventSub normaliser maps the fake\'s channel.chat.message and channel.raid frames', async () => {
  const fake = await new FakeTwitch({port: FAKE_PORT}).start();
  try {
    const token = fake.issueUserToken(['user:read:chat']).access_token;
    const client = new EventSubTestClient(fake.urls.eventSubWs);
    const session = await client.welcome();
    const auth = {clientId: fake.clientId, token};
    for (const [type, condition] of [['channel.chat.message', {broadcaster_user_id: fake.broadcaster.id, user_id: fake.broadcaster.id}], ['channel.raid', {to_broadcaster_user_id: fake.broadcaster.id}]] as const) {
      assert.equal((await helix(fake.urls.helixBase, 'POST', '/eventsub/subscriptions', auth, {type, version: '1', condition, transport: {method: 'websocket', session_id: session.id}})).status, 202);
    }
    fake.chat('viewer_one', 'hello comic');
    fake.raid('raidfriend', 21);
    await waitUntil(() => client.notifications().length === 2, 3000, 'two notifications');
    const chat = normalizeTwitchEvent(client.notifications('channel.chat.message')[0]);
    assert.equal(chat?.type, 'chat');
    assert.equal(chat?.text, 'hello comic');
    assert.equal(chat?.user, fake.user('viewer_one').id);
    const raid = normalizeTwitchEvent(client.notifications('channel.raid')[0]);
    assert.equal(raid?.type, 'raid');
    assert.equal(raid?.from, 'raidfriend');
    assert.equal(raid?.viewers, 21);
    await client.close();
  } finally { await fake.stop(); }
});

test('IRC adapter turns USERNOTICE msg-id=raid into a raid event', fixme(['P1-4'], 'USERNOTICE raid is not parsed by ingest/irc.ts yet'), () => adapterRun(async ({fake, events, statuses}) => {
  await waitUntil(() => statuses.includes('empty'), 3000, 'adapter welcome');
  fake.raid('raidfriend', 15);
  await waitUntil(() => events.some(e => e.type === 'raid'), 3000, 'raid event');
  const raid = events.find(e => e.type === 'raid')!;
  assert.equal(raid.from, 'raidfriend');
  assert.equal(raid.viewers, 15);
}));

test('EventSub chat keeps the Twitch message id so CLEARMSG / message_delete can find the line', async () => {
  const fake = await new FakeTwitch({port: FAKE_PORT}).start();
  try {
    const token = fake.issueUserToken(['user:read:chat']).access_token;
    const client = new EventSubTestClient(fake.urls.eventSubWs);
    const session = await client.welcome();
    await helix(fake.urls.helixBase, 'POST', '/eventsub/subscriptions', {clientId: fake.clientId, token}, {type: 'channel.chat.message', version: '1',
      condition: {broadcaster_user_id: fake.broadcaster.id, user_id: fake.broadcaster.id}, transport: {method: 'websocket', session_id: session.id}});
    const {id} = fake.chat('viewer_one', 'quote me');
    await waitUntil(() => client.notifications().length === 1);
    assert.equal(normalizeTwitchEvent(client.notifications()[0])?.id, id);
    await client.close();
  } finally { await fake.stop(); }
});
