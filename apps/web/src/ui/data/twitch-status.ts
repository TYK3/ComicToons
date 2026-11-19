/** Maps GET /api/twitch/status to the Studio's TwitchAuth state. Pure, so it is unit-tested without a browser. */
import type { TwitchAuth } from './adapter';

export interface WireTwitch { broadcaster_type?: TwitchAuth['broadcasterType']|null;requestedScopes?:string[]; configured: boolean; connected: boolean; login?: string; scopes: string[]; expiresAt?: number; reason?: string; bootId?: string }

/** The reason the server's token store records when the user signs out on purpose (token-store.ts disconnect()). */
export const DELIBERATE_SIGN_OUT = 'Twitch disconnected.';
/** LIVE-TEST BUG-1: the server keeps the sign-in in memory only, so a restart (e.g. a dev reload) drops it with no reason. */
export const SERVER_RESTARTED = 'Server restarted, reconnect Twitch.';

/**
 * `dismissed` is the server-side reason Young already dismissed; it stays dismissed until it changes.
 * `connectedBoot` is the server bootId this browser last saw Twitch connected on. Signed out with no reason
 * on a different bootId means the server process restarted and the in-memory sign-in went with it (BUG-1).
 */
export function twitchAuthFromStatus(status: WireTwitch, dismissed?: string, connectedBoot?: string): TwitchAuth {
  if (status.connected) return { state: 'connected', login: status.login, broadcasterType: status.broadcaster_type??undefined };
  if (!status.configured) return { state: 'error', error: status.reason ?? 'Twitch sign-in is not set up on this machine yet.' };
  // The server dropped the sign-in by itself (refresh refused after expiry or revocation, or a 401 on
  // validation): say why, so the Studio does not fall silently back to "Connect with Twitch".
  if (status.reason && status.reason !== DELIBERATE_SIGN_OUT && status.reason !== dismissed) return { state: 'error', error: status.reason };
  if (connectedBoot && status.bootId && status.bootId !== connectedBoot && !status.reason && dismissed !== SERVER_RESTARTED) return { state: 'error', error: SERVER_RESTARTED };
  return { state: 'signed-out' };
}
