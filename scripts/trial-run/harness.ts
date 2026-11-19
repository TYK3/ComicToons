/**
 * Trial-run harness: starts one ComicToons API server, points it at a Twitch channel (or the sample
 * source), samples the existing status endpoints every few seconds and writes a measured report.
 * It never posts to Twitch (the features that write to Twitch are forced off and the harness only
 * talks to the loopback server), keeps the art network off, and never writes inside the repo.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { buildReport, renderMarkdown, type Sample, type SampledPanel, type SampledState, type TrialError, type TrialReport } from './report.ts';

export const DEFAULT_API_PORT = 3125;
export const DEFAULT_WEB_PORT = 4125;
export const DEFAULT_INTERVAL_SECONDS = 5;
export const DIRECTOR_HEADER = 'x-comictoons-director-key';
const CHANNEL = /^[a-zA-Z0-9_]{1,25}$/;
const MAX_MINUTES = 24 * 60;
/** Participation features that would write to Twitch (rewards, polls, predictions, chat replies). */
const TWITCH_WRITE_FLAGS = ['INK_ME', 'TWITCH_POLLS', 'HYPE', 'BOT_REPLIES'];
/** Art provider credentials are blanked so the server cannot reach them even if a flag slipped through. */
const PROVIDER_KEY = /^(CLOUDFLARE|POLLINATIONS|HF|HUGGINGFACE|REPLICATE|STABILITY)_|_(API_KEY|API_TOKEN)(_\d+)?$/;

export interface TrialOptions {
  source: 'twitch' | 'sample'; channel?: string; fixture?: string; minutes: number;
  apiPort: number; webPort: number; intervalSeconds: number; outDir: string; repoRoot: string;
}
export interface ServerHandle {
  pid: number; logPath: string;
  exited(): { code: number | null; signal: string | null } | undefined;
  stop(): Promise<{ code: number | null; signal: string | null }>;
}
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;
export interface TrialDeps {
  env: Record<string, string | undefined>;
  startServer?: (options: { repoRoot: string; outDir: string; env: Record<string, string> }) => Promise<ServerHandle>;
  fetch?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void;
}

export const USAGE = `Usage: npm run trial-run -- --channel <name> --minutes <n> [options]

  --channel <name>     Twitch channel to read (public chat only; nothing is posted)
  --minutes <n>        How long to sample after the source is selected (decimals allowed)
  --source <s>         twitch (default) or sample
  --fixture <id>       With --source sample: replay this fixture at 60x (see GET /api/fixtures)
  --api-port <port>    API server port (default ${DEFAULT_API_PORT})
  --web-port <port>    Web port, reserved and reported; the harness does not start the web UI (default ${DEFAULT_WEB_PORT})
  --interval <s>       Seconds between samples (default ${DEFAULT_INTERVAL_SECONDS})
  --out <dir>          Output folder, must be outside the repo (default: a new folder in the system temp dir)
  --help               Show this text

Art network is always off. The director key, if needed, is read from COMICTOONS_DIRECTOR_KEY and never printed.`;

const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const real = (path: string) => { let probe = resolve(path); const tail: string[] = []; while (!existsSync(probe) && dirname(probe) !== probe) { tail.unshift(probe.slice(dirname(probe).length + 1)); probe = dirname(probe); } return join(realpathSync(probe), ...tail); };

export function assertOutsideRepo(outDir: string, repoRoot: string): void {
  if (inside(real(outDir), real(repoRoot))) throw new Error(`The output folder must be outside the repo (${outDir}).`);
}
export function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error(`Refusing a non-loopback request to ${host}: the trial harness only talks to its own local server (loopback).`);
}
export function directorKey(env: Record<string, string | undefined>): string | undefined {
  const value = (env.COMICTOONS_DIRECTOR_KEY ?? env.PANELCAST_DIRECTOR_KEY)?.trim();
  return value ? value : undefined;
}

const port = (name: string, value: string) => { const number = Number(value); if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error(`${name} must be a port from 1024 to 65535.`); return number; };

export function parseArgs(argv: string[], context: { repoRoot: string; env: Record<string, string | undefined>; now: number }): TrialOptions | { help: true } {
  const values = new Map<string, string>();
  const known = ['--channel', '--minutes', '--source', '--fixture', '--api-port', '--web-port', '--interval', '--out'];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!known.includes(flag)) throw new Error(`Unknown option ${flag}. Try --help.`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    values.set(flag, value);
  }
  const source = values.get('--source') ?? 'twitch';
  if (source !== 'twitch' && source !== 'sample') throw new Error('--source must be twitch or sample.');
  const rawChannel = values.get('--channel');
  if (source === 'twitch' && rawChannel === undefined) throw new Error('--channel is required for the twitch source.');
  if (rawChannel !== undefined && !CHANNEL.test(rawChannel)) throw new Error('--channel must be a Twitch login: 1 to 25 letters, digits or underscores.');
  const minutes = Number(values.get('--minutes'));
  if (!values.has('--minutes') || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) throw new Error(`--minutes must be a number above 0 and at most ${MAX_MINUTES}.`);
  const apiPort = port('--api-port', values.get('--api-port') ?? String(DEFAULT_API_PORT));
  const webPort = port('--web-port', values.get('--web-port') ?? String(DEFAULT_WEB_PORT));
  if (apiPort === webPort) throw new Error('--api-port and --web-port must differ.');
  const intervalSeconds = Number(values.get('--interval') ?? DEFAULT_INTERVAL_SECONDS);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 300) throw new Error('--interval must be from 1 to 300 seconds.');
  const stamp = new Date(context.now).toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(values.get('--out') ?? join(tmpdir(), `comictoons-trial-${stamp}`));
  assertOutsideRepo(outDir, context.repoRoot);
  return { source, channel: source === 'twitch' ? rawChannel!.toLowerCase() : undefined, fixture: values.get('--fixture'), minutes, apiPort, webPort, intervalSeconds, outDir, repoRoot: context.repoRoot };
}

/** The server's environment: art network off under both prefixes, provider keys blanked, Twitch writes off. */
export function serverEnv(env: Record<string, string | undefined>, options: { apiPort: number; outDir: string }): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = PROVIDER_KEY.test(name) ? '' : value;
  for (const prefix of ['COMICTOONS', 'PANELCAST']) {
    result[`${prefix}_ART_NETWORK`] = '0';
    for (const flag of TWITCH_WRITE_FLAGS) result[`${prefix}_FLAG_${flag}`] = '0';
  }
  result.COMICTOONS_ART_CACHE_DIR = join(options.outDir, 'art-cache');
  result.PANELCAST_ART_CACHE_DIR = result.COMICTOONS_ART_CACHE_DIR;
  result.COMICTOONS_API_PORT = String(options.apiPort);
  delete result.PANELCAST_API_PORT;
  return result;
}

/** Starts `apps/server/src/index.ts` in its own Node process; stop() signals only that exact PID.
 * extraImports (default none) are preloaded with their own `--import`, in order, before the server
 * entry point; `--signed-in` uses this to install its fetch allowlist before any app code runs. */
export async function startServer(options: { repoRoot: string; outDir: string; env: Record<string, string>; extraImports?: string[] }): Promise<ServerHandle> {
  const logPath = join(options.outDir, 'server.log');
  const fd = openSync(logPath, 'a');
  const tsx = import.meta.resolve('tsx');
  const child = spawn(process.execPath, ['--import', tsx, ...(options.extraImports ?? []).flatMap(path => ['--import', path]), join(options.repoRoot, 'apps', 'server', 'src', 'index.ts')], { cwd: options.outDir, env: options.env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const pid = child.pid;
  if (pid === undefined) throw new Error('The server process did not start.');
  let exit: { code: number | null; signal: string | null } | undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>(done => child.once('exit', (code, signal) => { exit = { code, signal }; done(exit); }));
  return {
    pid, logPath,
    exited: () => exit,
    async stop() {
      if (exit) return exit;
      process.kill(pid, 'SIGTERM');
      const timeout = new Promise<undefined>(done => setTimeout(() => done(undefined), 5_000));
      if (await Promise.race([exited, timeout])) return exit!;
      if (!exit) process.kill(pid, 'SIGKILL');
      return exited;
    },
  };
}

const trimPanels = (list: unknown): SampledPanel[] => Array.isArray(list)
  ? list.map(panel => { const item = panel as Record<string, unknown>; return { id: String(item.id), origin: typeof item.origin === 'string' ? item.origin : undefined, momentKind: typeof item.momentKind === 'string' ? item.momentKind : undefined }; })
  : [];
/** Keeps only what the report reads: never captions, quotes or chat text. */
function trimState(body: Record<string, unknown>): SampledState {
  const source = (body.source ?? {}) as Record<string, unknown>;
  const pick = <T>(value: unknown, type: string) => (typeof value === type ? value as T : undefined);
  return {
    status: pick<string>(body.status, 'string'),
    source: { requested: pick(source.requested, 'string'), active: pick(source.active, 'string'), connection: pick(source.connection, 'string'), reason: pick(source.reason, 'string'), channel: pick(source.channel, 'string'), simulated: pick(source.simulated, 'boolean'), received: pick(source.received, 'number') },
    panels: trimPanels(body.panels), pendingPanels: trimPanels(body.pendingPanels),
  };
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Error lines from the server's JSON log (level 50 and above), message only. */
export function serverLogErrors(logPath: string): TrialError[] {
  if (!existsSync(logPath)) return [];
  const errors: TrialError[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as { level?: number; time?: number; msg?: string; err?: { message?: string } };
      if ((entry.level ?? 0) >= 50) errors.push({ at: entry.time ?? 0, where: 'server log', message: String(entry.err?.message ?? entry.msg ?? 'error').slice(0, 300) });
    } catch { /* not a log entry */ }
  }
  return errors;
}

export async function runTrial(options: TrialOptions, deps: TrialDeps): Promise<{ report: TrialReport; files: string[] }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const log = deps.log ?? (message => console.log(message));
  assertOutsideRepo(options.outDir, options.repoRoot);
  mkdirSync(options.outDir, { recursive: true });
  const key = directorKey(deps.env);
  const redact = (text: string) => (key ? text.split(key).join('[redacted]') : text);
  const base = `http://127.0.0.1:${options.apiPort}`;
  const errors: TrialError[] = [];
  const samples: Sample[] = [];
  const samplesPath = join(options.outDir, 'samples.jsonl');
  writeFileSync(samplesPath, '');

  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const url = `${base}${path}`;
    assertLoopback(url);
    const headers: Record<string, string> = key ? { [DIRECTOR_HEADER]: key } : {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(url, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  const startedAt = now();
  const start = deps.startServer ?? startServer;
  let server: ServerHandle | undefined;
  let ingestStartedAt: number | undefined;
  let serverExit: { code: number | null; signal: string | null } | undefined;
  try {
    server = await start({ repoRoot: options.repoRoot, outDir: options.outDir, env: serverEnv(deps.env, { apiPort: options.apiPort, outDir: options.outDir }) });
    log(`server started, pid ${server.pid}, log ${server.logPath}`);
    // Readiness: the Twitch status endpoint answers once the server listens.
    let ready = false;
    for (const deadline = now() + 30_000; now() < deadline && !server.exited();) {
      try { await call('/api/twitch/status'); ready = true; break; } catch { await sleep(500); }
    }
    if (!ready) throw new Error(server.exited() ? `the server exited before it was ready (code ${server.exited()!.code})` : 'the server was not ready within 30 s');
    await call('/api/ingest', { method: 'POST', body: options.source === 'twitch' ? { mode: 'twitch', channel: options.channel } : { mode: 'sample' } });
    if (options.source === 'sample' && options.fixture) await call('/api/replay', { method: 'POST', body: { fixtureId: options.fixture, speed: 60 } });
    ingestStartedAt = now();
    log(`source selected: ${options.source}${options.channel ? ` #${options.channel}` : ''}; sampling every ${options.intervalSeconds} s for ${options.minutes} min`);
    const end = ingestStartedAt + options.minutes * 60_000;
    for (;;) {
      const sample: Sample = { at: now() };
      try { sample.state = trimState(await call('/api/state')); } catch (error) { sample.stateError = messageOf(error); }
      try { const body = await call('/api/participation/status'); sample.participation = { received: typeof body.received === 'number' ? body.received : undefined, helix: typeof body.helix === 'string' ? body.helix : undefined }; } catch (error) { sample.participationError = messageOf(error); }
      try { const body = await call('/api/twitch/status'); sample.twitch = { connected: typeof body.connected === 'boolean' ? body.connected : undefined, channel: typeof body.channel === 'string' ? body.channel : undefined }; } catch (error) { sample.twitchError = messageOf(error); }
      samples.push(sample);
      appendFileSync(samplesPath, `${redact(JSON.stringify(sample))}\n`);
      const exit = server.exited();
      if (exit) { errors.push({ at: now(), where: 'server', message: `server exited early (code ${exit.code ?? 'none'}, signal ${exit.signal ?? 'none'})` }); break; }
      const left = end - now();
      if (left <= 0) break;
      await sleep(Math.min(options.intervalSeconds * 1000, left));
    }
  } catch (error) {
    errors.push({ at: now(), where: 'harness', message: messageOf(error) });
  } finally {
    if (server) {
      serverExit = server.exited() ?? await server.stop().catch(error => { errors.push({ at: now(), where: 'harness', message: `stopping pid ${server!.pid}: ${messageOf(error)}` }); return undefined; });
      log(`server pid ${server.pid} stopped (${serverExit ? `code ${serverExit.code ?? 'none'}, signal ${serverExit.signal ?? 'none'}` : 'unknown'})`);
      errors.push(...serverLogErrors(server.logPath));
    }
  }
  const endedAt = now();
  const report = buildReport({
    source: options.source, channel: options.channel, fixture: options.fixture, requestedMinutes: options.minutes,
    apiPort: options.apiPort, webPort: options.webPort, intervalSeconds: options.intervalSeconds, outDir: options.outDir,
    serverPid: server?.pid, serverExit, startedAt, ingestStartedAt, endedAt, directorKeySet: key !== undefined, errors, samples,
  });
  const jsonPath = join(options.outDir, 'trial-report.json');
  const markdownPath = join(options.outDir, 'trial-report.md');
  writeFileSync(jsonPath, `${redact(JSON.stringify(report, null, 2))}\n`);
  writeFileSync(markdownPath, redact(renderMarkdown(report)));
  return { report, files: [markdownPath, jsonPath, samplesPath] };
}
