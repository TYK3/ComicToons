// FakeTwitch: one local process that stands in for the Twitch endpoints ComicToons
// uses, with payload shapes copied from dev.twitch.tv (see payloads.ts). It never
// contacts Twitch. One TCP port serves HTTP (OAuth, Helix, EventSub WebSocket) and
// plain-text IRC (sniffed from the first bytes), so a whole run needs one port.
//
// Endpoint docs mirrored here:
//   OAuth authorisation code flow  https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/
//   Refreshing access tokens       https://dev.twitch.tv/docs/authentication/refresh-tokens/
//   Validating tokens              https://dev.twitch.tv/docs/authentication/validate-tokens/
//   Revoking tokens                https://dev.twitch.tv/docs/authentication/revoke-tokens/
//   Helix reference                https://dev.twitch.tv/docs/api/reference/
//   Helix rate limits              https://dev.twitch.tv/docs/api/guide/
//   EventSub WebSocket             https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
//   EventSub subscription types    https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/
//   Chat over IRC                  https://dev.twitch.tv/docs/chat/irc/
//
// Secrets: every credential here is a made-up local value. The call log records
// grant types, paths and statuses only, never tokens, codes or secrets.
import {randomBytes, randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse} from 'node:http';
import {createServer as createNetServer, type AddressInfo, type Server as NetServer} from 'node:net';
import {FakeIrc} from './fake-irc.ts';
import * as P from './payloads.ts';
import {WsConnection} from './websocket.ts';

export type BroadcasterType = 'affiliate' | 'partner' | '';
export interface FakeUser extends P.TwitchUser { broadcasterType: BroadcasterType }
export interface FakeTwitchOptions {
  host?: string;
  /** Default 4120, the port reserved for the fake (0 picks a free port). */
  port?: number;
  clientId?: string;
  clientSecret?: string;
  redirectUris?: string[];
  broadcaster?: Partial<FakeUser>;
  accessTokenTtlSeconds?: number;
  /** Advertised in the welcome message; Twitch allows 10-600 (default 10). */
  keepaliveSeconds?: number;
  /** Close 4003 if no subscription arrives within this window (Twitch: 10 s). */
  subscribeWindowMs?: number;
  /** After session_reconnect, the old socket is closed 4004 after this (Twitch: 30 s). */
  reconnectGraceMs?: number;
  authorizeMode?: 'approve' | 'deny';
  /** Test speed-up only: send keepalives this often instead of just inside the advertised timeout. */
  keepaliveSendMs?: number;
}

export interface LogEntry { at: number; kind: string; detail: Record<string, string | number | boolean | undefined> }
interface TokenRecord { clientId: string; userId?: string; scopes: string[]; expiresAt: number; refreshToken?: string }
interface RefreshRecord { clientId: string; userId: string; scopes: string[] }
interface CodeRecord { clientId: string; redirectUri: string; scopes: string[]; userId: string }
interface Fault { method?: string; path: string; status: number; remaining: number; message?: string; retryAfterSeconds?: number }
interface Session {
  id: string; conn: WsConnection; connectedAt: string; keepaliveSeconds: number; status: 'connected' | 'reconnecting' | 'closed';
  keepaliveTimer?: NodeJS.Timeout; welcomeTimer?: NodeJS.Timeout; graceTimer?: NodeJS.Timeout; silent: boolean; sent: unknown[];
}

/** Scopes and condition keys per subscription type, from the subscription types page
 * and https://dev.twitch.tv/docs/authentication/scopes/. A list means "any of". */
export const SUBSCRIPTION_TYPES: Record<string, {version: string; scopes: string[]; condition: string[][]}> = {
  'channel.chat.message': {version: '1', scopes: ['user:read:chat'], condition: [['broadcaster_user_id', 'user_id']]},
  'channel.chat.message_delete': {version: '1', scopes: ['user:read:chat'], condition: [['broadcaster_user_id', 'user_id']]},
  'channel.chat.clear': {version: '1', scopes: ['user:read:chat'], condition: [['broadcaster_user_id', 'user_id']]},
  'channel.chat.clear_user_messages': {version: '1', scopes: ['user:read:chat'], condition: [['broadcaster_user_id', 'user_id']]},
  'channel.raid': {version: '1', scopes: [], condition: [['to_broadcaster_user_id'], ['from_broadcaster_user_id']]},
  'channel.channel_points_custom_reward_redemption.add': {version: '1', scopes: ['channel:read:redemptions', 'channel:manage:redemptions'], condition: [['broadcaster_user_id']]},
  'channel.channel_points_custom_reward_redemption.update': {version: '1', scopes: ['channel:read:redemptions', 'channel:manage:redemptions'], condition: [['broadcaster_user_id']]},
  'channel.poll.begin': {version: '1', scopes: ['channel:read:polls', 'channel:manage:polls'], condition: [['broadcaster_user_id']]},
  'channel.poll.progress': {version: '1', scopes: ['channel:read:polls', 'channel:manage:polls'], condition: [['broadcaster_user_id']]},
  'channel.poll.end': {version: '1', scopes: ['channel:read:polls', 'channel:manage:polls'], condition: [['broadcaster_user_id']]},
  'channel.prediction.begin': {version: '1', scopes: ['channel:read:predictions', 'channel:manage:predictions'], condition: [['broadcaster_user_id']]},
  'channel.prediction.progress': {version: '1', scopes: ['channel:read:predictions', 'channel:manage:predictions'], condition: [['broadcaster_user_id']]},
  'channel.prediction.lock': {version: '1', scopes: ['channel:read:predictions', 'channel:manage:predictions'], condition: [['broadcaster_user_id']]},
  'channel.prediction.end': {version: '1', scopes: ['channel:read:predictions', 'channel:manage:predictions'], condition: [['broadcaster_user_id']]},
  'channel.hype_train.begin': {version: '2', scopes: ['channel:read:hype_train'], condition: [['broadcaster_user_id']]},
  'channel.hype_train.progress': {version: '2', scopes: ['channel:read:hype_train'], condition: [['broadcaster_user_id']]},
  'channel.hype_train.end': {version: '2', scopes: ['channel:read:hype_train'], condition: [['broadcaster_user_id']]},
  'channel.cheer': {version: '1', scopes: ['bits:read'], condition: [['broadcaster_user_id']]},
  'stream.online': {version: '1', scopes: [], condition: [['broadcaster_user_id']]},
  'stream.offline': {version: '1', scopes: [], condition: [['broadcaster_user_id']]},
};

const fakeToken = () => randomBytes(15).toString('hex'); // 30 chars, like Twitch tokens
const MAX_BODY = 64 * 1024;

export class FakeTwitch extends EventEmitter<{log: [LogEntry]}> {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUris: string[];
  readonly broadcaster: FakeUser;
  readonly log: LogEntry[] = [];
  readonly irc: FakeIrc;
  authorizeMode: 'approve' | 'deny';
  acceptingWebsockets = true;
  /** false = refuse new chat (IRC) connections, to simulate an outage. */
  acceptingIrc = true;
  /** Login shown on the authorise step; defaults to the broadcaster. */
  authorizeAs: string;
  private host: string;
  private wantedPort: number;
  private port = 0;
  private net?: NetServer;
  private sockets = new Set<import('node:net').Socket>();
  private http: HttpServer;
  private opts: Required<Pick<FakeTwitchOptions, 'accessTokenTtlSeconds' | 'keepaliveSeconds' | 'subscribeWindowMs' | 'reconnectGraceMs'>> & {keepaliveSendMs?: number};
  private users = new Map<string, FakeUser>();
  private tokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, RefreshRecord>();
  private codes = new Map<string, CodeRecord>();
  private faults: Fault[] = [];
  private retired: string[] = [];
  private rate = {limit: 800, remaining: 800, resetAt: 0};
  readonly sessions = new Map<string, Session>();
  readonly subscriptions = new Map<string, P.Subscription>();
  readonly rewards = new Map<string, P.RewardState>();
  readonly redemptions = new Map<string, P.RedemptionState>();
  readonly polls: P.PollState[] = [];
  readonly predictions: P.PredictionState[] = [];
  readonly sentChat: {message_id: string; message: string}[] = [];
  /** Keyed by user id; Get Streams lists only users present here. */
  readonly streams = new Map<string, P.StreamState>();
  readonly clips: P.ClipState[] = [];

  constructor(options: FakeTwitchOptions = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.wantedPort = options.port ?? 4120;
    this.clientId = options.clientId ?? 'fakeclientid0000000000000000000';
    this.clientSecret = options.clientSecret ?? 'fake-client-secret-local-only';
    this.redirectUris = options.redirectUris ?? ['http://127.0.0.1:3120/auth/twitch/callback'];
    this.broadcaster = {id: '90000001', login: 'fakebroadcaster', name: 'FakeBroadcaster', broadcasterType: 'affiliate', ...options.broadcaster};
    this.users.set(this.broadcaster.login, this.broadcaster);
    this.authorizeAs = this.broadcaster.login;
    this.authorizeMode = options.authorizeMode ?? 'approve';
    this.opts = {accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? 14_400, keepaliveSeconds: options.keepaliveSeconds ?? 10,
      subscribeWindowMs: options.subscribeWindowMs ?? 10_000, reconnectGraceMs: options.reconnectGraceMs ?? 30_000, keepaliveSendMs: options.keepaliveSendMs};
    this.http = createHttpServer((req, res) => { void this.route(req, res); });
    this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.irc = new FakeIrc({
      authenticate: token => {
        const record = this.liveToken(token);
        const user = record?.userId ? this.userById(record.userId) : undefined;
        return record && user ? {user, scopes: record.scopes} : undefined;
      },
      roomId: () => this.broadcaster.id,
      log: (kind, detail) => this.record(kind, detail),
    });
  }

  // ---- lifecycle -------------------------------------------------------------------
  async start() {
    this.net = createNetServer(socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      socket.once('data', first => {
        socket.pause();
        socket.unshift(first);
        if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(first.subarray(0, 8).toString('latin1'))) this.http.emit('connection', socket);
        else if (!this.acceptingIrc) { this.record('irc.refused'); socket.destroy(); return; }
        else this.irc.attach(socket);
        socket.resume();
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      this.net!.once('error', reject);
      this.net!.listen(this.wantedPort, this.host, () => resolve());
    });
    this.port = (this.net.address() as AddressInfo).port;
    return this;
  }
  async stop() {
    for (const session of this.sessions.values()) { try { this.endSession(session, 'drop'); } catch { /* already gone */ } }
    try { this.irc.stop(); } catch { /* already gone */ }
    this.http.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.net ? this.net.close(() => resolve()) : resolve());
  }
  get urls() {
    const base = `http://${this.host}:${this.port}`;
    return {base, authBase: `${base}/oauth2`, helixBase: `${base}/helix`, eventSubWs: `ws://${this.host}:${this.port}/ws`,
      irc: `irc://${this.host}:${this.port}`, ircHost: this.host, ircPort: this.port};
  }
  /** Environment for a ComicToons server pointed at this fake. The override names are
   * proposed to the T2/T3 owners (see report); the client secret is a local fake. */
  appEnv(): Record<string, string> {
    return {
      TWITCH_CLIENT_ID: this.clientId, TWITCH_CLIENT_SECRET: this.clientSecret, TWITCH_REDIRECT_URI: this.redirectUris[0]!,
      TWITCH_CHANNEL: this.broadcaster.login,
      COMICTOONS_TWITCH_AUTH_BASE_URL: this.urls.authBase, COMICTOONS_TWITCH_HELIX_BASE_URL: this.urls.helixBase,
      COMICTOONS_TWITCH_EVENTSUB_WS_URL: this.urls.eventSubWs, COMICTOONS_TWITCH_IRC_URL: this.urls.irc,
    };
  }

  // ---- log ---------------------------------------------------------------------------
  private record(kind: string, detail: LogEntry['detail'] = {}) {
    const entry = {at: Date.now(), kind, detail};
    this.log.push(entry);
    this.emit('log', entry);
  }
  /** Resolves with the first log entry (past or future) that matches. */
  waitForLog(match: (entry: LogEntry) => boolean, timeoutMs = 5000) {
    const found = this.log.find(match);
    if (found) return Promise.resolve(found);
    return new Promise<LogEntry>((resolve, reject) => {
      const timer = setTimeout(() => { this.off('log', listener); reject(new Error(`timed out waiting for fake Twitch log entry after ${timeoutMs} ms`)); }, timeoutMs);
      const listener = (entry: LogEntry) => { if (match(entry)) { clearTimeout(timer); this.off('log', listener); resolve(entry); } };
      this.on('log', listener);
    });
  }

  // ---- users and tokens ------------------------------------------------------------
  user(login: string, broadcasterType: BroadcasterType = ''): FakeUser {
    const key = login.toLowerCase();
    let user = this.users.get(key);
    if (!user) {
      user = {id: String(91000000 + this.users.size), login: key, name: login, broadcasterType};
      this.users.set(key, user);
    }
    return user;
  }
  private userById(id: string) { return [...this.users.values()].find(u => u.id === id); }
  private liveToken(token: string) {
    const record = this.tokens.get(token);
    return record && record.expiresAt > Date.now() ? record : undefined;
  }
  /** Issues a user token directly (self-tests). Returns secrets to the caller only. */
  issueUserToken(scopes: string[], login = this.broadcaster.login, clientId = this.clientId) {
    const user = this.user(login);
    return this.mint(clientId, user.id, scopes);
  }
  private mint(clientId: string, userId: string | undefined, scopes: string[]) {
    const accessToken = fakeToken();
    const refreshToken = userId ? fakeToken() : undefined;
    this.tokens.set(accessToken, {clientId, userId, scopes, expiresAt: Date.now() + this.opts.accessTokenTtlSeconds * 1000, refreshToken});
    if (refreshToken && userId) this.refreshTokens.set(refreshToken, {clientId, userId, scopes});
    return {access_token: accessToken, expires_in: this.opts.accessTokenTtlSeconds, ...(refreshToken ? {refresh_token: refreshToken} : {}), scope: scopes, token_type: 'bearer'};
  }
  /** Every current access token stops working; refresh tokens still work (token expiry). */
  expireAccessTokens() {
    for (const record of this.tokens.values()) record.expiresAt = 0;
    this.record('control.expire_tokens');
  }
  /** The user disconnects the app on Twitch: access and refresh tokens die, subscriptions are revoked. */
  revokeAuthorisation() {
    this.retired.push(...this.tokens.keys(), ...this.refreshTokens.keys());
    this.tokens.clear(); this.refreshTokens.clear();
    for (const sub of this.subscriptions.values()) if (sub.status === 'enabled') this.revokeSubscription(sub.id, 'authorization_revoked');
    this.record('control.revoke_authorisation');
  }
  /** Every credential value this fake has handed out, so tests can assert none of them leaks
   * into app responses, logs or the browser. Never print the result. */
  secretValues() {
    return [this.clientSecret, ...this.tokens.keys(), ...this.refreshTokens.keys(), ...this.codes.keys(), ...this.retired];
  }
  get activeAccessTokenCount() { return [...this.tokens.values()].filter(t => t.expiresAt > Date.now()).length; }

  // ---- fault injection ----------------------------------------------------------------
  /** The next `times` matching requests fail with `status`. 429 also zeroes the rate-limit headers. */
  injectFault(fault: {method?: string; path: string; status: number; times?: number; message?: string; retryAfterSeconds?: number}) {
    this.faults.push({...fault, remaining: fault.times ?? 1});
  }
  private takeFault(method: string, path: string) {
    const fault = this.faults.find(f => f.remaining > 0 && path.startsWith(f.path) && (!f.method || f.method === method));
    if (fault) fault.remaining--;
    return fault;
  }

  // ---- HTTP routing ------------------------------------------------------------------
  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const method = req.method ?? 'GET';
    // No keep-alive: a pooled client socket must never outlive this fake and land on the next
    // one started on the same port.
    res.shouldKeepAlive = false;
    try {
      const fault = this.takeFault(method, url.pathname);
      if (fault) return this.sendFault(res, url.pathname, method, fault);
      if (url.pathname === '/oauth2/authorize' && method === 'GET') return this.authorize(url, res);
      if (url.pathname === '/oauth2/token' && method === 'POST') return this.token(await readForm(req), res);
      if (url.pathname === '/oauth2/validate' && method === 'GET') return this.validate(req, res);
      if (url.pathname === '/oauth2/revoke' && method === 'POST') return this.revoke(await readForm(req), res);
      if (url.pathname.startsWith('/helix/')) return await this.helix(req, res, url, method);
      if (url.pathname === '/health') return json(res, 200, {ok: true});
      return json(res, 404, P.helixError(404, 'Not Found'));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      this.record('http.error', {path: url.pathname, status});
      return json(res, status, P.helixError(status, error instanceof HttpError ? error.message : 'Internal Server Error'));
    }
  }
  private sendFault(res: ServerResponse, path: string, method: string, fault: Fault) {
    this.record('fault', {path, method, status: fault.status});
    const headers: Record<string, string> = {};
    if (path.startsWith('/helix/')) Object.assign(headers, this.rateHeaders(fault.status === 429));
    if (fault.status === 429 && fault.retryAfterSeconds !== undefined) headers['Ratelimit-Reset'] = String(Math.floor(Date.now() / 1000) + fault.retryAfterSeconds);
    const message = fault.message ?? ({401: 'Invalid OAuth token', 403: 'Forbidden', 429: 'Too Many Requests', 500: 'Internal Server Error'} as Record<number, string>)[fault.status] ?? 'Error';
    return json(res, fault.status, P.helixError(fault.status, message), headers);
  }

  // ---- OAuth --------------------------------------------------------------------------
  private authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const clientId = q.get('client_id'), redirectUri = q.get('redirect_uri') ?? '', state = q.get('state');
    const scopes = (q.get('scope') ?? '').split(' ').filter(Boolean);
    if (clientId !== this.clientId) { this.record('oauth.authorize', {ok: false, reason: 'client'}); return json(res, 400, {status: 400, message: 'invalid client'}); }
    if (!this.redirectUris.includes(redirectUri)) { this.record('oauth.authorize', {ok: false, reason: 'redirect_mismatch'}); return json(res, 400, {status: 400, message: 'redirect_mismatch'}); }
    if (q.get('response_type') !== 'code') { this.record('oauth.authorize', {ok: false, reason: 'response_type'}); return json(res, 400, {status: 400, message: 'unsupported response_type'}); }
    const target = new URL(redirectUri);
    if (this.authorizeMode === 'deny') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'The user denied you access');
    } else {
      const code = fakeToken();
      this.codes.set(code, {clientId, redirectUri, scopes, userId: this.user(this.authorizeAs).id});
      target.searchParams.set('code', code);
      target.searchParams.set('scope', scopes.join(' '));
    }
    if (state !== null) target.searchParams.set('state', state);
    this.record('oauth.authorize', {ok: this.authorizeMode === 'approve', scopes: scopes.join(' '), state: state !== null});
    res.writeHead(302, {Location: target.toString()}).end();
  }
  private token(form: URLSearchParams, res: ServerResponse) {
    const grant = form.get('grant_type') ?? '';
    const clientOk = form.get('client_id') === this.clientId && form.get('client_secret') === this.clientSecret;
    if (!clientOk) { this.record('oauth.token', {grant, status: 403}); return json(res, 403, {status: 403, message: 'invalid client secret'}); }
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const record = this.codes.get(code);
      if (record) this.retired.push(code);
      this.codes.delete(code); // single use
      if (!record || record.redirectUri !== form.get('redirect_uri')) {
        this.record('oauth.token', {grant, status: 400});
        return json(res, 400, {status: 400, message: 'Invalid authorization code'});
      }
      this.record('oauth.token', {grant, status: 200});
      return json(res, 200, this.mint(record.clientId, record.userId, record.scopes));
    }
    if (grant === 'refresh_token') {
      const refresh = form.get('refresh_token') ?? '';
      const record = this.refreshTokens.get(refresh);
      if (!record) {
        this.record('oauth.token', {grant, status: 400});
        return json(res, 400, {error: 'Bad Request', status: 400, message: 'Invalid refresh token'});
      }
      // Rotation: the old refresh token and its access tokens stop working.
      this.refreshTokens.delete(refresh);
      this.retired.push(refresh);
      for (const [token, t] of this.tokens) if (t.refreshToken === refresh) { this.tokens.delete(token); this.retired.push(token); }
      this.record('oauth.token', {grant, status: 200});
      return json(res, 200, this.mint(record.clientId, record.userId, record.scopes));
    }
    if (grant === 'client_credentials') {
      this.record('oauth.token', {grant, status: 200});
      const {access_token, expires_in} = this.mint(this.clientId, undefined, []);
      return json(res, 200, {access_token, expires_in, token_type: 'bearer'});
    }
    this.record('oauth.token', {grant, status: 400});
    return json(res, 400, {status: 400, message: 'Invalid grant type'});
  }
  private validate(req: IncomingMessage, res: ServerResponse) {
    const header = req.headers.authorization ?? '';
    const token = /^(?:OAuth|Bearer) (.+)$/i.exec(header)?.[1] ?? '';
    const record = this.liveToken(token);
    if (!record) { this.record('oauth.validate', {status: 401}); return json(res, 401, {status: 401, message: 'invalid access token'}); }
    const user = record.userId ? this.userById(record.userId) : undefined;
    this.record('oauth.validate', {status: 200});
    return json(res, 200, {client_id: record.clientId, login: user?.login, scopes: record.scopes, user_id: user?.id,
      expires_in: Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000))});
  }
  private revoke(form: URLSearchParams, res: ServerResponse) {
    const token = form.get('token') ?? '';
    const record = this.tokens.get(token);
    if (form.get('client_id') !== this.clientId || !record) { this.record('oauth.revoke', {status: 400}); return json(res, 400, {status: 400, message: 'Invalid token'}); }
    this.tokens.delete(token);
    this.retired.push(token);
    if (record.refreshToken) this.refreshTokens.delete(record.refreshToken);
    this.record('oauth.revoke', {status: 200});
    res.writeHead(200).end();
  }

  // ---- Helix --------------------------------------------------------------------------
  // Helix GETs are routed one path at a time below, not through a generic handler; an
  // endpoint with no case here simply falls through to the 404 at the end of helix().
  private rateHeaders(exhausted = false) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= this.rate.resetAt) { this.rate.resetAt = now + 60; this.rate.remaining = this.rate.limit; }
    if (exhausted) this.rate.remaining = 0; else if (this.rate.remaining > 0) this.rate.remaining--;
    return {'Ratelimit-Limit': String(this.rate.limit), 'Ratelimit-Remaining': String(this.rate.remaining), 'Ratelimit-Reset': String(this.rate.resetAt)};
  }
  private async helix(req: IncomingMessage, res: ServerResponse, url: URL, method: string) {
    const path = url.pathname.slice('/helix'.length);
    const headers = this.rateHeaders();
    const send = (status: number, body?: unknown) => {
      this.record('helix', {method, path, status});
      if (body === undefined) { res.writeHead(status, headers).end(); return; }
      json(res, status, body, headers);
    };
    const fail = (status: number, message: string) => send(status, P.helixError(status, message));
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const auth = this.liveToken(bearer);
    if (!auth) return fail(401, 'Invalid OAuth token');
    if (req.headers['client-id'] !== auth.clientId) return fail(401, 'Client ID and OAuth token do not match');
    const me = auth.userId ? this.userById(auth.userId) : undefined;
    const needScope = (...any: string[]) => any.some(s => auth.scopes.includes(s));
    const q = url.searchParams;
    const mustBeBroadcaster = () => {
      if (!me) { fail(401, 'User access token required'); return false; }
      if (q.get('broadcaster_id') !== me.id) { fail(403, 'The ID in broadcaster_id must match the user ID found in the request\'s OAuth token.'); return false; }
      return true;
    };

    if (path === '/users' && method === 'GET') {
      const logins = q.getAll('login'), ids = q.getAll('id');
      const list = logins.length || ids.length
        ? [...logins.map(l => this.users.get(l.toLowerCase())), ...ids.map(i => this.userById(i))].filter((u): u is FakeUser => !!u)
        : me ? [me] : [];
      const canEmail = needScope('user:read:email');
      return send(200, {data: list.map(u => P.userBody(u, canEmail && me && u.id === me.id ? `${u.login}@example.invalid` : undefined))});
    }

    if (path === '/eventsub/subscriptions') {
      if (method === 'GET') {
        const all = [...this.subscriptions.values()];
        return send(200, {data: all, total: all.length, total_cost: this.totalCost(), max_total_cost: 10, pagination: {}});
      }
      if (method === 'DELETE') {
        const id = q.get('id') ?? '';
        if (!this.subscriptions.delete(id)) return fail(404, 'subscription not found');
        return send(204);
      }
      if (method === 'POST') {
        const body = await readJson(req);
        if (!me) return fail(403, 'WebSocket transports require a user access token');
        const type = String(body.type ?? ''), version = String(body.version ?? '');
        const spec = SUBSCRIPTION_TYPES[type];
        if (!spec || spec.version !== version) return fail(400, 'The combination of values in the type and version fields is not valid');
        const condition = (body.condition ?? {}) as Record<string, string>;
        if (!spec.condition.some(keys => keys.every(k => typeof condition[k] === 'string' && condition[k]))) return fail(400, 'invalid condition');
        if (spec.scopes.length && !needScope(...spec.scopes)) return fail(403, 'subscription missing proper authorization');
        const transport = (body.transport ?? {}) as {method?: string; session_id?: string};
        if (transport.method !== 'websocket') return fail(400, 'only the websocket transport is mocked');
        const session = this.sessions.get(transport.session_id ?? '');
        if (!session || session.status === 'closed') return fail(400, 'session does not exist or has already disconnected');
        const same = [...this.subscriptions.values()].find(s => s.type === type && s.version === version && s.transport.session_id === session.id && JSON.stringify(s.condition) === JSON.stringify(condition));
        if (same) return fail(409, 'subscription already exists');
        if ([...this.subscriptions.values()].filter(s => s.transport.session_id === session.id).length >= 300) return fail(429, 'too many subscriptions on this session');
        const sub: P.Subscription = {id: randomUUID(), status: 'enabled', type, version, condition,
          transport: {method: 'websocket', session_id: session.id, connected_at: session.connectedAt}, created_at: P.stamp(), cost: 0};
        this.subscriptions.set(sub.id, sub);
        if (session.welcomeTimer) { clearTimeout(session.welcomeTimer); session.welcomeTimer = undefined; }
        this.record('eventsub.subscribe', {type, version, session: session.id});
        return send(202, {data: [sub], total: this.subscriptions.size, total_cost: this.totalCost(), max_total_cost: 10});
      }
    }

    if (path === '/channel_points/custom_rewards') {
      if (!needScope('channel:manage:redemptions', ...(method === 'GET' ? ['channel:read:redemptions'] : []))) return fail(401, 'Missing scope: channel:manage:redemptions');
      if (!mustBeBroadcaster()) return;
      if (me!.broadcasterType === '') return fail(403, 'The broadcaster is not a partner or affiliate.');
      if (method === 'GET') {
        const onlyManageable = q.get('only_manageable_rewards') === 'true';
        const list = [...this.rewards.values()].filter(r => !onlyManageable || r.ownerClientId === auth.clientId);
        return send(200, {data: list.map(r => P.rewardBody(me!, r))});
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const title = String(body.title ?? '').trim(), cost = Number(body.cost);
        if (!title || title.length > 45) return fail(400, 'The title field is required and may contain a maximum of 45 characters.');
        if (!Number.isInteger(cost) || cost < 1) return fail(400, 'The cost field is required and must be at least 1.');
        if ([...this.rewards.values()].some(r => r.title.toLowerCase() === title.toLowerCase())) return fail(400, 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD');
        if (this.rewards.size >= 50) return fail(400, 'The broadcaster has reached the maximum of 50 custom rewards.');
        const reward: P.RewardState = {id: randomUUID(), title, prompt: String(body.prompt ?? ''), cost,
          isUserInputRequired: body.is_user_input_required === true, isEnabled: body.is_enabled !== false, isPaused: false,
          backgroundColor: String(body.background_color ?? '#9147FF'),
          maxPerStream: body.is_max_per_stream_enabled === true ? Number(body.max_per_stream) : 0,
          maxPerUserPerStream: body.is_max_per_user_per_stream_enabled === true ? Number(body.max_per_user_per_stream) : 0,
          globalCooldownSeconds: body.is_global_cooldown_enabled === true ? Number(body.global_cooldown_seconds) : 0,
          skipQueue: body.should_redemptions_skip_request_queue === true, ownerClientId: auth.clientId};
        this.rewards.set(reward.id, reward);
        return send(200, {data: [P.rewardBody(me!, reward)]});
      }
    }

    if (path === '/channel_points/custom_rewards/redemptions' && method === 'PATCH') {
      if (!needScope('channel:manage:redemptions')) return fail(401, 'Missing scope: channel:manage:redemptions');
      if (!mustBeBroadcaster()) return;
      const reward = this.rewards.get(q.get('reward_id') ?? '');
      if (!reward) return fail(404, 'reward not found');
      if (reward.ownerClientId !== auth.clientId) return fail(403, 'The app that created the reward is the only app that may update the redemptions.');
      const body = await readJson(req);
      const status = String(body.status ?? '');
      if (status !== 'FULFILLED' && status !== 'CANCELED') return fail(400, 'status must be FULFILLED or CANCELED');
      const updated: P.RedemptionState[] = [];
      for (const id of q.getAll('id')) {
        const redemption = this.redemptions.get(id);
        if (!redemption || redemption.rewardId !== reward.id || redemption.status !== 'UNFULFILLED') continue;
        redemption.status = status;
        updated.push(redemption);
      }
      if (!updated.length) return fail(404, 'no UNFULFILLED redemptions matched the ids');
      for (const r of updated) this.record('redemption.update', {id: r.id, status: r.status});
      return send(200, {data: updated.map(r => P.redemptionBody(me!, r, reward))});
    }

    if (path === '/polls') {
      if (!needScope('channel:manage:polls', ...(method === 'GET' ? ['channel:read:polls'] : []))) return fail(401, 'Missing scope: channel:manage:polls');
      if (method === 'GET') { if (!mustBeBroadcaster()) return; return send(200, {data: [...this.polls].reverse().map(p => P.pollBody(me!, p)), pagination: {}}); }
      const body = await readJson(req);
      q.set('broadcaster_id', String(body.broadcaster_id ?? ''));
      if (!mustBeBroadcaster()) return;
      if (method === 'POST') {
        const title = String(body.title ?? ''), choices = Array.isArray(body.choices) ? body.choices as {title?: string}[] : [];
        const duration = Number(body.duration);
        if (!title || title.length > 60) return fail(400, 'The title may contain a maximum of 60 characters.');
        if (choices.length < 2 || choices.length > 5 || choices.some(c => !c.title || c.title.length > 25)) return fail(400, 'A poll must have 2-5 choices of up to 25 characters.');
        if (!Number.isInteger(duration) || duration < 15 || duration > 1800) return fail(400, 'The duration must be 15-1800 seconds.');
        if (this.activePoll) return fail(400, 'The broadcaster already has a poll that\'s running; you may not create another poll until the current poll completes.');
        const poll: P.PollState = {id: randomUUID(), title, durationSeconds: duration, status: 'ACTIVE', startedAt: P.stamp(),
          channelPointsVoting: {is_enabled: body.channel_points_voting_enabled === true, amount_per_vote: Number(body.channel_points_per_vote ?? 0)},
          choices: choices.map(c => ({id: randomUUID(), title: c.title!, bits_votes: 0, channel_points_votes: 0, votes: 0}))};
        this.polls.push(poll);
        this.notify('channel.poll.begin', P.pollBeginEvent(this.broadcaster, poll));
        return send(200, {data: [P.pollBody(me!, poll)]});
      }
      if (method === 'PATCH') {
        const poll = this.polls.find(p => p.id === body.id);
        const status = String(body.status ?? '');
        if (!poll) return fail(404, 'poll not found');
        if (status !== 'TERMINATED' && status !== 'ARCHIVED') return fail(400, 'status must be TERMINATED or ARCHIVED');
        if (poll.status !== 'ACTIVE' && !(status === 'ARCHIVED' && poll.status !== 'ARCHIVED')) return fail(400, 'poll is not active');
        this.finishPoll(poll, status);
        return send(200, {data: [P.pollBody(me!, poll)]});
      }
    }

    if (path === '/predictions') {
      if (!needScope('channel:manage:predictions', ...(method === 'GET' ? ['channel:read:predictions'] : []))) return fail(401, 'Missing scope: channel:manage:predictions');
      if (method === 'GET') { if (!mustBeBroadcaster()) return; return send(200, {data: [...this.predictions].reverse().map(p => P.predictionBody(me!, p)), pagination: {}}); }
      const body = await readJson(req);
      q.set('broadcaster_id', String(body.broadcaster_id ?? ''));
      if (!mustBeBroadcaster()) return;
      if (method === 'POST') {
        const title = String(body.title ?? ''), outcomes = Array.isArray(body.outcomes) ? body.outcomes as {title?: string}[] : [];
        const window = Number(body.prediction_window);
        if (!title || title.length > 45) return fail(400, 'The title may contain a maximum of 45 characters.');
        if (outcomes.length < 2 || outcomes.length > 10 || outcomes.some(o => !o.title || o.title.length > 25)) return fail(400, 'A prediction must have 2-10 outcomes of up to 25 characters.');
        if (!Number.isInteger(window) || window < 30 || window > 1800) return fail(400, 'The prediction_window must be 30-1800 seconds.');
        if (this.activePrediction) return fail(400, 'The broadcaster already has an active prediction.');
        const prediction: P.PredictionState = {id: randomUUID(), title, windowSeconds: window, status: 'ACTIVE', startedAt: P.stamp(),
          outcomes: outcomes.map((o, i) => ({id: randomUUID(), title: o.title!, color: i === 0 ? 'blue' : 'pink', users: 0, channel_points: 0}))};
        this.predictions.push(prediction);
        this.notify('channel.prediction.begin', P.predictionBeginEvent(this.broadcaster, prediction));
        return send(200, {data: [P.predictionBody(me!, prediction)]});
      }
      if (method === 'PATCH') {
        const prediction = this.predictions.find(p => p.id === body.id);
        const status = String(body.status ?? '');
        if (!prediction) return fail(404, 'prediction not found');
        if (status === 'LOCKED') {
          if (prediction.status !== 'ACTIVE') return fail(400, 'prediction is not active');
          this.lockPrediction(prediction);
        } else if (status === 'RESOLVED') {
          if (prediction.status !== 'ACTIVE' && prediction.status !== 'LOCKED') return fail(400, 'prediction already ended');
          if (!prediction.outcomes.some(o => o.id === body.winning_outcome_id)) return fail(400, 'winning_outcome_id is required to resolve');
          this.endPrediction(prediction, 'RESOLVED', String(body.winning_outcome_id));
        } else if (status === 'CANCELED') {
          if (prediction.status !== 'ACTIVE' && prediction.status !== 'LOCKED') return fail(400, 'prediction already ended');
          this.endPrediction(prediction, 'CANCELED');
        } else return fail(400, 'status must be RESOLVED, CANCELED or LOCKED');
        return send(200, {data: [P.predictionBody(me!, prediction)]});
      }
    }

    if (path === '/streams' && method === 'GET') {
      const logins = new Set(q.getAll('user_login').map(l => l.toLowerCase())), ids = new Set(q.getAll('user_id'));
      let list = [...this.streams.values()];
      if (logins.size || ids.size) list = list.filter(s => { const u = this.userById(s.userId); return !!u && (logins.has(u.login) || ids.has(u.id)); });
      return send(200, {data: list.map(s => P.streamBody(this.userById(s.userId)!, s)), pagination: {}});
    }

    if (path === '/clips' && method === 'GET') {
      const broadcasterId = q.get('broadcaster_id');
      if (!broadcasterId) return fail(400, 'The broadcaster_id, game_id or id query parameter is required.');
      return send(200, {data: this.clips.filter(c => c.broadcasterId === broadcasterId).map(P.clipBody), pagination: {}});
    }

    if (path === '/chat/messages' && method === 'POST') {
      if (!needScope('user:write:chat')) return fail(401, 'Missing scope: user:write:chat');
      const body = await readJson(req);
      const message = String(body.message ?? '');
      if (!message || message.length > 500) return fail(400, 'message must be 1-500 characters');
      if (!me || body.sender_id !== me.id) return fail(403, 'sender_id must match the user in the token');
      const messageId = randomUUID();
      this.sentChat.push({message_id: messageId, message});
      return send(200, {data: [{message_id: messageId, is_sent: true, drop_reason: null}]});
    }

    return fail(404, 'Not Found');
  }
  private totalCost() { return [...this.subscriptions.values()].reduce((sum, s) => sum + s.cost, 0); }

  // ---- EventSub WebSocket ------------------------------------------------------------
  private upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    if (url.pathname !== '/ws' || !this.acceptingWebsockets) {
      this.record('ws.refused', {path: url.pathname});
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const conn = WsConnection.accept(req, socket, head);
    if (!conn) return;
    const requested = Number(url.searchParams.get('keepalive_timeout_seconds'));
    const keepaliveSeconds = Number.isInteger(requested) && requested >= 10 && requested <= 600 ? requested : this.opts.keepaliveSeconds;
    const reconnectFrom = url.searchParams.get('reconnect_id');
    const session: Session = {id: `${randomBytes(4).toString('hex')}_${randomBytes(4).toString('hex')}`, conn, connectedAt: P.stamp(),
      keepaliveSeconds, status: 'connected', silent: false, sent: []};
    this.sessions.set(session.id, session);
    conn.on('message', () => {
      // Clients must not send anything except pong (close 4001 "Client sent inbound traffic").
      this.record('ws.inbound', {session: session.id});
      this.endSession(session, P.EVENTSUB_CLOSE.clientSentInboundTraffic);
    });
    conn.on('close', code => {
      if (session.status !== 'closed') this.record('ws.close', {session: session.id, code, by: conn.closedBy});
      this.markClosed(session);
    });
    let moved = 0;
    if (reconnectFrom) {
      const old = this.sessions.get(reconnectFrom);
      if (!old || old.status !== 'reconnecting') { this.record('ws.connect', {session: session.id, reconnect: true, ok: false}); this.endSession(session, P.EVENTSUB_CLOSE.invalidReconnect); return; }
      for (const sub of this.subscriptions.values()) if (sub.transport.session_id === old.id) { sub.transport.session_id = session.id; sub.transport.connected_at = session.connectedAt; moved++; }
    }
    this.record('ws.connect', {session: session.id, reconnect: !!reconnectFrom, moved});
    this.sendTo(session, P.welcomeMessage(session));
    // After a reconnect welcome the client closes the old socket itself (or 4004 fires).
    if (!reconnectFrom) {
      session.welcomeTimer = setTimeout(() => {
        if (![...this.subscriptions.values()].some(s => s.transport.session_id === session.id)) this.endSession(session, P.EVENTSUB_CLOSE.connectionUnused);
      }, this.opts.subscribeWindowMs);
      session.welcomeTimer.unref();
    }
  }
  private sendTo(session: Session, message: object) {
    if (session.status === 'closed') return;
    session.sent.push(message);
    session.conn.send(JSON.stringify(message));
    this.armKeepalive(session);
  }
  private armKeepalive(session: Session) {
    if (session.keepaliveTimer) clearTimeout(session.keepaliveTimer);
    if (session.status !== 'connected') return;
    // Twitch sends a keepalive when nothing else was sent within the advertised timeout.
    session.keepaliveTimer = setTimeout(() => {
      if (session.silent || session.status !== 'connected') return;
      this.sendTo(session, P.keepaliveMessage());
    }, this.opts.keepaliveSendMs ?? Math.max(100, session.keepaliveSeconds * 1000 - 500));
    session.keepaliveTimer.unref();
  }
  private markClosed(session: Session) {
    if (session.status === 'closed') return;
    session.status = 'closed';
    for (const timer of [session.keepaliveTimer, session.welcomeTimer, session.graceTimer]) if (timer) clearTimeout(timer);
    const disconnectedAt = P.stamp();
    for (const sub of this.subscriptions.values()) {
      if (sub.transport.session_id === session.id && sub.status === 'enabled') {
        sub.status = 'websocket_disconnected';
        sub.transport.disconnected_at = disconnectedAt;
      }
    }
  }
  private endSession(session: Session, code: number | 'drop') {
    if (session.status === 'closed') return;
    this.record('ws.close', {session: session.id, code: code === 'drop' ? 1006 : code, by: code === 'drop' ? 'drop' : 'server'});
    if (code === 'drop') session.conn.drop(); else session.conn.close(code);
    this.markClosed(session);
  }
  get connectedSessions() { return [...this.sessions.values()].filter(s => s.status !== 'closed'); }
  /** Messages sent to a session (self-tests read these to check shapes). */
  sentTo(sessionId: string) { return this.sessions.get(sessionId)?.sent ?? []; }

  /** Sends a notification to every enabled subscription of `type`. Returns deliveries. */
  notify(type: string, event: Record<string, unknown>) {
    let delivered = 0;
    for (const sub of this.subscriptions.values()) {
      if (sub.type !== type || sub.status !== 'enabled') continue;
      const session = this.sessions.get(sub.transport.session_id);
      if (!session || session.status === 'closed') continue;
      this.sendTo(session, P.notificationMessage(sub, event));
      delivered++;
    }
    this.record('eventsub.notify', {type, delivered});
    return delivered;
  }
  /** session_reconnect: the client must connect to reconnect_url, then close this socket.
   * If the old socket is still open after the grace period it is closed with 4004. */
  sendReconnect(sessionId?: string) {
    const targets = sessionId ? [this.sessions.get(sessionId)].filter((s): s is Session => !!s) : this.connectedSessions;
    for (const session of targets) {
      if (session.status !== 'connected') continue;
      const reconnectUrl = `${this.urls.eventSubWs}?reconnect_id=${encodeURIComponent(session.id)}`;
      this.sendTo(session, P.reconnectMessage(session, reconnectUrl));
      session.status = 'reconnecting';
      if (session.keepaliveTimer) clearTimeout(session.keepaliveTimer);
      session.graceTimer = setTimeout(() => this.endSession(session, P.EVENTSUB_CLOSE.reconnectGraceTimeExpired), this.opts.reconnectGraceMs);
      session.graceTimer.unref();
      this.record('eventsub.reconnect_sent', {session: session.id});
    }
    return targets.length;
  }
  revokeSubscription(id: string, status: 'user_removed' | 'authorization_revoked' | 'version_removed') {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;
    sub.status = status;
    const session = this.sessions.get(sub.transport.session_id);
    if (session) this.sendTo(session, P.revocationMessage(sub));
    this.record('eventsub.revoke', {type: sub.type, status});
    return true;
  }
  /** Stop sending keepalives (a silent, half-open link). */
  silence(enabled = true) { for (const s of this.connectedSessions) { s.silent = enabled; if (!enabled) this.armKeepalive(s); } }
  /** Close every EventSub socket with a Twitch close code, or drop it without a close frame. */
  closeSessions(code: number | 'drop' = 'drop') { for (const s of this.connectedSessions) this.endSession(s, code); }

  // ---- scenario helpers (what a viewer or the broadcaster does on Twitch) ---------------
  get activePoll() { return this.polls.find(p => p.status === 'ACTIVE'); }
  get activePrediction() { return this.predictions.find(p => p.status === 'ACTIVE' || p.status === 'LOCKED'); }
  /** A viewer chats: one id goes to IRC (PRIVMSG) and EventSub (channel.chat.message), so either path can dedupe. */
  chat(login: string, text: string, extra: {mod?: boolean; id?: string} = {}) {
    const chatter = login.toLowerCase() === this.broadcaster.login ? this.broadcaster : this.user(login);
    const id = extra.id ?? randomUUID();
    const irc = this.irc.privmsg(this.broadcaster.login, chatter, {id, text, mod: extra.mod, broadcaster: chatter.id === this.broadcaster.id}).delivered;
    const eventsub = this.notify('channel.chat.message', P.chatMessageEvent(this.broadcaster, chatter, {id, text,
      badges: chatter.id === this.broadcaster.id ? [{set_id: 'broadcaster', id: '1', info: ''}] : extra.mod ? [{set_id: 'moderator', id: '1', info: ''}] : []}));
    return {id, irc, eventsub};
  }
  /** A moderator deletes one message (CLEARMSG / channel.chat.message_delete). */
  deleteMessage(login: string, messageId: string, text = '') {
    const target = this.user(login);
    return {irc: this.irc.clearmsg(this.broadcaster.login, target.login, messageId, text),
      eventsub: this.notify('channel.chat.message_delete', P.chatMessageDeleteEvent(this.broadcaster, target, messageId))};
  }
  /** Ban or timeout (CLEARCHAT with target / clear_user_messages), or clear the room. */
  clearChat(login?: string, banDurationSeconds?: number) {
    if (!login) return {irc: this.irc.clearchat(this.broadcaster.login), eventsub: this.notify('channel.chat.clear', P.chatClearEvent(this.broadcaster))};
    const target = this.user(login);
    return {irc: this.irc.clearchat(this.broadcaster.login, {userId: target.id, login: target.login, banDuration: banDurationSeconds}),
      eventsub: this.notify('channel.chat.clear_user_messages', P.chatClearUserMessagesEvent(this.broadcaster, target))};
  }
  /** Another channel raids this one (USERNOTICE msg-id=raid and channel.raid). */
  raid(fromLogin: string, viewers: number) {
    const from = this.user(fromLogin, 'affiliate');
    return {irc: this.irc.raid(this.broadcaster.login, from, viewers), eventsub: this.notify('channel.raid', P.raidEvent(from, this.broadcaster, viewers))};
  }
  /** A viewer redeems a custom reward (by title or id). */
  redeem(rewardTitleOrId: string, login: string, userInput = '') {
    const reward = this.rewards.get(rewardTitleOrId) ?? [...this.rewards.values()].find(r => r.title === rewardTitleOrId);
    if (!reward) throw new Error('fake Twitch: no such reward');
    const user = this.user(login);
    const redemption: P.RedemptionState = {id: randomUUID(), rewardId: reward.id, user, userInput, status: reward.skipQueue ? 'FULFILLED' : 'UNFULFILLED', redeemedAt: P.stamp()};
    this.redemptions.set(redemption.id, redemption);
    const delivered = this.notify('channel.channel_points_custom_reward_redemption.add', P.redemptionAddEvent(this.broadcaster, user,
      {id: redemption.id, userInput, status: redemption.status.toLowerCase(), redeemedAt: redemption.redeemedAt}, reward));
    return {redemption, delivered};
  }
  /** Viewers vote; sends channel.poll.progress. */
  votePoll(votes: number[]) {
    const poll = this.activePoll;
    if (!poll) throw new Error('fake Twitch: no active poll');
    poll.choices.forEach((c, i) => { c.votes += votes[i] ?? 0; });
    return this.notify('channel.poll.progress', P.pollProgressEvent(this.broadcaster, poll));
  }
  /** The poll timer runs out (status COMPLETED), or the broadcaster ends it. */
  finishPoll(poll = this.activePoll, status: 'COMPLETED' | 'TERMINATED' | 'ARCHIVED' = 'COMPLETED') {
    if (!poll) throw new Error('fake Twitch: no active poll');
    poll.status = status; poll.endedAt = P.stamp();
    return this.notify('channel.poll.end', P.pollEndEvent(this.broadcaster, poll));
  }
  predict(outcomeIndex: number, users: number, points: number) {
    const prediction = this.activePrediction;
    if (!prediction) throw new Error('fake Twitch: no active prediction');
    const outcome = prediction.outcomes[outcomeIndex];
    if (!outcome) throw new Error('fake Twitch: no such outcome');
    outcome.users += users; outcome.channel_points += points;
    return this.notify('channel.prediction.progress', P.predictionProgressEvent(this.broadcaster, prediction));
  }
  lockPrediction(prediction = this.activePrediction) {
    if (!prediction) throw new Error('fake Twitch: no active prediction');
    prediction.status = 'LOCKED'; prediction.lockedAt = P.stamp();
    return this.notify('channel.prediction.lock', P.predictionLockEvent(this.broadcaster, prediction));
  }
  endPrediction(prediction = this.activePrediction, status: 'RESOLVED' | 'CANCELED' = 'RESOLVED', winningOutcomeId?: string) {
    if (!prediction) throw new Error('fake Twitch: no active prediction');
    prediction.status = status; prediction.endedAt = P.stamp();
    prediction.winningOutcomeId = status === 'RESOLVED' ? winningOutcomeId ?? prediction.outcomes[0]!.id : undefined;
    return this.notify('channel.prediction.end', P.predictionEndEvent(this.broadcaster, prediction));
  }
  /** A user's channel goes live (visible to Get Streams until goOffline). */
  goLive(login: string, overrides: Partial<Omit<P.StreamState, 'id' | 'userId'>> = {}) {
    const user = this.user(login);
    const stream: P.StreamState = {id: randomUUID(), userId: user.id, gameId: '509658', gameName: 'Just Chatting', type: 'live',
      title: 'fixture stream', viewerCount: 1, startedAt: P.stamp(), language: 'en', tags: [], isMature: false, ...overrides};
    this.streams.set(user.id, stream);
    return stream;
  }
  /** The channel stops streaming (no longer listed by Get Streams). */
  goOffline(login: string) { this.streams.delete(this.user(login).id); }
  /** Adds one fixture clip for a broadcaster (Get Clips fixture data). */
  addClip(login: string, overrides: Partial<Omit<P.ClipState, 'id' | 'broadcasterId' | 'broadcasterName'>> = {}) {
    const broadcaster = this.user(login);
    const clip: P.ClipState = {id: randomUUID(), broadcasterId: broadcaster.id, broadcasterName: broadcaster.name,
      creatorId: this.broadcaster.id, creatorName: this.broadcaster.name, videoId: '', gameId: '509658', language: 'en',
      title: 'fixture clip', viewCount: 0, createdAt: P.stamp(), duration: 30, vodOffset: null, isFeatured: false, ...overrides};
    this.clips.push(clip);
    return clip;
  }
  hypeTrain(level = 1, total = 500) {
    return this.notify('channel.hype_train.begin', P.hypeTrainBeginEvent(this.broadcaster, {id: randomUUID(), level, total, goal: total * 2, contributor: this.user('hypefan')}));
  }
}

// ---- small HTTP helpers ------------------------------------------------------------------
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {'Content-Type': 'application/json', ...headers}).end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readForm(req: IncomingMessage) {
  const text = await readBody(req);
  // Twitch accepts the token request as a form body or query; the body is what the docs show.
  return new URLSearchParams(text || new URL(req.url ?? '/', 'http://fake.local').search);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new HttpError(400, 'Malformed JSON body');
}
