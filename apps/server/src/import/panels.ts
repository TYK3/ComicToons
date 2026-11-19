import type { ComicPanel } from '@comictoons/core';
import type { ChatLogLine } from './chatlog.ts';

/** The clip fields a panel is built from (Helix's clip, see ingest/clips.ts HelixClip), plus a locally inked frame when there is one. */
export interface ImportClip { id: string; title: string; thumbnailUrl: string; url: string; createdAt: number; viewCount?: number; inkedUrl?: string }

function basePanel(id: string, caption: string, clip: ImportClip, at: number, dialogue: string[]): ComicPanel {
  const title = caption || 'Clip';
  // The inked frame when the art network made one; otherwise the clip's own thumbnail is the frame (the clip-frame fallback).
  return { id, caption: title, dialogue, scene: '', characters: [], mood: '', altText: title, imageUrl: clip.inkedUrl ?? clip.thumbnailUrl,
    ...(clip.inkedUrl ? { frameUrl: clip.thumbnailUrl } : {}), at, clipUrl: clip.url, origin: 'twitch' };
}

/** `items` split into at most `maxGroups` contiguous, chronologically ordered chunks. */
function splitContiguous<T>(items: readonly T[], maxGroups: number): T[][] {
  if (items.length === 0 || maxGroups <= 0) return [];
  // Balanced: exactly min(maxGroups, items) groups, the first ones one item longer (9 lines in 4 groups is 3,2,2,2).
  const groups = Math.min(maxGroups, items.length);
  const base = Math.floor(items.length / groups), extra = items.length % groups;
  const result: T[][] = [];
  for (let group = 0, start = 0; group < groups; group += 1) {
    const size = base + (group < extra ? 1 : 0);
    result.push(items.slice(start, start + size));
    start += size;
  }
  return result;
}

/**
 * The clips of a VOD import: only those made inside the (already capped) window, at most `max`,
 * the most viewed first (the earliest on a tie), then back in time order so the comic reads in order.
 */
export function selectVodClips<T extends ImportClip>(clips: readonly T[], window: { startedAt: number; endedAt: number }, max: number): T[] {
  return clips.filter(clip => clip.createdAt >= window.startedAt && clip.createdAt <= window.endedAt)
    .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0) || a.createdAt - b.createdAt)
    .slice(0, Math.max(0, max))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * One panel per clip (a VOD import or several clip links, capped at caps.maxPanels), or, for a single
 * clip, 1 to caps.singleClipMaxPanels panels split from the optional chat log (the same frame each time,
 * since one clip has one title and one thumbnail). Chat log lines go out in contiguous, chronological
 * chunks, never reordered. `sessionStartedAt` (epoch ms) turns each clip's createdAt into seconds into
 * the VOD; without it (several clip links, no shared timeline) `at` is the clip's position.
 */
export function buildPanelsFromClips(clips: readonly ImportClip[], chatLog: readonly ChatLogLine[], caps: { maxPanels: number; singleClipMaxPanels: number }, opts: { sessionStartedAt?: number; expandSingleClip?: boolean } = {}): ComicPanel[] {
  if (clips.length === 0) return [];
  const lines = chatLog.map(line => line.text);
  if (clips.length === 1 && opts.expandSingleClip !== false) {
    const clip = clips[0]!;
    const groups = splitContiguous(lines, caps.singleClipMaxPanels);
    if (groups.length === 0) return [basePanel(`clip-${clip.id}`, clip.title, clip, 0, [])];
    return groups.map((group, index) => basePanel(`clip-${clip.id}-${index}`, index === 0 ? clip.title : `${clip.title} (cont.)`, clip, index, group));
  }
  const capped = clips.slice(0, caps.maxPanels);
  const groups = splitContiguous(lines, capped.length);
  const start = opts.sessionStartedAt;
  return capped.map((clip, index) => basePanel(`clip-${clip.id}`, clip.title, clip,
    start !== undefined ? Math.max(0, Math.round((clip.createdAt - start) / 1000)) : index, groups[index] ?? []));
}
