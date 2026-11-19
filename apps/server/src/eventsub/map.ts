import {safeText} from '@comictoons/core';
import type {ParticipationEvent} from '../participation/commands.ts';

// Maps one EventSub notification onto the existing StreamEvent shapes, so the MomentDetector
// (Studio listens on the bus) and participation (routes.ts) both receive it. Payload fields are
// from https://dev.twitch.tv/docs/eventsub/eventsub-reference/ (checked 31 Oct 2026).

export type MappedNotification =
  | {kind:'stream-event';event:ParticipationEvent}
  | {kind:'stream-online';payload:{id?:string;startedAt?:string;broadcasterId?:string}}
  | {kind:'stream-offline';payload:{broadcasterId?:string}};

type Raw=Record<string,unknown>;
const str=(value:unknown)=>typeof value==='string'?value:undefined;
const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:0;
const list=(value:unknown):Raw[]=>Array.isArray(value)?value.filter((entry):entry is Raw=>!!entry&&typeof entry==='object'):[];
const POLL_STATUS={completed:'COMPLETED',terminated:'TERMINATED',archived:'ARCHIVED',moderated:'MODERATED',invalid:'INVALID'} as const;

/** `t` is seconds since the live session started (>= 0; non-finite becomes 0), like the IRC path uses. */
export function mapNotification(type:string,raw:unknown,messageId:string,t:number):MappedNotification|null {
  if(!raw||typeof raw!=='object')return null;
  const event=raw as Raw;const base={id:messageId,t:Number.isFinite(t)?Math.max(0,t):0};
  switch(type){
    case 'channel.chat.message':{
      const message=event.message as Raw|undefined;const text=str(message?.text);
      if(text===undefined)return null;
      const badges=list(event.badges).map(badge=>str(badge.set_id)).filter((badge):badge is string=>!!badge);
      // The chat message's own id, so a later channel.chat.message_delete can withdraw it.
      return {kind:'stream-event',event:{...base,id:str(event.message_id)??messageId,type:'chat',user:str(event.chatter_user_id),name:str(event.chatter_user_name)??str(event.chatter_user_login),text:safeText(text),
        badges,moderator:badges.includes('moderator')||undefined,broadcaster:badges.includes('broadcaster')||undefined}};
    }
    case 'channel.chat.message_delete':{
      const target=str(event.message_id);if(!target)return null;
      return {kind:'stream-event',event:{...base,type:'chat',text:'',withdraw:'message',targetId:target,moderator:true}};
    }
    case 'channel.raid':{
      // Same rules as the IRC raid notice (ingest/irc.ts): the count must be 1 to 9 digits or the
      // raid is dropped; a name that is empty after safeText becomes 'Anonymous crew'.
      const count=typeof event.viewers==='number'||typeof event.viewers==='string'?String(event.viewers):'';
      if(!/^\d{1,9}$/.test(count))return null;
      const from=safeText(str(event.from_broadcaster_user_name)||str(event.from_broadcaster_user_login)||'').trim()||'Anonymous crew';
      return {kind:'stream-event',event:{...base,type:'raid',from,viewers:Number(count)}};
    }
    case 'channel.cheer':{
      const anonymous=event.is_anonymous===true;
      return {kind:'stream-event',event:{...base,type:'cheer',user:anonymous?undefined:str(event.user_id),name:anonymous?'Anonymous':str(event.user_name),text:safeText(str(event.message)??''),level:num(event.bits)}};
    }
    case 'channel.channel_points_custom_reward_redemption.add':{
      const reward=event.reward as Raw|undefined;const id=str(event.id);const rewardId=str(reward?.id);
      if(!id||!rewardId)return null;
      return {kind:'stream-event',event:{...base,type:'redemption',user:str(event.user_id),name:str(event.user_name),text:safeText(str(event.user_input)??''),redemption:{id,rewardId,userLogin:str(event.user_login)}}};
    }
    case 'channel.poll.begin':case 'channel.poll.progress':case 'channel.poll.end':{
      const id=str(event.id);if(!id)return null;
      const ended=type==='channel.poll.end';
      const status=ended?(POLL_STATUS[str(event.status)?.toLowerCase() as keyof typeof POLL_STATUS]??'INVALID'):'ACTIVE';
      const choices=list(event.choices).map(choice=>({id:str(choice.id),title:safeText(str(choice.title)??''),votes:num(choice.votes)}));
      return {kind:'stream-event',event:{...base,type:'poll',text:safeText(str(event.title)??''),poll:{id,status,choices}}};
    }
    case 'channel.prediction.begin':case 'channel.prediction.progress':case 'channel.prediction.lock':case 'channel.prediction.end':{
      const id=str(event.id);if(!id)return null;
      const ending=str(event.status)?.toLowerCase();
      const status=type==='channel.prediction.lock'?'LOCKED':type==='channel.prediction.end'?(ending==='canceled'?'CANCELED':'RESOLVED'):'ACTIVE';
      const outcomes=list(event.outcomes).map(outcome=>({id:str(outcome.id)??'',title:safeText(str(outcome.title)??''),users:num(outcome.users)}));
      // Begin and a resolved end are moments worth drawing ('hype'); progress and lock only update
      // participation, so they ride as 'moment', which the MomentDetector does not open a panel for.
      const momentWorthy=type==='channel.prediction.begin'||(type==='channel.prediction.end'&&status==='RESOLVED');
      return {kind:'stream-event',event:{...base,type:momentWorthy?'hype':'moment',text:safeText(str(event.title)??''),
        prediction:{id,status,title:safeText(str(event.title)??''),outcomes,winningOutcomeId:str(event.winning_outcome_id)}}};
    }
    case 'channel.hype_train.begin':
      return {kind:'stream-event',event:{...base,type:'hype_train_begin',level:Math.max(1,num(event.level))}};
    case 'channel.hype_train.end':
      return {kind:'stream-event',event:{...base,type:'hype_train_end',level:Math.max(1,num(event.level))}};
    case 'stream.online':
      return {kind:'stream-online',payload:{id:str(event.id),startedAt:str(event.started_at),broadcasterId:str(event.broadcaster_user_id)}};
    case 'stream.offline':
      return {kind:'stream-offline',payload:{broadcasterId:str(event.broadcaster_user_id)}};
    default:
      return null;
  }
}
