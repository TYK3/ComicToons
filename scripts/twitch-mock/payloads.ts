// Payload builders for the fake Twitch. Every shape below is copied from the public
// Twitch developer docs (field names, nesting and value kinds); only the values are
// fake. Each builder cites the page it was copied from. Never put real ids or
// tokens in here.
import {randomUUID} from 'node:crypto';

export interface TwitchUser { id: string; login: string; name: string }
export interface Subscription {
  id: string; status: string; type: string; version: string;
  condition: Record<string, string>;
  transport: {method: 'websocket'; session_id: string; connected_at?: string; disconnected_at?: string};
  created_at: string; cost: number;
}

/** Twitch timestamps are RFC 3339 with nanoseconds; millisecond ISO strings parse the same. */
export const stamp = (ms = Date.now()) => new Date(ms).toISOString();

// ---- EventSub WebSocket messages -------------------------------------------------
// https://dev.twitch.tv/docs/eventsub/handling-websocket-events/

/** "Welcome message" section. */
export function welcomeMessage(session: {id: string; keepaliveSeconds: number; connectedAt: string}) {
  return {
    metadata: {message_id: randomUUID(), message_type: 'session_welcome', message_timestamp: stamp()},
    payload: {session: {id: session.id, status: 'connected', connected_at: session.connectedAt,
      keepalive_timeout_seconds: session.keepaliveSeconds, reconnect_url: null, recovery_url: null}},
  };
}

/** "Keepalive message" section: the payload is an empty object. */
export function keepaliveMessage() {
  return {metadata: {message_id: randomUUID(), message_type: 'session_keepalive', message_timestamp: stamp()}, payload: {}};
}

/** "Notification message" section. */
export function notificationMessage(subscription: Subscription, event: Record<string, unknown>) {
  return {
    metadata: {message_id: randomUUID(), message_type: 'notification', message_timestamp: stamp(),
      subscription_type: subscription.type, subscription_version: subscription.version},
    payload: {subscription, event},
  };
}

/** "Reconnect message" section: keepalive_timeout_seconds is null and reconnect_url is set. */
export function reconnectMessage(session: {id: string; connectedAt: string}, reconnectUrl: string) {
  return {
    metadata: {message_id: randomUUID(), message_type: 'session_reconnect', message_timestamp: stamp()},
    payload: {session: {id: session.id, status: 'reconnecting', keepalive_timeout_seconds: null,
      reconnect_url: reconnectUrl, recovery_url: null, connected_at: session.connectedAt}},
  };
}

/** "Revocation message" section: no event, the subscription status says why. */
export function revocationMessage(subscription: Subscription) {
  return {
    metadata: {message_id: randomUUID(), message_type: 'revocation', message_timestamp: stamp(),
      subscription_type: subscription.type, subscription_version: subscription.version},
    payload: {subscription},
  };
}

/** "Close message" table on the same page. */
export const EVENTSUB_CLOSE = {
  internalServerError: 4000, clientSentInboundTraffic: 4001, clientFailedPingPong: 4002,
  connectionUnused: 4003, reconnectGraceTimeExpired: 4004, networkTimeout: 4005,
  networkError: 4006, invalidReconnect: 4007,
} as const;

// ---- EventSub event bodies ---------------------------------------------------------
// https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/
// (each builder names the section; the "event" object is copied from its example)

const broadcasterFields = (b: TwitchUser) => ({broadcaster_user_id: b.id, broadcaster_user_login: b.login, broadcaster_user_name: b.name});

/** "Channel Chat Message" (channel.chat.message v1). */
export function chatMessageEvent(b: TwitchUser, chatter: TwitchUser, message: {id: string; text: string; badges?: {set_id: string; id: string; info: string}[]}) {
  return {
    ...broadcasterFields(b),
    chatter_user_id: chatter.id, chatter_user_login: chatter.login, chatter_user_name: chatter.name,
    message_id: message.id,
    message: {text: message.text, fragments: [{type: 'text', text: message.text, cheermote: null, emote: null, mention: null}]},
    color: '#00FF7F', badges: message.badges ?? [], message_type: 'text', cheer: null, reply: null,
    channel_points_custom_reward_id: null,
    source_broadcaster_user_id: null, source_broadcaster_user_login: null, source_broadcaster_user_name: null,
    source_message_id: null, source_badges: null, is_source_only: null,
  };
}

/** "Channel Chat Message Delete" (channel.chat.message_delete v1). */
export function chatMessageDeleteEvent(b: TwitchUser, target: TwitchUser, messageId: string) {
  return {...broadcasterFields(b), target_user_id: target.id, target_user_name: target.name, target_user_login: target.login, message_id: messageId};
}

/** "Channel Chat Clear" (channel.chat.clear v1). */
export function chatClearEvent(b: TwitchUser) { return {...broadcasterFields(b)}; }

/** "Channel Chat Clear User Messages" (channel.chat.clear_user_messages v1). */
export function chatClearUserMessagesEvent(b: TwitchUser, target: TwitchUser) {
  return {...broadcasterFields(b), target_user_id: target.id, target_user_name: target.name, target_user_login: target.login};
}

/** "Channel Raid" (channel.raid v1). */
export function raidEvent(from: TwitchUser, to: TwitchUser, viewers: number) {
  return {
    from_broadcaster_user_id: from.id, from_broadcaster_user_login: from.login, from_broadcaster_user_name: from.name,
    to_broadcaster_user_id: to.id, to_broadcaster_user_login: to.login, to_broadcaster_user_name: to.name, viewers,
  };
}

/** "Channel Points Custom Reward Redemption Add" (channel.channel_points_custom_reward_redemption.add v1). */
export function redemptionAddEvent(b: TwitchUser, user: TwitchUser, redemption: {id: string; userInput: string; status: string; redeemedAt: string},
  reward: {id: string; title: string; cost: number; prompt: string}) {
  return {
    id: redemption.id, ...broadcasterFields(b),
    user_id: user.id, user_login: user.login, user_name: user.name,
    user_input: redemption.userInput, status: redemption.status,
    reward: {id: reward.id, title: reward.title, cost: reward.cost, prompt: reward.prompt},
    redeemed_at: redemption.redeemedAt,
  };
}

export interface PollChoice { id: string; title: string; bits_votes: number; channel_points_votes: number; votes: number }
export interface PollState {
  id: string; title: string; choices: PollChoice[]; durationSeconds: number;
  channelPointsVoting: {is_enabled: boolean; amount_per_vote: number};
  status: 'ACTIVE' | 'COMPLETED' | 'TERMINATED' | 'ARCHIVED'; startedAt: string; endedAt?: string;
}
const pollVoting = (p: PollState) => ({bits_voting: {is_enabled: false, amount_per_vote: 0}, channel_points_voting: p.channelPointsVoting});
const endsAt = (p: PollState) => stamp(Date.parse(p.startedAt) + p.durationSeconds * 1000);

/** "Channel Poll Begin" (channel.poll.begin v1): choices carry id and title only. */
export function pollBeginEvent(b: TwitchUser, p: PollState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, choices: p.choices.map(c => ({id: c.id, title: c.title})),
    ...pollVoting(p), started_at: p.startedAt, ends_at: endsAt(p)};
}
/** "Channel Poll Progress" (channel.poll.progress v1). */
export function pollProgressEvent(b: TwitchUser, p: PollState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, choices: p.choices.map(c => ({...c})), ...pollVoting(p), started_at: p.startedAt, ends_at: endsAt(p)};
}
/** "Channel Poll End" (channel.poll.end v1): status is lower case (completed, archived, terminated). */
export function pollEndEvent(b: TwitchUser, p: PollState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, choices: p.choices.map(c => ({...c})), ...pollVoting(p),
    status: p.status.toLowerCase(), started_at: p.startedAt, ended_at: p.endedAt ?? stamp()};
}

export interface PredictionOutcome { id: string; title: string; color: 'blue' | 'pink'; users: number; channel_points: number }
export interface PredictionState {
  id: string; title: string; outcomes: PredictionOutcome[]; windowSeconds: number;
  status: 'ACTIVE' | 'LOCKED' | 'RESOLVED' | 'CANCELED'; startedAt: string; lockedAt?: string; endedAt?: string; winningOutcomeId?: string;
}
const outcomeBody = (o: PredictionOutcome) => ({...o, top_predictors: []});

/** "Channel Prediction Begin" (channel.prediction.begin v1). */
export function predictionBeginEvent(b: TwitchUser, p: PredictionState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, outcomes: p.outcomes.map(o => ({id: o.id, title: o.title, color: o.color})),
    started_at: p.startedAt, locks_at: stamp(Date.parse(p.startedAt) + p.windowSeconds * 1000)};
}
/** "Channel Prediction Progress" (channel.prediction.progress v1). */
export function predictionProgressEvent(b: TwitchUser, p: PredictionState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, outcomes: p.outcomes.map(outcomeBody),
    started_at: p.startedAt, locks_at: stamp(Date.parse(p.startedAt) + p.windowSeconds * 1000)};
}
/** "Channel Prediction Lock" (channel.prediction.lock v1). */
export function predictionLockEvent(b: TwitchUser, p: PredictionState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, outcomes: p.outcomes.map(outcomeBody), started_at: p.startedAt, locked_at: p.lockedAt ?? stamp()};
}
/** "Channel Prediction End" (channel.prediction.end v1): status is resolved or canceled. */
export function predictionEndEvent(b: TwitchUser, p: PredictionState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, winning_outcome_id: p.winningOutcomeId ?? null,
    outcomes: p.outcomes.map(outcomeBody), status: p.status.toLowerCase(), started_at: p.startedAt, ended_at: p.endedAt ?? stamp()};
}

/** "Hype Train Begin" (channel.hype_train.begin v2). */
export function hypeTrainBeginEvent(b: TwitchUser, train: {id: string; level: number; total: number; goal: number; contributor: TwitchUser}) {
  const now = Date.now();
  return {id: train.id, ...broadcasterFields(b), total: train.total, progress: train.total, goal: train.goal,
    top_contributions: [{user_id: train.contributor.id, user_login: train.contributor.login, user_name: train.contributor.name, type: 'bits', total: train.total}],
    shared_train_participants: null, level: train.level, started_at: stamp(now), expires_at: stamp(now + 300_000),
    is_shared_train: false, type: 'regular', all_time_high_level: train.level, all_time_high_total: train.total};
}

// ---- Helix bodies ---------------------------------------------------------------
// https://dev.twitch.tv/docs/api/reference/

export interface RewardState {
  id: string; title: string; prompt: string; cost: number; isUserInputRequired: boolean; isEnabled: boolean;
  isPaused: boolean; backgroundColor: string; maxPerStream: number; maxPerUserPerStream: number; globalCooldownSeconds: number;
  skipQueue: boolean; ownerClientId: string;
}
/** "Create Custom Rewards" response item (also "Get Custom Reward"). */
export function rewardBody(b: TwitchUser, r: RewardState) {
  return {
    ...broadcasterFields(b), id: r.id, title: r.title, prompt: r.prompt, cost: r.cost, image: null,
    default_image: {url_1x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-1.png', url_2x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', url_4x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-4.png'},
    background_color: r.backgroundColor, is_enabled: r.isEnabled, is_user_input_required: r.isUserInputRequired,
    max_per_stream_setting: {is_enabled: r.maxPerStream > 0, max_per_stream: r.maxPerStream},
    max_per_user_per_stream_setting: {is_enabled: r.maxPerUserPerStream > 0, max_per_user_per_stream: r.maxPerUserPerStream},
    global_cooldown_setting: {is_enabled: r.globalCooldownSeconds > 0, global_cooldown_seconds: r.globalCooldownSeconds},
    is_paused: r.isPaused, is_in_stock: r.isEnabled && !r.isPaused, should_redemptions_skip_request_queue: r.skipQueue,
    redemptions_redeemed_current_stream: null, cooldown_expires_at: null,
  };
}

export interface RedemptionState { id: string; rewardId: string; user: TwitchUser; userInput: string; status: 'UNFULFILLED' | 'FULFILLED' | 'CANCELED'; redeemedAt: string }
/** "Update Redemption Status" response item. */
export function redemptionBody(b: TwitchUser, r: RedemptionState, reward: RewardState) {
  return {...broadcasterFields(b), id: r.id, user_id: r.user.id, user_login: r.user.login, user_name: r.user.name,
    user_input: r.userInput, status: r.status, redeemed_at: r.redeemedAt,
    reward: {id: reward.id, title: reward.title, prompt: reward.prompt, cost: reward.cost}};
}

/** "Create Poll" / "End Poll" response item: status is upper case here. */
export function pollBody(b: TwitchUser, p: PollState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, choices: p.choices.map(c => ({...c})),
    bits_voting_enabled: false, bits_per_vote: 0, channel_points_voting_enabled: p.channelPointsVoting.is_enabled,
    channel_points_per_vote: p.channelPointsVoting.amount_per_vote, status: p.status, duration: p.durationSeconds,
    started_at: p.startedAt, ended_at: p.endedAt ?? null};
}

/** "Create Prediction" / "End Prediction" response item. */
export function predictionBody(b: TwitchUser, p: PredictionState) {
  return {id: p.id, ...broadcasterFields(b), title: p.title, winning_outcome_id: p.winningOutcomeId ?? null,
    outcomes: p.outcomes.map(o => ({...o, top_predictors: null})), prediction_window: p.windowSeconds, status: p.status,
    created_at: p.startedAt, ended_at: p.endedAt ?? null, locked_at: p.lockedAt ?? null};
}

/** "Get Users" response item. broadcaster_type is "affiliate", "partner" or "". `email` is
 * present only for the user tied to the access token, and only with the user:read:email scope. */
export function userBody(u: TwitchUser & {broadcasterType: string}, email?: string) {
  return {id: u.id, login: u.login, display_name: u.name, type: '', broadcaster_type: u.broadcasterType,
    description: '', profile_image_url: '', offline_image_url: '', view_count: 0, created_at: '2016-12-14T20:32:28Z',
    ...(email ? {email} : {})};
}

export interface StreamState {
  id: string; userId: string; gameId: string; gameName: string; type: 'live'; title: string; viewerCount: number;
  startedAt: string; language: string; tags: string[]; isMature: boolean;
}
/** "Get Streams" response item. tag_ids is always empty; Twitch deprecated it in favour of tags. */
export function streamBody(u: TwitchUser, s: StreamState) {
  return {id: s.id, user_id: u.id, user_login: u.login, user_name: u.name, game_id: s.gameId, game_name: s.gameName,
    type: s.type, title: s.title, viewer_count: s.viewerCount, started_at: s.startedAt, language: s.language,
    thumbnail_url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${u.login}-{width}x{height}.jpg`,
    tag_ids: [] as string[], tags: s.tags, is_mature: s.isMature};
}

export interface ClipState {
  id: string; broadcasterId: string; broadcasterName: string; creatorId: string; creatorName: string; videoId: string;
  gameId: string; language: string; title: string; viewCount: number; createdAt: string; duration: number;
  vodOffset: number | null; isFeatured: boolean;
}
/** "Get Clips" response item. */
export function clipBody(c: ClipState) {
  return {id: c.id, url: `https://clips.twitch.tv/${c.id}`, embed_url: `https://clips.twitch.tv/embed?clip=${c.id}`,
    broadcaster_id: c.broadcasterId, broadcaster_name: c.broadcasterName, creator_id: c.creatorId, creator_name: c.creatorName,
    video_id: c.videoId, game_id: c.gameId, language: c.language, title: c.title, view_count: c.viewCount,
    created_at: c.createdAt, thumbnail_url: `https://clips-media-assets2.twitch.tv/${c.id}-preview-480x272.jpg`,
    duration: c.duration, vod_offset: c.vodOffset, is_featured: c.isFeatured};
}

/** Helix error body, e.g. {"error":"Unauthorized","status":401,"message":"Invalid OAuth token"}.
 * https://dev.twitch.tv/docs/api/guide/ ("Rate limits" and error handling). */
export function helixError(status: number, message: string) {
  const error = ({400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 500: 'Internal Server Error'} as Record<number, string>)[status] ?? 'Error';
  return {error, status, message};
}

// ---- Chat IRC lines ---------------------------------------------------------------
// https://dev.twitch.tv/docs/chat/irc/ (and the "Twitch IRC tags" reference it links)

/** IRCv3 tag value escaping, as Twitch uses for system-msg and display names. */
export function escapeTag(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}
const tagString = (tags: Record<string, string | number>) => '@' + Object.entries(tags).map(([k, v]) => `${k}=${escapeTag(String(v))}`).join(';');

/** "Authenticating with the Twitch IRC server": the welcome burst after PASS/NICK. */
export function ircWelcome(login: string, user: TwitchUser, withTags: boolean) {
  const lines = [
    `:tmi.twitch.tv 001 ${login} :Welcome, GLHF!`, `:tmi.twitch.tv 002 ${login} :Your host is tmi.twitch.tv`,
    `:tmi.twitch.tv 003 ${login} :This server is rather new`, `:tmi.twitch.tv 004 ${login} :-`,
    `:tmi.twitch.tv 375 ${login} :-`, `:tmi.twitch.tv 372 ${login} :You are in a maze of twisty passages, all alike.`,
    `:tmi.twitch.tv 376 ${login} :>`,
  ];
  if (withTags) lines.push(`${tagString({'badge-info': '', badges: '', color: '', 'display-name': user.name, 'emote-sets': '0', 'user-id': user.id, 'user-type': ''})} :tmi.twitch.tv GLOBALUSERSTATE`);
  return lines;
}
/** Failed PASS/NICK: the server sends this NOTICE and closes. */
export const ircLoginFailed = () => ':tmi.twitch.tv NOTICE * :Login authentication failed';

/** "Joining chat rooms": JOIN echo, NAMES and ROOMSTATE. */
export function ircJoin(login: string, channel: string, roomId: string, withTags: boolean) {
  const lines = [`:${login}!${login}@${login}.tmi.twitch.tv JOIN #${channel}`,
    `:${login}.tmi.twitch.tv 353 ${login} = #${channel} :${login}`, `:${login}.tmi.twitch.tv 366 ${login} #${channel} :End of /NAMES list`];
  if (withTags) lines.push(`${tagString({'emote-only': 0, 'followers-only': -1, r9k: 0, 'room-id': roomId, slow: 0, 'subs-only': 0})} :tmi.twitch.tv ROOMSTATE #${channel}`);
  return lines;
}

/** PRIVMSG with tags (example under "PRIVMSG" in the tags reference). */
export function ircPrivmsg(channel: string, roomId: string, chatter: TwitchUser, message: {id: string; text: string; mod?: boolean; broadcaster?: boolean}, withTags: boolean) {
  const prefix = `:${chatter.login}!${chatter.login}@${chatter.login}.tmi.twitch.tv PRIVMSG #${channel} :${message.text}`;
  if (!withTags) return prefix;
  return `${tagString({'badge-info': '', badges: message.broadcaster ? 'broadcaster/1' : message.mod ? 'moderator/1' : '', color: '#0000FF',
    'display-name': chatter.name, emotes: '', 'first-msg': 0, flags: '', id: message.id, mod: message.mod ? 1 : 0, 'room-id': roomId,
    subscriber: 0, 'tmi-sent-ts': Date.now(), turbo: 0, 'user-id': chatter.id, 'user-type': ''})} ${prefix}`;
}

/** CLEARMSG: one message removed. Example "@login=foo;room-id=;target-msg-id=...;tmi-sent-ts=... :tmi.twitch.tv CLEARMSG #bar :what a great day". */
export function ircClearmsg(channel: string, login: string, targetMsgId: string, text: string) {
  return `${tagString({login, 'room-id': '', 'target-msg-id': targetMsgId, 'tmi-sent-ts': Date.now()})} :tmi.twitch.tv CLEARMSG #${channel} :${text}`;
}

/** CLEARCHAT: with a target user (ban or timeout, ban-duration for a timeout) or the whole room. */
export function ircClearchat(channel: string, roomId: string, target?: {userId: string; login: string; banDuration?: number}) {
  if (!target) return `${tagString({'room-id': roomId, 'tmi-sent-ts': Date.now()})} :tmi.twitch.tv CLEARCHAT #${channel}`;
  const tags: Record<string, string | number> = {};
  if (target.banDuration !== undefined) tags['ban-duration'] = target.banDuration;
  Object.assign(tags, {'room-id': roomId, 'target-user-id': target.userId, 'tmi-sent-ts': Date.now()});
  return `${tagString(tags)} :tmi.twitch.tv CLEARCHAT #${channel} :${target.login}`;
}

/** USERNOTICE with msg-id=raid (example under "USERNOTICE" in the tags reference). */
export function ircRaidUsernotice(channel: string, roomId: string, raider: TwitchUser, viewers: number) {
  return `${tagString({'badge-info': '', badges: '', color: '#0D4200', 'display-name': raider.name, emotes: '', id: randomUUID(), login: raider.login,
    mod: 0, 'msg-id': 'raid', 'msg-param-displayName': raider.name, 'msg-param-login': raider.login, 'msg-param-viewerCount': viewers,
    'room-id': roomId, subscriber: 0, 'system-msg': `${viewers} raiders from ${raider.name} have joined!`, 'tmi-sent-ts': Date.now(),
    turbo: 0, 'user-id': raider.id, 'user-type': ''})} :tmi.twitch.tv USERNOTICE #${channel}`;
}
