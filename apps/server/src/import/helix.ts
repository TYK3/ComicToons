import { HELIX_BASE } from '../twitch-api/helix.ts';
import { TwitchApiError, TwitchSignedOutError } from '../twitch-api/errors.ts';
import type { FetchLike, TwitchAuthProvider } from '../twitch-api/types.ts';
import { safeClipUrl, type HelixClip } from '../ingest/clips.ts';

/**
 * getClips() (ingest/clips.ts) is the Get Clips call for IMPORT-1's VOD window lookup; it is used,
 * not duplicated. It only takes broadcaster_id, so a clip URL (`GET /helix/clips?id=<slug>`) and a
 * VOD URL (`GET /helix/videos?id=<id>`) need this tiny client: read-only GETs, app token only.
 */
export interface ImportHelixClient { auth: TwitchAuthProvider; baseUrl?: string; fetch?: FetchLike }

export interface HelixVideo { id: string; userId: string; userLogin: string; title: string; createdAt: number; durationSeconds: number; thumbnailUrl: string; url: string }

/** Twitch's "41m44s" / "2h51m18s" / "35m3s" video duration, in seconds. Undefined on anything else. */
export function parseHelixDuration(value: string): number | undefined {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !value) return undefined;
  const [, h, m, s] = match;
  if (h === undefined && m === undefined && s === undefined) return undefined;
  return (Number(h ?? 0) * 3600) + (Number(m ?? 0) * 60) + Number(s ?? 0);
}

async function helixGet<T>(client: ImportHelixClient, path: string, query: Record<string, string | string[]>): Promise<T> {
  const fetchImpl: FetchLike = client.fetch ?? ((input, init) => fetch(input, init));
  let refreshed = false;
  for (;;) {
    const auth = await client.auth.getAuth();
    if (!auth) throw new TwitchSignedOutError();
    const url = new URL(`${(client.baseUrl ?? HELIX_BASE).replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(query)) for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, entry);
    const response = await fetchImpl(url, { method: 'GET', headers: { 'Client-Id': auth.clientId, Authorization: `Bearer ${auth.accessToken}` } });
    if (response.status === 401 && !refreshed) { refreshed = true; await client.auth.refresh(); continue; }
    if (response.status === 429) throw new TwitchApiError(429, 'Twitch asked us to slow down.', path);
    if (!response.ok) throw new TwitchApiError(response.status, `Twitch answered ${response.status}.`, path);
    return await response.json() as T;
  }
}

type RawVideo = { id?: unknown; user_id?: unknown; user_login?: unknown; title?: unknown; created_at?: unknown; duration?: unknown; thumbnail_url?: unknown; url?: unknown };

/**
 * GET /helix/videos?id=<id> (https://dev.twitch.tv/docs/api/reference/#get-videos), app token,
 * read-only. A bad id, a deleted VOD or a private one all come back 200 with an empty `data`
 * array (report-import-0.md), so "not found" is undefined, never thrown here.
 */
export async function getVideoById(client: ImportHelixClient, id: string): Promise<HelixVideo | undefined> {
  const body = await helixGet<{ data?: RawVideo[] }>(client, '/videos', { id });
  const raw = body.data?.[0];
  if (!raw || typeof raw.id !== 'string' || typeof raw.user_id !== 'string') return undefined;
  const createdAt = Date.parse(typeof raw.created_at === 'string' ? raw.created_at : '');
  const durationSeconds = parseHelixDuration(typeof raw.duration === 'string' ? raw.duration : '');
  if (!Number.isFinite(createdAt) || durationSeconds === undefined) return undefined;
  return { id: raw.id, userId: raw.user_id, userLogin: typeof raw.user_login === 'string' ? raw.user_login.toLowerCase() : '', title: typeof raw.title === 'string' ? raw.title : '', createdAt, durationSeconds,
    thumbnailUrl: typeof raw.thumbnail_url === 'string' ? raw.thumbnail_url : '', url: typeof raw.url === 'string' ? raw.url : `https://www.twitch.tv/videos/${raw.id}` };
}

type RawClip = { id?: unknown; url?: unknown; thumbnail_url?: unknown; view_count?: unknown; created_at?: unknown; title?: unknown; creator_name?: unknown; broadcaster_name?: unknown };
/** A clip looked up by id, with the broadcaster's display name (getClips() drops it; the series needs a channel). */
export type ImportHelixClip = HelixClip & { broadcasterName?: string };
/**
 * IMPORT-LIVE-1 r2: a clip's own link, allow-listed like clip-url-1's safeClipUrl (plain https, no userinfo, no explicit
 * port), but also in the form real Helix returns today, https://www.twitch.tv/<channel>/clip/<slug> (live check,
 * 1 Nov 2026), which safeClipUrl refuses. Exact twitch.tv hosts only.
 */
const CLIP_PATH = /^\/[A-Za-z0-9_]{1,25}\/clip\/[A-Za-z0-9_-]{1,100}\/?$/;
export function safeImportClipUrl(value: unknown): string | undefined {
  const short = safeClipUrl(value);
  if (short) return short;
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/)[0]!;
  if (/:\d*$/.test(authority)) return undefined;
  if (!['www.twitch.tv', 'twitch.tv', 'm.twitch.tv'].includes(url.hostname) || !CLIP_PATH.test(url.pathname)) return undefined;
  return url.href;
}
/** A clip with no safe link is dropped; a thumbnail off https *.jtvnw.net becomes '' (it is inked server-side). */
function toClip(raw: RawClip): ImportHelixClip | undefined {
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  const url = safeImportClipUrl(raw.url);
  if (!url) return undefined;
  const createdAt = Date.parse(typeof raw.created_at === 'string' ? raw.created_at : '');
  if (!Number.isFinite(createdAt)) return undefined;
  return { id: raw.id, url, thumbnailUrl: safeClipUrl(raw.thumbnail_url) ?? '',
    viewCount: typeof raw.view_count === 'number' && Number.isFinite(raw.view_count) ? raw.view_count : 0, createdAt,
    title: typeof raw.title === 'string' ? raw.title : '', creatorName: typeof raw.creator_name === 'string' ? raw.creator_name : undefined,
    broadcasterName: typeof raw.broadcaster_name === 'string' ? raw.broadcaster_name : undefined };
}

/**
 * GET /helix/clips?id=<slug>[&id=<slug>...] (up to 100 ids per call), app token, read-only. Used
 * for a clip URL (clips.twitch.tv/<slug> or twitch.tv/<channel>/clip/<slug>): getClips() only
 * takes broadcaster_id, not id, so it cannot serve this lookup. Missing/private/deleted clips are
 * simply absent from `data`; the caller decides what "not found" means for each requested id.
 */
export async function getClipsById(client: ImportHelixClient, ids: string[]): Promise<ImportHelixClip[]> {
  if (ids.length === 0) return [];
  const body = await helixGet<{ data?: RawClip[] }>(client, '/clips', { id: ids });
  const clips: ImportHelixClip[] = [];
  for (const raw of body.data ?? []) { const clip = toClip(raw); if (clip) clips.push(clip); }
  return clips;
}
