import { HELIX_BASE, rateLimitWaitMs, TwitchApiError, type FetchLike } from '../apps/server/src/twitch-api/index.ts';

type Query = Record<string, string | string[] | undefined>;

function buildUrl(path: string, query: Query = {}): URL {
  const url = new URL(`${HELIX_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, entry);
  }
  return url;
}

export interface HelixGetAuth { clientId: string; accessToken: string }
export interface HelixGetOptions { sleep?: (ms: number) => Promise<void>; now?: () => number }
export interface HelixGetResult<T> { status: number; json: T | undefined }

/**
 * Read-only GET against Helix: the method is always GET and no body is ever sent, so there is
 * nothing here that could create, change or delete anything. Retries once on 429, like the
 * write client in twitch-api/helix.ts, and raises the same TwitchApiError on any other non-2xx.
 */
export async function helixGet<T>(auth: HelixGetAuth, fetchImpl: FetchLike, path: string, query: Query = {}, options: HelixGetOptions = {}): Promise<HelixGetResult<T>> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  let rateLimited = false;
  for (;;) {
    const headers: Record<string, string> = { 'Client-Id': auth.clientId, Authorization: `Bearer ${auth.accessToken}` };
    const response = await fetchImpl(buildUrl(path, query), { method: 'GET', headers });
    if (response.status === 429 && !rateLimited) {
      rateLimited = true;
      await sleep(rateLimitWaitMs(response.headers.get('Ratelimit-Reset'), now()));
      continue;
    }
    if (!response.ok) throw new TwitchApiError(response.status, `Twitch answered ${response.status}.`, `GET ${path}`);
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) as T : undefined };
  }
}

/**
 * Blocks every request except a GET, with one deliberate exception: the client-credentials
 * token POST to id.twitch.tv/oauth2/token, which is the only write this smoke test ever makes.
 * Wrapping every outgoing fetch in this guard is the enforcement point for "read-only".
 */
export function guardFetch(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(String(input));
    const isTokenPost = method === 'POST' && url.hostname === 'id.twitch.tv' && url.pathname === '/oauth2/token';
    if (method !== 'GET' && !isTokenPost) throw new Error(`Refusing non-GET request: ${method} ${url.pathname}`);
    return fetchImpl(input, init);
  };
}
