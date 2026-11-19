import assert from 'node:assert/strict';
import test from 'node:test';
import {ALLOWED_REQUESTS, READ_ONLY_EVENTSUB_TYPES, SignedInAllowlistViolation, checkAllowed} from '../scripts/trial-run/signed-in-allowlist.ts';

const AUTH = 'http://127.0.0.1:4120/oauth2';
const HELIX = 'http://127.0.0.1:4120/helix';
const subscribeBody = (type: string) => JSON.stringify({type, version: '1', condition: {broadcaster_user_id: '1'}, transport: {method: 'websocket', session_id: 's'}});

test('allowlist: every read-only entry is accepted', () => {
  assert.doesNotThrow(() => checkAllowed({method: 'GET', url: `${AUTH}/authorize?client_id=x`}));
  assert.doesNotThrow(() => checkAllowed({method: 'POST', url: `${AUTH}/token`, body: 'grant_type=authorization_code'}));
  assert.doesNotThrow(() => checkAllowed({method: 'GET', url: `${AUTH}/validate`}));
  assert.doesNotThrow(() => checkAllowed({method: 'GET', url: `${HELIX}/users?id=1`}));
  for (const type of READ_ONLY_EVENTSUB_TYPES) {
    assert.doesNotThrow(() => checkAllowed({method: 'POST', url: `${HELIX}/eventsub/subscriptions`, body: subscribeBody(type)}), `subscribing to ${type} must be allowed`);
  }
  assert.ok(READ_ONLY_EVENTSUB_TYPES.length >= 16, 'the read-only list should cover every type the app subscribes to');
  assert.ok(ALLOWED_REQUESTS.every(entry => entry.comment.length > 0), 'every allowed entry must carry a comment explaining why it is safe');
});

test('allowlist: every write is rejected', () => {
  const writes: {method: string; url: string; body?: string}[] = [
    {method: 'POST', url: `${HELIX}/channel_points/custom_rewards`, body: '{"title":"Ink me","cost":500}'},
    {method: 'PATCH', url: `${HELIX}/channel_points/custom_rewards`, body: '{"is_paused":true}'},
    {method: 'PATCH', url: `${HELIX}/channel_points/custom_rewards/redemptions?id=1`, body: '{"status":"FULFILLED"}'},
    {method: 'POST', url: `${HELIX}/polls`, body: '{"title":"Pick one"}'},
    {method: 'PATCH', url: `${HELIX}/polls`, body: '{"status":"TERMINATED"}'},
    {method: 'POST', url: `${HELIX}/predictions`, body: '{"title":"Will they?"}'},
    {method: 'PATCH', url: `${HELIX}/predictions`, body: '{"status":"RESOLVED"}'},
    {method: 'POST', url: `${HELIX}/chat/messages`, body: '{"message":"hi"}'},
    {method: 'DELETE', url: `${HELIX}/eventsub/subscriptions?id=1`},
    {method: 'GET', url: `${HELIX}/eventsub/subscriptions`},
    {method: 'POST', url: `${AUTH}/revoke`, body: 'token=x'},
    {method: 'GET', url: 'https://api.twitch.tv/helix/channels', body: undefined},
  ];
  for (const request of writes) {
    assert.throws(() => checkAllowed(request), SignedInAllowlistViolation, `${request.method} ${request.url} must be blocked`);
  }
});

test('allowlist: EventSub subscription creation is rejected for any type outside the read-only set', () => {
  for (const type of ['channel.update', 'channel.subscribe', 'drop.entitlement.grant', 'channel.ban']) {
    assert.throws(() => checkAllowed({method: 'POST', url: `${HELIX}/eventsub/subscriptions`, body: subscribeBody(type)}), SignedInAllowlistViolation, `${type} must not be subscribable`);
  }
  assert.throws(() => checkAllowed({method: 'POST', url: `${HELIX}/eventsub/subscriptions`, body: '{}'}), SignedInAllowlistViolation, 'a missing type must be rejected, not treated as allowed');
  assert.throws(() => checkAllowed({method: 'POST', url: `${HELIX}/eventsub/subscriptions`}), SignedInAllowlistViolation, 'a missing body must be rejected');
});

test('allowlist: the violation message names the method and URL but never the request body', () => {
  try {
    checkAllowed({method: 'post', url: `${HELIX}/chat/messages`, body: '{"message":"super secret chat text"}'});
    assert.fail('expected a throw');
  } catch (error) {
    assert.ok(error instanceof SignedInAllowlistViolation);
    assert.match(error.message, /POST/);
    assert.match(error.message, /chat\/messages/);
    assert.doesNotMatch(error.message, /super secret chat text/);
  }
});

test('allowlist: only Twitch hosts or a loopback fake may be contacted, whatever the path', () => {
  assert.doesNotThrow(() => checkAllowed({method: 'POST', url: 'https://id.twitch.tv/oauth2/token', body: 'grant_type=authorization_code'}));
  assert.doesNotThrow(() => checkAllowed({method: 'GET', url: 'https://api.twitch.tv/helix/users'}));
  assert.doesNotThrow(() => checkAllowed({method: 'GET', url: 'http://localhost:4120/oauth2/validate'}));
  for (const url of ['https://evil.example/helix/users', 'https://api.twitch.tv.evil.example/helix/users', 'http://10.0.0.5/oauth2/validate', 'https://id.twitch.tv/helix/users', 'https://api.twitch.tv/oauth2/token']) {
    assert.throws(() => checkAllowed({method: 'GET', url}), SignedInAllowlistViolation, `${url} must be blocked`);
  }
});

test('allowlist: a wrong method on an allowed path is rejected, on Twitch hosts and on the loopback fake', () => {
  const hosts = [{auth: 'https://id.twitch.tv/oauth2', helix: 'https://api.twitch.tv/helix'}, {auth: AUTH, helix: HELIX}];
  for (const {auth, helix} of hosts) {
    const wrong: {method: string; url: string; body?: string}[] = [
      ...['PUT', 'PATCH', 'DELETE', 'POST'].map(method => ({method, url: `${helix}/users?id=1`, body: method === 'DELETE' ? undefined : '{"description":"changed"}'})),
      ...['PUT', 'DELETE', 'PATCH', 'GET'].map(method => ({method, url: `${auth}/token`, body: method === 'GET' ? undefined : 'grant_type=authorization_code'})),
      ...['POST', 'DELETE'].map(method => ({method, url: `${auth}/validate`})),
      ...['POST', 'PUT'].map(method => ({method, url: `${auth}/authorize?client_id=x`})),
      ...['PUT', 'PATCH', 'DELETE'].map(method => ({method, url: `${helix}/eventsub/subscriptions`, body: subscribeBody('channel.raid')})),
    ];
    for (const request of wrong) {
      assert.throws(() => checkAllowed(request), SignedInAllowlistViolation, `${request.method} ${request.url} must be blocked: only the listed method is allowed on this path`);
    }
  }
});

test('allowlist: deleting a custom reward (DELETE channel_points/custom_rewards) is rejected', () => {
  for (const helix of ['https://api.twitch.tv/helix', HELIX]) {
    for (const url of [`${helix}/channel_points/custom_rewards?broadcaster_id=1&id=1`, `${helix}/channel_points/custom_rewards/`]) {
      assert.throws(() => checkAllowed({method: 'DELETE', url}), SignedInAllowlistViolation, `DELETE ${url} must be blocked`);
      assert.throws(() => checkAllowed({method: 'delete', url}), SignedInAllowlistViolation, `a lower-case delete on ${url} must be blocked too`);
    }
  }
});
