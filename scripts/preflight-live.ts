// PREFLIGHT-1: read-only checks before a live Twitch test. Run it through scripts/preflight-live.sh.
// Every request here is a GET to the local ComicToons API or web server. Nothing here writes to Twitch,
// signs in, signs out or changes app state, and no token value is ever read or printed: the app keeps
// its Twitch tokens in memory and reports only the login, scopes and expiry on GET /api/twitch/status.
import {existsSync, readFileSync, readdirSync, readlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {TWITCH_SCOPES_READONLY} from '../apps/server/src/twitch/config.ts';
import {EVENTSUB_TYPES, listedEventSubStatus, type EventSubStatus} from '../apps/web/src/ui/data/adapter.ts';

export type Check = 'readonly-scopes' | 'api-health' | 'twitch-token' | 'image-budget' | 'overlay' | 'eventsub-count';
export interface Result {check: Check; ok: boolean; detail: string}
export interface Ports {api: number; web: number; apiBase: string; webBase: string}
export interface WireTwitchStatus {configured?: boolean; connected?: boolean; login?: string; scopes?: string[]; missingScopes?: string[]; expiresAt?: number; reason?: string; requestedScopes?: string[]}

const pass = (check: Check, detail: string): Result => ({check, ok: true, detail});
const fail = (check: Check, detail: string): Result => ({check, ok: false, detail});
export const READ_SCOPES: readonly string[] = TWITCH_SCOPES_READONLY;

/** One line per check: `PASS <check> (<detail>)` or `FAIL <check>: <reason>`. */
export function formatResult(result: Result): string {
  result = {...result, detail: result.detail.replace(/\s*\r?\n\s*/g, ' ').trim()};
  return result.ok ? `PASS ${result.check}${result.detail ? ` (${result.detail})` : ''}` : `FAIL ${result.check}: ${result.detail}`;
}

/** The app's own port names and defaults (apps/server/src/index.ts, apps/web/vite.config.ts): API 3001, web 4173. */
export function parsePorts(env: Record<string, string | undefined>): Ports {
  const read = (name: string, fallback: number) => {
    const raw = (env[name] ?? env[name.replace(/^COMICTOONS_/, 'PANELCAST_')])?.trim();
    if (!raw) return fallback;
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
    return port;
  };
  const api = read('COMICTOONS_API_PORT', 3001); const web = read('COMICTOONS_WEB_PORT', 4173);
  return {api, web, apiBase: `http://127.0.0.1:${api}`, webBase: `http://127.0.0.1:${web}`};
}

/** The same rule the server uses (twitch/config.ts): 1, true, on or yes, any case, trimmed. */
export const readOnlyFlag = (raw: string | undefined) => /^(1|true|on|yes)$/i.test(raw?.trim() ?? '');

/** Reads one variable from .env text without returning any other value. Last assignment wins, as process.loadEnvFile does. */
export function envFileValue(text: string, name: string): string | undefined {
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== name) continue;
    let raw = match[2]!.trim();
    if (/^(["']).*\1$/.test(raw)) raw = raw.slice(1, -1); else raw = raw.replace(/\s+#.*$/, '');
    value = raw;
  }
  return value;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && b.every(item => a.includes(item));

/** (a) requestedScopes on GET /api/twitch/status is the scope list the server asks Twitch for (store.config.scopes). */
export function readOnlyScopesCheck(status: WireTwitchStatus, fallback?: {source: string; value: string | undefined}): Result {
  if (Array.isArray(status.requestedScopes)) {
    if (sameSet(status.requestedScopes, READ_SCOPES)) return pass('readonly-scopes', `app requests exactly the ${READ_SCOPES.length} read scopes, so COMICTOONS_OAUTH_SCOPES_READONLY is on`);
    const extra = status.requestedScopes.filter(scope => !READ_SCOPES.includes(scope));
    return fail('readonly-scopes', `the app was not started with COMICTOONS_OAUTH_SCOPES_READONLY=1: it requests ${status.requestedScopes.join(' ') || 'no scopes'}${extra.length ? ` (not read-only: ${extra.join(' ')})` : ''}`);
  }
  if (fallback && fallback.value !== undefined) return readOnlyFlag(fallback.value)
    ? pass('readonly-scopes', `COMICTOONS_OAUTH_SCOPES_READONLY=${fallback.value.trim()} in ${fallback.source}; the status has no requestedScopes`)
    : fail('readonly-scopes', `COMICTOONS_OAUTH_SCOPES_READONLY is "${fallback.value.trim()}" in ${fallback.source}, not 1`);
  return fail('readonly-scopes', 'GET /api/twitch/status has no requestedScopes and COMICTOONS_OAUTH_SCOPES_READONLY was not found in the process environment or .env');
}

/** (c) The token as the app last validated it: signed in, not expired, holding all six read scopes. */
export function tokenCheck(status: WireTwitchStatus, now = Date.now()): Result {
  if (status.configured === false) return fail('twitch-token', 'Twitch sign-in is not configured (client id, secret or redirect URI missing)');
  if (!status.connected) return fail('twitch-token', `not signed in to Twitch${status.reason ? `: ${status.reason.replace(/\.+$/, '')}` : ''}. Open /ui.html#/connect and sign in first`);
  const scopes = status.scopes ?? [];
  const missing = READ_SCOPES.filter(scope => !scopes.includes(scope));
  if (missing.length) return fail('twitch-token', `token for @${status.login ?? '?'} lacks ${missing.join(' ')}`);
  if (typeof status.expiresAt !== 'number' || status.expiresAt <= now) return fail('twitch-token', 'token has no expiry or has expired');
  const minutes = Math.floor((status.expiresAt - now) / 60_000);
  return pass('twitch-token', `@${status.login ?? '?'} signed in, all ${READ_SCOPES.length} read scopes, expires in ${minutes} min`);
}

/** (d) budget.perHour on GET /api/participation/status is budgetPerHour() as the server read it (blank means unset, so 12). */
export function budgetCheck(participation: {budget?: {perHour?: unknown; used?: unknown}}): Result {
  const perHour = participation.budget?.perHour;
  if (typeof perHour !== 'number' || !Number.isFinite(perHour)) return fail('image-budget', 'GET /api/participation/status has no budget.perHour');
  if (perHour <= 0) return fail('image-budget', `the server reads IMAGE_BUDGET_PER_HOUR as ${perHour}, so no panel art will be drawn. Set it above 0 (or leave it blank for 12) and restart`);
  return pass('image-budget', `server reads ${perHour} panels per hour, ${typeof participation.budget?.used === 'number' ? participation.budget.used : '?'} used`);
}

/** (f) Listed types subscribed equals the Studio's expected list, and the count the Studio shows never exceeds it. */
export function eventSubCheck(status: EventSubStatus, chip?: string): Result {
  const expected = EVENTSUB_TYPES.map(entry => entry.type);
  const shown = listedEventSubStatus(status);
  const missing = expected.filter(type => !status.subscribed.includes(type));
  const extra = status.subscribed.filter(type => !expected.includes(type));
  const chipCount = chip ? /(\d+) of (\d+) subscriptions/.exec(chip) : null;
  if (chipCount && Number(chipCount[1]) > Number(chipCount[2])) return fail('eventsub-count', `the Studio shows "${chipCount[0]}"`);
  if (!status.signedIn || status.state !== 'subscribed') return fail('eventsub-count', `EventSub is ${status.state}${status.signedIn ? '' : ', not signed in'}${status.lastError ? `: ${status.lastError}` : ''}`);
  if (shown.subscribed.length > expected.length) return fail('eventsub-count', `"${shown.subscribed.length} of ${expected.length}"`);
  const failed = [...new Set(shown.failed.map(entry => entry.type))];
  const absent = missing.filter(type => !failed.includes(type));
  const detail = [absent.length ? `missing ${absent.join(' ')}` : '', failed.length ? `failed ${failed.join(' ')}` : ''].filter(Boolean).join('; ');
  if (detail) return fail('eventsub-count', `${shown.subscribed.length} of ${expected.length} listed types subscribed; ${detail}`);
  return pass('eventsub-count', `listed ${shown.subscribed.length} = expected ${expected.length}${extra.length ? `, plus unlisted ${extra.join(' ')} not counted` : ''}${chipCount ? `; Studio shows "${chipCount[0]}"` : ''}`);
}

// ---- I/O (GET only) ------------------------------------------------------------------------------
async function getJson<T>(url: string): Promise<{status: number; body: T}> {
  const response = await fetch(url, {method: 'GET', headers: {accept: 'application/json'}, signal: AbortSignal.timeout(8000)});
  const text = await response.text();
  let body: T; try { body = JSON.parse(text) as T; } catch { throw new Error(`${new URL(url).pathname} answered ${response.status} with no JSON`); }
  return {status: response.status, body};
}
const reason = (error: unknown) => ((error as {cause?: {code?: string}}).cause?.code ?? (error instanceof Error ? error.message : String(error))).split(/\r?\n/)[0]!.trim();

/** (a) fallback, only when the status has no requestedScopes: the API process's environment (Linux /proc), then the repo .env. */
function readOnlyFallback(root: string, apiPort: number): {source: string; value: string | undefined} | undefined {
  const name = 'COMICTOONS_OAUTH_SCOPES_READONLY';
  try {
    const inodes = new Set<string>();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols[3] === '0A' && parseInt(cols[1]?.split(':')[1] ?? '', 16) === apiPort && cols[9]) inodes.add(cols[9]);
      }
    }
    for (const pid of inodes.size ? readdirSync('/proc').filter(entry => /^\d+$/.test(entry)) : []) {
      let owns = false;
      try { owns = readdirSync(`/proc/${pid}/fd`).some(fd => { try { return inodes.has(/^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1] ?? ''); } catch { return false; } }); } catch { continue; }
      if (!owns) continue;
      // Only this one variable is kept; every other value in the environment is discarded unread.
      const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(item => item.startsWith(`${name}=`) || item.startsWith(`${name.replace('COMICTOONS_', 'PANELCAST_')}=`));
      if (entry) return {source: `the environment of API pid ${pid}`, value: entry.slice(entry.indexOf('=') + 1)};
    }
  } catch { /* not Linux, or not our process */ }
  const file = `${root}.env`;
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    const value = envFileValue(text, name) ?? envFileValue(text, name.replace('COMICTOONS_', 'PANELCAST_'));
    if (value !== undefined) return {source: '.env', value};
  }
  return undefined;
}

async function overlayCheck(ports: Ports): Promise<{result: Result; chip?: string}> {
  const url = `${ports.webBase}/ui.html#/overlay`;
  type Pw = typeof import('playwright');
  let playwright: Pw | undefined;
  try { playwright = await import('playwright'); } catch { playwright = undefined; }
  if (playwright) {
    let browser: Awaited<ReturnType<Pw['chromium']['launch']>> | undefined;
    try { browser = await playwright.chromium.launch({headless: true}); } catch { browser = undefined; }
    if (browser) {
      try {
        const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
        // Loopback only, and GET only: anything else is refused before it leaves the browser.
        await context.route('**/*', route => {
          const request = route.request(); const target = new URL(request.url());
          const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.protocol === 'data:' || target.protocol === 'blob:';
          return local && ['GET', 'HEAD'].includes(request.method()) ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        const errors: string[] = [];
        // The Vite dev client's own hot-reload socket errors are not the overlay's; they are counted, not failed.
        let devClient = 0;
        page.on('pageerror', error => { if (/@vite\/client/.test(error.stack ?? '')) devClient++; else errors.push(error.message); });
        const response = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30_000});
        if (!response || response.status() >= 400) return {result: fail('overlay', `${url} answered ${response?.status() ?? 'nothing'}`)};
        const stage = page.getByRole('region', {name: 'Stream overlay'});
        await stage.waitFor({state: 'visible', timeout: 30_000});
        const box = await stage.boundingBox();
        const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
        if (errors.length) return {result: fail('overlay', `page error: ${errors[0]}`)};
        if (!box || box.width < 100 || box.height < 50) return {result: fail('overlay', 'the overlay stage did not render at a usable size')};
        // The Studio's EventSub chip, for check (f). Loading the Studio only reads (GET) from the API.
        let chip: string | undefined;
        try {
          const studio = await context.newPage();
          await studio.goto(`${ports.webBase}/ui.html#/studio`, {waitUntil: 'domcontentloaded', timeout: 30_000});
          const label = studio.locator('.ct-sr', {hasText: /EventSub,/}).first();
          await label.waitFor({state: 'attached', timeout: 20_000});
          // Let the 5 s EventSub poll land so the chip shows the server's count, not the loading state.
          await studio.waitForFunction(() => /\d+ of \d+ subscriptions/.test(document.body.textContent ?? ''), undefined, {timeout: 12_000}).catch(() => undefined);
          chip = (await label.textContent())?.trim();
        } catch { chip = undefined; }
        return {chip, result: pass('overlay', `headless Chromium 1920x1080 rendered the "Stream overlay" stage at ${Math.round(box.width)}x${Math.round(box.height)}, background ${background}, no page errors${devClient ? ` (ignored ${devClient} Vite dev-client socket error${devClient > 1 ? 's' : ''})` : ''}`)};
      } catch (error) {
        return {result: fail('overlay', `${url}: ${reason(error)}`)};
      } finally { await browser.close(); }
    }
  }
  // No Playwright or no browser: fetch ui.html and every script and stylesheet it names.
  try {
    const page = await fetch(`${ports.webBase}/ui.html`, {signal: AbortSignal.timeout(8000)});
    if (!page.ok) return {result: fail('overlay', `/ui.html answered ${page.status}`)};
    const html = await page.text();
    const assets = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map(match => match[1]!).filter(src => !/^https?:/.test(src));
    for (const asset of assets) {
      const response = await fetch(new URL(asset, `${ports.webBase}/`), {signal: AbortSignal.timeout(8000)});
      if (!response.ok) return {result: fail('overlay', `${asset} answered ${response.status}`)};
    }
    return {result: pass('overlay', `LIMITED: Playwright/Chromium not available, so ui.html and its ${assets.length} asset(s) were fetched (200) but not rendered`)};
  } catch (error) { return {result: fail('overlay', `${ports.webBase}/ui.html: ${reason(error)}`)}; }
}

export async function runPreflight(env: Record<string, string | undefined> = process.env): Promise<Result[]> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const ports = parsePorts(env);
  const results: Result[] = [];
  let twitch: WireTwitchStatus | undefined; let twitchError = '';
  try { const response = await getJson<WireTwitchStatus>(`${ports.apiBase}/api/twitch/status`); if (response.status === 200) twitch = response.body; else twitchError = `GET /api/twitch/status answered ${response.status}`; }
  catch (error) { twitchError = `GET /api/twitch/status: ${reason(error)}`; }

  // (a)
  results.push(twitch ? readOnlyScopesCheck(twitch, Array.isArray(twitch.requestedScopes) ? undefined : readOnlyFallback(root, ports.api)) : fail('readonly-scopes', twitchError));

  // (b) There is no /api/health route in this app; if one answers 200 it is used, otherwise GET /api/fixtures stands in.
  try {
    const health = await fetch(`${ports.apiBase}/api/health`, {signal: AbortSignal.timeout(8000)}).catch(() => undefined);
    let liveness = health?.ok ? '/api/health 200' : '';
    if (!liveness) { const fixtures = await getJson<unknown[]>(`${ports.apiBase}/api/fixtures`); if (fixtures.status !== 200 || !Array.isArray(fixtures.body)) throw new Error(`GET /api/fixtures answered ${fixtures.status}`); liveness = `/api/fixtures 200 (${fixtures.body.length} fixtures; no /api/health route)`; }
    const state = await getJson<{status?: string; panels?: unknown[]; source?: {active?: string}}>(`${ports.apiBase}/api/state`);
    if (state.status !== 200 || typeof state.body.status !== 'string' || !Array.isArray(state.body.panels)) throw new Error(`GET /api/state answered ${state.status} without a studio state`);
    results.push(pass('api-health', `${liveness}; /api/state 200, status ${state.body.status}, source ${state.body.source?.active ?? '?'}`));
  } catch (error) { results.push(fail('api-health', `${ports.apiBase}: ${reason(error)}`)); }

  // (c)
  results.push(twitch ? tokenCheck(twitch) : fail('twitch-token', twitchError));

  // (d)
  try { const response = await getJson<{budget?: {perHour?: unknown; used?: unknown}}>(`${ports.apiBase}/api/participation/status`); results.push(response.status === 200 ? budgetCheck(response.body) : fail('image-budget', `GET /api/participation/status answered ${response.status}`)); }
  catch (error) { results.push(fail('image-budget', `GET /api/participation/status: ${reason(error)}`)); }

  // (e)
  const overlay = await overlayCheck(ports);
  results.push(overlay.result);

  // (f)
  try { const response = await getJson<EventSubStatus>(`${ports.apiBase}/api/participation/eventsub`); results.push(response.status === 200 ? eventSubCheck(response.body, overlay.chip) : fail('eventsub-count', `GET /api/participation/eventsub answered ${response.status}`)); }
  catch (error) { results.push(fail('eventsub-count', `GET /api/participation/eventsub: ${reason(error)}`)); }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let ports: Ports;
  try { ports = parsePorts(process.env); } catch (error) { console.log(`FAIL ports: ${(error as Error).message}`); process.exit(2); }
  console.log(`ComicToons live preflight (read-only): API ${ports.apiBase}, web ${ports.webBase}`);
  const results = await runPreflight(process.env);
  for (const result of results) console.log(formatResult(result));
  const failed = results.filter(result => !result.ok).length;
  console.log(failed ? `PREFLIGHT FAILED: ${failed} of ${results.length} checks failed` : `PREFLIGHT PASSED: ${results.length} of ${results.length} checks`);
  process.exit(failed ? 1 : 0);
}
