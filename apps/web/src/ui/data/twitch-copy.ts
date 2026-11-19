/**
 * BANNERS (report-token-expiry.md REQUEST 3): the Studio's Twitch sign-in banner names the cause the
 * server reported, never a guessed one. Pure, so tests/ui-banners.test.ts checks every case.
 * The reason strings are the server's own (apps/server/src/twitch/token-store.ts).
 */
import { TWITCH_STILL_SIGNED_OUT } from './adapter';
import { SERVER_RESTARTED } from './twitch-status';

/** Same text as data/server.ts loadTwitch() shows when GET /api/twitch/status says Twitch is not configured and gives no reason. */
export const TWITCH_NOT_SET_UP = 'Twitch sign-in is not set up on this machine yet.';
/** Same text as the mock adapter's cancelled sign-in (data/mock.ts), and the banner's text when no reason came with the error. */
export const TWITCH_CANCELLED = 'You may have cancelled it, or Twitch didn’t answer.';
/** token-store.ts disconnect() reasons when the server drops a sign-in that was working (refresh refused or failed, or a 401 on validation). */
const SESSION_ENDED = new Set(['Twitch authorization expired. Reconnect Twitch.', 'Twitch refresh unavailable. Reconnect Twitch.']);
/** token-store.ts: the hourly validation could not reach Twitch; the sign-in itself was not dropped. */
const NOT_CHECKED = 'Twitch validation unavailable.';

export interface TwitchErrorCopy { heading: string; detail: string }

export function twitchErrorCopy(error?: string): TwitchErrorCopy {
  if (error === SERVER_RESTARTED) return { heading: SERVER_RESTARTED, detail: 'The ComicToons server restarted and Twitch sign-in does not carry over a restart. Connect with Twitch above signs you in again.' };
  if (error && SESSION_ENDED.has(error)) return { heading: 'Your Twitch sign-in ended.', detail: `${error} Connect with Twitch above signs you in again.` };
  if (error === NOT_CHECKED) return { heading: 'Twitch couldn’t check your sign-in.', detail: `${error} Try again reads the sign-in again.` };
  if (error === TWITCH_NOT_SET_UP) return { heading: 'Twitch sign-in isn’t set up.', detail: `${error} Your sample replay is still running.` };
  if (!error || error === TWITCH_CANCELLED || error === TWITCH_STILL_SIGNED_OUT) return { heading: 'Twitch sign-in didn’t finish.', detail: `${error ?? TWITCH_CANCELLED} Your sample replay is still running. Connect with Twitch above starts a new sign-in.` };
  return { heading: 'Twitch isn’t signed in.', detail: `${error} Connect with Twitch above starts a new sign-in.` };
}
