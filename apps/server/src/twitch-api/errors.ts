/** The studio message for a channel that cannot have channel-point rewards. Exact text agreed with the lead. */
export const INK_ME_AFFILIATE_MESSAGE = 'Ink me needs an Affiliate or Partner channel';
export const OTHER_APP_MESSAGE = 'This Twitch reward belongs to another app, so ComicToons cannot change it.';
export const SIGNED_OUT_MESSAGE = 'Twitch is not connected.';

/** Any non-2xx Helix answer. The message is Twitch's own text; it never contains a token. */
export class TwitchApiError extends Error {
  constructor(readonly status: number, message: string, readonly endpoint: string) {
    super(message);
    this.name = 'TwitchApiError';
  }
}

/**
 * 403 from Helix. `not-affiliate` (the broadcaster is not a partner or affiliate, or Twitch gave no
 * reason) carries the exact Ink me message; `other-app` is a reward created under a different Client-Id.
 */
export class TwitchForbiddenError extends TwitchApiError {
  readonly reason: 'not-affiliate' | 'other-app';
  readonly userMessage: string;
  readonly twitchMessage: string;
  constructor(twitchMessage: string, endpoint: string) {
    const reason = /client[- ]?id/i.test(twitchMessage) && !/partner|affiliate/i.test(twitchMessage) ? 'other-app' : 'not-affiliate';
    const userMessage = reason === 'not-affiliate' ? INK_ME_AFFILIATE_MESSAGE : OTHER_APP_MESSAGE;
    super(403, userMessage, endpoint);
    this.name = 'TwitchForbiddenError';
    this.reason = reason; this.userMessage = userMessage; this.twitchMessage = twitchMessage;
  }
}

/** No signed-in broadcaster (getAuth() returned undefined). No request was sent. */
export class TwitchSignedOutError extends Error {
  constructor() { super(SIGNED_OUT_MESSAGE); this.name = 'TwitchSignedOutError'; }
}
