// HARNESS-PORT-1: a test run must never reach the developer's live app on 3001 (API) or 4173 (web)
// while the port env names other ports. Two checks:
// (1) the outbound guard is installed in this test process and refuses 3001/4173 before any socket connects;
// (2) the sign-in callback of a harness app sends the browser to the harness web port, read from the
//     Location header only (the web UI hop is never fetched here).
import assert from 'node:assert/strict';
import net from 'node:net';
import {after, before, test} from 'node:test';
import {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import {Browser, startApp, type RunningApp} from './app-kit.ts';
import {APP_PORT, FAKE_PORT, testPort} from './helpers.ts';

const LIVE = [3001, 4173];
const webPort = testPort('COMICTOONS_TWITCH_TEST_WEB_PORT', FAKE_PORT);
const named = new Set([APP_PORT, FAKE_PORT, webPort]);
const guarded = LIVE.filter(port => !named.has(port));

let fake: FakeTwitch;
let app: RunningApp | undefined;
before(async () => { fake = await new FakeTwitch({port: FAKE_PORT, redirectUris: [`http://127.0.0.1:${APP_PORT}/auth/twitch/callback`]}).start(); });
after(async () => { await app?.stop(); app = undefined; await fake.stop(); });

test('HARNESS-PORT-1: the test process refuses 3001/4173 before connecting when the port env names other ports', {skip: guarded.length ? undefined : 'the port env names both live ports'}, () => {
  const guard = (globalThis as Record<symbol, unknown>)[Symbol.for('comictoons.twitchTestPortGuard')] as {hits: string[]; quiet: boolean} | undefined;
  // Without the guard, nothing below may run: it would dial the live app.
  if (!guard) assert.fail('live-port guard is not installed in the test process (run-tests.mjs --import tests/twitch/port-guard.mjs)');
  const before = guard.hits.length;
  guard.quiet = true; // deliberate refusals: no stderr noise
  try {
    for (const port of guarded) {
      assert.throws(() => fetch(`http://localhost:${port}/ui.html`), /live-port guard/, `fetch to ${port} is refused`);
      assert.throws(() => net.connect(port, '127.0.0.1'), /live-port guard/, `connect to ${port} is refused`);
      assert.throws(() => net.connect({port, host: '::1'}), /live-port guard/, `connect to [::1]:${port} is refused`);
    }
  } finally { guard.quiet = false; }
  assert.equal(guard.hits.length - before, guarded.length * 3, 'every refusal is recorded');
  guard.hits.splice(before); // these were deliberate; the exit check must only see real ones
});

test('HARNESS-PORT-1: the sign-in callback sends the browser to the harness web port, not 4173', async () => {
  const issued = fake.appEnv();
  app = await startApp(fake, {COMICTOONS_TWITCH_CLIENT_ID: issued.TWITCH_CLIENT_ID!, COMICTOONS_TWITCH_CLIENT_SECRET: issued.TWITCH_CLIENT_SECRET!, COMICTOONS_TWITCH_REDIRECT_URI: issued.TWITCH_REDIRECT_URI!});
  const browser = new Browser();
  const login = await browser.get(`${app.base}/auth/twitch/login`);
  assert.equal(login.status, 302, 'login redirects to the fake authorise page');
  const authorise = await browser.get(new URL(login.headers.get('location')!, app.base).toString());
  assert.equal(authorise.status, 302, 'the fake approves and redirects to the callback');
  const callbackUrl = new URL(authorise.headers.get('location')!, fake.urls.base);
  assert.equal(callbackUrl.port, String(APP_PORT), 'callback is on the harness app port');
  const callback = await browser.get(callbackUrl.toString());
  assert.equal(callback.status, 302, 'callback redirects to the web UI');
  const landing = new URL(callback.headers.get('location')!);
  assert.ok(!guarded.includes(Number(landing.port || 80)), `callback must not send the browser to a live port (${landing.host})`);
  assert.equal(landing.host, `localhost:${webPort}`, 'callback lands on the harness web port');
  assert.equal(landing.pathname, '/ui.html');
});
