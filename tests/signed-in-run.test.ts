import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {installSignedInGuard} from '../scripts/trial-run/signed-in-guard.ts';
import {SignedInAllowlistViolation} from '../scripts/trial-run/signed-in-allowlist.ts';
import {
  REAL_RUN_OPT_IN_ENV, REAL_RUN_OPT_IN_VALUE, assertRealRunApproved, parseSignedInArgs, runSignedIn, wantsSignedIn,
} from '../scripts/trial-run/signed-in.ts';

const repoRoot = resolve(import.meta.dirname, '..');

test('wantsSignedIn only recognizes --signed-in; every existing trial-run invocation is unaffected', () => {
  assert.equal(wantsSignedIn(['--channel', 'inkstreamer', '--minutes', '5']), false);
  assert.equal(wantsSignedIn(['--source', 'sample', '--minutes', '1']), false);
  assert.equal(wantsSignedIn([]), false);
  assert.equal(wantsSignedIn(['--signed-in']), true);
  assert.equal(wantsSignedIn(['--signed-in', '--fake']), true);
  assert.equal(wantsSignedIn(['--help']), false);
});

test('a real sign-in refuses to start without the exact opt-in value, before anything else runs', () => {
  assert.throws(() => assertRealRunApproved({}, false), /Young/);
  assert.throws(() => assertRealRunApproved({[REAL_RUN_OPT_IN_ENV]: 'yes'}, false), /Young/, 'close but not the exact value must still refuse');
  assert.throws(() => assertRealRunApproved({[REAL_RUN_OPT_IN_ENV]: '1'}, false), /Young/);
  assert.doesNotThrow(() => assertRealRunApproved({[REAL_RUN_OPT_IN_ENV]: REAL_RUN_OPT_IN_VALUE}, false));
  assert.doesNotThrow(() => assertRealRunApproved({}, true), '--fake never needs the opt-in');
});

test('runSignedIn refuses a real run before starting any server when the opt-in is missing', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'signed-in-test-'));
  let started = 0;
  try {
    await assert.rejects(
      runSignedIn({fake: false, apiPort: 3118, webPort: 4118, outDir, repoRoot, timeoutMs: 1000},
        {env: {}, startServer: async () => { started += 1; throw new Error('must not be called'); }}),
      /Young/,
    );
    assert.equal(started, 0, 'no server process may start before the opt-in is checked');
  } finally { rmSync(outDir, {recursive: true, force: true}); }
});

test('parseSignedInArgs: --fake is a dry run against the mock, --help short-circuits, unknown flags reject', () => {
  const options = parseSignedInArgs(['--fake'], {repoRoot, now: 0});
  assert.ok(!('help' in options));
  if ('help' in options) return;
  assert.equal(options.fake, true);
  assert.equal(options.apiPort, 3118);
  assert.equal(options.webPort, 4118);
  assert.deepEqual(parseSignedInArgs(['--help'], {repoRoot, now: 0}), {help: true});
  assert.throws(() => parseSignedInArgs(['--channel', 'x'], {repoRoot, now: 0}), /unknown|channel/i);
});

test('the guard wraps fetch exactly once and blocks a write before it reaches the network', async () => {
  const target = {fetch: (async () => { throw new Error('the real fetch must never run for a blocked request'); }) as typeof fetch};
  installSignedInGuard(target);
  const first = target.fetch;
  installSignedInGuard(target);
  assert.equal(target.fetch, first, 'installing twice must not double-wrap');
  await assert.rejects(target.fetch('https://api.twitch.tv/helix/chat/messages', {method: 'POST', body: '{"message":"hi"}'}), SignedInAllowlistViolation);
});

test('parseSignedInArgs: a real run defaults to the registered callback port 3001 and a 180 s wait', () => {
  const options = parseSignedInArgs([], {repoRoot, now: 0});
  assert.ok(!('help' in options));
  if ('help' in options) return;
  assert.equal(options.fake, false);
  assert.equal(options.apiPort, 3001, 'the real redirect URI is http://localhost:3001/auth/twitch/callback');
  assert.equal(options.timeoutMs, 180_000, 'a person needs time to click Authorize');
  const custom = parseSignedInArgs(['--fake', '--api-port', '3200', '--timeout', '5'], {repoRoot, now: 0});
  if ('help' in custom) return;
  assert.equal(custom.apiPort, 3200);
  assert.equal(custom.timeoutMs, 5000);
});
