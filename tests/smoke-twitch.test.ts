import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { FetchLike } from '../apps/server/src/twitch-api/index.ts';
import { comicToonsSubscriptions } from '../apps/server/src/eventsub/subscriptions.ts';
import { runSmoke } from '../scripts/smoke-twitch.ts';
import { guardFetch } from '../scripts/smoke-twitch-helix.ts';

// Hermetic: every test drives runSmoke with a scripted fake fetch. No network, no real tokens.
type Call = { method: string; url: URL; headers: Record<string, string>; body?: string };
interface Scripted { status: number; body: string | Record<string, unknown> }

function fakeFetch(script: Scripted[]) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ method: init?.method ?? 'GET', url: new URL(String(input)), headers, body: init?.body });
    const next = script.shift();
    if (!next) throw new Error('fake fetch: no scripted response left');
    const bodyText = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    const contentType = typeof next.body === 'string' ? 'text/html' : 'application/json';
    return new Response(bodyText, { status: next.status, headers: { 'content-type': contentType } });
  };
  return { calls, fetchImpl };
}

// Mirrors the real page's row shape, e.g. "Channel Raid | channel.raid | 1 | A broadcaster raids...":
// a friendly name, the type in a <code> cell, a bare version number (no leading "v"), a description.
function friendlyName(type: string): string {
  return type.split('.').flatMap(part => part.split('_')).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function buildDocHtml(subscriptions: { type: string; version: string }[]): string {
  const rows = subscriptions.map(sub =>
    `<tr><td>${friendlyName(sub.type)}</td><td><code>${sub.type}</code></td><td>${sub.version}</td><td>Example event for ${sub.type}.</td></tr>`).join('');
  return `<html><body><table><thead><tr><th>Name</th><th>Type</th><th>Version</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

const SECRET_TOKEN = 'app-token-ABC123';
const SECRET_CLIENT_ID = 'client-id-XYZ789';
const SECRET_USER_ID = 'user-id-998877';
const SECRET_LOGIN = 'summit1g';
const SECRET_CLIP_URL = 'https://clips.twitch.tv/SecretClipSlug';

function buildSuccessScript(docHtml: string): Scripted[] {
  return [
    { status: 200, body: { access_token: SECRET_TOKEN, expires_in: 5000, token_type: 'bearer' } },
    { status: 200, body: { client_id: SECRET_CLIENT_ID, login: '', scopes: [], user_id: '', expires_in: 5000 } },
    { status: 200, body: { data: [{ id: SECRET_USER_ID, login: SECRET_LOGIN, display_name: 'Summit1g', broadcaster_type: 'partner' }] } },
    { status: 200, body: { data: [] } },
    { status: 200, body: { data: [{ id: 'clip1', url: SECRET_CLIP_URL, title: 'My Amazing Clip' }] } },
    { status: 200, body: docHtml },
  ];
}

let logCounter = 0;
function tempLogPath(): string {
  logCounter += 1;
  return `artifacts/tmp/smoke-twitch-test-${process.pid}-${logCounter}.log`;
}

test('smoke-twitch skips cleanly with no Twitch env and makes no request', async () => {
  const { calls, fetchImpl } = fakeFetch([]);
  const logPath = tempLogPath();
  const result = await runSmoke({ env: {}, fetch: fetchImpl, logPath });
  assert.equal(result.exitCode, 0);
  assert.equal(result.log, 'SKIP: TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set');
  assert.equal(calls.length, 0);
  assert.equal(await readFile(logPath, 'utf8'), result.log);
});

test('smoke-twitch runs token, validate, users, streams, clips and the EventSub doc check with GET only', async () => {
  const subscriptions = comicToonsSubscriptions('0');
  const { calls, fetchImpl } = fakeFetch(buildSuccessScript(buildDocHtml(subscriptions)));
  const logPath = tempLogPath();
  const result = await runSmoke({ env: { TWITCH_CLIENT_ID: SECRET_CLIENT_ID, TWITCH_CLIENT_SECRET: 'client-secret-SECRETVALUE' }, fetch: fetchImpl, logPath, now: () => 1_700_000_000_000 });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 6);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`, 'https://id.twitch.tv/oauth2/token');
  for (const call of calls.slice(1)) assert.equal(call.method, 'GET');
  assert.equal(`${calls[1]!.url.origin}${calls[1]!.url.pathname}`, 'https://id.twitch.tv/oauth2/validate');
  assert.equal(`${calls[2]!.url.origin}${calls[2]!.url.pathname}`, 'https://api.twitch.tv/helix/users');
  assert.equal(`${calls[3]!.url.origin}${calls[3]!.url.pathname}`, 'https://api.twitch.tv/helix/streams');
  assert.equal(`${calls[4]!.url.origin}${calls[4]!.url.pathname}`, 'https://api.twitch.tv/helix/clips');
  assert.equal(calls[5]!.url.href.startsWith('https://dev.twitch.tv/docs/eventsub/'), true);

  assert.match(result.log, /Step 1 token: status=200/);
  assert.match(result.log, /Step 2 validate: status=200/);
  assert.match(result.log, /Step 3 users: status=200 .*count=1/);
  assert.match(result.log, /Step 4a streams: status=200 .*count=0/);
  assert.match(result.log, /Step 4b clips: status=200 .*count=1/);
  assert.match(result.log, /Step 5 doc: status=200/);
  for (const sub of subscriptions) assert.match(result.log, new RegExp(`${sub.type.replace(/\./g, '\\.')} v${sub.version}: listed`));
  assert.match(result.log, /RESULT: PASS/);
});

test('smoke-twitch log holds only status codes, field names and counts: no token, client id, secret, id or login', async () => {
  const subscriptions = comicToonsSubscriptions('0');
  const clientSecret = 'client-secret-SECRETVALUE';
  const { fetchImpl } = fakeFetch(buildSuccessScript(buildDocHtml(subscriptions)));
  const logPath = tempLogPath();
  const result = await runSmoke({ env: { TWITCH_CLIENT_ID: SECRET_CLIENT_ID, TWITCH_CLIENT_SECRET: clientSecret }, fetch: fetchImpl, logPath });

  for (const secret of [SECRET_TOKEN, SECRET_CLIENT_ID, clientSecret, SECRET_USER_ID, SECRET_LOGIN, SECRET_CLIP_URL, 'My Amazing Clip']) {
    assert.equal(result.log.includes(secret), false, `log must not contain: ${secret}`);
  }
  const written = await readFile(logPath, 'utf8');
  for (const secret of [SECRET_TOKEN, SECRET_CLIENT_ID, clientSecret, SECRET_USER_ID, SECRET_LOGIN, SECRET_CLIP_URL]) {
    assert.equal(written.includes(secret), false, `written log must not contain: ${secret}`);
  }
});

test('smoke-twitch refuses any Helix write: a non-GET request throws before fetch', async () => {
  let fetchCalls = 0;
  const inner: FetchLike = async () => { fetchCalls += 1; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const guarded = guardFetch(inner);

  await assert.rejects(guarded('https://api.twitch.tv/helix/polls', { method: 'POST', body: '{}' }));
  assert.equal(fetchCalls, 0, 'the blocked call must never reach the underlying fetch');

  await assert.rejects(guarded('https://api.twitch.tv/helix/channel_points/custom_rewards', { method: 'DELETE' }));
  assert.equal(fetchCalls, 0);

  await guarded('https://api.twitch.tv/helix/users');
  assert.equal(fetchCalls, 1, 'a plain GET still goes through');

  await guarded('https://id.twitch.tv/oauth2/token', { method: 'POST', body: 'grant_type=client_credentials' });
  assert.equal(fetchCalls, 2, 'the one allowed write, the token POST, still goes through');
});

test('smoke-twitch doc check needs the exact type and version: a prefix or a wrong version is NOT LISTED', async () => {
  const subscriptions = comicToonsSubscriptions('0');
  const raid = subscriptions.find(sub => sub.type === 'channel.raid');
  const chatMessage = subscriptions.find(sub => sub.type === 'channel.chat.message');
  assert.ok(raid && chatMessage, 'fixture expects channel.raid and channel.chat.message in the subscription list');

  const docSubs = subscriptions
    // the doc page only lists the longer channel.chat.message_delete type, never the bare one
    .filter(sub => sub !== chatMessage)
    // the doc page lists channel.raid under the wrong version
    .map(sub => (sub === raid ? { ...sub, version: '99' } : sub));
  const { fetchImpl } = fakeFetch(buildSuccessScript(buildDocHtml(docSubs)));
  const logPath = tempLogPath();
  const result = await runSmoke({ env: { TWITCH_CLIENT_ID: SECRET_CLIENT_ID, TWITCH_CLIENT_SECRET: 'client-secret-SECRETVALUE' }, fetch: fetchImpl, logPath });

  assert.equal(result.exitCode, 1);
  assert.match(result.log, /channel\.chat\.message v1: NOT LISTED/);
  assert.match(result.log, /channel\.chat\.message_delete v1: listed/);
  assert.match(result.log, /channel\.raid v1: NOT LISTED/);
  assert.match(result.log, /RESULT: FAIL/);
});

test('smoke-twitch logs the real HTTP status of the users request instead of a hard-coded 200', async () => {
  const subscriptions = comicToonsSubscriptions('0');
  const script = buildSuccessScript(buildDocHtml(subscriptions));
  script[2] = { ...script[2]!, status: 201 }; // GET /users answers 201 this time, not 200
  const { fetchImpl } = fakeFetch(script);
  const logPath = tempLogPath();
  const result = await runSmoke({ env: { TWITCH_CLIENT_ID: SECRET_CLIENT_ID, TWITCH_CLIENT_SECRET: 'client-secret-SECRETVALUE' }, fetch: fetchImpl, logPath });

  assert.match(result.log, /Step 3 users: status=201/);
});

test('smoke-twitch flags an EventSub type or version the docs do not list and exits 1', async () => {
  const subscriptions = comicToonsSubscriptions('0');
  const tampered = subscriptions.map((sub, index) => (index === 0 ? { ...sub, version: '99' } : sub));
  const { fetchImpl } = fakeFetch(buildSuccessScript(buildDocHtml(tampered)));
  const logPath = tempLogPath();
  const result = await runSmoke({ env: { TWITCH_CLIENT_ID: SECRET_CLIENT_ID, TWITCH_CLIENT_SECRET: 'client-secret-SECRETVALUE' }, fetch: fetchImpl, logPath });

  assert.equal(result.exitCode, 1);
  const first = subscriptions[0]!;
  assert.match(result.log, new RegExp(`${first.type.replace(/\./g, '\\.')} v${first.version}: NOT LISTED`));
  assert.match(result.log, /RESULT: FAIL/);
});
