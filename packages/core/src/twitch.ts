// Placeholder for S1: Twitch OAuth, token storage, Helix and EventSub clients land here.
// normalizeTwitchEvent stays in index.ts until S1 moves it alongside this config.
export interface TwitchConfig { clientId?: string; clientSecret?: string; redirectUri?: string }
export const defaultTwitchConfig: TwitchConfig = {};
