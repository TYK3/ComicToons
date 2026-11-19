/**
 * Structurally identical to the TwitchAuthProvider published for
 * eventsub/types.ts (the T3 hand-over types file). Declared locally so this
 * folder imports nothing from eventsub/; TypeScript's structural typing makes the two interchangeable.
 */
export interface TwitchAuthProvider {
  getAuth(): Promise<{ clientId: string; accessToken: string; broadcasterId: string; login: string } | undefined>;
  refresh(): Promise<void>;
}

/** The subset of global fetch the client uses, so tests can pass a scripted fake. */
export type FetchLike = (input: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export type BroadcasterType = 'affiliate' | 'partner' | '';
export interface HelixUser { id: string; login: string; displayName: string; broadcasterType: BroadcasterType }
