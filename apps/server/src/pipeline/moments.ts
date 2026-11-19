import type { StreamEvent } from '@comictoons/core';
import { initialClipClusterState, polledClipOf, stepClipCluster, type ClusterClip } from '../ingest/clips.ts';

export type MomentKind = 'raid' | 'cheer' | 'hype' | 'redemption' | 'poll' | 'clip' | 'spike' | 'burst' | 'chat';

export interface MomentConfig {
  /** Rolling window (seconds) used to measure the current chat velocity. */
  spikeWindowSeconds: number;
  /** Trailing window (seconds, inclusive of spikeWindowSeconds) used to measure the baseline velocity. */
  baselineWindowSeconds: number;
  /** The window's message count must be at least this many times the trailing baseline rate. */
  spikeMultiplier: number;
  /** A spike also needs at least this many messages in the window, so a quiet channel never spikes on one line. */
  spikeMinCount: number;
  /** A spike also needs this many distinct chatters in the window, so one user spamming is never a crowd reaction. */
  spikeMinUsers: number;
  /** No spike can open until chat has been observed for this long, so the empty baseline at
   * the very start of a session is never mistaken for a sudden surge. */
  spikeWarmupSeconds: number;
  /** Window (seconds) used to look for the same emote/keyword repeated by distinct users. */
  burstWindowSeconds: number;
  /** Distinct users required inside burstWindowSeconds using the same token to count as a burst. */
  burstMinUsers: number;
  /** After a spike or burst opens a moment, further spikes/bursts are ignored for this long: one burst, one moment. */
  cooldownSeconds: number;
  /** A moment stays open and keeps absorbing related events until this many quiet seconds pass. */
  idleCloseSeconds: number;
  /** Tokens/emotes (case-insensitive; whole-word unless the token contains a space) that count towards a burst. */
  keywords: string[];
  /** Caps how many events a single open moment keeps (oldest dropped first), so a sustained
   * burst that never goes idle cannot grow one moment's memory without bound. */
  maxEventsPerMoment: number;
  /** Caps how many finalised moments completedMoments() retains, so a long-running stream
   * cannot grow this history without bound either. */
  maxCompletedMoments: number;
  /** CLIP-WATCH-1: this many distinct polled clips within clipClusterWindowSeconds open one clip moment. */
  clipClusterMinClips: number;
  clipClusterWindowSeconds: number;
  /** After a clip cluster opens a moment, polled clips only merge into it for this long. */
  clipClusterCooldownSeconds: number;
}

export const defaultMomentConfig: MomentConfig = {
  spikeWindowSeconds: 10,
  baselineWindowSeconds: 120,
  spikeMultiplier: 3,
  spikeMinCount: 6,
  spikeMinUsers: 3,
  spikeWarmupSeconds: 30,
  burstWindowSeconds: 8,
  burstMinUsers: 3,
  cooldownSeconds: 30,
  idleCloseSeconds: 45,
  keywords: ['kekw', 'lul', 'pogchamp', 'pog', 'w', 'gg', 'f', 'clip it'],
  maxEventsPerMoment: 60,
  // MEM-1a #10: 50 (was 200). Nothing in the app reads them; 50 keeps about an hour of moments for debugging.
  maxCompletedMoments: 50,
  clipClusterMinClips: 3,
  clipClusterWindowSeconds: 120,
  clipClusterCooldownSeconds: 120,
};

/** A prediction is a channel-wide call like a poll; Bits used outside a cheer message are a cheer. */
const strongSignalKinds: Partial<Record<StreamEvent['type'], MomentKind>> = {
  raid: 'raid', cheer: 'cheer', bits: 'cheer', hype: 'hype', hype_train_begin: 'hype', redemption: 'redemption', poll: 'poll', prediction: 'poll', clip: 'clip',
};
/** The moment kind a strong signal opens, or undefined for chat and other event types. */
export const strongSignalKind = (type: StreamEvent['type']): MomentKind | undefined => strongSignalKinds[type];

export interface LiveMoment {
  kind: MomentKind;
  startAt: number;
  endAt: number;
  score: number;
  events: StreamEvent[];
  sourceIds: string[];
  /** For a burst: the emote/keyword that several distinct users repeated. */
  token?: string;
  /** For a clip cluster: the most-viewed clip, whose thumbnail inkClipFrame turns into the panel frame. */
  frame?: { url: string; thumbnailUrl: string };
}

function weightFor(kind: MomentKind): number {
  switch (kind) {
    case 'raid': return 50;
    case 'hype': return 40;
    case 'cheer': return 30;
    case 'redemption': return 25;
    case 'poll': return 20;
    case 'clip': return 15;
    case 'burst': return 12;
    case 'spike': return 10;
    default: return 1;
  }
}

function pushEvent(moment: LiveMoment, event: StreamEvent, maxEvents: number): void {
  moment.events.push(event);
  if (event.id) moment.sourceIds.push(event.id);
  moment.endAt = Math.max(moment.endAt, event.t);
  moment.score += weightFor(moment.kind);
  while (moment.events.length > maxEvents) moment.events.shift();
  while (moment.sourceIds.length > maxEvents) moment.sourceIds.shift();
}

function makeMoment(kind: MomentKind, event: StreamEvent, maxEvents: number, seed: StreamEvent[] = [], token?: string): LiveMoment {
  const leading = seed.filter((item) => item !== event);
  const moment: LiveMoment = { kind, startAt: Math.min(event.t, ...leading.map((item) => item.t)), endAt: event.t, score: 0, events: [], sourceIds: [] };
  if (token) moment.token = token;
  for (const item of leading) pushEvent(moment, item, maxEvents);
  pushEvent(moment, event, maxEvents);
  return moment;
}

interface Detection { kind: MomentKind; seed: StreamEvent[]; token?: string }

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractTokens(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const keyword of keywords) {
    const matches = keyword.includes(' ')
      ? lower.includes(keyword)
      : new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(keyword)}(?:$|[^a-z0-9])`).test(lower);
    if (matches) found.push(keyword);
  }
  return found;
}

/**
 * Deterministic, in-process live moment detector: chat velocity spikes over a trailing
 * baseline, emote/keyword bursts repeated by distinct users, and strong Twitch signals
 * (raid, cheer, hype, redemption, poll, clip) that open a moment immediately. A cooldown
 * keeps one sustained burst from reopening a fresh moment on every qualifying message.
 */
export class MomentDetector {
  private readonly config: MomentConfig;
  /** Chat arrivals in the baseline window; the id and user let forget() drop withdrawn lines. */
  private chatTimes: { t: number; id?: string; user?: string }[] = [];
  private tokenUses: { t: number; user: string; token: string; event: StreamEvent }[] = [];
  /** The chat events inside the spike window, so a spike moment can cite the lines that made it. */
  private recentChat: StreamEvent[] = [];
  private open?: LiveMoment;
  private completed: LiveMoment[] = [];
  private cooldownUntil = -Infinity;
  private firstChatAt?: number;
  private clipCluster = initialClipClusterState<ClusterClip & { event: StreamEvent }>();

  constructor(config: Partial<MomentConfig> = {}) {
    this.config = { ...defaultMomentConfig, ...config };
  }

  current(): LiveMoment | undefined { return this.open; }
  completedMoments(): LiveMoment[] { return this.completed; }

  /**
   * Withdrawn chat lines (CLEARMSG, a room-wide CLEARCHAT, a ban or timeout) stop counting
   * towards the spike, baseline and burst windows, and are pruned from open/completed
   * records. Accept ids or a predicate; unknown ids are ignored.
   */
  forget(ids: Iterable<string>|((event:StreamEvent)=>boolean)): number {
    const gone=typeof ids==='function'?undefined:new Set(ids);
    const match=typeof ids==='function'?ids:(event:StreamEvent)=>!!event.id&&gone!.has(event.id);
    const matchingIds=new Set([...this.recentChat,...this.tokenUses.map(use=>use.event)].filter(match).flatMap(event=>event.id?[event.id]:[]));
    let removed=0;
    for(const moment of [this.open,...this.completed]){
      if(!moment)continue;
      const kept=moment.events.filter(event=>!match(event));
      removed+=moment.events.length-kept.length;
      moment.events.splice(0,moment.events.length,...kept);
      moment.sourceIds=kept.flatMap(event=>event.id?[event.id]:[]);
    }
    const before=this.recentChat.length+this.tokenUses.length;
    this.recentChat=this.recentChat.filter(event=>!match(event));
    this.tokenUses=this.tokenUses.filter(use=>!match(use.event));
    this.dropFromWindows(id=>id!==undefined&&(matchingIds.has(id)||!!gone?.has(id)),()=>false);
    return removed+before-this.recentChat.length-this.tokenUses.length;
  }

  /** An opted-out user's lines stop counting towards every window, as with forget(). */
  forgetUser(user: string): void {
    this.dropFromWindows(() => false, (who) => who === user);
  }

  private dropFromWindows(byId: (id?: string) => boolean, byUser: (user?: string) => boolean): void {
    this.chatTimes = this.chatTimes.filter((entry) => !byId(entry.id) && !byUser(entry.user));
    this.recentChat = this.recentChat.filter((event) => !byId(event.id) && !byUser(event.user));
    this.tokenUses = this.tokenUses.filter((use) => !byId(use.event.id) && !byUser(use.user));
  }

  /** Closes an open moment that has gone quiet for idleCloseSeconds, finalising it. */
  closeIfIdle(now: number): LiveMoment | undefined {
    if (!this.open || now - this.open.endAt < this.config.idleCloseSeconds) return undefined;
    return this.close();
  }

  close(): LiveMoment | undefined {
    const finished = this.open;
    if (!finished) return undefined;
    this.open = undefined;
    this.completed.push(finished);
    while (this.completed.length > this.config.maxCompletedMoments) this.completed.shift();
    return finished;
  }

  /**
   * Feeds one event in. Returns a freshly opened LiveMoment exactly when this event starts
   * a new one (a strong signal, a velocity spike, or an emote/keyword burst); returns
   * undefined for ordinary chat, or when the event merges into whichever moment is already open.
   */
  ingest(event: StreamEvent): LiveMoment | undefined {
    this.closeIfIdle(event.t);
    const polled = polledClipOf(event);
    if (polled) return this.ingestPolledClip(polled);
    const strongKind = strongSignalKinds[event.type];
    if (strongKind) return this.openOrMerge(strongKind, event, this.config.idleCloseSeconds);
    if (event.type !== 'chat' || !event.text) return undefined;
    this.chatTimes = this.chatTimes.filter((entry) => event.t - entry.t <= this.config.baselineWindowSeconds);
    this.chatTimes.push({ t: event.t, id: event.id, user: event.user });
    this.firstChatAt ??= event.t;
    this.recentChat = this.recentChat.filter((item) => event.t - item.t <= this.config.spikeWindowSeconds);
    this.recentChat.push(event);
    const detected = this.detectBurst(event) ?? this.detectSpike(event.t);
    if (detected && event.t >= this.cooldownUntil) {
      this.cooldownUntil = event.t + this.config.cooldownSeconds;
      return this.openOrMerge(detected.kind, event, this.config.cooldownSeconds, detected.seed, detected.token);
    }
    if (this.open && event.t - this.open.endAt <= this.config.idleCloseSeconds) pushEvent(this.open, event, this.config.maxEventsPerMoment);
    return undefined;
  }

  /** Polled clips (CLIP-WATCH-1) open a moment only as a cluster; each one adds the clip weight, so the score rises with the count. */
  private ingestPolledClip(clip: ClusterClip & { event: StreamEvent }): LiveMoment | undefined {
    const step = stepClipCluster(this.clipCluster, clip, this.config);
    this.clipCluster = step.state;
    if (step.opened) {
      this.close();
      this.open = makeMoment('clip', clip.event, this.config.maxEventsPerMoment, step.opened.clips.map((item) => item.event));
      this.open.frame = step.opened.frame;
      return this.open;
    }
    if (step.merge && this.open?.kind === 'clip') pushEvent(this.open, clip.event, this.config.maxEventsPerMoment);
    return undefined;
  }

  private detectSpike(now: number): Detection | undefined {
    const recent = this.chatTimes.filter(({ t }) => now - t <= this.config.spikeWindowSeconds).length;
    if (recent < this.config.spikeMinCount) return undefined;
    if (now - (this.firstChatAt ?? now) < this.config.spikeWarmupSeconds) return undefined;
    const users = new Set(this.recentChat.map((item) => item.user ?? item.id ?? ''));
    if (users.size < this.config.spikeMinUsers) return undefined;
    // Normalise by the history actually observed, so a young session's short baseline is not
    // diluted across the full trailing window (which would make ordinary chat look like a spike).
    const observed = Math.min(this.config.baselineWindowSeconds, now - (this.firstChatAt ?? now));
    const baselineSpan = Math.max(1, observed - this.config.spikeWindowSeconds);
    const baselineCount = this.chatTimes.filter(({ t }) => now - t > this.config.spikeWindowSeconds).length;
    const baselineRate = (baselineCount / baselineSpan) * this.config.spikeWindowSeconds;
    return recent >= Math.max(this.config.spikeMinCount, baselineRate * this.config.spikeMultiplier) ? { kind: 'spike', seed: [...this.recentChat] } : undefined;
  }

  private detectBurst(event: StreamEvent): Detection | undefined {
    if (!event.user || !event.text) return undefined;
    const tokens = extractTokens(event.text, this.config.keywords);
    if (!tokens.length) return undefined;
    this.tokenUses = this.tokenUses.filter((use) => event.t - use.t <= this.config.burstWindowSeconds);
    for (const token of tokens) this.tokenUses.push({ t: event.t, user: event.user, token, event });
    for (const token of tokens) {
      const uses = this.tokenUses.filter((use) => use.token === token);
      const distinctUsers = new Set(uses.map((use) => use.user));
      if (distinctUsers.size >= this.config.burstMinUsers) return { kind: 'burst', seed: uses.map((use) => use.event), token };
    }
    return undefined;
  }

  private openOrMerge(kind: MomentKind, event: StreamEvent, mergeWindowSeconds: number, seed: StreamEvent[] = [], token?: string): LiveMoment | undefined {
    if (this.open && this.open.kind === kind && event.t - this.open.endAt <= mergeWindowSeconds) {
      pushEvent(this.open, event, this.config.maxEventsPerMoment);
      return undefined;
    }
    this.close();
    this.open = makeMoment(kind, event, this.config.maxEventsPerMoment, seed, token);
    return this.open;
  }
}
