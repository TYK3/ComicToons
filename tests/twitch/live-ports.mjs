// HARNESS-PORT-1: ports of the developer's live app (API 3001, web 4173). A test run may only reach
// one of them when the twitch test port env names it; otherwise a connect or fetch there is refused
// before any socket opens. Shared by the test-process guard (port-guard.mjs) and the app child
// (egress-guard.mjs). No network access here.
import {readProductEnv} from '../../packages/core/src/env.mjs';

export const LIVE_PORTS = [3001, 4173];
const NAMES = ['COMICTOONS_TWITCH_TEST_APP_PORT', 'COMICTOONS_TWITCH_TEST_FAKE_PORT', 'COMICTOONS_TWITCH_TEST_WEB_PORT'];

/** Live ports this run must not reach: 3001/4173 minus any the port env names. */
export function guardedPorts(env = process.env) {
  const named = new Set(NAMES.map(name => readProductEnv(name, env)).filter(value => value && /^\d+$/.test(value)).map(Number));
  return LIVE_PORTS.filter(port => !named.has(port));
}

/** Port of a net.Socket.prototype.connect call (options object, [options, cb] or port, host); undefined for a pipe path. */
export function connectPort(args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  if (first && typeof first === 'object') return first.path ? undefined : Number(first.port);
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) return Number(first);
  return undefined;
}

/** Port of a fetch input. */
export function fetchPort(input) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  return {host: url.host, port: Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80))};
}
