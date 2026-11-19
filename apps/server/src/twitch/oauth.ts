import {type TwitchConfig} from './config.ts';

export interface OAuthOptions {fetchImpl?: typeof fetch; baseUrl?: string}
export interface TwitchTokens {accessToken: string; refreshToken: string}
export interface TwitchIdentity {clientId: string; login: string; userId: string; scopes: string[]; expiresIn: number}
export class TwitchOAuthError extends Error {
  constructor(readonly status: number) { super('Twitch authentication could not be completed. Reconnect Twitch.'); }
}
/** Provider responses are never included in errors or logs. */
export class TwitchOAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  constructor(private readonly config: TwitchConfig, options: OAuthOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? 'https://id.twitch.tv').replace(/\/oauth2\/?$/, '');
  }
  authorize(state: string): string {
    const url = new URL('/oauth2/authorize', this.baseUrl);
    url.search = new URLSearchParams({response_type: 'code', client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri, scope: this.config.scopes.join(' '), state}).toString();
    return url.href;
  }
  private async tokens(fields: Record<string, string>): Promise<TwitchTokens> {
    try {
      const response = await this.fetchImpl(new URL('/oauth2/token', this.baseUrl), {
        method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({client_id: this.config.clientId, client_secret: this.config.clientSecret, ...fields}),
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
      if (!response.ok) throw new TwitchOAuthError(response.status);
      const data = await response.json() as Record<string, unknown>;
      if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token) throw new TwitchOAuthError(502);
      return {accessToken: data.access_token, refreshToken: data.refresh_token};
    } catch (error) { throw error instanceof TwitchOAuthError ? error : new TwitchOAuthError(503); }
  }
  exchange(code: string): Promise<TwitchTokens> {
    return this.tokens({code, grant_type: 'authorization_code', redirect_uri: this.config.redirectUri});
  }
  refresh(refreshToken: string): Promise<TwitchTokens> {
    return this.tokens({grant_type: 'refresh_token', refresh_token: refreshToken});
  }
  async validate(accessToken: string): Promise<TwitchIdentity | undefined> {
    try {
      const response = await this.fetchImpl(new URL('/oauth2/validate', this.baseUrl), {
        headers: {Authorization: `OAuth ${accessToken}`}, signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
      if (response.status === 401) return undefined;
      if (!response.ok) throw new TwitchOAuthError(response.status);
      const data = await response.json() as Record<string, unknown>;
      if (typeof data.client_id !== 'string' || typeof data.login !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(data.login)
        || typeof data.user_id !== 'string' || !data.user_id || !Array.isArray(data.scopes) || !data.scopes.every(scope => typeof scope === 'string')
        || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new TwitchOAuthError(502);
      return {clientId: data.client_id, login: data.login.toLowerCase(), userId: data.user_id, scopes: data.scopes, expiresIn: data.expires_in};
    } catch (error) { throw error instanceof TwitchOAuthError ? error : new TwitchOAuthError(503); }
  }
}
