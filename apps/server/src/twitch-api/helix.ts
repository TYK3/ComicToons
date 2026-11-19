import type { RewardInput } from '../participation/rewards.ts';
import { TwitchApiError, TwitchForbiddenError, TwitchSignedOutError } from './errors.ts';
import type { BroadcasterType, FetchLike, HelixUser, TwitchAuthProvider } from './types.ts';

export const HELIX_BASE = 'https://api.twitch.tv/helix';
/** Upper bound for one 429 wait. Twitch's bucket refills within a minute (dev.twitch.tv/docs/api/guide). */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;

export interface PollCreate { title: string; choices: { title: string }[]; duration: number }
export interface PredictionCreate { title: string; outcomes: { title: string }[]; predictionWindow: number }
export interface RewardUpdate { rewardId: string; title?: string; cost?: number; prompt?: string; isEnabled?: boolean; isPaused?: boolean }

/**
 * Real Twitch Helix calls behind the same method names as the in-memory fake in participation/routes.ts,
 * plus the extra calls the live features need. Every endpoint, method, body and scope is cited in report-t3b.md.
 */
export interface TwitchHelixClient {
  getUsers(input?: { ids?: string[]; logins?: string[] }): Promise<HelixUser[]>;
  getBroadcasterType(): Promise<BroadcasterType>;
  createCustomReward(input: RewardInput): Promise<{ id: string }>;
  findCustomReward(title: string): Promise<{ id: string } | undefined>;
  updateCustomReward(input: RewardUpdate): Promise<void>;
  deleteCustomReward(input: { rewardId: string }): Promise<void>;
  updateRedemptionStatus(input: { rewardId: string; redemptionIds: string[]; status: 'FULFILLED' | 'CANCELED' }): Promise<void>;
  createPoll(input: PollCreate): Promise<{ id: string }>;
  endPoll(input: { id: string; status: 'TERMINATED' | 'ARCHIVED' }): Promise<void>;
  createPrediction(input: PredictionCreate): Promise<{ id: string; outcomes: { id: string; title: string }[] }>;
  endPrediction(input: { id: string; status: 'RESOLVED' | 'CANCELED' | 'LOCKED'; winningOutcomeId?: string }): Promise<void>;
  sendChatMessage(input: { message: string; replyParentMessageId?: string }): Promise<void>;
}

export interface HelixClientOptions {
  auth: TwitchAuthProvider;
  baseUrl?: string;
  /** Defaults to global fetch. */
  fetch?: FetchLike;
  /** Injectable so the 429 wait is instant in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Query = Record<string, string | string[] | undefined>;
type Auth = NonNullable<Awaited<ReturnType<TwitchAuthProvider['getAuth']>>>;

function buildUrl(path: string, query: Query = {}, baseUrl = HELIX_BASE): URL {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, entry);
  }
  return url;
}
async function readMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown; error?: unknown };
    if (typeof body.message === 'string' && body.message) return body.message;
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch { /* empty or non-JSON body */ }
  return `Twitch answered ${response.status}.`;
}
/** Milliseconds until Ratelimit-Reset (Unix seconds), clamped to 0..MAX_RATE_LIMIT_WAIT_MS. */
export function rateLimitWaitMs(reset: string | null, now: number): number {
  const seconds = Number(reset);
  if (!reset || !Number.isFinite(seconds)) return DEFAULT_RATE_LIMIT_WAIT_MS;
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, Math.ceil(seconds * 1000 - now)));
}

export function createHelixClient(options: HelixClientOptions): TwitchHelixClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  async function currentAuth(): Promise<Auth> {
    const auth = await options.auth.getAuth();
    if (!auth) throw new TwitchSignedOutError();
    return auth;
  }

  /**
   * One Helix request. 401: refresh() once and retry once. 429: wait until Ratelimit-Reset and retry
   * at most once. 403: TwitchForbiddenError. Anything else non-2xx: TwitchApiError.
   */
  async function request<T>(method: string, path: string, build: (auth: Auth) => { query?: Query; body?: unknown }): Promise<T | undefined> {
    let auth = await currentAuth();
    let refreshed = false; let rateLimited = false;
    for (;;) {
      const { query, body } = build(auth);
      const headers: Record<string, string> = { 'Client-Id': auth.clientId, Authorization: `Bearer ${auth.accessToken}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(buildUrl(path, query, options.baseUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await options.auth.refresh();
        auth = await currentAuth();
        continue;
      }
      if (response.status === 429 && !rateLimited) {
        rateLimited = true;
        await sleep(rateLimitWaitMs(response.headers.get('Ratelimit-Reset'), now()));
        continue;
      }
      const endpoint = `${method} ${path}`;
      if (response.status === 403) throw new TwitchForbiddenError(await readMessage(response), endpoint);
      if (!response.ok) throw new TwitchApiError(response.status, await readMessage(response), endpoint);
      if (response.status === 204) return undefined;
      const text = await response.text();
      return text ? JSON.parse(text) as T : undefined;
    }
  }
  const first = <T>(payload: { data?: T[] } | undefined, endpoint: string): T => {
    const item = payload?.data?.[0];
    if (!item) throw new TwitchApiError(502, 'Twitch returned no data.', endpoint);
    return item;
  };

  type RawUser = { id: string; login: string; display_name: string; broadcaster_type: string };
  const client: TwitchHelixClient = {
    async getUsers(input = {}) {
      const payload = await request<{ data?: RawUser[] }>('GET', '/users', () => ({ query: { id: input.ids, login: input.logins } }));
      return (payload?.data ?? []).map(user => ({ id: user.id, login: user.login, displayName: user.display_name,
        broadcasterType: user.broadcaster_type === 'affiliate' || user.broadcaster_type === 'partner' ? user.broadcaster_type : '' }));
    },
    async getBroadcasterType() {
      const { broadcasterId } = await currentAuth();
      const user = (await client.getUsers({ ids: [broadcasterId] }))[0];
      if (!user) throw new TwitchApiError(404, 'Twitch did not return the signed-in channel.', 'GET /users');
      return user.broadcasterType;
    },
    async createCustomReward(input) {
      const payload = await request<{ data?: { id: string }[] }>('POST', '/channel_points/custom_rewards', auth => ({
        query: { broadcaster_id: auth.broadcasterId },
        body: { title: input.title, cost: input.cost, prompt: input.prompt, is_enabled: true,
          is_max_per_user_per_stream_enabled: input.isMaxPerUserPerStreamEnabled, max_per_user_per_stream: input.maxPerUserPerStream,
          is_global_cooldown_enabled: input.isGlobalCooldownEnabled, global_cooldown_seconds: input.globalCooldownSeconds },
      }));
      return { id: first(payload, 'POST /channel_points/custom_rewards').id };
    },
    async findCustomReward(title) {
      const payload = await request<{ data?: { id: string; title: string }[] }>('GET', '/channel_points/custom_rewards', auth => ({
        query: { broadcaster_id: auth.broadcasterId, only_manageable_rewards: 'true' },
      }));
      const match = payload?.data?.find(reward => reward.title.trim().toLowerCase() === title.trim().toLowerCase());
      return match ? { id: match.id } : undefined;
    },
    async updateCustomReward(input) {
      const body: Record<string, unknown> = {};
      if (input.title !== undefined) body.title = input.title;
      if (input.cost !== undefined) body.cost = input.cost;
      if (input.prompt !== undefined) body.prompt = input.prompt;
      if (input.isEnabled !== undefined) body.is_enabled = input.isEnabled;
      if (input.isPaused !== undefined) body.is_paused = input.isPaused;
      await request('PATCH', '/channel_points/custom_rewards', auth => ({ query: { broadcaster_id: auth.broadcasterId, id: input.rewardId }, body }));
    },
    async deleteCustomReward(input) {
      await request('DELETE', '/channel_points/custom_rewards', auth => ({ query: { broadcaster_id: auth.broadcasterId, id: input.rewardId } }));
    },
    async updateRedemptionStatus(input) {
      if (input.redemptionIds.length < 1 || input.redemptionIds.length > 50) throw new Error('Update 1 to 50 redemptions at a time.');
      await request('PATCH', '/channel_points/custom_rewards/redemptions', auth => ({
        query: { id: input.redemptionIds, broadcaster_id: auth.broadcasterId, reward_id: input.rewardId },
        body: { status: input.status },
      }));
    },
    async createPoll(input) {
      const payload = await request<{ data?: { id: string }[] }>('POST', '/polls', auth => ({
        body: { broadcaster_id: auth.broadcasterId, title: input.title, choices: input.choices.map(choice => ({ title: choice.title })), duration: input.duration },
      }));
      return { id: first(payload, 'POST /polls').id };
    },
    async endPoll(input) {
      await request('PATCH', '/polls', auth => ({ body: { broadcaster_id: auth.broadcasterId, id: input.id, status: input.status } }));
    },
    async createPrediction(input) {
      const payload = await request<{ data?: { id: string; outcomes?: { id: string; title: string }[] }[] }>('POST', '/predictions', auth => ({
        body: { broadcaster_id: auth.broadcasterId, title: input.title, outcomes: input.outcomes.map(outcome => ({ title: outcome.title })), prediction_window: input.predictionWindow },
      }));
      const created = first(payload, 'POST /predictions');
      return { id: created.id, outcomes: (created.outcomes ?? []).map(outcome => ({ id: outcome.id, title: outcome.title })) };
    },
    async endPrediction(input) {
      if (input.status === 'RESOLVED' && !input.winningOutcomeId) throw new Error('A resolved prediction needs the winning outcome.');
      await request('PATCH', '/predictions', auth => ({
        body: { broadcaster_id: auth.broadcasterId, id: input.id, status: input.status, ...(input.status === 'RESOLVED' ? { winning_outcome_id: input.winningOutcomeId } : {}) },
      }));
    },
    async sendChatMessage(input) {
      await request('POST', '/chat/messages', auth => ({
        body: { broadcaster_id: auth.broadcasterId, sender_id: auth.broadcasterId, message: input.message, ...(input.replyParentMessageId ? { reply_parent_message_id: input.replyParentMessageId } : {}) },
      }));
    },
  };
  return client;
}
