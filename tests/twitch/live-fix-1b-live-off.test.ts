// LIVE-FIX-1b: with every participation flag on (app-kit ALL_FLAGS), a lost Twitch sign-in takes the
// server off Live within 5 s of the streamer's Ink me "connect" press. Fake Twitch on 4120, app on 3120.
// The trigger is QA's: Get Users answers 401 twice and the refresh is refused (400), then
// POST /api/participation/rewards/connect. Only /api/state and /api/participation/eventsub are polled,
// never /api/twitch/status, so the status route cannot be what notices the lost sign-in.
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import {ALL_FLAGS, Browser, json, startApp, type RunningApp} from './app-kit.ts';
import {APP_PORT, FAKE_PORT, sleep} from './helpers.ts';

type Source = {active?: string; connection?: string};
type EventSub = {state?: string; signedIn?: boolean; subscribed?: string[]};

let fake: FakeTwitch;
let app: RunningApp | undefined;
before(async () => { fake = await new FakeTwitch({port: FAKE_PORT, redirectUris: [`http://127.0.0.1:${APP_PORT}/auth/twitch/callback`]}).start(); });
after(async () => { await app?.stop(); app = undefined; await fake.stop(); });

test('LIVE-FIX-1b: all flags on, a lost sign-in found by the Ink me connect press leaves Live within 5 s', async t => {
  assert.equal(ALL_FLAGS.length, 8, 'every participation flag is on');
  const issued = fake.appEnv();
  app = await startApp(fake, {COMICTOONS_TWITCH_CLIENT_ID: issued.TWITCH_CLIENT_ID!, COMICTOONS_TWITCH_CLIENT_SECRET: issued.TWITCH_CLIENT_SECRET!, COMICTOONS_TWITCH_REDIRECT_URI: issued.TWITCH_REDIRECT_URI!});
  const base = app.base;
  const source = async () => (await json<{source?: Source}>(`${base}/api/state`)).body.source ?? {};
  const eventsub = async () => (await json<EventSub>(`${base}/api/participation/eventsub`)).body;

  const {response} = await new Browser().follow(`${base}/auth/twitch/login`);
  assert.ok(response.status < 400, `sign-in through the fake finished (${response.status})`);
  await fake.waitForLog(e => e.kind === 'eventsub.subscribe', 10_000);
  await json(`${base}/api/ingest`, {method: 'POST', body: JSON.stringify({mode: 'twitch'})});
  // With Ink me on, sign-in already made the reward, so the press below is the "already ready" case.
  const deadline = Date.now() + 10_000;
  let live = await source();
  while (!(live.active === 'twitch' && live.connection === 'live')) {
    if (Date.now() > deadline) assert.fail(`never went Live before the trigger: ${JSON.stringify(live)}`);
    fake.chat('viewer1', 'the goblin opens the wrong door');
    await sleep(250);
    live = await source();
  }
  assert.equal((await eventsub()).signedIn, true, 'EventSub signed in before the trigger');

  const mark = fake.log.length;
  fake.injectFault({path: '/helix/users', status: 401, times: 2});
  fake.injectFault({path: '/oauth2/token', method: 'POST', status: 400, times: 1});
  const trigger = Date.now();
  const pressed = await json<{status?: string; offReason?: string}>(`${base}/api/participation/rewards/connect`, {method: 'POST'});
  assert.equal(pressed.status, 200);

  let last: {source: Source; eventsub: EventSub} = {source: await source(), eventsub: await eventsub()};
  while (last.source.connection === 'live' || last.eventsub.signedIn !== false) {
    const since = Date.now() - trigger;
    const seen = [...new Set(fake.log.slice(mark).map(e => e.kind))];
    if (since > 5000) assert.fail(`still Live ${(since / 1000).toFixed(1)} s after the trigger: source ${last.source.active}/${last.source.connection}, EventSub ${last.eventsub.state} signedIn ${last.eventsub.signedIn} (${last.eventsub.subscribed?.length ?? 0} subscribed); fake Twitch saw ${JSON.stringify(seen)} since the trigger`);
    await sleep(200);
    last = {source: await source(), eventsub: await eventsub()};
  }
  const took = Date.now() - trigger;
  assert.ok(took <= 5000, 'left Live within 5 s');
  t.diagnostic(`left Live and EventSub signed out ${took} ms after the trigger`);
  assert.equal(last.eventsub.state, 'stopped');
  assert.notEqual(pressed.body.status, 'ready', 'the press does not report Ink me ready on a lost sign-in');
  assert.equal(pressed.body.offReason, 'signed-out');
  assert.ok(fake.log.slice(mark).some(e => e.kind === 'fault' && e.detail.path === '/oauth2/token'), 'the refresh really was refused');
  assert.equal((await json<{connected?: boolean}>(`${base}/api/twitch/status`)).body.connected, false, 'the store reads signed out');
  for (const secret of fake.secretValues()) assert.ok(!app.output().includes(secret), 'no Twitch credential in server output');
});
