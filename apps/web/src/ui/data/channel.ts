import type { ChatSourceState } from '@comictoons/core';

export function parseTwitchChannel(input: string): string {
  let channel = input.trim();
  if (/^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\//i.test(channel)) {
    const url = new URL(/^https?:\/\//i.test(channel) ? channel : `https://${channel}`);
    if (!['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) throw new Error('Enter a Twitch channel username or channel link.');
    channel = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    if(['directory','videos','clips','settings','subscriptions','login','signup','search','downloads','dashboard','moderator','p'].includes(channel.toLowerCase()))throw new Error('Paste a streamer’s channel link. Twitch directory, video and settings pages are not live channel links.');
  } else channel = channel.replace(/^[@#]/, '');
  if (!/^[a-zA-Z0-9_]{1,25}$/.test(channel)) throw new Error('Enter a Twitch username or a link like twitch.tv/channel.');
  return channel.toLowerCase();
}

export const readingOtherChannel = (source: ChatSourceState, account: {login?: string}) =>
  source.requested === 'twitch' && !!source.channel && source.channel !== account.login;
