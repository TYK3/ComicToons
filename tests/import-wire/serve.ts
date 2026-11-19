/**
 * IMPORT-1-WIRE e2e launcher (tests/import-wire/playwright.config.ts starts it). One process:
 * 1. a counting egress guard: any non-loopback socket or fetch is refused and counted;
 * 2. a fake Twitch on 127.0.0.1:0 (POST /oauth2/token, GET /helix/clips, clip thumbnails), so no real Twitch call;
 * 3. the real Studio server (createApp) pointed at the fake, art network off, listening on COMICTOONS_API_PORT.
 * GET /__import-wire/egress reports the guard's count to the spec. Test-only; never part of the product.
 */
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CHANNEL = 'importwirefake';
export const FAKE_CLIP = 'ImportWireClip-1';
const port = Number(process.env.COMICTOONS_API_PORT ?? '');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COMICTOONS_API_PORT must be set for the import-wire launcher');
// Nothing from the shell reaches the app: no Twitch keys, no art network, no stray product settings.
for (const name of Object.keys(process.env)) if (/^(COMICTOONS|PANELCAST)_|^TWITCH_/.test(name)) delete process.env[name];

const refused: string[] = [];
const loopback = (host: string) => host === 'localhost' || host === '::1' || host === '[::1]' || (/^127\./.test(host) && net.isIP(host) === 4);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
  const normalized = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
  const options = normalized[0] as { host?: string; path?: string } | number | string;
  const host = typeof options === 'object' ? options?.host : typeof normalized[1] === 'string' ? normalized[1] : '127.0.0.1';
  if (!(typeof options === 'object' && options?.path) && !loopback(host ?? '127.0.0.1')) { refused.push(`socket ${host}`); throw new Error('import-wire: non-loopback egress refused'); }
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
const realFetch = globalThis.fetch;
// Clip thumbnails use Twitch's real CDN form, because clip-url-1's safeClipUrl allow-lists only https clips.twitch.tv
// and *.jtvnw.net. The browser loads them, and the spec answers that host itself (page.route), so nothing leaves the box.
const THUMB_HOST = 'static-cdn.jtvnw.net';
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback(url.hostname)) { refused.push(`fetch ${url.hostname}`); return Promise.reject(new Error('import-wire: non-loopback egress refused')); }
  return realFetch(input, init);
};

// A 2x2 PNG for the clip thumbnail.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOosDkBRAwQCgAoXgXxPgnaUgAAAABJRU5ErkJggg==', 'base64');
let origin = '';
const helixCalls: string[] = [];
const fake: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', origin);
  helixCalls.push(`${req.method} ${url.pathname}`);
  const json = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'POST' && url.pathname === '/oauth2/token') { json({ access_token: 'fake-app-token', expires_in: 3600, token_type: 'bearer' }); return; }
  if (url.pathname.startsWith('/thumb/')) { res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }); res.end(PNG); return; }
  if (req.headers.authorization !== 'Bearer fake-app-token' || req.headers['client-id'] !== 'fake-client') { res.writeHead(401).end(); return; }
  if (url.pathname === '/helix/clips' && url.searchParams.getAll('id').includes(FAKE_CLIP)) {
    json({ data: [{ id: FAKE_CLIP, broadcaster_id: '4242', broadcaster_name: 'ImportWireFake', title: 'The boss fight finally lands',
      created_at: '2026-10-31T20:00:00Z', view_count: 321, url: `https://clips.twitch.tv/${FAKE_CLIP}`, thumbnail_url: `https://${THUMB_HOST}/twitch-clips-thumbnails-prod/${FAKE_CLIP}/preview-480x272.png`,
      video_id: '', vod_offset: null, duration: 30 }], pagination: {} });
    return;
  }
  if (url.pathname === '/helix/clips' || url.pathname === '/helix/videos') { json({ data: [], pagination: {} }); return; }
  res.writeHead(404).end();
});
await new Promise<void>(done => fake.listen(0, '127.0.0.1', done));
origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

// Each run starts with no series for the fake channel, so the first chapter is chapter 1.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
await rm(join(root, 'artifacts/series', `${FAKE_CHANNEL}.json`), { force: true });
const recapDirectory = await mkdtemp(join(tmpdir(), 'import-wire-'));
const { createApp } = await import('../../apps/server/src/app.ts');
const app = createApp({
  logger: false, recapDirectory,
  env: {
    COMICTOONS_TWITCH_CLIENT_ID: 'fake-client', COMICTOONS_TWITCH_CLIENT_SECRET: 'fake-secret',
    COMICTOONS_TWITCH_REDIRECT_URI: `http://127.0.0.1:${port}/auth/twitch/callback`,
    COMICTOONS_TWITCH_AUTH_BASE_URL: origin, COMICTOONS_TWITCH_HELIX_BASE_URL: `${origin}/helix`, COMICTOONS_ART_NETWORK: '0',
  },
});
app.get('/__import-wire/egress', async () => ({ refused: refused.length, attempts: refused, helixCalls }));
await app.listen({ port, host: '127.0.0.1' });
const stop = async () => { await app.close(); fake.close(); await rm(recapDirectory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
