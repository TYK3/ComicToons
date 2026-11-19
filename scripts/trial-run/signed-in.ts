/**
 * `trial-run --signed-in`: drives the existing /auth/twitch/login and /auth/twitch/callback
 * routes to sign in, lets the app's own EventSub bridge subscribe to read-only event types, and
 * reports what arrived (counts by type only — never chat text or viewer names). A hard allowlist
 * (signed-in-allowlist.ts), installed in the server's own process before any app code runs, makes
 * every write to Twitch throw instead of sending. A real sign-in additionally refuses to start
 * unless Young's explicit opt-in is set; --fake instead runs entirely against the local mock
 * Twitch (scripts/twitch-mock), so a dry run needs no real account, no browser and no real keys.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { FakeTwitch } from '../twitch-mock/fake-twitch.ts';
import { assertOutsideRepo, assertLoopback, serverEnv, serverLogErrors, startServer as realStartServer, type ServerHandle } from './harness.ts';
import type { TrialError } from './report.ts';
import { checkAllowed } from './signed-in-allowlist.ts';
import { startLanding, type LandingHandle } from './signed-in-landing.ts';

export const REAL_RUN_OPT_IN_ENV = 'COMICTOONS_SIGNED_IN_REAL_RUN';
/** The exact value Young must set after he says yes; anything else (including truthy-looking values) still refuses. */
export const REAL_RUN_OPT_IN_VALUE = 'young-approved';
export const DEFAULT_SIGNED_IN_API_PORT = 3118; // default API port for a --fake dry run (kept off the app's usual 3001)
export const DEFAULT_SIGNED_IN_WEB_PORT = 4118; // default web port for a --fake dry run
/** A real run must listen where the registered redirect URI points: http://localhost:3001/auth/twitch/callback. */
export const REAL_RUN_API_PORT = 3001;
const DEFAULT_TIMEOUT_MS = 20_000;
/** A real run waits for a person to click Authorize, so it gets longer by default. */
const REAL_RUN_TIMEOUT_MS = 180_000;
/** After a real run sees the sign-in, how long it keeps the landing page up for the browser to arrive. */
export const LANDING_GRACE_MS = 15_000;
/** Where the app's callback sends the browser (apps/server/src/twitch/routes.ts); the run serves a plain page there. */
export const landingUrl = (webPort: number) => `http://localhost:${webPort}/ui.html#/connect?twitch=connected`;

export const USAGE_SIGNED_IN = `Usage: npm run trial-run -- --signed-in [--fake] [options]

  --fake               Dry run against the local mock Twitch (scripts/twitch-mock); no real account,
                        browser or keys needed. Without --fake this prepares a REAL sign-in, which
                        refuses to start unless ${REAL_RUN_OPT_IN_ENV}=${REAL_RUN_OPT_IN_VALUE} is set.
  --api-port <port>    API server port (default ${DEFAULT_SIGNED_IN_API_PORT} with --fake, ${REAL_RUN_API_PORT} for a real run)
  --web-port <port>    Web port; the run serves the plain "Connected as ..." page the sign-in callback lands on (default ${DEFAULT_SIGNED_IN_WEB_PORT})
  --timeout <s>        How long to wait for sign-in and subscriptions to complete (default ${DEFAULT_TIMEOUT_MS / 1000} with --fake, ${REAL_RUN_TIMEOUT_MS / 1000} for a real run)
  --out <dir>          Output folder, must be outside the repo (default: a new folder in the system temp dir)
  --help               Show this text

This mode never posts chat, starts a poll or prediction, creates or changes a reward, or updates a
redemption; every outbound request is checked against a hard allowlist before it is sent. See
docs/SIGNED_IN_RUN.md for the full runbook.`;

export interface SignedInOptions { fake: boolean; apiPort: number; webPort: number; outDir: string; repoRoot: string; timeoutMs: number }

/** True only when the raw CLI argv asks for this mode; every existing trial-run invocation returns false. */
export function wantsSignedIn(argv: string[]): boolean { return argv.includes('--signed-in'); }

/** Refuses a real sign-in before any server starts or any request is sent, unless Young's exact opt-in is set. --fake never needs it. */
export function assertRealRunApproved(env: Record<string, string | undefined>, fake: boolean): void {
  if (fake) return;
  if (env[REAL_RUN_OPT_IN_ENV] === REAL_RUN_OPT_IN_VALUE) return;
  throw new Error(`A real Twitch sign-in needs Young's explicit yes first. Set ${REAL_RUN_OPT_IN_ENV}=${REAL_RUN_OPT_IN_VALUE} only after he says go, or pass --fake for a local dry run against the mock Twitch.`);
}

const port = (name: string, value: string) => { const number = Number(value); if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error(`${name} must be a port from 1024 to 65535.`); return number; };

export function parseSignedInArgs(argv: string[], context: { repoRoot: string; now: number }): SignedInOptions | { help: true } {
  const values = new Map<string, string>();
  const known = ['--api-port', '--web-port', '--timeout', '--out'];
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--fake' || arg === '--signed-in') { flags.add(arg); continue; }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!known.includes(flag)) throw new Error(`Unknown option ${flag} for --signed-in. Try --help.`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    values.set(flag, value);
  }
  const fake = flags.has('--fake');
  const apiPort = port('--api-port', values.get('--api-port') ?? String(fake ? DEFAULT_SIGNED_IN_API_PORT : REAL_RUN_API_PORT));
  const webPort = port('--web-port', values.get('--web-port') ?? String(DEFAULT_SIGNED_IN_WEB_PORT));
  if (apiPort === webPort) throw new Error('--api-port and --web-port must differ.');
  const timeoutSeconds = Number(values.get('--timeout') ?? (fake ? DEFAULT_TIMEOUT_MS : REAL_RUN_TIMEOUT_MS) / 1000);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) throw new Error('--timeout must be from 0 to 600 seconds.');
  const stamp = new Date(context.now).toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(values.get('--out') ?? join(tmpdir(), `comictoons-signed-in-${stamp}`));
  assertOutsideRepo(outDir, context.repoRoot);
  return { fake, apiPort, webPort, outDir, repoRoot: context.repoRoot, timeoutMs: timeoutSeconds * 1000 };
}

function join(...parts: string[]): string { return resolve(parts[0]!, ...parts.slice(1)); }

/** What scripts/trial-run/signed-in.ts needs from a stand-in for the local mock Twitch. */
export interface FakeHandle {
  appEnv(): Record<string, string>;
  log: { at: number; kind: string; detail: Record<string, string | number | boolean | undefined> }[];
  secretValues(): string[];
  /** Fires a few read-only, already-public events so a dry run has something to report. */
  scenario(): void;
  stop(): Promise<void>;
}

async function defaultFake(apiPort: number): Promise<FakeHandle> {
  const fake = new FakeTwitch({ port: 0, redirectUris: [`http://127.0.0.1:${apiPort}/auth/twitch/callback`] });
  await fake.start();
  return {
    appEnv: () => fake.appEnv(),
    log: fake.log,
    secretValues: () => fake.secretValues(),
    scenario: () => { fake.chat('viewer1', 'hello from the dry run'); fake.raid('raider1', 12); fake.hypeTrain(1, 500); },
    stop: () => fake.stop(),
  };
}

type FetchLike = (url: string, init?: { method?: string; redirect?: 'manual' | 'follow' | 'error' }) => Promise<Response>;
export interface SignedInDeps {
  env: Record<string, string | undefined>;
  now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void;
  fetch?: FetchLike;
  startServer?: (options: { repoRoot: string; outDir: string; env: Record<string, string>; extraImports?: string[] }) => Promise<ServerHandle>;
  createFake?: (apiPort: number) => Promise<FakeHandle>;
}

export type Metric = { value: number; note?: string } | { gap: string };
export type CountsMetric = { value: Record<string, number> } | { gap: string };
export interface SignedInReport {
  run: {
    fake: boolean; apiPort: number; webPort: number; outDir: string; serverPid?: number;
    startedAt: string; endedAt: string; durationSeconds: number; timedOut: boolean;
  };
  connected: boolean; channel?: string; requestedScopes: string[];
  eventSub: { state?: string; subscribedTypes: string[]; failed: { type: string; error: string }[]; totalNotifications: Metric };
  eventCountsByType: CountsMetric;
  /** The plain page the callback lands on: where it is, what the run's own check of it saw, and how many times it was opened. */
  landing: { url: string; status?: number; connected?: boolean; hits: number };
  writeAttemptsBlocked: number;
  errors: { at: string; where: string; message: string }[];
}

const iso = (at: number) => new Date(at).toISOString();

function tally(entries: { kind: string; detail: Record<string, unknown> }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.kind !== 'eventsub.notify') continue;
    const type = String(entry.detail.type ?? 'unknown');
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

export function renderSignedInMarkdown(report: SignedInReport): string {
  const lines = [
    `# ComicToons signed-in dry run (${report.run.fake ? 'fake Twitch' : 'real Twitch'})`,
    '', 'Every number below was measured in this run; nothing here is chat text or a viewer name.', '',
    '## Run', '', '| Setting | Value |', '|---|---|',
    `| Mode | ${report.run.fake ? 'fake (local mock Twitch)' : 'real (needs Young’s yes)'} |`,
    `| API port | ${report.run.apiPort} |`, `| Web port | ${report.run.webPort} |`,
    `| Server PID | ${report.run.serverPid ?? 'GAP: the server did not start'} |`,
    `| Started (UTC) | ${report.run.startedAt} |`, `| Ended (UTC) | ${report.run.endedAt} |`,
    `| Duration (s) | ${report.run.durationSeconds} |`, `| Timed out waiting for sign-in/subscriptions | ${report.run.timedOut} |`,
    '', '## Sign-in', '', '| Item | Value |', '|---|---|', `| Connected | ${report.connected} |`, `| Channel | ${report.channel ?? 'none'} |`,
    `| Requested scopes | ${report.requestedScopes.join(', ') || 'none'} |`, '',
    '## EventSub (read-only types only)', '', '| Item | Value |', '|---|---|', `| State | ${report.eventSub.state ?? 'unknown'} |`,
    `| Subscribed types | ${report.eventSub.subscribedTypes.join(', ') || 'none'} |`,
    `| Failed subscriptions | ${report.eventSub.failed.map(f => `${f.type}: ${f.error}`).join('; ') || 'none'} |`,
    `| Total notifications | ${'value' in report.eventSub.totalNotifications ? report.eventSub.totalNotifications.value : `GAP: ${report.eventSub.totalNotifications.gap}`} |`,
    `| Counts by type | ${'value' in report.eventCountsByType && report.eventCountsByType.value ? Object.entries(report.eventCountsByType.value).map(([type, count]) => `${type}: ${count}`).join(', ') || 'none yet' : `GAP: ${'gap' in report.eventCountsByType ? report.eventCountsByType.gap : ''}`} |`,
    '', '## Landing page', '', '| Item | Value |', '|---|---|', `| URL | ${report.landing.url} |`,
    `| Checked by the run (fake only) | ${report.landing.status === undefined ? 'not checked' : `HTTP ${report.landing.status}, ${report.landing.connected ? 'says connected' : 'does not say connected'}`} |`,
    `| Times opened | ${report.landing.hits} |`,
    '', '## Safety', '', '| Item | Value |', '|---|---|', `| Write attempts blocked by the allowlist | ${report.writeAttemptsBlocked} |`,
    '', report.writeAttemptsBlocked > 0 ? '**A write was attempted and blocked. Investigate before any real run.**' : 'No write was ever attempted; every outbound request matched a read-only allowlist entry.',
    '', '## Errors', '',
  ];
  if (report.errors.length) lines.push('| Time (UTC) | Where | Message |', '|---|---|---|', ...report.errors.map(e => `| ${e.at} | ${e.where} | ${e.message} |`));
  else lines.push('None.');
  return `${lines.join('\n')}\n`;
}

export async function runSignedIn(options: SignedInOptions, deps: SignedInDeps): Promise<{ report: SignedInReport; files: string[] }> {
  assertRealRunApproved(deps.env, options.fake);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const log = deps.log ?? (message => console.log(message));
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  assertOutsideRepo(options.outDir, options.repoRoot);
  mkdirSync(options.outDir, { recursive: true });
  const base = `http://127.0.0.1:${options.apiPort}`;
  const startedAt = now();
  const errors: TrialError[] = [];
  const call = async (path: string, init: { method?: string; redirect?: 'manual' | 'follow' | 'error' } = {}) => {
    const url = `${base}${path}`;
    assertLoopback(url);
    return fetchImpl(url, { method: init.method ?? 'GET', redirect: init.redirect ?? 'follow' });
  };

  let fakeHandle: FakeHandle | undefined;
  let extraEnv: Record<string, string> = {};
  if (options.fake) {
    fakeHandle = await (deps.createFake ?? defaultFake)(options.apiPort);
    extraEnv = fakeHandle.appEnv();
  }
  const guardPath = fileURLToPath(new URL('./signed-in-guard.ts', import.meta.url));
  const env = { ...serverEnv(deps.env, { apiPort: options.apiPort, outDir: options.outDir }), ...extraEnv,
    COMICTOONS_WEB_PORT: String(options.webPort),
    // Narrows the OAuth scope request to just the six read-only scopes the 16 read-only EventSub
    // types need (apps/server/src/twitch/config.ts); every other trial-run mode leaves this unset.
    COMICTOONS_OAUTH_SCOPES_READONLY: '1' };
  const start = deps.startServer ?? ((o: Parameters<typeof realStartServer>[0]) => realStartServer({ ...o, extraImports: [...(o.extraImports ?? []), guardPath] }));

  let server: ServerHandle | undefined;
  let landing: LandingHandle | undefined;
  const landingReport: SignedInReport['landing'] = { url: landingUrl(options.webPort), hits: 0 };
  let connected = false; let channel: string | undefined; let requestedScopes: string[] = [];
  let eventSubState: string | undefined; let subscribedTypes: string[] = []; let failed: { type: string; error: string }[] = [];
  let totalNotifications: number | undefined;
  let timedOut = false;
  try {
    // Up before the server, so a busy web port fails the run before anyone signs in.
    landing = await startLanding(options.webPort, async () => {
      const status = await (await call('/api/twitch/status')).json() as { connected?: boolean; channel?: string };
      return { connected: !!status.connected, channel: status.channel };
    });
    server = await start({ repoRoot: options.repoRoot, outDir: options.outDir, env });
    log(`server started, pid ${server.pid}, log ${server.logPath}`);
    let ready = false;
    for (const deadline = now() + 30_000; now() < deadline && !server.exited();) {
      try { const response = await call('/api/twitch/status'); if (response.ok) { ready = true; break; } } catch { /* not listening yet */ }
      await sleep(300);
    }
    if (!ready) throw new Error(server.exited() ? `the server exited before it was ready (code ${server.exited()!.code})` : 'the server was not ready within 30 s');

    if (options.fake) {
      const loginResponse = await call('/auth/twitch/login', { redirect: 'manual' });
      if (loginResponse.status !== 302) throw new Error(`/auth/twitch/login returned ${loginResponse.status}, expected a redirect to Twitch`);
      const authorizeUrl = loginResponse.headers.get('location');
      if (!authorizeUrl) throw new Error('/auth/twitch/login did not return a redirect location');
      checkAllowed({ method: 'GET', url: authorizeUrl });
      // Stands in for Young clicking "Authorize" in the box browser; a real run never fetches this itself.
      const authorizeResponse = await fetchImpl(authorizeUrl, { redirect: 'manual' });
      const callbackUrl = authorizeResponse.headers.get('location');
      if (!callbackUrl) throw new Error('the mock Twitch did not redirect back to the callback');
      assertLoopback(callbackUrl);
      const callbackResponse = await fetchImpl(callbackUrl, { redirect: 'manual' });
      if (callbackResponse.status !== 302) throw new Error(`the sign-in callback returned ${callbackResponse.status}`);
      // Stands in for the browser following the callback's redirect to the landing page.
      const landedAt = callbackResponse.headers.get('location');
      if (!landedAt) throw new Error('the sign-in callback did not redirect to a landing page');
      assertLoopback(landedAt);
      landingReport.url = landedAt;
      const landingResponse = await fetchImpl(landedAt, { redirect: 'manual' });
      landingReport.status = landingResponse.status;
      landingReport.connected = /Connected as /.test(await landingResponse.text());
    } else {
      log(`Open this in the box browser, signed in as the channel to monitor: http://localhost:${options.apiPort}/auth/twitch/login`);
      log('Waiting for sign-in to finish on Twitch (this script never opens a browser or drives it itself)...');
    }

    const deadline = now() + options.timeoutMs;
    for (;;) {
      const status = await (await call('/api/twitch/status')).json() as { connected?: boolean; channel?: string; requestedScopes?: string[] };
      const eventSub = await (await call('/api/participation/eventsub')).json() as { state?: string; subscribed?: string[]; failed?: { type: string; error: string }[]; notifications?: number };
      connected = !!status.connected; channel = status.channel; requestedScopes = status.requestedScopes ?? [];
      eventSubState = eventSub.state; subscribedTypes = eventSub.subscribed ?? []; failed = eventSub.failed ?? []; totalNotifications = eventSub.notifications;
      if (connected && eventSubState === 'subscribed') break;
      if (server.exited()) { errors.push({ at: now(), where: 'server', message: 'server exited while waiting for sign-in' }); break; }
      if (now() > deadline) { timedOut = true; break; }
      await sleep(300);
    }

    if (!options.fake && connected && landing.hits === 0) {
      log('Signed in. Waiting for the browser to land on the "Connected as ..." page...');
      for (const graceEnd = now() + LANDING_GRACE_MS; landing.hits === 0 && now() < graceEnd;) await sleep(100);
    }

    if (options.fake && fakeHandle && connected) {
      fakeHandle.scenario(); await sleep(600);
      // Re-read the app's own count so the report reflects the events that just arrived.
      const after = await (await call('/api/participation/eventsub')).json() as { notifications?: number };
      if (typeof after.notifications === 'number') totalNotifications = after.notifications;
    }
  } catch (error) {
    errors.push({ at: now(), where: 'harness', message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (landing) { landingReport.hits = landing.hits; await landing.stop().catch(() => undefined); }
    if (server) { await server.stop().catch(error => errors.push({ at: now(), where: 'harness', message: `stopping pid ${server!.pid}: ${error instanceof Error ? error.message : String(error)}` })); }
    if (fakeHandle) await fakeHandle.stop().catch(() => undefined);
  }
  if (server) errors.push(...serverLogErrors(server.logPath));

  const writeAttemptsBlocked = errors.filter(e => /SignedInAllowlistViolation|not on the read-only allowlist/.test(e.message)).length;
  const endedAt = now();
  const eventCountsByType: SignedInReport['eventCountsByType'] = fakeHandle
    ? { value: tally(fakeHandle.log) }
    : { gap: 'no local mock Twitch in a real run; Twitch keeps no after-the-fact count of notifications delivered' };
  const report: SignedInReport = {
    run: { fake: options.fake, apiPort: options.apiPort, webPort: options.webPort, outDir: options.outDir, serverPid: server?.pid,
      startedAt: iso(startedAt), endedAt: iso(endedAt), durationSeconds: Math.round((endedAt - startedAt) / 100) / 10, timedOut },
    connected, channel, requestedScopes,
    eventSub: { state: eventSubState, subscribedTypes, failed, totalNotifications: totalNotifications === undefined ? { gap: 'no successful /api/participation/eventsub sample' } : { value: totalNotifications } },
    eventCountsByType, landing: landingReport, writeAttemptsBlocked,
    errors: errors.map(e => ({ at: iso(e.at), where: e.where, message: e.message })),
  };
  const jsonPath = join(options.outDir, 'signed-in-report.json');
  const markdownPath = join(options.outDir, 'signed-in-report.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderSignedInMarkdown(report));
  return { report, files: [markdownPath, jsonPath] };
}

export async function runSignedInCli(argv: string[], context: { repoRoot: string; env: Record<string, string | undefined>; now: number }): Promise<void> {
  const rest = argv.filter(arg => arg !== '--signed-in');
  let options: SignedInOptions | { help: true };
  try { options = parseSignedInArgs(rest, context); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); console.error(USAGE_SIGNED_IN); process.exitCode = 2; return; }
  if ('help' in options) { console.log(USAGE_SIGNED_IN); return; }
  try { assertRealRunApproved(context.env, options.fake); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; return; }
  const { report, files } = await runSignedIn(options, { env: context.env });
  console.log(`connected: ${report.connected}; eventsub: ${report.eventSub.state ?? 'unknown'}; subscribed types: ${report.eventSub.subscribedTypes.length}; writes blocked: ${report.writeAttemptsBlocked}; errors: ${report.errors.length}`);
  if ('value' in report.eventCountsByType && report.eventCountsByType.value) {
    for (const [type, count] of Object.entries(report.eventCountsByType.value)) console.log(`  ${type}: ${count}`);
  }
  for (const file of files) console.log(`wrote ${file}`);
  process.exitCode = report.connected && report.eventSub.state === 'subscribed' && report.writeAttemptsBlocked === 0 ? 0 : 1;
}
