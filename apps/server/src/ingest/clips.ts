import { safeText, type StreamEvent } from '@comictoons/core';
import type { ClipRef } from '../pipeline/frames.ts';
import { HELIX_BASE, rateLimitWaitMs } from '../twitch-api/helix.ts';
import { TwitchApiError, TwitchSignedOutError } from '../twitch-api/errors.ts';
import type { FetchLike, TwitchAuthProvider } from '../twitch-api/types.ts';

/**
 * CLIP-WATCH-1: read-only Helix Get Clips (GET /helix/clips, app or user access token, no scope;
 * https://dev.twitch.tv/docs/api/reference/#get-clips, checked 31 Oct 2026). EventSub has no clip
 * event, so while a session is Live the poller asks for the broadcaster's clips since the last
 * one it saw, every 30 s, and emits each new clip once as a 'clip' StreamEvent. The clip-cluster
 * rule (stepClipCluster) is a pure function so the moment detector only needs a small hook.
 */

/** One clip, trimmed to what the studio and IMPORT-1 use. `createdAt` is epoch ms. */
export interface HelixClip { id: string; url: string; thumbnailUrl: string; viewCount: number; createdAt: number; title: string; creatorName?: string }
/** The same auth abstraction and options the Helix client takes (twitch-api/helix.ts). */
export interface ClipsClient { auth: TwitchAuthProvider; baseUrl?: string; fetch?: FetchLike }
export interface GetClipsQuery {
  broadcasterId: string;
  /** Epoch ms, a Date or an RFC3339 string. Helix defaults ended_at to started_at plus one week. */
  startedAt?: number | Date | string;
  endedAt?: number | Date | string;
  /** Pages of up to 100 clips; capped at CLIPS_MAX_PAGES. */
  maxPages?: number;
  pageSize?: number;
}
export interface GetClipsResult { clips: HelixClip[]; pages: number; /** A cursor was left over when the page cap was hit. */ truncated: boolean }

/** Helix returns about 1,000 clips over all pages; 10 pages of 100 is that ceiling. */
export const CLIPS_MAX_PAGES = 10;
export const CLIP_POLL_INTERVAL_MS = 30_000;
/** Longest wait between polls after repeated 429s or failures without a Ratelimit-Reset header. */
export const CLIP_MAX_BACKOFF_MS = 300_000;
const SEEN_LIMIT = 10_000;

/** A 429 from Get Clips. getClips never sleeps on it; the caller decides when to try again. */
export class ClipsRateLimitedError extends TwitchApiError {
  constructor(readonly retryAfterMs: number, readonly hasReset: boolean) {
    super(429, 'Twitch asked us to slow down.', 'GET /clips');
    this.name = 'ClipsRateLimitedError';
  }
}

const rfc3339 = (value: number | Date | string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return new Date(value).toISOString();
};
/**
 * Allow-lists a clip's url/thumbnail_url before it leaves toClip: the thumbnail is fetched
 * server-side by inkClipFrame and the clip url is rendered as an <a href>, so only a plain
 * https link (no userinfo, no explicit port, not even :443, and not one hidden by a tab, LF,
 * CR or backslash) is let through. For `kind: 'thumbnail'` (the default) that link must be to
 * clips.twitch.tv or a *.jtvnw.net subdomain. For `kind: 'clip'` it may also be to www.twitch.tv
 * or twitch.tv, but only for the exact Get Clips path shape '/<channel>/clip/<slug>' (an optional
 * single trailing slash is allowed); real Helix clips carry that `url`, not a clips.twitch.tv one.
 */
export function safeClipUrl(value: unknown, kind: 'clip' | 'thumbnail' = 'thumbnail'): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  // url.port is '' for an explicit ':443' (the parser normalises it away), so the raw authority is
  // checked as well. The parser silently drops tab/LF/CR and reads '\' as '/' for https, so the raw
  // text is treated the same way first; otherwise ':8\t443' or ':8443\a' slips past the raw check.
  if (url.protocol !== 'https:' || url.username || url.password || url.port !== '') return undefined;
  const stripped = value.replace(/[\t\n\r]/g, '');
  const authority = stripped.slice(stripped.indexOf('://') + 3).split(/[/\\?#]/)[0]!;
  const hostport = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  if (/:\d*$/.test(hostport)) return undefined;
  // Exact match and the '.jtvnw.net' suffix also reject a trailing-dot host ('clips.twitch.tv.').
  const host = url.hostname;
  const isJtvnw = host.endsWith('.jtvnw.net') && host.length > '.jtvnw.net'.length;
  if (host === 'clips.twitch.tv' || isJtvnw) return url.href;
  // A query string or fragment is allowed here too, exactly as it already is for clips.twitch.tv:
  // Helix never sends either on this field, but neither changes what the link points at.
  if (kind === 'clip' && (host === 'www.twitch.tv' || host === 'twitch.tv') && /^\/[A-Za-z0-9_]{1,25}\/clip\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return url.href;
  return undefined;
}

type RawClip = { id?: unknown; url?: unknown; thumbnail_url?: unknown; view_count?: unknown; created_at?: unknown; title?: unknown; creator_name?: unknown };
function toClip(raw: RawClip): HelixClip | undefined {
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  const url = safeClipUrl(raw.url, 'clip');
  if (!url) return undefined;
  const createdAt = Date.parse(typeof raw.created_at === 'string' ? raw.created_at : '');
  if (!Number.isFinite(createdAt)) return undefined;
  return { id: raw.id, url, thumbnailUrl: safeClipUrl(raw.thumbnail_url) ?? '',
    viewCount: typeof raw.view_count === 'number' && Number.isFinite(raw.view_count) ? raw.view_count : 0, createdAt,
    title: typeof raw.title === 'string' ? raw.title : '', creatorName: typeof raw.creator_name === 'string' ? raw.creator_name : undefined };
}

/**
 * Every clip of one broadcaster in a time window, following pagination.cursor up to maxPages.
 * Reusable by IMPORT-1. 401: refresh() once and retry. 429: ClipsRateLimitedError (no wait here).
 * Any other non-2xx: TwitchApiError. Read only: GET, nothing else.
 */
export async function getClips(client: ClipsClient, query: GetClipsQuery): Promise<GetClipsResult> {
  const fetchImpl: FetchLike = client.fetch ?? ((input, init) => fetch(input, init));
  const maxPages = Math.max(1, Math.min(CLIPS_MAX_PAGES, Math.floor(query.maxPages ?? CLIPS_MAX_PAGES)));
  const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize ?? 100)));
  const clips: HelixClip[] = [];
  let cursor: string | undefined; let pages = 0; let refreshed = false;
  while (pages < maxPages) {
    const auth = await client.auth.getAuth();
    if (!auth) throw new TwitchSignedOutError();
    const url = new URL(`${(client.baseUrl ?? HELIX_BASE).replace(/\/$/, '')}/clips`);
    url.searchParams.set('broadcaster_id', query.broadcasterId);
    const started = rfc3339(query.startedAt); const ended = rfc3339(query.endedAt);
    if (started) url.searchParams.set('started_at', started);
    if (ended) url.searchParams.set('ended_at', ended);
    url.searchParams.set('first', String(pageSize));
    if (cursor) url.searchParams.set('after', cursor);
    const response = await fetchImpl(url, { method: 'GET', headers: { 'Client-Id': auth.clientId, Authorization: `Bearer ${auth.accessToken}` } });
    if (response.status === 401 && !refreshed) { refreshed = true; await client.auth.refresh(); continue; }
    if (response.status === 429) {
      const reset = response.headers.get('Ratelimit-Reset');
      throw new ClipsRateLimitedError(rateLimitWaitMs(reset, Date.now()), !!reset && Number.isFinite(Number(reset)));
    }
    if (!response.ok) throw new TwitchApiError(response.status, `Twitch answered ${response.status}.`, 'GET /clips');
    const body = await response.json() as { data?: RawClip[]; pagination?: { cursor?: unknown } };
    pages++;
    for (const raw of body.data ?? []) { const clip = toClip(raw); if (clip) clips.push(clip); }
    cursor = typeof body.pagination?.cursor === 'string' && body.pagination.cursor ? body.pagination.cursor : undefined;
    if (!cursor) return { clips, pages, truncated: false };
  }
  return { clips, pages, truncated: !!cursor };
}

/**
 * An app access token (OAuth client credentials, https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow)
 * behind the existing TwitchAuthProvider shape. The token stays in memory and is never logged.
 * broadcasterId and login are empty: Get Clips takes broadcaster_id as a query parameter.
 */
export function createAppTokenAuth(options: { clientId: string; clientSecret: string; authBaseUrl?: string; fetch?: FetchLike; now?: () => number }): TwitchAuthProvider {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  let token: { accessToken: string; expiresAt: number } | undefined;
  let pending: Promise<void> | undefined;
  const mint = async () => {
    const base = (options.authBaseUrl ?? 'https://id.twitch.tv').replace(/\/oauth2\/?$/, '').replace(/\/$/, '');
    const response = await fetchImpl(`${base}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, grant_type: 'client_credentials' }).toString() });
    if (!response.ok) { token = undefined; return; }
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || !data.access_token) { token = undefined; return; }
    const seconds = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? data.expires_in : 3600;
    token = { accessToken: data.access_token, expiresAt: now() + Math.max(0, seconds - 60) * 1000 };
  };
  const refresh = () => { pending ??= mint().finally(() => { pending = undefined; }); return pending; };
  return {
    async getAuth() {
      if (!options.clientId || !options.clientSecret) return undefined;
      if (!token || token.expiresAt <= now()) await refresh();
      return token ? { clientId: options.clientId, accessToken: token.accessToken, broadcasterId: '', login: '' } : undefined;
    },
    async refresh() { token = undefined; await refresh(); },
  };
}

/** The 'clip' StreamEvent the poller emits: the usual fields plus the clip itself. */
export type ClipStreamEvent = StreamEvent & { type: 'clip'; clip: { id: string; url: string; thumbnailUrl: string; viewCount: number; createdAt: number } };
/** `t` is seconds since the live session started, as on the IRC and EventSub paths. */
export function clipEvent(clip: HelixClip, sessionStartedAt: number): ClipStreamEvent {
  return { id: `clip-${clip.id}`, t: Math.max(0, (clip.createdAt - sessionStartedAt) / 1000), type: 'clip', name: clip.creatorName, text: safeText(clip.title),
    clip: { id: clip.id, url: clip.url, thumbnailUrl: clip.thumbnailUrl, viewCount: clip.viewCount, createdAt: clip.createdAt } };
}

export interface PollTimers { set(task: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimers: PollTimers = {
  set(task, ms) { const handle = setTimeout(task, ms); handle.unref?.(); return handle; },
  clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
export interface ClipPollerOptions {
  client: ClipsClient;
  broadcasterId: string;
  /** Epoch ms when the live session started: the first started_at, and t = 0 for events. */
  sessionStartedAt: number;
  emit: (event: ClipStreamEvent) => void;
  intervalMs?: number;
  maxBackoffMs?: number;
  maxPages?: number;
  timers?: PollTimers;
  log?: (message: string) => void;
}

/**
 * Polls Get Clips with started_at = the newest created_at seen so far, every intervalMs.
 * A 429 waits until Ratelimit-Reset (never sooner than the normal interval) or, without the
 * header, doubles the wait up to maxBackoffMs; so do other failures. Clips are deduped by id.
 */
export class ClipPoller {
  private readonly seen = new Set<string>();
  private lastSeen: number;
  private timer: unknown;
  private stopped = true;
  private failures = 0;
  private inflight?: Promise<void>;
  private readonly timers: PollTimers;
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  polls = 0;
  lastDelayMs = 0;
  constructor(private readonly options: ClipPollerOptions) {
    this.lastSeen = options.sessionStartedAt;
    this.timers = options.timers ?? realTimers;
    this.intervalMs = options.intervalMs ?? CLIP_POLL_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? CLIP_MAX_BACKOFF_MS;
  }
  get running(): boolean { return !this.stopped; }
  get clipsSeen(): number { return this.seen.size; }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }
  /** Resolves when the poll in flight (if any) has finished. For tests and shutdown. */
  async settled(): Promise<void> { await this.inflight; }
  private schedule(ms: number): void {
    if (this.stopped) return;
    this.lastDelayMs = ms;
    this.timer = this.timers.set(() => { this.timer = undefined; this.inflight = this.poll(); }, ms);
  }
  private backoff(): number { return Math.min(this.maxBackoffMs, this.intervalMs * 2 ** this.failures); }
  private async poll(): Promise<void> {
    if (this.stopped) return;
    this.polls++;
    let next = this.intervalMs;
    try {
      const { clips } = await getClips(this.options.client, { broadcasterId: this.options.broadcasterId, startedAt: this.lastSeen, maxPages: this.options.maxPages });
      if (this.stopped) return;
      this.failures = 0;
      for (const clip of [...clips].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
        if (this.seen.has(clip.id)) continue;
        this.seen.add(clip.id);
        while (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
        this.lastSeen = Math.max(this.lastSeen, clip.createdAt);
        this.options.emit(clipEvent(clip, this.options.sessionStartedAt));
      }
    } catch (error) {
      if (this.stopped) return;
      // Ratelimit-Reset says exactly when to come back; without it, wait twice as long each time.
      if (error instanceof ClipsRateLimitedError && error.hasReset) next = Math.max(this.intervalMs, error.retryAfterMs);
      else { this.failures++; next = this.backoff(); }
      this.options.log?.(`clips: ${error instanceof TwitchApiError ? `HTTP ${error.status}` : error instanceof Error ? error.name : 'error'}; next poll in ${Math.round(next / 1000)} s`);
    }
    this.schedule(next);
  }
}

export interface ClipWatchOptions extends Omit<ClipPollerOptions, 'broadcasterId' | 'sessionStartedAt'> {
  /** The signed-in broadcaster's user id, or undefined while signed out. */
  broadcaster: () => Promise<string | undefined>;
  /** 'stream-offline' on this bus stops the poller until the session leaves Live. */
  bus?: { on(channel: 'stream-offline', handler: (payload: unknown) => void): () => void };
  now?: () => number;
}
/**
 * Starts and stops one ClipPoller with the session: sync(true) while Live, sync(false) when not.
 * After stream.offline it stays stopped until sync(false) is seen, so a studio that has not left
 * Live yet does not start polling again.
 */
export function createClipWatch(options: ClipWatchOptions) {
  const now = options.now ?? (() => Date.now());
  let poller: ClipPoller | undefined; let ended = false; let starting = false; let generation = 0;
  const stop = () => { generation++; poller?.stop(); poller = undefined; starting = false; };
  const offOffline = options.bus?.on('stream-offline', () => { ended = true; stop(); });
  return {
    get poller() { return poller; },
    sync(live: boolean): void {
      if (!live) { ended = false; if (poller || starting) stop(); return; }
      if (ended || poller || starting) return;
      starting = true; const mine = ++generation; const sessionStartedAt = now();
      void options.broadcaster().then(broadcasterId => {
        if (mine !== generation) return;
        starting = false;
        if (!broadcasterId) return;
        poller = new ClipPoller({ ...options, broadcasterId, sessionStartedAt });
        poller.start();
      }, () => { if (mine === generation) starting = false; });
    },
    close(): void { stop(); offOffline?.(); },
  };
}

/** DEFAULTS for the clip-cluster rule; the moments.ts DEFAULTS hunk copies these values. */
export interface ClipClusterConfig { clipClusterMinClips: number; clipClusterWindowSeconds: number; clipClusterCooldownSeconds: number }
export const defaultClipClusterConfig: ClipClusterConfig = { clipClusterMinClips: 3, clipClusterWindowSeconds: 120, clipClusterCooldownSeconds: 120 };
export interface ClusterClip { id: string; t: number; viewCount: number; url: string; thumbnailUrl: string }
export interface ClipClusterState<C extends ClusterClip = ClusterClip> { recent: C[]; cooldownUntil: number }
export interface ClipClusterStep<C extends ClusterClip = ClusterClip> {
  state: ClipClusterState<C>;
  /** Set on the clip that completes a cluster: every clip in it and the most-viewed clip's frame. */
  opened?: { clips: C[]; frame: ClipRef };
  /** The clip arrived during the cooldown after a cluster: it joins that moment, never opens one. */
  merge: boolean;
  duplicate: boolean;
}
export const initialClipClusterState = <C extends ClusterClip = ClusterClip>(): ClipClusterState<C> => ({ recent: [], cooldownUntil: -Infinity });
/** The most-viewed clip (earliest on a tie) gives the panel frame, inked later by inkClipFrame. */
export function mostViewed<C extends ClusterClip>(clips: C[]): C | undefined {
  return clips.reduce<C | undefined>((best, clip) => !best || clip.viewCount > best.viewCount || (clip.viewCount === best.viewCount && clip.t < best.t) ? clip : best, undefined);
}
/**
 * Pure clip-cluster rule: minClips distinct clips whose created times span at most windowSeconds
 * open one moment. The clips are then consumed, and for cooldownSeconds new clips only merge into
 * that moment, so one cluster gives one moment.
 */
export function stepClipCluster<C extends ClusterClip>(state: ClipClusterState<C>, clip: C, config: ClipClusterConfig = defaultClipClusterConfig): ClipClusterStep<C> {
  if (state.recent.some(item => item.id === clip.id)) return { state, merge: false, duplicate: true };
  if (clip.t < state.cooldownUntil) return { state, merge: true, duplicate: false };
  const newest = Math.max(clip.t, ...state.recent.map(item => item.t));
  const recent = [...state.recent, clip].filter(item => newest - item.t <= config.clipClusterWindowSeconds).sort((a, b) => a.t - b.t);
  if (recent.length < config.clipClusterMinClips) return { state: { ...state, recent }, merge: false, duplicate: false };
  const frame = mostViewed(recent)!;
  return { state: { recent: [], cooldownUntil: clip.t + config.clipClusterCooldownSeconds }, opened: { clips: recent, frame: { url: frame.url, thumbnailUrl: frame.thumbnailUrl } }, merge: false, duplicate: false };
}
/** The cluster view of a polled clip event, or undefined for any other event (including a 'clip' without a clip payload). */
export function polledClipOf<E extends StreamEvent>(event: E): (ClusterClip & { event: E }) | undefined {
  const clip = (event as { clip?: Partial<ClipStreamEvent['clip']> }).clip;
  if (event.type !== 'clip' || !clip || typeof clip.id !== 'string' || typeof clip.url !== 'string') return undefined;
  return { id: clip.id, t: event.t, viewCount: typeof clip.viewCount === 'number' ? clip.viewCount : 0, url: clip.url, thumbnailUrl: clip.thumbnailUrl ?? '', event };
}
