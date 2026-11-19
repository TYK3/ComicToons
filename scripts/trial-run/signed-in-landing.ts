/**
 * The page a browser lands on after "Authorize" in a signed-in run. The app's callback redirects to
 * http://localhost:<web port>/ui.html#/connect?twitch=<result>, but the signed-in run does not serve
 * the web UI, so this small loopback server answers on that port with a plain page instead. It reads
 * the result from the app's own /api/twitch/status; it never talks to Twitch and holds no secret.
 */
import { createServer, type Server } from 'node:http';

export interface LandingStatus { connected: boolean; channel?: string }
export interface LandingHandle { port: number; hits: number; stop(): Promise<void> }

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function landingPage(status: LandingStatus | undefined): string {
  const message = status?.connected
    ? `Connected as ${escapeHtml(status.channel || 'your Twitch account')}, you can close this tab.`
    : 'Not connected yet. If Twitch showed an error, go back to the terminal running the signed-in run.';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>ComicToons signed-in run</title></head>`
    + `<body><main><h1>ComicToons signed-in run</h1><p>${message}</p></main></body></html>\n`;
}

/** Listens on 127.0.0.1 and, where available, ::1, so "localhost" works whichever address the browser tries first. */
export async function startLanding(port: number, status: () => Promise<LandingStatus | undefined>): Promise<LandingHandle> {
  let hits = 0;
  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    let current: LandingStatus | undefined;
    try { current = await status(); } catch { current = undefined; }
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" });
    res.end(req.method === 'HEAD' ? undefined : landingPage(current));
  };
  const listen = (host: string) => new Promise<Server>((done, fail) => {
    const server = createServer((req, res) => { void handler(req, res); });
    server.once('error', fail);
    server.listen(port, host, () => { server.off('error', fail); done(server); });
  });
  const servers = [await listen('127.0.0.1')];
  try { servers.push(await listen('::1')); } catch { /* no IPv6 loopback on this box */ }
  return {
    port,
    get hits() { return hits; },
    stop: () => Promise.all(servers.map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))).then(() => undefined),
  };
}
