/**
 * UI-LIVE-B: the screen side of the live contract, read defensively.
 * The data side (data/server.ts) adds these fields in parallel; until it lands they may be missing,
 * so every reader here falls back to what the UI did before. No network, no React: plain functions the screens share.
 *
 *  - GET /api/state                  `nextUp: string | null`  the panel a mod's `!ink yes` or the A key approves next
 *  - GET /api/participation/status   `inkChat`                passed through as routes.ts returns it (ink-chat.ts view())
 *  - adapter                         `connection: 'ok' | 'lost' | 'reconnecting'`
 */
import { chatTransportLabel, type ChatSourceState } from '@comictoons/core';
import type { ParticipationStatus, TwitchAuth, UiPanel, UiSnapshot, UiStudioState } from '../../data/adapter';

// ---- connection ------------------------------------------------------------------------------
export type Connection = 'ok' | 'lost' | 'reconnecting';
const CONNECTIONS: readonly Connection[] = ['ok', 'lost', 'reconnecting'];
const isConnection = (value: unknown): value is Connection => CONNECTIONS.includes(value as Connection);

/** The adapter's `connection`, from the snapshot or the adapter itself. Before it lands: offline or an error reads as lost. */
export function readConnection(ui: UiSnapshot, adapter?: unknown): Connection {
  const fromUi = (ui as { connection?: unknown }).connection;
  if (isConnection(fromUi)) return fromUi;
  const fromAdapter = adapter && typeof adapter === 'object' ? (adapter as { connection?: unknown }).connection : undefined;
  if (isConnection(fromAdapter)) return fromAdapter;
  return ui.offline || ui.error ? 'lost' : 'ok';
}

export interface BannerCopy { title: string; body: string; retry: boolean }
/** Banner text for each connection state. 'ok' shows no banner. */
export function connectionBanner(connection: Connection): BannerCopy | null {
  if (connection === 'lost') return { title: 'Connection lost.', body: 'ComicToons can’t reach the studio on this computer. Approved panels stay on the overlay.', retry: true };
  if (connection === 'reconnecting') return { title: 'Reconnecting…', body: 'Getting the latest panels from the studio. Nothing is lost.', retry: false };
  return null;
}

// ---- next up ---------------------------------------------------------------------------------
/** The server's `nextUp` id: a string, null (nothing is next), or undefined (an older server that doesn't send it). */
export function readNextUpId(studio: UiStudioState): string | null | undefined {
  const value = (studio as { nextUp?: unknown }).nextUp;
  return typeof value === 'string' || value === null ? value : undefined;
}

/**
 * The waiting panel to put in front of the streamer: the server's `nextUp` when it names a waiting panel,
 * otherwise the oldest waiting panel (what the A key approved before nextUp existed).
 */
export function nextUpPanel(studio: UiStudioState): UiPanel | undefined {
  const id = readNextUpId(studio);
  return (id ? studio.pendingPanels.find(panel => panel.id === id) : undefined) ?? studio.pendingPanels[0];
}

// ---- chat !ink requests ----------------------------------------------------------------------
export type InkChatStatus = 'queued' | 'drafted' | 'approved' | 'rejected' | 'withdrawn';
export interface InkChatRequestView { id: string; name: string; at: number; status: InkChatStatus; note: string; panelId?: string }
export interface InkChatView { active: boolean; text: string; cooldownEndsAt?: number; note?: string; requests: InkChatRequestView[] }
const INK_STATUSES: readonly InkChatStatus[] = ['queued', 'drafted', 'approved', 'rejected', 'withdrawn'];

/**
 * `participation.inkChat` as ink-chat.ts view() sends it ({active, text, cooldownEndsAt, note, requests}).
 * The contract also names the fields `cooldown` and `notes`, so both spellings are read. Null when the server sent none.
 */
export function readInkChat(participation: ParticipationStatus): InkChatView | null {
  const raw = (participation as { inkChat?: unknown }).inkChat;
  if (!raw || typeof raw !== 'object') return null;
  const wire = raw as Record<string, unknown>;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
  const requests = Array.isArray(wire.requests) ? wire.requests : [];
  return {
    active: wire.active === true,
    text: text(wire.text) ?? '',
    cooldownEndsAt: number(wire.cooldownEndsAt) ?? number(wire.cooldown),
    note: text(wire.note) ?? text(wire.notes),
    requests: requests.flatMap((entry: unknown): InkChatRequestView[] => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      const status = INK_STATUSES.find(value => value === item.status);
      if (typeof item.id !== 'string' || !status) return [];
      return [{ id: item.id, name: text(item.name) ?? 'viewer', at: number(item.at) ?? 0, status, note: typeof item.note === 'string' ? item.note : '', panelId: text(item.panelId) }];
    }),
  };
}

/** Chat !ink requests still waiting: queued for the panel budget, or drafted and waiting for !ink yes / !ink no. */
export const inkChatWaiting = (inkChat: InkChatView | null) => inkChat ? inkChat.requests.filter(entry => entry.status === 'queued' || entry.status === 'drafted').length : 0;

/** The Director's Ink me queue: channel-point redemptions not yet done, plus chat cameos still waiting. */
export function inkQueueWaiting(participation: ParticipationStatus): number {
  const redemptions = participation.reward.redemptions.filter(entry => entry.status === 'queued' || entry.status === 'drawing').length;
  return redemptions + inkChatWaiting(readInkChat(participation));
}

export const INK_CHAT_LABEL: Record<InkChatStatus, string> = { queued: 'Queued', drafted: 'Waiting for !ink yes', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };

// ---- times -----------------------------------------------------------------------------------
/** UK 24-hour clock time, e.g. "20:05". Local time on this computer. */
export function time24(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ---- chat source -----------------------------------------------------------------------------
/** Where chat comes from, said the same way in the header chip, the Channel card and the Chat card. */
export function chatSourceChip(source: ChatSourceState): string {
  // STREAM-END-1: EventSub stream.offline sets this once the session leaves Live; it must win
  // over the active/simulated check below, or the chip keeps reading "Live chat".
  if (source.connection === 'ended') return 'Stream ended';
  if (source.active === 'twitch' && !source.simulated) return 'Live chat';
  if (source.active === 'twitch') return 'Simulated chat';
  if (source.requested === 'twitch' && source.connection === 'connecting') return 'Connecting to chat…';
  return 'Sample data';
}

/** BANNER-RAID-1: quiet chat stays Live (RAID-SAMPLE-1), so "gone quiet" is a client-side window: no new line for this long. */
export const CHAT_QUIET_MS = 60_000;

/** BANNER-RAID-1: real live chat that has read at least one line and has had no new line for `quietMs` since `lastLineAt`. */
export function isLiveChatQuiet(source: ChatSourceState | undefined, lastLineAt: number, now: number, quietMs = CHAT_QUIET_MS): boolean {
  return !!source && source.active === 'twitch' && !source.simulated && source.connection === 'live' && source.received > 0 && now - lastLineAt >= quietMs;
}

/** The Chat card's status line. Never shows a raw reason token, and never says "fell back" while chat is connecting or connected.
 * `quiet` (isLiveChatQuiet) adds "Chat is quiet" while the source stays Live. */
export function chatStateText(source: ChatSourceState, quiet = false): string {
  const transport = chatTransportLabel(source);
  if (source.connection === 'ended') return 'Stream ended · approved panels and the manga export stay available';
  if (source.active === 'twitch' && !source.simulated && source.connection === 'live') return `${transport ? `Live chat · ${transport}` : 'Live chat'}${quiet && source.received > 0 ? ' · Chat is quiet' : ''}`;
  if (source.active === 'twitch' && source.simulated) return 'Simulated chat · Sample data';
  switch (source.connection) {
    case 'live': return 'Live chat';
    case 'connecting': return 'Connecting to Twitch chat…';
    case 'sample': return 'Sample replay';
    // 'empty' arrives while Twitch chat is quiet: welcomed on a transport means connected, otherwise still on the way.
    // CHAT-BANNER-1: after the first received line, 'empty' (Sample data while still asking for Twitch) is not "waiting".
    case 'empty': return source.requested !== 'twitch' ? 'Sample data' : source.received > 0 ? (source.transport ? `Connected · ${source.transport === 'wss' ? 'WSS 443' : 'TLS 6697'} · chat is quiet` : 'Chat is quiet · Sample data meanwhile') : source.transport ? `Connected · ${source.transport === 'wss' ? 'WSS 443' : 'TLS 6697'} · waiting for the first chat line` : 'Waiting for Twitch chat · Sample data meanwhile';
    case 'unreachable': return 'Twitch chat couldn’t be reached · showing Sample data';
    case 'disconnected': return 'Twitch chat disconnected · showing Sample data';
    case 'unauthenticated': return 'Twitch refused the chat sign-in · showing Sample data';
    case 'paused': return 'Live chat paused · showing Sample data';
    default: return 'Sample data';
  }
}

// ---- Twitch sign-in on a keyless machine -----------------------------------------------------
/**
 * True when this computer has no Twitch app set up, so sign-in can't start at all (not a sign-in that failed).
 * Reads `configured: false` if the adapter sends it; until then, the server adapter's own keyless message
 * (data/server.ts loadTwitch: "…not set up on this machine…") is the only signal.
 */
export function isKeyless(twitch: TwitchAuth): boolean {
  if ((twitch as { configured?: unknown }).configured === false) return true;
  return twitch.state === 'error' && /not set up on this (machine|computer)/i.test(twitch.error ?? '');
}
