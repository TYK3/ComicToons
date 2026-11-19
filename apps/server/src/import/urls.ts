import { validChannel } from '../ingest/irc.ts';
import { MAX_PANELS } from './caps.ts';
import { ImportError } from './errors.ts';

export type ParsedImportUrl =
  | { kind: 'live'; channel: string }
  | { kind: 'vod'; id: string }
  | { kind: 'clip'; slug: string; channel?: string };

/** The URL box takes one link per line; several lines only make sense when every line is a clip. */
export type ParsedImportInput =
  | { kind: 'live'; channel: string }
  | { kind: 'vod'; id: string }
  | { kind: 'clips'; slugs: string[]; channel?: string };

const CLIP_SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);
/** First path segments on twitch.tv that are pages, not channels. */
const RESERVED = new Set(['directory', 'videos', 'settings', 'search', 'downloads', 'jobs', 'p', 'turbo', 'prime', 'subscriptions', 'inventory', 'wallet', 'drops', 'friends', 'messages', 'login', 'signup']);

/**
 * One line of the URL box: twitch.tv/<channel> (live), twitch.tv/videos/<id> (VOD),
 * clips.twitch.tv/<slug> or twitch.tv/<channel>/clip/<slug> (clip). http(s) only, no user info.
 * Anything else throws ImportError('bad-url') with a message the Studio can show as it is.
 */
export function parseImportUrl(raw: string): ParsedImportUrl {
  const trimmed = raw.trim();
  if (!trimmed) throw new ImportError('bad-url', 'Paste a Twitch VOD, clip or channel link.');
  const shown = trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ImportError('bad-url', `"${shown}" is not a Twitch link.`);
  }
  const host = url.hostname.toLowerCase();
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || (host !== 'clips.twitch.tv' && !TWITCH_HOSTS.has(host))) {
    throw new ImportError('bad-url', `"${shown}" is not a Twitch link.`);
  }
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'clips.twitch.tv') {
    const slug = segments[0];
    if (segments.length === 1 && slug && CLIP_SLUG.test(slug)) return { kind: 'clip', slug };
    throw new ImportError('bad-url', `"${shown}" is not a clip link.`);
  }
  if (segments.length === 2 && segments[0] === 'videos') {
    if (/^\d{1,20}$/.test(segments[1]!)) return { kind: 'vod', id: segments[1]! };
    throw new ImportError('bad-url', `"${shown}" is not a VOD link.`);
  }
  if (segments.length === 3 && segments[1] === 'clip') {
    const channel = segments[0]!.toLowerCase();
    if (validChannel(channel) && CLIP_SLUG.test(segments[2]!)) return { kind: 'clip', slug: segments[2]!, channel };
    throw new ImportError('bad-url', `"${shown}" is not a clip link.`);
  }
  if (segments.length === 1) {
    const channel = segments[0]!.toLowerCase();
    if (validChannel(channel) && !RESERVED.has(channel)) return { kind: 'live', channel };
    throw new ImportError('bad-url', `"${shown}" is not a Twitch channel link.`);
  }
  throw new ImportError('bad-url', `"${shown}" is not a Twitch VOD, clip or channel link.`);
}

/** The whole URL box: one link, or up to MAX_PANELS clip links, one per line. Blank lines are ignored. */
export function parseImportInput(raw: string): ParsedImportInput {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new ImportError('bad-url', 'Paste a Twitch VOD, clip or channel link.');
  const parsed = lines.map(parseImportUrl);
  if (parsed.length === 1 && parsed[0]!.kind !== 'clip') return parsed[0] as ParsedImportInput;
  if (!parsed.every((item): item is Extract<ParsedImportUrl, { kind: 'clip' }> => item.kind === 'clip')) {
    throw new ImportError('bad-url', 'Several lines are only accepted when every line is a clip link.');
  }
  if (parsed.length > MAX_PANELS) throw new ImportError('bad-url', `Up to ${MAX_PANELS} clip links at a time.`);
  const channel = parsed.find(item => item.channel)?.channel;
  return { kind: 'clips', slugs: parsed.map(item => item.slug), ...(channel ? { channel } : {}) };
}
