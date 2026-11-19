// Starts the real ComicToons server on 127.0.0.1:3120 pointed at the fake Twitch on 4120.
// Every credential is the fake's; every art and AI key is blanked so a developer's
// repo-root .env cannot switch on network art or real Twitch (values already in the
// environment win over .env). Only the exact child PID started here is ever signalled.
import {spawn, type ChildProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import {APP_PORT, FAKE_PORT, WEB_PORT, sleep} from './helpers.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Names from .env.example (never values), blanked in the child unless set below. */
function exampleEnvNames() {
  return readFileSync(new URL('../../.env.example', import.meta.url), 'utf8').split('\n')
    .map(line => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter((name): name is string => !!name);
}

export const ALL_FLAGS = ['POLLS', 'TWITCH_POLLS', 'INK_ME', 'CATCHUP', 'HYPE', 'DIRECTOR', 'NOINK', 'BOT_REPLIES'];

export interface RunningApp { base: string; pid: number; output: () => string; stop: () => Promise<void>; child: ChildProcess }

export function appEnv(fake: FakeTwitch, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const name of exampleEnvNames()) env[name] = '';
  for(const name of ['TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','COMICTOONS_TWITCH_CLIENT_ID','COMICTOONS_TWITCH_CLIENT_SECRET'])delete env[name];
  for (const key of Object.keys(env)) if (/^(PANELCAST|COMICTOONS)_/.test(key) || /^(CLOUDFLARE|POLLINATIONS|OPENAI)_/.test(key)) env[key] = '';
  Object.assign(env, {
    NODE_ENV: 'test', MODE: 'live', COMICTOONS_API_PORT: String(APP_PORT),
    // HARNESS-PORT-1: the sign-in callback returns to the harness web port, never the 4173 default; the egress guard reads the test ports.
    COMICTOONS_WEB_PORT: String(WEB_PORT), COMICTOONS_TWITCH_TEST_APP_PORT: String(APP_PORT), COMICTOONS_TWITCH_TEST_FAKE_PORT: String(FAKE_PORT), COMICTOONS_TWITCH_TEST_WEB_PORT: String(WEB_PORT),
    COMICTOONS_ART_NETWORK: '0', PANELCAST_ART_NETWORK: '0', COMICTOONS_PARTICIPATION_MOCK: '0',
    ...Object.fromEntries(ALL_FLAGS.map(flag => [`COMICTOONS_FLAG_${flag}`, '1'])),
    ...fake.appEnv(),
    ...extra,
  });
  return env;
}

export async function startApp(fake: FakeTwitch, extra: Record<string, string> = {}, readyTimeoutMs = 30_000): Promise<RunningApp> {
  if(['TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','COMICTOONS_TWITCH_CLIENT_ID','COMICTOONS_TWITCH_CLIENT_SECRET'].some(name=>process.env[name]))throw new Error('Refusing inherited Twitch credentials; run the harness with a clean environment.');
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./egress-guard.mjs',import.meta.url)), '--import', 'tsx', 'apps/server/src/index.ts'], {cwd: root, env: appEnv(fake, extra), stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  child.stdout!.on('data', (chunk: Buffer) => { log += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { log += chunk.toString('utf8'); });
  const base = `http://127.0.0.1:${APP_PORT}`;
  const stop = () => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill('SIGTERM'); // this exact child only
    const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    hard.unref();
  });
  const end = Date.now() + readyTimeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`ComicToons server exited early (${child.exitCode})`);
    try { if ((await fetch(`${base}/api/twitch/status`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > end) { await stop(); throw new Error(`ComicToons server did not answer on ${APP_PORT} in time`); }
    await sleep(200);
  }
  return {base, pid: child.pid!, output: () => log, stop, child};
}

/** Small cookie-keeping client for the OAuth round trip (state may live in a cookie). */
export class Browser {
  private cookies = new Map<string, string>();
  async get(url: string) {
    const response = await fetch(url, {redirect: 'manual', headers: this.cookies.size ? {Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')} : {}});
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  }
  /** Follows redirects by hand so every hop (app -> fake authorise -> app callback) is visible.
   * HARNESS-PORT-1: the harness runs no web UI, so the callback's redirect to /ui.html is never fetched;
   * it must name the harness web port (localhost:WEB_PORT) and is returned as `landing`. */
  async follow(url: string, maxHops = 6) {
    const hops: {url: string; status: number}[] = [];
    let next = url;
    for (let i = 0; i < maxHops; i++) {
      const response = await this.get(next);
      hops.push({url: next, status: response.status});
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return {response, hops, body: await response.text()};
      next = new URL(location, next).toString();
      const target = new URL(next);
      if (target.pathname === '/ui.html') {
        if (target.host !== `localhost:${WEB_PORT}`) throw new Error(`sign-in sent the browser to ${target.host}, not the harness web port localhost:${WEB_PORT}`);
        return {response, hops, body: await response.text(), landing: target};
      }
    }
    throw new Error('too many redirects');
  }
}

export async function json<T = Record<string, unknown>>(url: string, init?: RequestInit) {
  const response = await fetch(url, {...init, headers: {...(init?.body ? {'Content-Type': 'application/json'} : {}), ...init?.headers}});
  const text = await response.text();
  return {status: response.status, body: (text ? JSON.parse(text) : {}) as T, text};
}
