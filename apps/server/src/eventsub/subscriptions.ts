import type {SubscriptionRequest} from './messages.ts';

// Every type, version, condition and scope below was checked against the live page
// https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/ on 31 Oct 2026.
// channel.hype_train.* is version 2: version 1 is no longer listed there.
export const EVENTSUB_TYPES_URL='https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/';

/** The subscriptions one ComicToons session needs, for a broadcaster signed in with a user token. */
export function comicToonsSubscriptions(broadcasterId:string,userId:string=broadcasterId):SubscriptionRequest[] {
  const channel={broadcaster_user_id:broadcasterId};
  return [
    // Raids into this channel. Only one of from_/to_broadcaster_user_id may be set.
    {type:'channel.raid',version:'1',condition:{to_broadcaster_user_id:broadcasterId},scopes:[]},
    {type:'channel.cheer',version:'1',condition:channel,scopes:['bits:read']},
    {type:'channel.channel_points_custom_reward_redemption.add',version:'1',condition:channel,scopes:['channel:read:redemptions','channel:manage:redemptions']},
    {type:'channel.poll.begin',version:'1',condition:channel,scopes:['channel:read:polls','channel:manage:polls']},
    {type:'channel.poll.progress',version:'1',condition:channel,scopes:['channel:read:polls','channel:manage:polls']},
    {type:'channel.poll.end',version:'1',condition:channel,scopes:['channel:read:polls','channel:manage:polls']},
    {type:'channel.prediction.begin',version:'1',condition:channel,scopes:['channel:read:predictions','channel:manage:predictions']},
    {type:'channel.prediction.progress',version:'1',condition:channel,scopes:['channel:read:predictions','channel:manage:predictions']},
    {type:'channel.prediction.lock',version:'1',condition:channel,scopes:['channel:read:predictions','channel:manage:predictions']},
    {type:'channel.prediction.end',version:'1',condition:channel,scopes:['channel:read:predictions','channel:manage:predictions']},
    {type:'channel.hype_train.begin',version:'2',condition:channel,scopes:['channel:read:hype_train']},
    {type:'channel.hype_train.end',version:'2',condition:channel,scopes:['channel:read:hype_train']},
    // Chat as the signed-in user reading this channel's chat (user:read:chat from that user).
    {type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:broadcasterId,user_id:userId},scopes:['user:read:chat']},
    {type:'channel.chat.message_delete',version:'1',condition:{broadcaster_user_id:broadcasterId,user_id:userId},scopes:['user:read:chat']},
    {type:'stream.online',version:'1',condition:channel,scopes:[]},
    // https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#streamoffline: v1, condition
    // broadcaster_user_id, no authorization required.
    {type:'stream.offline',version:'1',condition:channel,scopes:[]},
  ];
}

/** Every scope the list above needs (the manage scopes also cover Helix writes). */
export const COMICTOONS_SCOPES=['bits:read','channel:manage:redemptions','channel:manage:polls','channel:manage:predictions','channel:read:hype_train','user:read:chat','user:write:chat'] as const;
