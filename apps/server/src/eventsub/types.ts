export interface TwitchAuthProvider {
  getAuth(): Promise<{ clientId: string; accessToken: string; broadcasterId: string; login: string } | undefined>;
  refresh(): Promise<void>;
}
