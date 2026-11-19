import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHelixClient, TwitchApiError, type FetchLike, type TwitchAuthProvider } from '../apps/server/src/twitch-api/index.ts';
import { comicToonsSubscriptions, EVENTSUB_TYPES_URL } from '../apps/server/src/eventsub/subscriptions.ts';
import { guardFetch, helixGet } from './smoke-twitch-helix.ts';

const DEFAULT_LOG_PATH = 'artifacts/tmp/smoke-twitch.log';
const SMOKE_LOGIN = 'summit1g';

export interface RunSmokeOptions {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  logPath?: string;
  now?: () => number;
}
export interface RunSmokeResult { exitCode: number; log: string }

function sortedKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

/** Strips markup so the EventSub doc page can be searched as plain text. No values from the
 * page besides "listed/NOT LISTED" per type ever reach the log. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ');
}

function isSubscriptionListed(pageText: string, type: string, version: string): boolean {
  const escapedType = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escapedType}\\s+${escapedVersion}(\\s|$)`).test(pageText);
}

async function fetchAppToken(fetchImpl: FetchLike, clientId: string, clientSecret: string): Promise<{ status: number; fields: string[]; token?: string }> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString();
  const response = await fetchImpl('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  return { status: response.status, fields: sortedKeys(json), token: typeof json.access_token === 'string' ? json.access_token : undefined };
}

function assertNoSecrets(logText: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret && logText.includes(secret)) throw new Error('Refusing to write a secret value to the smoke log.');
  }
}

async function writeLog(logPath: string, text: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, text);
}

/** Wraps a fetch to remember the status of the last response it returned, so callers that go
 * through createHelixClient (which does not expose the raw Response) can still log it. */
function withLastStatus(fetchImpl: FetchLike): { fetch: FetchLike; lastStatus: () => number | undefined } {
  let lastStatus: number | undefined;
  const fetch: FetchLike = async (input, init) => {
    const response = await fetchImpl(input, init);
    lastStatus = response.status;
    return response;
  };
  return { fetch, lastStatus: () => lastStatus };
}

export async function runSmoke(options: RunSmokeOptions): Promise<RunSmokeResult> {
  const logPath = options.logPath ?? DEFAULT_LOG_PATH;
  const now = options.now ?? (() => Date.now());
  const clientId = options.env.TWITCH_CLIENT_ID;
  const clientSecret = options.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const log = 'SKIP: TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set';
    console.log(log);
    await writeLog(logPath, log);
    return { exitCode: 0, log };
  }

  const guarded = guardFetch(options.fetch);
  const secrets: string[] = [clientId, clientSecret];
  const lines: string[] = [new Date(now()).toISOString()];
  let ok = true;

  const tokenResult = await fetchAppToken(guarded, clientId, clientSecret);
  lines.push(`Step 1 token: status=${tokenResult.status} fields=[${tokenResult.fields.join(',')}]`);
  if (tokenResult.status < 200 || tokenResult.status >= 300) ok = false;
  let appToken = tokenResult.token;
  if (appToken) secrets.push(appToken);

  if (appToken) {
    const response = await guarded('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${appToken}` } });
    const text = await response.text();
    const json = text ? JSON.parse(text) as Record<string, unknown> : {};
    const scopesCount = Array.isArray(json.scopes) ? json.scopes.length : 0;
    lines.push(`Step 2 validate: status=${response.status} fields=[${sortedKeys(json).join(',')}] scopesCount=${scopesCount} expiresInPresent=${'expires_in' in json ? 'yes' : 'no'}`);
    if (!response.ok) ok = false;
  } else {
    lines.push('Step 2 validate: skipped (no token)');
    ok = false;
  }

  const authProvider: TwitchAuthProvider = {
    async getAuth() { return appToken ? { clientId, accessToken: appToken, broadcasterId: '', login: '' } : undefined; },
    async refresh() {
      const refreshed = await fetchAppToken(guarded, clientId, clientSecret);
      appToken = refreshed.token;
      if (appToken) secrets.push(appToken);
    },
  };

  let userId: string | undefined;
  const usersFetch = withLastStatus(guarded);
  try {
    const client = createHelixClient({ auth: authProvider, fetch: usersFetch.fetch });
    const users = await client.getUsers({ logins: [SMOKE_LOGIN] });
    userId = users[0]?.id;
    lines.push(`Step 3 users: status=${usersFetch.lastStatus() ?? 0} fields=[${sortedKeys(users[0]).join(',')}] count=${users.length}`);
  } catch (error) {
    lines.push(`Step 3 users: status=${error instanceof TwitchApiError ? error.status : usersFetch.lastStatus() ?? 0}`);
    ok = false;
  }

  if (appToken) {
    try {
      const { status, json } = await helixGet<{ data?: Record<string, unknown>[] }>({ clientId, accessToken: appToken }, guarded, '/streams', { user_login: SMOKE_LOGIN });
      const data = json?.data ?? [];
      lines.push(`Step 4a streams: status=${status} fields=[${sortedKeys(data[0]).join(',')}] count=${data.length}`);
    } catch (error) {
      lines.push(`Step 4a streams: status=${error instanceof TwitchApiError ? error.status : 0}`);
      ok = false;
    }
  } else {
    lines.push('Step 4a streams: skipped (no token)');
    ok = false;
  }

  if (appToken && userId) {
    try {
      const { status, json } = await helixGet<{ data?: Record<string, unknown>[] }>({ clientId, accessToken: appToken }, guarded, '/clips', { broadcaster_id: userId, first: '5' });
      const data = json?.data ?? [];
      lines.push(`Step 4b clips: status=${status} fields=[${sortedKeys(data[0]).join(',')}] count=${data.length}`);
    } catch (error) {
      lines.push(`Step 4b clips: status=${error instanceof TwitchApiError ? error.status : 0}`);
      ok = false;
    }
  } else {
    lines.push('Step 4b clips: skipped (no token or broadcaster id)');
    ok = false;
  }

  const docResponse = await guarded(EVENTSUB_TYPES_URL);
  lines.push(`Step 5 doc: status=${docResponse.status} url=${EVENTSUB_TYPES_URL}`);
  const subscriptions = comicToonsSubscriptions('0');
  if (docResponse.ok) {
    const pageText = stripTags(await docResponse.text());
    for (const subscription of subscriptions) {
      const listed = isSubscriptionListed(pageText, subscription.type, subscription.version);
      lines.push(`${subscription.type} v${subscription.version}: ${listed ? 'listed' : 'NOT LISTED'}`);
      if (!listed) ok = false;
    }
  } else {
    ok = false;
    for (const subscription of subscriptions) lines.push(`${subscription.type} v${subscription.version}: NOT LISTED`);
  }

  lines.push(`RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  const log = lines.join('\n');
  assertNoSecrets(log, secrets);
  console.log(log);
  await writeLog(logPath, log);
  return { exitCode: ok ? 0 : 1, log };
}

async function main(): Promise<void> {
  const logPath = process.argv[2];
  const result = await runSmoke({ env: process.env, fetch: (input, init) => fetch(input, init), logPath });
  process.exitCode = result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
