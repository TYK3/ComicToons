import {safeText,type ComicPanel,type EventBus,type ComicToonsBusEvents,type StreamEvent} from '@comictoons/core';

// Live events as S4 expects them once S1 normalises EventSub payloads. Every extra field is
// optional, so a plain core StreamEvent is still accepted. See REQUEST 1 in report-s4.md.
export interface ParticipationEvent extends StreamEvent {
  broadcaster?: boolean;
  badges?: string[];
  poll?: { id: string; status: 'ACTIVE' | 'COMPLETED' | 'TERMINATED' | 'ARCHIVED' | 'MODERATED' | 'INVALID'; choices: { id?: string; title: string; votes: number }[] };
  redemption?: { id: string; rewardId: string; userLogin?: string };
  prediction?: { id: string; status: 'ACTIVE' | 'LOCKED' | 'RESOLVED' | 'CANCELED'; title?: string; outcomes: { id: string; title: string; users?: number }[]; winningOutcomeId?: string };
  phase?: 'begin' | 'progress' | 'end';
}

export type ChatCommand =
  | { kind: 'vote'; choice: number }
  | { kind: 'previously' }
  | { kind: 'ink-approve' }
  | { kind: 'ink-reject' }
  | { kind: 'noink' }
  | { kind: 'ink-optin' };

export function parseCommand(text: string | undefined): ChatCommand | null {
  const clean = safeText(text ?? '').trim();
  const vote = /^!([1-5])$/.exec(clean);
  if (vote) return { kind: 'vote', choice: Number(vote[1]) };
  if (/^!previously$/i.test(clean)) return { kind: 'previously' };
  const ink = /^!ink\s+(yes|no)$/i.exec(clean);
  if (ink) return { kind: ink[1]!.toLowerCase() === 'yes' ? 'ink-approve' : 'ink-reject' };
  if (/^!(?:noink|optout)$/i.test(clean)) return { kind: 'noink' };
  if (/^!ink$/i.test(clean)) return { kind: 'ink-optin' };
  return null;
}

export function isCommandText(text: string | undefined): boolean {
  return /^!/.test(safeText(text ?? '').trim());
}

export function isModerator(event: ParticipationEvent): boolean {
  return !!(event.moderator || event.broadcaster || event.badges?.some(badge => badge === 'moderator' || badge === 'broadcaster'));
}

const key = (value: string) => value.trim().toLowerCase();

/**
 * Who has typed !noink / !optout this stream. Opt-outs are sticky: a later !ink does not undo
 * them (same rule as core optedInCharacters and ingest/source.ts). If the ledger fills it fails
 * closed: everyone counts as opted out, so nobody can be cameo'd or quoted by mistake.
 */
export class OptOutLedger {
  private ids = new Set<string>();
  private names = new Set<string>();
  private locked = false;
  private listeners = new Set<(user?: string, name?: string) => void>();
  constructor(private capacity = 10_000) {}
  get size() { return this.ids.size + this.names.size; }
  get isLocked() { return this.locked; }
  add(user?: string, name?: string) {
    if (!user && !name) return;
    if (this.size >= this.capacity) this.locked = true;
    else { if (user) this.ids.add(key(user)); if (name) this.names.add(key(name)); }
    for (const listener of this.listeners) listener(user, name);
  }
  has(user?: string, name?: string): boolean {
    if (this.locked) return true;
    return (!!user && this.ids.has(key(user))) || (!!name && this.names.has(key(name)));
  }
  onOptOut(listener: (user?: string, name?: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  clear() { this.ids.clear(); this.names.clear(); this.locked = false; }
}

/** Sends a chat message as the bot (S1's Send Chat Message). Mocked in the mock phase. */
export interface ChatSender { sendChatMessage(input: { message: string; replyParentMessageId?: string }): Promise<void> }

export interface CatchupRequest { reason: 'raid' | 'command' | 'streamer'; at: number; minutes: number; requestedBy?: string; raider?: string; viewers?: number }

/**
 * Raid and !previously triggers. Emits `catchup` on the bus for S3's "PREVIOUSLY ON…" sequence.
 * A global cooldown stops chat from spamming the overlay; raids and the streamer's own button bypass it.
 */
export class CatchupTriggers {
  readonly history: CatchupRequest[] = [];
  private lastCommand = -Infinity;
  private lastRaid = new Map<string, number>();
  constructor(private deps: { bus: EventBus<ComicToonsBusEvents>; optOuts: OptOutLedger; now: () => number; cooldownMs?: number; minutes?: number; reply?: (message: string, parentId?: string) => void }) {}
  private emit(request: CatchupRequest) {
    this.history.unshift(request);
    this.history.length = Math.min(this.history.length, 10);
    this.deps.bus.emit('catchup', request);
    return request;
  }
  command(event: ParticipationEvent): CatchupRequest | null {
    const now = this.deps.now();
    if (now - this.lastCommand < (this.deps.cooldownMs ?? 60_000)) return null;
    this.lastCommand = now;
    // An opted-out viewer can still ask for a catch-up, but is never named on it.
    const requestedBy = this.deps.optOuts.has(event.user, event.name) ? undefined : safeText(event.name ?? '') || undefined;
    const request = this.emit({ reason: 'command', at: now, minutes: this.deps.minutes ?? 10, requestedBy });
    this.deps.reply?.('Previously on… is rolling on the overlay now.', event.id);
    return request;
  }
  raid(event: ParticipationEvent): CatchupRequest | null {
    const now = this.deps.now();
    const raider = safeText(event.from ?? '').trim();
    if (raider && now - (this.lastRaid.get(key(raider)) ?? -Infinity) < 60_000) return null;
    if (raider) {
      // MEM-1a #7: an entry only matters inside its 60 s window, so expired raiders are forgotten here.
      for (const [name, at] of this.lastRaid) if (now - at >= 60_000) this.lastRaid.delete(name);
      this.lastRaid.set(key(raider), now);
    }
    const named = raider && !this.deps.optOuts.has(undefined, raider) ? raider : undefined;
    return this.emit({ reason: 'raid', at: now, minutes: this.deps.minutes ?? 10, raider: named, viewers: typeof event.viewers === 'number' ? Math.max(0, Math.floor(event.viewers)) : undefined });
  }
  streamer(): CatchupRequest { return this.emit({ reason: 'streamer', at: this.deps.now(), minutes: this.deps.minutes ?? 10 }); }
}

/** The slice of Studio that S4 uses. The real Studio (S2) satisfies it; tests pass a small fake. */
export interface StudioLike {
  state: { panels: ComicPanel[]; pendingPanels: ComicPanel[]; elapsed: number; approvalMode: boolean };
  moderate(kind: 'approve' | 'reject', panelId?: string): unknown;
  caption(panelId: string, caption: string, attribution?:'Author'|'Chat chose'|'Prediction result'): unknown;
}

/** A redemption's cameo panel, enough to match it against a panel the director just decided on. */
export interface CameoRedemption { id: string; panelId?: string; status: string }

/** The redemption whose cameo is `panelId`, if it hasn't already been fulfilled or canceled. */
export function unsettledCameoRedemption<R extends CameoRedemption>(redemptions: R[], panelId: string): R | undefined {
  return redemptions.find(entry => entry.panelId === panelId && entry.status !== 'fulfilled' && entry.status !== 'canceled');
}

/** Cuts text to `max` characters on a word boundary, adding an ellipsis when it had to cut. */
export function fitText(text: string, max: number): string {
  const clean = safeText(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= Math.floor(max / 2) ? cut.slice(0, space) : cut).trimEnd()}…`;
}
