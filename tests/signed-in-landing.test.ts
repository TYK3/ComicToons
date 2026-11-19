import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer, type AddressInfo} from 'node:net';
import {landingPage, startLanding} from '../scripts/trial-run/signed-in-landing.ts';
import {REAL_RUN_OPT_IN_ENV, REAL_RUN_OPT_IN_VALUE, runSignedIn} from '../scripts/trial-run/signed-in.ts';

const repoRoot = resolve(import.meta.dirname, '..');
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const {port} = server.address() as AddressInfo;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}
const refused = async (url: string) => { try { await fetch(url); return false; } catch { return true; } };

test('SIGNED-IN-LANDING-PAGE: a connected run says who is connected and that the tab can close; the login is HTML-escaped', () => {
  assert.match(landingPage({connected: true, channel: 'somechannel'}), /<p>Connected as somechannel, you can close this tab\.<\/p>/);
  const hostile = landingPage({connected: true, channel: '<img src=x onerror=1>'});
  assert.doesNotMatch(hostile, /<img/);
  assert.match(hostile, /Connected as &lt;img src=x onerror=1&gt;, you can close this tab\./);
  assert.match(landingPage({connected: false}), /Not connected yet/);
  assert.match(landingPage(undefined), /Not connected yet/);
});

test('SIGNED-IN-LANDING-SERVE: the landing server answers the callback\'s ui.html path on localhost with the live status, and rejects writes', async () => {
  const port = await freePort();
  let connected = false;
  const landing = await startLanding(port, async () => ({connected, channel: 'somechannel'}));
  try {
    const before = await fetch(`http://localhost:${port}/ui.html`);
    assert.equal(before.status, 200);
    assert.match(before.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await before.text(), /Not connected yet/);
    connected = true;
    assert.match(await (await fetch(`http://127.0.0.1:${port}/ui.html`)).text(), /Connected as somechannel, you can close this tab\./);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ui.html`, {method: 'POST'})).status, 405);
    assert.equal(landing.hits, 2);
  } finally { await landing.stop(); }
  assert.equal(await refused(`http://127.0.0.1:${port}/ui.html`), true, 'the landing server must close when stopped');
});

test('SIGNED-IN-LANDING-REAL-RUN: a real run serves the landing page on its web port and keeps it up until the browser lands, then closes it', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'signed-in-landing-'));
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  let landed: string | undefined;
  const stubFetch = async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/twitch/status') return Response.json({connected: true, channel: 'somechannel', requestedScopes: []});
    if (path === '/api/participation/eventsub') return Response.json({state: 'subscribed', subscribed: [], failed: [], notifications: 0});
    throw new Error(`unexpected request ${url}`);
  };
  // Stands in for Young's browser following the callback redirect a little after the run sees the sign-in.
  const browser = (async () => {
    for (let attempt = 0; attempt < 40 && landed === undefined; attempt += 1) {
      await new Promise(done => setTimeout(done, 100));
      try { landed = await (await fetch(`http://localhost:${webPort}/ui.html`)).text(); } catch { /* not up yet */ }
    }
  })();
  try {
    const {report} = await runSignedIn(
      {fake: false, apiPort, webPort, outDir, repoRoot, timeoutMs: 5_000},
      {env: {[REAL_RUN_OPT_IN_ENV]: REAL_RUN_OPT_IN_VALUE}, fetch: stubFetch, log: () => undefined,
        startServer: async () => ({pid: 1, logPath: join(outDir, 'none.log'), exited: () => undefined, stop: async () => ({code: 0, signal: null})})});
    await browser;
    assert.match(landed ?? '', /Connected as somechannel, you can close this tab\./, 'the browser must land on the plain page, not "This site can\'t be reached"');
    assert.equal(report.landing.hits, 1);
    assert.equal(report.landing.url, `http://localhost:${webPort}/ui.html#/connect?twitch=connected`);
    assert.deepEqual(report.errors, []);
    assert.equal(await refused(`http://127.0.0.1:${webPort}/ui.html`), true, 'the run must close its landing server when it ends');
  } finally { rmSync(outDir, {recursive: true, force: true}); }
});
