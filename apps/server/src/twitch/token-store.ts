import type {TwitchAuthProvider} from '../eventsub/types.ts';
import {twitchConfig, type TwitchConfig} from './config.ts';
import {TwitchOAuth, TwitchOAuthError, type OAuthOptions, type TwitchIdentity, type TwitchTokens} from './oauth.ts';

export interface TwitchStatus {configured: boolean; connected: boolean; login?: string; scopes: string[]; missingScopes: string[]; channel: string; expiresAt?: number; reason?: string}
export interface TokenStoreOptions extends OAuthOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  intervalMs?: number;
  schedule?: (task: () => void, ms: number) => {unref?: () => void};
  cancel?: (timer: {unref?: () => void}) => void;
}
/** In-memory credentials only. No token fields are part of the public status. */
export class TwitchTokenStore implements TwitchAuthProvider {
  readonly config: TwitchConfig;
  readonly oauth: TwitchOAuth;
  private tokens?: TwitchTokens;
  private identity?: TwitchIdentity;
  private expiresAt?: number;
  private reason?: string;
  private refreshing?: Promise<void>;
  private validating?: Promise<void>;
  private generation = 0;
  private timer?: {unref?: () => void};
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly options: TokenStoreOptions = {}) {
    this.config = twitchConfig(options.env);
    this.oauth = new TwitchOAuth(this.config, options);
    this.now = options.now ?? Date.now;
  }
  status(): TwitchStatus {
    return {configured: this.config.configured, connected: !!this.tokens && !!this.identity,
      login: this.identity?.login, channel: this.config.channel || this.identity?.login || '', missingScopes: this.config.scopes.filter(scope=>!this.identity?.scopes.includes(scope)), scopes: [...(this.identity?.scopes ?? [])], expiresAt: this.expiresAt, reason: this.reason};
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private stopTimer(): void {
    if (this.timer) {
      if (this.options.cancel) this.options.cancel(this.timer);
      else clearInterval(this.timer as ReturnType<typeof setInterval>);
      this.timer = undefined;
    }
  }
  disconnect(reason = 'Twitch disconnected.'): void {
    this.generation++; this.tokens = undefined; this.identity = undefined; this.expiresAt = undefined;
    this.refreshing = undefined; this.validating = undefined; this.reason = reason; this.stopTimer(); this.notify();
  }
  close(): void { this.disconnect(); this.listeners.clear(); }
  private checkIdentity(identity: TwitchIdentity | undefined, previousUser?: string): asserts identity is TwitchIdentity {
    if (!identity || identity.clientId !== this.config.clientId || (previousUser && identity.userId !== previousUser)) throw new TwitchOAuthError(401);
  }
  private save(tokens: TwitchTokens, identity: TwitchIdentity): void {
    this.tokens = tokens; this.identity = identity; this.expiresAt = this.now() + identity.expiresIn * 1000; this.reason = undefined;
    this.notify();
  }
  async connect(code: string): Promise<void> {
    const generation = ++this.generation;
    if (!this.config.configured) throw new TwitchOAuthError(503);
    let tokens = await this.oauth.exchange(code);
    let identity = await this.oauth.validate(tokens.accessToken);
    if (!identity) { tokens = await this.oauth.refresh(tokens.refreshToken); identity = await this.oauth.validate(tokens.accessToken); }
    this.checkIdentity(identity);
    if (generation !== this.generation) throw new TwitchOAuthError(409);
    this.save(tokens, identity);
    this.stopTimer();
    this.timer = (this.options.schedule ?? ((task, ms) => setInterval(task, ms)))(() => { void this.validate(); }, this.options.intervalMs ?? 3_600_000);
    this.timer.unref?.();
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!this.tokens) return Promise.resolve();
    const generation = this.generation, tokens = this.tokens, user = this.identity?.userId;
    const task = (async () => {
      try {
        const rotated = await this.oauth.refresh(tokens.refreshToken);
        if (generation === this.generation) this.tokens = rotated;
        const identity = await this.oauth.validate(rotated.accessToken);
        this.checkIdentity(identity, user);
        if (generation === this.generation) this.save(rotated, identity);
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof TwitchOAuthError && (error.status === 400 || error.status === 401)) this.disconnect('Twitch authorization expired. Reconnect Twitch.');
        else this.disconnect('Twitch refresh unavailable. Reconnect Twitch.');
      }
    })();
    this.refreshing = task;
    void task.finally(() => { if (this.refreshing === task) this.refreshing = undefined; });
    return task;
  }
  validate(): Promise<void> {
    if (this.validating) return this.validating;
    if (!this.tokens) return Promise.resolve();
    const generation = this.generation, token = this.tokens.accessToken;
    const task = (async () => {
      try {
        const identity = await this.oauth.validate(token);
        if (generation !== this.generation || this.tokens?.accessToken !== token) return;
        if (!identity) { await this.refresh(); return; }
        this.checkIdentity(identity, this.identity?.userId);
        this.save(this.tokens, identity);
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof TwitchOAuthError && error.status === 401) this.disconnect('Twitch authorization expired. Reconnect Twitch.');
        else { this.reason = 'Twitch validation unavailable.'; this.notify(); }
      }
    })();
    this.validating = task;
    void task.finally(() => { if (this.validating === task) this.validating = undefined; });
    return task;
  }
  async getAuth(): ReturnType<TwitchAuthProvider['getAuth']> {
    if (this.expiresAt !== undefined && this.expiresAt <= this.now()) await this.refresh();
    if (!this.tokens || !this.identity || (this.expiresAt ?? 0) <= this.now()) return undefined;
    return {clientId: this.config.clientId, accessToken: this.tokens.accessToken, broadcasterId: this.identity.userId, login: this.identity.login};
  }
  ircSnapshot(): {username: string; token: string} | undefined {
    if (!this.tokens || !this.identity || (this.expiresAt ?? 0) <= this.now()) return undefined;
    return {username: this.identity.login, token: `oauth:${this.tokens.accessToken}`};
  }
}

/** Retry once with current credentials after a Helix 401; never expose credentials in errors. */
export async function withTwitchAuth<T extends {status: number}>(provider: TwitchAuthProvider,
  run: (auth: NonNullable<Awaited<ReturnType<TwitchAuthProvider['getAuth']>>>) => Promise<T>): Promise<T> {
  const auth = await provider.getAuth();
  if (!auth) throw new Error('Connect Twitch before using this feature.');
  const response = await run(auth);
  if (response.status !== 401) return response;
  await provider.refresh();
  const refreshed = await provider.getAuth();
  if (!refreshed) throw new Error('Twitch authorization expired. Reconnect Twitch.');
  return run(refreshed);
}
