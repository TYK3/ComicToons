import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, statSync} from 'node:fs';
import {comicToonsSubscriptions} from '../apps/server/src/eventsub/subscriptions.ts';
import {TWITCH_SCOPES, TWITCH_SCOPES_READONLY} from '../apps/server/src/twitch/config.ts';
import type {EventSubStatus} from '../apps/web/src/ui/data/adapter.ts';
import {budgetCheck, envFileValue, eventSubCheck, formatResult, parsePorts, readOnlyFlag, readOnlyScopesCheck, tokenCheck} from '../scripts/preflight-live.ts';

// PREFLIGHT-1: the parsing and decisions behind scripts/preflight-live.sh, with no server and no network.
const now = 1_900_000_000_000;
const signedIn = {configured: true, connected: true, login: 'tyk_twitch', scopes: [...TWITCH_SCOPES_READONLY], missingScopes: [], expiresAt: now + 3_600_000, requestedScopes: [...TWITCH_SCOPES_READONLY]};

test('PREFLIGHT-PORTS: Young\'s defaults are 3001/4173, the app\'s own env names override them, and junk is refused', () => {
  assert.deepEqual(parsePorts({}), {api: 3001, web: 4173, apiBase: 'http://127.0.0.1:3001', webBase: 'http://127.0.0.1:4173'});
  assert.equal(parsePorts({COMICTOONS_API_PORT: '3120', COMICTOONS_WEB_PORT: '4120'}).webBase, 'http://127.0.0.1:4120');
  assert.equal(parsePorts({PANELCAST_API_PORT: '3120'}).api, 3120, 'the legacy prefix still works, as readProductEnv allows');
  assert.equal(parsePorts({COMICTOONS_API_PORT: ' '}).api, 3001, 'blank means unset');
  for (const bad of ['0', '70000', '31.5', 'abc']) assert.throws(() => parsePorts({COMICTOONS_API_PORT: bad}), /COMICTOONS_API_PORT/);
});

test('PREFLIGHT-READONLY: requestedScopes must be exactly the six read scopes; env and .env are read as the server reads them', () => {
  assert.equal(TWITCH_SCOPES_READONLY.length, 6);
  assert.equal(readOnlyScopesCheck(signedIn).ok, true);
  const wide = readOnlyScopesCheck({...signedIn, requestedScopes: [...TWITCH_SCOPES]});
  assert.equal(wide.ok, false); assert.match(formatResult(wide), /^FAIL readonly-scopes: .*channel:manage:polls/);
  assert.equal(readOnlyScopesCheck({connected: false}, {source: '.env', value: 'yes'}).ok, true);
  assert.equal(readOnlyScopesCheck({connected: false}, {source: '.env', value: '0'}).ok, false);
  assert.equal(readOnlyScopesCheck({connected: false}).ok, false);
  for (const on of ['1', 'true', ' ON ', 'Yes']) assert.equal(readOnlyFlag(on), true);
  for (const off of ['', '0', 'no', undefined]) assert.equal(readOnlyFlag(off), false);
  const env = 'A=1\nCOMICTOONS_OAUTH_SCOPES_READONLY=0\n# note\nexport COMICTOONS_OAUTH_SCOPES_READONLY="1"\nOTHER=secret-value # x\n';
  assert.equal(envFileValue(env, 'COMICTOONS_OAUTH_SCOPES_READONLY'), '1', 'the last assignment wins');
  assert.equal(envFileValue('X=2 # comment', 'X'), '2');
  assert.equal(envFileValue(env, 'MISSING'), undefined);
});

test('PREFLIGHT-TOKEN: signed in, unexpired and holding all six read scopes; never prints anything but the login', () => {
  const ok = tokenCheck(signedIn, now);
  assert.equal(ok.ok, true); assert.match(formatResult(ok), /^PASS twitch-token \(@tyk_twitch signed in, all 6 read scopes, expires in 60 min\)$/);
  assert.match(formatResult(tokenCheck({...signedIn, scopes: ['user:read:chat']}, now)), /^FAIL twitch-token: .*lacks bits:read/);
  assert.match(formatResult(tokenCheck({...signedIn, connected: false, reason: 'Twitch authorization expired. Reconnect Twitch.'}, now)), /^FAIL twitch-token: not signed in.*expired/);
  assert.equal(tokenCheck({...signedIn, expiresAt: now - 1}, now).ok, false);
  assert.equal(tokenCheck({...signedIn, configured: false}, now).ok, false);
});

test('PREFLIGHT-BUDGET: the server\'s budget.perHour must be above 0', () => {
  assert.equal(budgetCheck({budget: {perHour: 12, used: 0}}).ok, true);
  const zero = budgetCheck({budget: {perHour: 0, used: 0}});
  assert.equal(zero.ok, false); assert.match(formatResult(zero), /^FAIL image-budget: the server reads IMAGE_BUDGET_PER_HOUR as 0/);
  assert.equal(budgetCheck({}).ok, false);
  assert.equal(formatResult({check: 'overlay', ok: false, detail: 'timeout\nCall log:\n  - navigating'}), 'FAIL overlay: timeout Call log: - navigating', 'always one line per check');
});

test('PREFLIGHT-EVENTSUB: listed equals expected (15), the unlisted stream.offline is not counted, and "16 of 15" fails', () => {
  const all = comicToonsSubscriptions('796822059').map(entry => entry.type);
  const status: EventSubStatus = {state: 'subscribed', signedIn: true, subscribed: all, failed: [], revoked: [], reconnects: 0, notifications: 0};
  const ok = eventSubCheck(status, 'EventSub, Connected, 15 of 15 subscriptions. Show details.');
  assert.equal(ok.ok, true, ok.detail); assert.match(ok.detail, /listed 15 = expected 15, plus unlisted stream\.offline not counted/);
  assert.match(formatResult(eventSubCheck(status, 'EventSub, Connected, 16 of 15 subscriptions. Show details.')), /^FAIL eventsub-count: the Studio shows "16 of 15 subscriptions"/);
  assert.equal(eventSubCheck({...status, subscribed: all.filter(type => type !== 'channel.raid'), failed: [{type: 'channel.raid', error: 'x'}]}).ok, false);
  assert.equal(eventSubCheck({...status, state: 'idle', signedIn: false, subscribed: []}).ok, false);
});

test('PREFLIGHT-READ-ONLY: the script is executable and sends no write method anywhere', () => {
  // Windows file systems carry no execute bit, so a git checkout is checked by the mode git records (100755).
  const script = new URL('../scripts/preflight-live.sh', import.meta.url);
  const recorded = (() => { try { return execFileSync('git', ['ls-files', '-s', '--', 'scripts/preflight-live.sh'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(' ')[0]; } catch { return ''; } })();
  assert.ok(recorded ? recorded === '100755' : statSync(script).mode & 0o111, 'preflight-live.sh is executable');
  const source = readFileSync(new URL('../scripts/preflight-live.ts', import.meta.url), 'utf8') + readFileSync(new URL('../scripts/preflight-live.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(source, /\/api\/(approve|reject|undo|caption|hide|stop|replay|settings|end|recaps'|twitch\/disconnect)|\/auth\/twitch\/login|oauth2\/(token|revoke)/);
  assert.doesNotMatch(source, /accessToken|refreshToken|access_token/);
});

test('PREFLIGHT-NITS-TOKEN: an expired reason joins the reconnect guidance with one period', () => {
  const result = tokenCheck({...signedIn, connected: false, reason: 'Twitch authorization expired. Reconnect Twitch.'}, now);
  const line = formatResult(result);
  assert.equal(result.ok, false);
  assert.match(line, /^FAIL twitch-token:/);
  assert.ok(line.includes('Reconnect Twitch. Open /ui.html#/connect'));
  assert.ok(!line.includes('..'));
});

test('PREFLIGHT-NITS-EVENTSUB: failed types are distinct from genuinely missing types', () => {
  const all = comicToonsSubscriptions('796822059').map(entry => entry.type);
  const status: EventSubStatus = {state: 'subscribed', signedIn: true, subscribed: all, failed: [{type: 'channel.cheer', error: 'x'}], revoked: [], reconnects: 0, notifications: 0};
  const failed = eventSubCheck(status);
  assert.equal(failed.ok, false);
  assert.match(formatResult(failed), /^FAIL eventsub-count: 15 of 15 listed types subscribed; failed channel\.cheer/);
  assert.doesNotMatch(formatResult(failed), /missing/);
  const missing = eventSubCheck({...status, subscribed: all.filter(type => type !== 'channel.raid'), failed: []});
  assert.equal(missing.ok, false);
  assert.match(formatResult(missing), /missing channel\.raid/);
  const both = eventSubCheck({...status, subscribed: all.filter(type => type !== 'channel.cheer' && type !== 'channel.raid'), failed: [...status.failed, ...status.failed]});
  assert.equal(both.ok, false);
  assert.match(both.detail, /; missing channel\.raid; failed channel\.cheer$/);
});
