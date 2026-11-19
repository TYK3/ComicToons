import assert from 'node:assert/strict';
import test from 'node:test';
import {twitchAuthFromStatus} from '../apps/web/src/ui/data/twitch-status.ts';

// The Studio polls GET /api/twitch/status every 15 s (data/server.ts). When the server drops the
// Twitch sign-in on its own (refresh refused after expiry or revocation, or a validation 401), the
// status is configured, not connected, with a reason. The Studio must show that reason instead of the
// same plain "signed out" state as a deliberate sign-out.

test('a server-side sign-out with a reason (expired or revoked token) is shown as an error that names the reason', () => {
  for (const reason of ['Twitch authorization expired. Reconnect Twitch.', 'Twitch refresh unavailable. Reconnect Twitch.', 'Twitch validation unavailable.'])
    assert.deepEqual(twitchAuthFromStatus({configured: true, connected: false, scopes: [], reason}), {state: 'error', error: reason});
});

test('a deliberate sign-out and a never-signed-in machine stay plain signed-out', () => {
  assert.deepEqual(twitchAuthFromStatus({configured: true, connected: false, scopes: [], reason: 'Twitch disconnected.'}), {state: 'signed-out'});
  assert.deepEqual(twitchAuthFromStatus({configured: true, connected: false, scopes: []}), {state: 'signed-out'});
});

test('connected and not-configured states are unchanged', () => {
  assert.deepEqual(twitchAuthFromStatus({configured: true, connected: true, scopes: [], login: 'tyk_twitch', broadcaster_type: ''}), {state: 'connected', login: 'tyk_twitch', broadcasterType: ''});
  assert.deepEqual(twitchAuthFromStatus({configured: false, connected: false, scopes: []}), {state: 'error', error: 'Twitch sign-in is not set up on this machine yet.'});
});

test('a dismissed reason stays dismissed on the next status poll, and a new reason shows again', () => {
  const expired = 'Twitch authorization expired. Reconnect Twitch.';
  assert.deepEqual(twitchAuthFromStatus({configured: true, connected: false, scopes: [], reason: expired}, expired), {state: 'signed-out'});
  assert.deepEqual(twitchAuthFromStatus({configured: true, connected: false, scopes: [], reason: 'Twitch refresh unavailable. Reconnect Twitch.'}, expired), {state: 'error', error: 'Twitch refresh unavailable. Reconnect Twitch.'});
});
