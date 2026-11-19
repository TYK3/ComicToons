// Shared helpers for tests/twitch. Clients here talk only to 127.0.0.1.
import {readProductEnv} from '../../packages/core/src/env.mjs';
import {connect, type Socket} from 'node:net';

/** Dedicated configurable loopback ports; defaults are app 3120 and fake 4120. */
export function testPort(name:string,fallback:number){
  const raw=readProductEnv(name);
  const value=raw===undefined?fallback:Number(raw);
  if((raw!==undefined&&!/^\d+$/.test(raw))||!Number.isInteger(value)||value<1024||value>65535)throw new Error(`${name} must be an integer from 1024 to 65535`);
  return value;
}
export const APP_PORT=testPort('COMICTOONS_TWITCH_TEST_APP_PORT',3120);
export const FAKE_PORT=testPort('COMICTOONS_TWITCH_TEST_FAKE_PORT',4120);
/** HARNESS-PORT-1: the web port a harness app's sign-in callback sends the browser to (COMICTOONS_WEB_PORT in the app).
 * Defaults to the fake port, the web half of the pair; nothing serves the web UI there and Browser.follow never fetches it. */
export const WEB_PORT=testPort('COMICTOONS_TWITCH_TEST_WEB_PORT',FAKE_PORT);

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function waitUntil(check: () => boolean, timeoutMs = 5000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

export interface EventSubFrame { metadata: {message_id: string; message_type: string; message_timestamp: string; subscription_type?: string; subscription_version?: string}; payload: Record<string, unknown> }

/** A test EventSub client on the runtime's WebSocket (Node 22+, or Node 20 with --experimental-websocket). */
export class EventSubTestClient {
  readonly frames: EventSubFrame[] = [];
  closeCode?: number;
  private socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), {once: true});
      this.socket.addEventListener('error', event => reject(new Error(`websocket error: ${String((event as ErrorEvent).error?.cause ?? (event as ErrorEvent).message ?? '')}`)), {once: true});
    });
    this.opened.catch(() => undefined); // only awaiters see the error; never an unhandled rejection
    this.closed = new Promise(resolve => this.socket.addEventListener('close', event => { this.closeCode = event.code; resolve(event.code); }, {once: true}));
    this.socket.addEventListener('message', event => { this.frames.push(JSON.parse(String(event.data)) as EventSubFrame); });
  }
  async next(type: string, timeoutMs = 5000, after = 0) {
    await waitUntil(() => this.frames.slice(after).some(f => f.metadata.message_type === type), timeoutMs, `EventSub ${type}`);
    return this.frames.slice(after).find(f => f.metadata.message_type === type)!;
  }
  async welcome() {
    const frame = await this.next('session_welcome');
    return (frame.payload.session as {id: string; keepalive_timeout_seconds: number; reconnect_url: string | null; status: string});
  }
  notifications(type?: string) { return this.frames.filter(f => f.metadata.message_type === 'notification' && (!type || f.metadata.subscription_type === type)); }
  send(text: string) { this.socket.send(text); }
  close() { this.socket.close(1000); return this.closed; }
}

/** A raw line-based IRC client for the fake chat server. */
export class IrcTestClient {
  readonly lines: string[] = [];
  closed = false;
  private socket: Socket;
  private pending = '';
  readonly ready: Promise<void>;
  constructor(port: number, host = '127.0.0.1') {
    this.socket = connect(port, host);
    this.ready = new Promise((resolve, reject) => { this.socket.once('connect', () => resolve()); this.socket.once('error', reject); });
    this.ready.catch(() => undefined);
    this.socket.setEncoding('utf8');
    this.socket.on('data', chunk => {
      this.pending += String(chunk);
      let end: number;
      while ((end = this.pending.indexOf('\r\n')) >= 0) { this.lines.push(this.pending.slice(0, end)); this.pending = this.pending.slice(end + 2); }
    });
    this.socket.on('close', () => { this.closed = true; });
    this.socket.on('error', () => undefined);
  }
  send(line: string) { this.socket.write(`${line}\r\n`); }
  async waitFor(pattern: RegExp, timeoutMs = 5000) {
    await waitUntil(() => this.lines.some(l => pattern.test(l)), timeoutMs, `IRC line ${pattern}`);
    return this.lines.find(l => pattern.test(l))!;
  }
  async login(token: string, nick: string) {
    await this.ready;
    this.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    this.send(`PASS oauth:${token}`);
    this.send(`NICK ${nick}`);
  }
  end() { this.socket.destroy(); }
}

/** Helix call with the two headers Twitch requires. */
export async function helix(base: string, method: string, path: string, auth: {clientId: string; token: string}, body?: unknown) {
  const response = await fetch(`${base}${path}`, {method, headers: {'Client-Id': auth.clientId, Authorization: `Bearer ${auth.token}`,
    ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)});
  const text = await response.text();
  return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, unknown> : {}};
}

export const form = (values: Record<string, string>) => ({method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(values).toString()});

/** Sorted key paths of a JSON value, for shape comparison (values ignored, arrays use the first item). */
export function shape(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [`${prefix}[]`, ...(value.length ? shape(value[0], `${prefix}[]`) : [])];
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [`${prefix}.${k}`, ...shape(v, `${prefix}.${k}`)]).sort();
  return [];
}

/** node:test's stand-in for Playwright's test.fixme: skipped with "fixme(<ids>): reason"
 * until every id is listed in COMICTOONS_TWITCH_E2E (comma list, or "all"). */
export function fixme(ids: string[], reason: string): {skip?: string} {
  const enabled = (readProductEnv('COMICTOONS_TWITCH_E2E') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (enabled.includes('all') || ids.every(id => enabled.includes(id))) return {};
  return {skip: `fixme(${ids.join(',')}): ${reason}`};
}
