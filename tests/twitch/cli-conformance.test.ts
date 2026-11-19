// Optional conformance check against the official Twitch CLI
// (https://dev.twitch.tv/docs/cli/websocket-event-command/). When the CLI is
// installed (TWITCH_CLI_BIN or `twitch` on PATH) this starts its mock EventSub
// WebSocket server on 127.0.0.1:3120, triggers events with
// `twitch event trigger <type> --transport=websocket`, and checks that the fake on
// 4120 sends frames with the same keys. Without the CLI the test is skipped.
// Nothing here talks to Twitch; the CLI's update check is disabled.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import {findTwitchCli, reconnectCli, startCliWebsocket, triggerCli} from '../../scripts/twitch-mock/twitch-cli.ts';
import {APP_PORT, EventSubTestClient, FAKE_PORT, helix, waitUntil, type EventSubFrame} from './helpers.ts';

const cli = findTwitchCli();
const keys = (value: unknown) => Object.keys((value ?? {}) as object).sort();
/** Keys the CLI sends that the fake lacks. The fake may carry extra documented keys. */
const missing = (cliValue: unknown, fakeValue: unknown) => keys(cliValue).filter(k => !keys(fakeValue).includes(k));

// Types both sides can produce. Hype train is left out: the CLI defaults to v1, ComicToons wants v2.
const TYPES = ['channel.raid', 'channel.channel_points_custom_reward_redemption.add', 'channel.poll.begin', 'channel.poll.progress',
  'channel.poll.end', 'channel.prediction.begin', 'channel.prediction.progress', 'channel.prediction.lock', 'channel.prediction.end'];

test('fake EventSub frames carry every key the official Twitch CLI sends', {skip: cli ? undefined : 'Twitch CLI not installed (set TWITCH_CLI_BIN to run this check)'}, async () => {
  const server = await startCliWebsocket(cli!, APP_PORT);
  const fake = await new FakeTwitch({port: FAKE_PORT}).start();
  try {
    // 1. The CLI side.
    const cliClient = new EventSubTestClient(server.url);
    await cliClient.welcome();
    for (const type of TYPES) {
      const run = triggerCli(cli!, type);
      assert.ok(run.ok, `twitch event trigger ${type} failed`);
    }
    await waitUntil(() => cliClient.notifications().length >= TYPES.length, 15_000, 'CLI notifications');
    assert.ok(reconnectCli(cli!).ok, 'twitch event websocket reconnect failed');
    const cliReconnect = await cliClient.next('session_reconnect', 10_000);

    // 2. The fake side, driven through Helix like the app will be.
    const token = fake.issueUserToken(['channel:manage:redemptions', 'channel:manage:polls', 'channel:manage:predictions']).access_token;
    const auth = {clientId: fake.clientId, token};
    const fakeClient = new EventSubTestClient(fake.urls.eventSubWs);
    const session = await fakeClient.welcome();
    for (const type of TYPES) {
      const condition = type === 'channel.raid' ? {to_broadcaster_user_id: fake.broadcaster.id} : {broadcaster_user_id: fake.broadcaster.id};
      assert.equal((await helix(fake.urls.helixBase, 'POST', '/eventsub/subscriptions', auth, {type, version: '1', condition, transport: {method: 'websocket', session_id: session.id}})).status, 202);
    }
    fake.raid('raidfriend', 5);
    await helix(fake.urls.helixBase, 'POST', `/channel_points/custom_rewards?broadcaster_id=${fake.broadcaster.id}`, auth, {title: 'Ink me', cost: 500});
    fake.redeem('Ink me', 'viewer1', 'me as a robot');
    await helix(fake.urls.helixBase, 'POST', '/polls', auth, {broadcaster_id: fake.broadcaster.id, title: 'Next?', choices: [{title: 'A'}, {title: 'B'}], duration: 60});
    fake.votePoll([1, 2]); fake.finishPoll();
    await helix(fake.urls.helixBase, 'POST', '/predictions', auth, {broadcaster_id: fake.broadcaster.id, title: 'Win?', outcomes: [{title: 'Yes'}, {title: 'No'}], prediction_window: 60});
    fake.predict(0, 1, 100); fake.lockPrediction(); fake.endPrediction();
    await waitUntil(() => fakeClient.notifications().length >= TYPES.length, 5000, 'fake notifications');
    fake.sendReconnect();
    const fakeReconnect = await fakeClient.next('session_reconnect');

    // 3. Compare shapes.
    const problems: string[] = [];
    const check = (label: string, cliValue: unknown, fakeValue: unknown) => { const gap = missing(cliValue, fakeValue); if (gap.length) problems.push(`${label}: fake lacks ${gap.join(', ')}`); };
    check('welcome.session', cliClient.frames[0]!.payload.session, fakeClient.frames[0]!.payload.session);
    check('reconnect.session', cliReconnect.payload.session, fakeReconnect.payload.session);
    for (const type of TYPES) {
      const c = cliClient.notifications(type)[0] as EventSubFrame & {payload: {subscription: unknown; event: Record<string, unknown>}};
      const f = fakeClient.notifications(type)[0] as EventSubFrame & {payload: {subscription: unknown; event: Record<string, unknown>}};
      assert.ok(c && f, `both sides sent ${type}`);
      check(`${type} metadata`, c.metadata, f.metadata);
      check(`${type} subscription`, c.payload.subscription, f.payload.subscription);
      check(`${type} event`, c.payload.event, f.payload.event);
      for (const nested of ['reward', 'outcomes', 'choices'] as const) {
        const cv = c.payload.event[nested], fv = f.payload.event[nested];
        if (cv !== undefined) check(`${type} event.${nested}`, Array.isArray(cv) ? cv[0] : cv, Array.isArray(fv) ? fv[0] : fv);
      }
    }
    assert.deepEqual(problems, []);
    await fakeClient.close();
    await cliClient.close();
  } finally {
    await fake.stop();
    await server.stop();
  }
});
