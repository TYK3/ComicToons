// The ten-step live checklist (docs/LIVE_TEST.md), run end to end against the fake Twitch on
// 127.0.0.1:4120 and the real ComicToons server on 127.0.0.1:3120. No real Twitch calls.
//
// Each step is fixme until the P0 items it depends on have landed (T2 sign-in and token store,
// T3 EventSub and the real Helix client), so the gate stays green. Enable them with
//   COMICTOONS_TWITCH_E2E=all npm run test:twitch            (or a list, e.g. P0-1,P0-2)
// The bodies are real assertions: when enabled today they fail, which is the point.
// Route and status field names follow the T2/T3 handoffs; adjust here if the landed code
// names them differently, and say so in that slice's report.
import assert from 'node:assert/strict';
import {after, afterEach, before, describe, test} from 'node:test';
import {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import {Browser, json, startApp, type RunningApp} from './app-kit.ts';
import {FAKE_PORT, fixme, sleep, waitUntil} from './helpers.ts';

type State = {source?: {active?: string; channel?: string; received?: number}; panels: {id: string; origin?: string; caption: string; dialogue: string[]; sources?: string[]}[]; pendingPanels: {id: string; origin?: string; caption: string; dialogue: string[]; sources?: string[]}[]};
type TwitchStatus = {connected?: boolean; channel?: string; login?: string; scopes?: string[]; eventsub?: {connected?: boolean; subscriptions?: number}};
type Participation = Record<string, unknown>;

let fake: FakeTwitch;
let app: RunningApp | undefined;

before(async () => { fake = await new FakeTwitch({port: FAKE_PORT}).start(); });
after(async () => { await fake.stop(); });
afterEach(async () => { await app?.stop(); app = undefined; });

const state = async () => (await json<State>(`${app!.base}/api/state`)).body;
const twitchStatus = async () => (await json<TwitchStatus>(`${app!.base}/api/twitch/status`)).body;
const participation = async () => (await json<Participation>(`${app!.base}/api/participation/status`)).body;
const allLines = (s: State) => [...s.panels, ...s.pendingPanels].flatMap(p => [p.caption, ...p.dialogue, ...(p.sources ?? [])]).join('\n');

async function poll<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last).slice(0, 400)}`);
    await sleep(150);
    last = await read();
  }
  return last;
}

/** Nothing the fake issued (client secret, codes, access or refresh tokens) may show up in app output. */
function assertNoSecretsIn(text: string, where: string) {
  for (const secret of fake.secretValues()) assert.ok(!text.includes(secret), `a Twitch credential leaked into ${where}`);
}

/** Step 1 path: sign in through the app, then wait for chat and EventSub to be live.
 * It only returns once the app's chat has logged in to the fake, which proves the endpoint
 * overrides are honoured, so a later /api/ingest twitch can never reach real Twitch. */
async function connect(extra: Record<string, string> = {}) {
  app = await startApp(fake, extra);
  const browser = new Browser();
  const {hops, response, body} = await browser.follow(`${app.base}/auth/twitch/login`);
  assert.ok(hops.some(h => h.url.startsWith(`${fake.urls.authBase}/authorize`)), 'login redirects to the Twitch authorise page');
  assert.ok(hops.some(h => h.url.startsWith(`${app!.base}/auth/twitch/callback`)), 'Twitch sends the browser back to the callback');
  assert.ok(response.status < 400, `callback finished without an error (${response.status})`);
  assertNoSecretsIn(body + JSON.stringify(hops.map(h => h.url.replace(/[?&]code=[^&]+/, ''))), 'the browser');
  await fake.waitForLog(e => e.kind === 'irc.auth' && e.detail.ok === true, 10_000);
  await fake.waitForLog(e => e.kind === 'irc.join', 5000);
  await fake.waitForLog(e => e.kind === 'eventsub.subscribe', 10_000);
  return browser;
}

async function chatBurst(viewers = 6, perViewer = 2) {
  const ids: string[] = [];
  for (let round = 0; round < perViewer; round++)
    for (let v = 0; v < viewers; v++) ids.push(fake.chat(`viewer${v}`, `round ${round}: the dragon just stole the loot again ${v}`).id);
  return ids;
}

describe('e2e kit', () => {
  test('ComicToons starts on 3120 with fake credentials, makes no Twitch calls, and stops by PID', async () => {
    const logBefore = fake.log.length;
    app = await startApp(fake);
    const pid = app.pid;
    const status = await json<TwitchStatus>(`${app.base}/api/twitch/status`);
    assert.equal(status.status, 200);
    assert.notEqual(status.body.connected, true, 'not connected without a sign-in');
    assertNoSecretsIn(status.text + app.output(), 'status or server logs');
    assert.equal(fake.log.length, logBefore, 'the app did not contact Twitch on its own');
    await app.stop();
    assert.ok(app.child.exitCode !== null || app.child.signalCode !== null, `child ${pid} exited`);
    await assert.rejects(fetch(`${app.base}/api/twitch/status`), 'port 3120 released');
    app = undefined;
  });
});

describe('live checklist against fake Twitch (4120) and ComicToons (3120)', () => {
  test('Step 1, Connect: sign in with Twitch, token kept server-side, chat and EventSub live', fixme(['P0-1', 'P0-2'], 'needs T2 OAuth routes and token store'), async () => {
    await connect();
    const token = fake.log.filter(e => e.kind === 'oauth.token');
    assert.ok(token.some(e => e.detail.grant === 'authorization_code' && e.detail.status === 200), 'code exchanged once');
    assert.ok(fake.log.some(e => e.kind === 'oauth.validate' && e.detail.status === 200), 'token validated on start (hourly after)');
    const authorise = fake.log.find(e => e.kind === 'oauth.authorize');
    assert.equal(authorise?.detail.state, true, 'authorise request carries state');
    const status = await twitchStatus();
    assert.equal(status.connected, true);
    assert.equal(status.channel, fake.broadcaster.login);
    assertNoSecretsIn(JSON.stringify(status), '/api/twitch/status');
    assertNoSecretsIn(app!.output(), 'server logs');
  });

  test('Step 2, Chat burst opens a moment from live chat', fixme(['P0-3', 'P0-8'], 'needs T2 chat credentials and T3 chat-to-participation'), async () => {
    await connect();
    await json(`${app!.base}/api/ingest`, {method: 'POST', body: JSON.stringify({mode: 'twitch', channel: fake.broadcaster.login})});
    await chatBurst();
    const s = await poll(state, v => v.source?.active === 'twitch' && [...v.panels, ...v.pendingPanels].some(p => p.origin === 'twitch'), 30_000, 'a Twitch-origin panel');
    assert.ok((s.source?.received ?? 0) >= 12, 'every chat line counted once (IRC and EventSub not double counted)');
    assert.ok((s.source?.received ?? 0) < 24, 'IRC and EventSub copies of the same message are de-duplicated');
  });

  test('Step 3, Raid lands as a raid beat and catch-up card', fixme(['P0-4', 'P0-5'], 'needs T3 EventSub channel.raid'), async () => {
    await connect();
    const {eventsub} = fake.raid('friendlyraider', 42);
    assert.equal(eventsub, 1, 'exactly one app EventSub session received channel.raid');
    const p = await poll(participation, v => JSON.stringify(v).includes('friendlyraider'), 10_000, 'the raid in participation status');
    assert.match(JSON.stringify(p), /42/);
  });

  test('Step 4, Ink me: reward created on Twitch, redemption shown, fulfil reaches Twitch', fixme(['P0-5', 'P0-6', 'P0-7'], 'needs T3 real Helix and redemption EventSub'), async () => {
    await connect();
    await json(`${app!.base}/api/participation/rewards/connect`, {method: 'POST'});
    await waitUntil(() => [...fake.rewards.values()].some(r => /ink me/i.test(r.title)), 10_000, 'Ink me reward on the fake channel');
    const {redemption} = fake.redeem([...fake.rewards.values()].find(r => /ink me/i.test(r.title))!.id, 'inkfan', 'draw me as a wizard');
    await poll(participation, v => JSON.stringify(v).includes(redemption.id), 10_000, 'the redemption in participation status');
    const resolved = await json(`${app!.base}/api/participation/redemptions/${redemption.id}`, {method: 'POST', body: JSON.stringify({action: 'fulfil'})});
    assert.equal(resolved.status, 200, resolved.text);
    await waitUntil(() => fake.redemptions.get(redemption.id)?.status === 'FULFILLED', 5000, 'FULFILLED on Twitch');
  });

  test('Step 4b, Ink me on a channel that is not Affiliate or Partner shows the fallback message', fixme(['P0-7'], 'needs T3 real Helix error mapping'), async () => {
    await fake.stop();
    fake = await new FakeTwitch({port: FAKE_PORT, broadcaster: {broadcasterType: ''}}).start();
    try {
      await connect();
      const view = await json<Participation>(`${app!.base}/api/participation/rewards/connect`, {method: 'POST'});
      assert.equal(fake.rewards.size, 0, 'no reward created');
      assert.match(JSON.stringify(view.body), /affiliate|partner/i, 'clear fallback message about Affiliate or Partner');
      assertNoSecretsIn(view.text, 'the fallback message');
    } finally {
      await app?.stop(); app = undefined;
      await fake.stop();
      fake = await new FakeTwitch({port: FAKE_PORT}).start();
    }
  });

  test('Step 5, Poll: created on Twitch, votes arrive, result picks the panel', fixme(['P0-5', 'P0-6', 'P0-8'], 'needs T3 real Helix polls and channel.poll.*'), async () => {
    await connect();
    await json(`${app!.base}/api/ingest`, {method: 'POST', body: JSON.stringify({mode: 'twitch', channel: fake.broadcaster.login})});
    await chatBurst();
    await poll(state, v => [...v.panels, ...v.pendingPanels].length > 0, 30_000, 'a panel to vote on');
    const started = await json(`${app!.base}/api/participation/polls`, {method: 'POST', body: JSON.stringify({duration: 30})});
    assert.equal(started.status, 200, started.text);
    await waitUntil(() => !!fake.activePoll, 5000, 'a poll on the fake channel');
    const active = fake.activePoll!;
    assert.ok(active.title.length <= 60 && active.choices.length >= 2 && active.choices.length <= 5, 'poll fits Twitch limits');
    fake.votePoll([1, 5]);
    fake.finishPoll();
    const p = await poll(participation, v => /COMPLETED|completed|winner/.test(JSON.stringify(v)), 10_000, 'poll result in participation status');
    assert.match(JSON.stringify(p), new RegExp(active.choices[1]!.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('Step 6, Prediction: hype train opens a prediction, the result becomes the punchline', fixme(['P0-5', 'P0-6'], 'needs T3 real Helix predictions and channel.prediction.*'), async () => {
    await connect();
    fake.hypeTrain(2, 800);
    await waitUntil(() => !!fake.activePrediction, 10_000, 'a prediction on the fake channel');
    const prediction = fake.activePrediction!;
    fake.predict(0, 3, 300);
    fake.lockPrediction();
    fake.endPrediction(prediction, 'RESOLVED', prediction.outcomes[0]!.id);
    const p = await poll(participation, v => JSON.stringify(v).includes('RESOLVED'), 10_000, 'resolved prediction in participation status');
    assert.match(JSON.stringify(p), new RegExp(prediction.outcomes[0]!.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('Step 7, CLEARMSG: a deleted chat line disappears from drafts and the overlay', fixme(['P0-3'], 'needs T2 live chat; EventSub delete also needs event.message_id kept'), async () => {
    await connect();
    await json(`${app!.base}/api/ingest`, {method: 'POST', body: JSON.stringify({mode: 'twitch', channel: fake.broadcaster.login})});
    await chatBurst();
    const marked = fake.chat('rudeviewer', 'this line must vanish PURPLEWALRUS');
    await poll(state, v => allLines(v).includes('PURPLEWALRUS'), 30_000, 'the marked line in a panel');
    fake.deleteMessage('rudeviewer', marked.id, 'this line must vanish PURPLEWALRUS');
    await poll(state, v => !allLines(v).includes('PURPLEWALRUS'), 5000, 'the marked line removed');
  });

  test('Step 8, Token expiry: a 401 triggers one refresh and the call succeeds', fixme(['P0-2'], 'needs T2 refresh on 401'), async () => {
    await connect();
    const refreshesBefore = fake.log.filter(e => e.kind === 'oauth.token' && e.detail.grant === 'refresh_token').length;
    fake.expireAccessTokens();
    const started = await json(`${app!.base}/api/participation/rewards/connect`, {method: 'POST'});
    assert.ok(started.status < 500, started.text);
    await fake.waitForLog(e => e.kind === 'oauth.token' && e.detail.grant === 'refresh_token' && e.detail.status === 200, 10_000);
    const refreshes = fake.log.filter(e => e.kind === 'oauth.token' && e.detail.grant === 'refresh_token').length - refreshesBefore;
    assert.ok(refreshes >= 1 && refreshes <= 2, `refreshed once, not in a loop (${refreshes})`);
    assert.equal((await twitchStatus()).connected, true);
    assertNoSecretsIn(app!.output(), 'server logs after refresh');
    // Revoked access must end in a clear "sign in again" state, not a retry storm.
    fake.revokeAuthorisation();
    fake.expireAccessTokens();
    await json(`${app!.base}/api/participation/rewards/connect`, {method: 'POST'});
    await poll(twitchStatus, v => v.connected === false, 10_000, 'disconnected after revoke');
    const storm = fake.log.filter(e => e.kind === 'oauth.token' && e.detail.grant === 'refresh_token' && e.detail.status === 400).length;
    assert.ok(storm <= 2, `no refresh storm after revoke (${storm})`);
  });

  test('Step 9, EventSub reconnect: session_reconnect moves to the new URL with no gap', fixme(['P0-4'], 'needs T3 EventSub session_reconnect handling'), async () => {
    await connect();
    const subsBefore = fake.subscriptions.size;
    const [old] = fake.connectedSessions;
    assert.ok(old, 'one EventSub session');
    fake.sendReconnect(old.id);
    await fake.waitForLog(e => e.kind === 'ws.connect' && e.detail.reconnect === true && e.detail.ok !== false, 10_000);
    await fake.waitForLog(e => e.kind === 'ws.close' && e.detail.session === old.id && e.detail.by === 'client', 10_000);
    assert.ok(!fake.log.some(e => e.kind === 'ws.close' && (e.detail.code === 4004 || e.detail.code === 4007)), 'no grace-period or invalid-reconnect close');
    assert.equal(fake.subscriptions.size, subsBefore, 'subscriptions carried over, not re-created');
    assert.equal(fake.raid('afterreconnect', 7).eventsub, 1);
    await poll(participation, v => JSON.stringify(v).includes('afterreconnect'), 10_000, 'raid after reconnect');
  });

  test('Step 10, Disconnect and recover: fall back cleanly, then resubscribe and resume', fixme(['P0-3', 'P0-4'], 'needs T2 chat reconnect and T3 keepalive-timeout reconnect'), async () => {
    await connect();
    await json(`${app!.base}/api/ingest`, {method: 'POST', body: JSON.stringify({mode: 'twitch', channel: fake.broadcaster.login})});
    fake.acceptingWebsockets = false;
    fake.acceptingIrc = false;
    fake.silence();
    fake.irc.dropAll();
    await poll(twitchStatus, v => v.connected === false || v.eventsub?.connected === false, 30_000, 'the app noticing the outage (keepalive timeout)');
    const s = await state();
    assert.notEqual(s.source?.active, undefined, 'the studio keeps a source and does not crash');
    const typesBefore = new Set(fake.log.filter(e => e.kind === 'eventsub.subscribe').map(e => String(e.detail.type)));
    fake.acceptingWebsockets = true;
    fake.acceptingIrc = true;
    await fake.waitForLog(e => e.kind === 'irc.auth' && e.detail.ok === true && e.at > Date.now() - 60_000, 60_000);
    await poll(async () => fake.connectedSessions.length, n => n === 1, 60_000, 'one fresh EventSub session');
    const session = fake.connectedSessions[0]!;
    await waitUntil(() => [...fake.subscriptions.values()].filter(sub => sub.status === 'enabled' && sub.transport.session_id === session.id).length >= typesBefore.size, 15_000, 'all subscriptions re-created on the new session');
    fake.chat('viewer1', 'we are back');
    await poll(state, v => v.source?.active === 'twitch', 15_000, 'live source again');
  });
});
