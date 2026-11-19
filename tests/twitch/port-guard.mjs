// HARNESS-PORT-1: loaded with --import into every `npm run test:twitch` test process (run-tests.mjs).
// Refuses, records and fails the run on any connect or fetch to 3001/4173 while the port env names
// other ports, so a test can never be answered by the developer's live app.
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {connectPort, fetchPort, guardedPorts} from './live-ports.mjs';

const KEY = Symbol.for('comictoons.twitchTestPortGuard');
if (!globalThis[KEY]) {
  const guarded = guardedPorts();
  const hits = [];
  const state = {guarded, hits, quiet: false};
  const refuse = what => {
    hits.push(what);
    if (!state.quiet) console.error(`live-port guard: refused ${what} (port env names other ports)`);
    throw new Error(`live-port guard: refused ${what}; tests must use the configured twitch test ports`);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const port = connectPort(args);
    if (port !== undefined && guarded.includes(port)) refuse(`connect to port ${port}`);
    return connect.apply(this, args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const {host, port} = fetchPort(input);
    if (guarded.includes(port)) refuse(`fetch to ${host}`);
    return originalFetch(input, init);
  };
  syncBuiltinESMExports();
  globalThis[KEY] = state;
  // A refusal swallowed by a test's catch still fails the file.
  process.on('exit', () => {
    if (!hits.length) return;
    console.error(`live-port guard: ${hits.length} refused request(s): ${hits.join(', ')}`);
    process.exitCode = 1;
  });
}
