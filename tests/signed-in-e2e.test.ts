import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer, type AddressInfo} from 'node:net';
import {FakeTwitch} from '../scripts/twitch-mock/fake-twitch.ts';
import {TWITCH_SCOPES_READONLY} from '../apps/server/src/twitch/config.ts';
import {READ_ONLY_EVENTSUB_TYPES} from '../scripts/trial-run/signed-in-allowlist.ts';
import {runSignedIn} from '../scripts/trial-run/signed-in.ts';

const repoRoot = resolve(import.meta.dirname, '..');

/** A free loopback port, so this test never collides with a gate or app running on a fixed pair. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const {port} = server.address() as AddressInfo;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

// A real dry run: a real ComicToons server (its own process) signs in through a real FakeTwitch
// (its own loopback HTTP/WS server), subscribes over a real EventSub WebSocket, and reports what
// arrived. No real Twitch host is ever contacted; the server gets a free loopback port.
test('signed-in --fake: completes sign-in via the fake, subscribes read-only types, and reports counts by type with no writes', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'signed-in-e2e-'));
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  let capturedFake: FakeTwitch | undefined;
  try {
    const { report, files } = await runSignedIn(
      { fake: true, apiPort, webPort, outDir, repoRoot, timeoutMs: 20_000 },
      {
        env: {},
        createFake: async apiPort => {
          const fake = new FakeTwitch({ port: 0, redirectUris: [`http://127.0.0.1:${apiPort}/auth/twitch/callback`] });
          await fake.start();
          capturedFake = fake;
          return {
            appEnv: () => fake.appEnv(),
            log: fake.log,
            secretValues: () => fake.secretValues(),
            scenario: () => { fake.chat('viewer1', 'hello from the e2e test'); fake.raid('raider1', 12); fake.hypeTrain(1, 500); },
            stop: () => fake.stop(),
          };
        },
      },
    );

    assert.equal(report.connected, true, JSON.stringify(report.errors));
    assert.equal(report.eventSub.state, 'subscribed');
    assert.equal(report.run.timedOut, false);
    assert.deepEqual(report.eventSub.failed, []);
    for (const type of ['channel.chat.message', 'channel.raid', 'channel.hype_train.begin']) {
      assert.ok(report.eventSub.subscribedTypes.includes(type), `expected ${type} to be subscribed`);
    }
    for (const type of report.eventSub.subscribedTypes) {
      assert.ok((READ_ONLY_EVENTSUB_TYPES as readonly string[]).includes(type), `${type} must be one of the read-only types`);
    }
    assert.equal(report.eventSub.subscribedTypes.length, 16, 'all 16 read-only EventSub types must subscribe on the narrowed read-only token');
    assert.deepEqual(report.requestedScopes, [...TWITCH_SCOPES_READONLY], 'a --signed-in run always narrows to the six read-only scopes');
    const authorizeEntry = capturedFake?.log.find(entry => entry.kind === 'oauth.authorize');
    assert.ok(authorizeEntry, 'the fake must have logged the authorize request');
    assert.equal(authorizeEntry!.detail.scopes, TWITCH_SCOPES_READONLY.join(' '), 'the token the fake minted must hold only the six read-only scopes');
    assert.ok('value' in report.eventCountsByType && report.eventCountsByType.value);
    const counts = (report.eventCountsByType as { value: Record<string, number> }).value;
    assert.ok((counts['channel.chat.message'] ?? 0) >= 1);
    assert.ok((counts['channel.raid'] ?? 0) >= 1);
    assert.ok((counts['channel.hype_train.begin'] ?? 0) >= 1);
    assert.equal(report.writeAttemptsBlocked, 0);
    // The callback's redirect lands on the run's own plain page on the web port, not on an unserved web UI.
    assert.equal(report.landing.url, `http://localhost:${webPort}/ui.html#/connect?twitch=connected`);
    assert.equal(report.landing.status, 200);
    assert.equal(report.landing.connected, true, 'the landing page must say the run is connected');
    assert.ok(report.landing.hits >= 1);
    assert.ok('value' in report.eventSub.totalNotifications && report.eventSub.totalNotifications.value >= 3, 'the app\'s own notification count must include the events that just arrived');

    assert.ok(capturedFake, 'the fake must have started');
    const writeKinds = capturedFake!.log.filter(entry => entry.kind === 'helix' && ['POST', 'PATCH', 'DELETE'].includes(String(entry.detail.method)) && entry.detail.path !== '/eventsub/subscriptions');
    assert.deepEqual(writeKinds, [], 'the fake must never see a write-shaped Helix call');
    assert.equal(capturedFake!.sentChat.length, 0, 'the fake must never receive a sent chat message');
    assert.equal(capturedFake!.rewards.size, 0);
    assert.equal(capturedFake!.polls.length, 0);
    assert.equal(capturedFake!.predictions.length, 0);

    const dump = `${JSON.stringify(report)} ${readFileSync(files[0]!, 'utf8')} ${readFileSync(files[1]!, 'utf8')}`;
    for (const secret of capturedFake!.secretValues()) assert.equal(dump.includes(secret), false, 'a credential leaked into the report');
    assert.doesNotMatch(dump, /hello from the e2e test/, 'chat text must never appear in the report');
    assert.doesNotMatch(dump, /viewer1|raider1/, 'viewer names must never appear in the report');
  } finally {
    // runSignedIn already stops the fake and the server process in its own finally block.
    rmSync(outDir, { recursive: true, force: true });
  }
});
