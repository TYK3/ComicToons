/**
 * The hard allowlist for `trial-run --signed-in`: the exact HTTP methods and URL shapes this mode
 * may ever send to Twitch (or the local fake standing in for it). Anything else — every write
 * (chat messages, polls, predictions, custom rewards, redemption updates) and every method or URL
 * not listed here — throws before the request is sent. Pure and network-free, so it is cheap to
 * unit test on its own; scripts/trial-run/signed-in-guard.ts wraps fetch with it for real runs.
 */

/**
 * EventSub subscription types this mode may ever ask Twitch for. Every one of these only reports
 * something that already happened; subscribing to any of them cannot start a poll, create a
 * reward, post a message or otherwise change the channel. Mirrors the production list in
 * apps/server/src/eventsub/subscriptions.ts (comicToonsSubscriptions) — keep both lists in sync.
 */
export const READ_ONLY_EVENTSUB_TYPES = [
  'channel.raid', // a raid into the channel already happened
  'channel.cheer', // bits were already cheered
  'channel.channel_points_custom_reward_redemption.add', // a viewer already redeemed an existing reward
  'channel.poll.begin', 'channel.poll.progress', 'channel.poll.end', // an existing poll's lifecycle
  'channel.prediction.begin', 'channel.prediction.progress', 'channel.prediction.lock', 'channel.prediction.end',
  'channel.hype_train.begin', 'channel.hype_train.end',
  'channel.chat.message', 'channel.chat.message_delete', // chat the signed-in user already has permission to read
  'stream.online', 'stream.offline',
] as const;

export class SignedInAllowlistViolation extends Error {
  constructor(method: string, url: string, reason?: string) {
    super(`signed-in dry run blocked ${method} ${url}${reason ? ` (${reason})` : ''}: not on the read-only allowlist.`);
    this.name = 'SignedInAllowlistViolation';
  }
}

function readSubscriptionType(body: unknown): string | undefined {
  if (typeof body !== 'string' || !body) return undefined;
  try {
    const parsed = JSON.parse(body) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : undefined;
  } catch { return undefined; }
}

/** Hosts each kind of request may go to: the real Twitch host for that API, or a loopback fake (the dry run). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const AUTH_HOST = 'id.twitch.tv';
const HELIX_HOST = 'api.twitch.tv';

interface AllowedEntry { method: string; host: typeof AUTH_HOST | typeof HELIX_HOST; comment: string; matches(pathname: string, body: unknown): boolean }

/**
 * Every request this mode is ever allowed to send, Twitch or fake. Each entry is one exact
 * method and URL shape, with the reason it is safe. EventSub subscription creation is the only
 * allowed POST besides the OAuth token exchange, and only for a READ_ONLY_EVENTSUB_TYPES type.
 */
export const ALLOWED_REQUESTS: AllowedEntry[] = [
  {
    method: 'GET',
    host: AUTH_HOST,
    comment: 'The Twitch consent page: what a real run has Young open and approve in the box browser; a dry run fetches it itself because there is no browser.',
    matches: pathname => /\/oauth2\/authorize\/?$/.test(pathname),
  },
  {
    method: 'POST',
    host: AUTH_HOST,
    comment: 'Exchanges the authorization code (or an expiring token) for an access token. The only request that ever carries the client secret.',
    matches: pathname => /\/oauth2\/token\/?$/.test(pathname),
  },
  {
    method: 'GET',
    host: AUTH_HOST,
    comment: "Validates the access token and reads its login and scopes. Runs after every exchange and on the app's hourly check.",
    matches: pathname => /\/oauth2\/validate\/?$/.test(pathname),
  },
  {
    method: 'GET',
    host: HELIX_HOST,
    comment: "Reads the signed-in broadcaster's own user record (for the Affiliate/Partner check shown in Studio). Changes nothing.",
    matches: pathname => /\/helix\/users\/?$/.test(pathname),
  },
  {
    method: 'POST',
    host: HELIX_HOST,
    comment: 'Creates an EventSub subscription, but only for a type in READ_ONLY_EVENTSUB_TYPES. Subscribing only asks Twitch to start sending events that already happened; it can never change the channel.',
    matches: (pathname, body) => {
      if (!/\/helix\/eventsub\/subscriptions\/?$/.test(pathname)) return false;
      const type = readSubscriptionType(body);
      return type !== undefined && (READ_ONLY_EVENTSUB_TYPES as readonly string[]).includes(type);
    },
  },
];

/** Throws SignedInAllowlistViolation unless this exact request matches one allowed entry. */
export function checkAllowed(request: { method: string; url: string | URL; body?: unknown }): void {
  const url = request.url instanceof URL ? request.url : new URL(String(request.url));
  const method = request.method.toUpperCase();
  const hostOk = (entry: AllowedEntry) => (url.protocol === 'https:' && url.host === entry.host) || LOOPBACK_HOSTS.has(url.hostname);
  const allowed = ALLOWED_REQUESTS.some(entry => entry.method === method && hostOk(entry) && entry.matches(url.pathname, request.body));
  if (!allowed) throw new SignedInAllowlistViolation(method, url.href);
}
