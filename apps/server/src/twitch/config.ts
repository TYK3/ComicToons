import {readProductEnv} from '../../../../packages/core/src/env.mjs';
export const TWITCH_SCOPES = [
  'user:read:chat', // https://dev.twitch.tv/docs/authentication/scopes/#userreadchat
  'chat:read', // https://dev.twitch.tv/docs/authentication/scopes/#chatread
  'channel:manage:redemptions', // https://dev.twitch.tv/docs/authentication/scopes/#channelmanageredemptions
  'channel:manage:polls', // https://dev.twitch.tv/docs/authentication/scopes/#channelmanagepolls
  'channel:manage:predictions', // https://dev.twitch.tv/docs/authentication/scopes/#channelmanagepredictions
  'bits:read', // https://dev.twitch.tv/docs/authentication/scopes/#bitsread
  'channel:read:hype_train', // https://dev.twitch.tv/docs/authentication/scopes/#channelreadhype_train
] as const;
/**
 * Read-only scopes for `trial-run --signed-in` (COMICTOONS_OAUTH_SCOPES_READONLY=1): just enough to
 * subscribe to the 16 read-only EventSub types in apps/server/src/eventsub/subscriptions.ts, no more.
 * Checked against https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/ on 31 Oct 2026:
 * channel.chat.message / channel.chat.message_delete need user:read:chat; channel.cheer needs
 * bits:read; channel.channel_points_custom_reward_redemption.add needs channel:read:redemptions or
 * manage; channel.poll.* needs channel:read:polls or manage; channel.prediction.* needs
 * channel:read:predictions or manage; channel.hype_train.* (v2) needs channel:read:hype_train;
 * channel.raid, stream.online and stream.offline need no scope. No write, manage, edit or moderate
 * scope, and never user:write:chat (BOT_REPLIES does not apply in this mode).
 */
export const TWITCH_SCOPES_READONLY = [
  'user:read:chat',
  'bits:read',
  'channel:read:redemptions',
  'channel:read:polls',
  'channel:read:predictions',
  'channel:read:hype_train',
] as const;
export interface TwitchConfig {clientId: string; clientSecret: string; redirectUri: string; channel: string; configured: boolean; scopes: string[]}
export function twitchConfig(env: Record<string, string | undefined> = process.env): TwitchConfig {
  const clientId = (readProductEnv('COMICTOONS_TWITCH_CLIENT_ID',env)??env.TWITCH_CLIENT_ID)?.trim() ?? '';
  const clientSecret = (readProductEnv('COMICTOONS_TWITCH_CLIENT_SECRET',env)??env.TWITCH_CLIENT_SECRET)?.trim() ?? '';
  const redirectUri = (readProductEnv('COMICTOONS_TWITCH_REDIRECT_URI',env)??env.TWITCH_REDIRECT_URI)?.trim() ?? 'http://localhost:3001/auth/twitch/callback';
  const readOnly=/^(1|true|on|yes)$/i.test(readProductEnv('COMICTOONS_OAUTH_SCOPES_READONLY',env)?.trim()??'');
  const scopes:string[]=readOnly?[...TWITCH_SCOPES_READONLY]:[...TWITCH_SCOPES];
  // https://dev.twitch.tv/docs/authentication/scopes/#userwritechat
  if(!readOnly&&/^(1|true|on|yes)$/i.test(readProductEnv('COMICTOONS_FLAG_BOT_REPLIES',env)?.trim()??''))scopes.push('user:write:chat');
  return {scopes,clientId, clientSecret, redirectUri, channel: env.TWITCH_CHANNEL?.trim().toLowerCase() ?? '', configured: !!(clientId && clientSecret && redirectUri)};
}
