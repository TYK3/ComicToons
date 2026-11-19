import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {DIRECTOR_KEY_ENV, DIRECTOR_KEY_HEADER, directorAccess, readDirectorKey} from '../apps/server/src/director-access.ts';

const request = (remoteAddress: string, headers: Record<string, string | string[]> = {}) =>
  ({headers, socket: {remoteAddress}}) as Parameters<typeof directorAccess>[0];
const key = 'test-only-director-key-abcdefghij';

test('director access requires a loopback socket and only loopback forwarded hops without a key', () => {
  for (const address of ['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1']) {
    assert.equal(directorAccess(request(address), '  ').ok, true);
    assert.equal(directorAccess(request(address, {'x-forwarded-for': '127.0.0.1, ::1, ::ffff:127.2.3.4'}), undefined).ok, true);
    assert.equal(directorAccess(request(address, {'x-forwarded-for': ['127.0.0.1', '192.168.1.20']}), undefined).ok, false);
  }
  for (const address of ['192.168.1.20', '10.0.0.5', '127.0.0.999', '']) {
    const access = directorAccess(request(address, {'x-forwarded-for': '127.0.0.1'}), undefined);
    assert.equal(access.ok, false);
    if (!access.ok) {
      assert.equal(access.status, 403);
      assert.match(access.error, /COMICTOONS_DIRECTOR_KEY/);
      assert.match(access.error, /ComicToons/);
    }
  }
});

test('a configured director key is mandatory for local and remote callers and never echoed', () => {
  for (const address of ['127.0.0.1', '192.168.1.20']) {
    for (const sent of [undefined, '', 'wrong', key.slice(0, -1), `${key} `]) {
      const access = directorAccess(request(address, sent === undefined ? {} : {[DIRECTOR_KEY_HEADER]: sent}), key);
      assert.equal(access.ok, false);
      if (!access.ok) assert.equal(access.status, 401);
      assert.equal(JSON.stringify(access).includes(key), false);
    }
    assert.equal(directorAccess(request(address, {[DIRECTOR_KEY_HEADER]: key}), ` ${key} `).ok, true);
  }
});

test('director settings accept the legacy prefix for one release and prefer the current name', () => {
  const legacyName = DIRECTOR_KEY_ENV.replace('COMICTOONS_', 'PANELCAST_');
  const env = {[legacyName]: ` ${key} `};
  assert.equal(readDirectorKey(env), key);
  env[DIRECTOR_KEY_ENV] = 'new-test-only-key';
  assert.equal(readDirectorKey(env), 'new-test-only-key');
  env[DIRECTOR_KEY_ENV] = '  ';
  assert.equal(readDirectorKey(env), undefined);
});


const writes = [
  '/api/ingest', '/api/replay', '/api/settings', '/api/approve', '/api/reject',
  '/api/undo', '/api/caption', '/api/stop', '/api/recaps', '/api/end',
  '/api/catchup', '/api/comics/missing-issue/title', '/api/twitch/disconnect',
  '/api/participation/polls', '/api/participation/polls/end', '/api/participation/rewards/connect',
  '/api/participation/redemptions/test-id', '/api/participation/catchup',
  '/api/participation/director/approve', '/api/participation/director/reject',
  '/api/participation/mock-event', '/api/participation/mock-connect',
];
for (const url of writes) test(`studio guard authenticates before parsing and preserves state on denial: ${url}`, async () => {
  const directory = await mkdtemp(resolve('artifacts/tmp/director-guard-'));
  const local = createApp({env: {COMICTOONS_PARTICIPATION_MOCK: '1'}, recapDirectory: directory});
  const keyed = createApp({env: {[DIRECTOR_KEY_ENV]: ` ${key} `, COMICTOONS_PARTICIPATION_MOCK: '1'}, recapDirectory: directory});
  try {
    // Invalid JSON ensures an authorized probe never executes a write or starts an export.
    const probe = {method: 'POST' as const, url, payload: '{', headers: {'content-type': 'application/json'}};
    for (const [app, attempts] of [
      [local, [
        {remoteAddress: '192.168.1.20', headers: {}, status: 403},
        {remoteAddress: '127.0.0.1', headers: {'x-forwarded-for': '192.168.1.20'}, status: 403},
      ]],
      [keyed, ['127.0.0.1', '192.168.1.20'].flatMap(remoteAddress => [
        {remoteAddress, headers: {}, status: 401},
        {remoteAddress, headers: {[DIRECTOR_KEY_HEADER]: 'wrong'}, status: 401},
      ])],
    ] as const) {
      const before = (await app.inject('/api/state')).json();
      for (const attempt of attempts) {
        const response = await app.inject({...probe, remoteAddress: attempt.remoteAddress, headers: {...probe.headers, ...attempt.headers}});
        assert.equal(response.statusCode, attempt.status, response.body);
        assert.equal(response.body.includes(key), false);
        assert.deepEqual((await app.inject('/api/state')).json(), before, 'denied write changed studio state');
      }
    }
    const remote = await keyed.inject({...probe, remoteAddress: '192.168.1.20', headers: {...probe.headers, [DIRECTOR_KEY_HEADER]: key}});
    const loopback = await local.inject({...probe, remoteAddress: '127.0.0.1'});
    for (const response of [remote, loopback]) {
      assert.notEqual(response.statusCode, 401);
      assert.notEqual(response.statusCode, 403);
      assert.equal(response.body.includes(key), false);
    }
  } finally {
    await Promise.all([local.close(), keyed.close()]);
    await rm(directory, {recursive: true, force: true});
  }
});

test('app captures the director key once and leaves read routes public', async () => {
  const env = {[DIRECTOR_KEY_ENV]: key};
  const app = createApp({env});
  env[DIRECTOR_KEY_ENV] = 'replacement-test-key';
  try {
    const response = await app.inject({method: 'POST', url: '/api/settings', remoteAddress: '192.168.1.20',
      headers: {[DIRECTOR_KEY_HEADER]: key}, payload: {approvalMode: false}});
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes(key), false);
    for (const url of ['/api/state', '/api/fixtures', '/api/ingest/sample', '/api/comics/status', '/api/catchup', '/art/generated/panel-missing.webp']) {
      const read = await app.inject({url, remoteAddress: '192.168.1.20'});
      assert.notEqual(read.statusCode, 401);
      assert.notEqual(read.statusCode, 403);
      assert.equal(read.body.includes(key), false);
    }
  } finally { await app.close(); }
});

test('plain loopback can still write studio settings without a configured key', async () => {
  const app = createApp({env: {}});
  try {
    const response = await app.inject({method: 'POST', url: '/api/settings', payload: {approvalMode: false}});
    assert.equal(response.statusCode, 200, response.body);
  } finally { await app.close(); }
});


test('participation desk reads and path variants cannot bypass the app boundary guard', async () => {
  const local = createApp({env: {COMICTOONS_PARTICIPATION_MOCK: '1'}});
  const keyed = createApp({env: {[DIRECTOR_KEY_ENV]: key, COMICTOONS_PARTICIPATION_MOCK: '1'}});
  try {
    const routes = [
      {method: 'GET' as const, url: '/api/participation/director'},
      ...['/api/participation//polls', '/api/participation/polls?x=1', '/api/participation/polls/',
        '/api/participation/%70olls', '/API/PARTICIPATION/polls', '/api%2fparticipation%2fpolls'].map(url => ({method: 'POST' as const, url})),
    ];
    for (const route of routes) {
      assert.equal((await local.inject({...route, remoteAddress: '192.168.1.20'})).statusCode, 403, route.url);
      assert.equal((await local.inject({...route, remoteAddress: '127.0.0.1', headers: {'x-forwarded-for': '10.0.0.5'}})).statusCode, 403, route.url);
      for (const headers of [{}, {[DIRECTOR_KEY_HEADER]: 'wrong'}]) {
        const response = await keyed.inject({...route, remoteAddress: '192.168.1.20', headers});
        assert.equal(response.statusCode, 401, route.url);
        assert.equal(response.body.includes(key), false);
      }
    }
  } finally {await Promise.all([local.close(), keyed.close()]);}
});
