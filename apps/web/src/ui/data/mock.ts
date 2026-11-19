import { sampleStoryIssue } from './sampleStories';
/**
 * Mock adapter: the whole UI runs on this with no back end and no network.
 * Timers push fake panels, chat lines, votes and redemptions. Everything here is Sample Data.
 */
import type { ChatSourceState, StreamEvent } from '@comictoons/core';
import type { Fixture } from '../../types';
import { buildSeries } from '../../../../../packages/core/src/manga';
import { exportIssuePage } from '../export';
import { storyArt, type ArtAsset } from './art';
import {
  EVENTSUB_TYPES, isLook, resolveLook, TWITCH_STILL_SIGNED_OUT, type BindResult, type CatchupView, type ChatLine, type ComicToonsAdapter, type EventSubRevocation, type EventSubStatus,
  type InkMeOffReason, type InkMeReward, type IssueView, type SeriesView, type LookId, type OutputMode, type ParticipationStatus, type TwitchAuth, type UiEvent, type UiEventName, type UiPanel,
  type UiSnapshot, type UiStudioState,
} from './adapter';

/** ?eventsub= for screenshots. 'revoke-live' starts connected and is revoked four seconds in (needs timers, so not with freeze=1). */
export type MockEventSub = 'off' | 'connecting' | 'connected' | 'partial' | 'failed' | 'revoked' | 'revoke-live';
const EVENTSUB_STATES: readonly MockEventSub[] = ['off', 'connecting', 'connected', 'partial', 'failed', 'revoked', 'revoke-live'];

/** Sample EventSub status in the GET /api/participation/eventsub shape. */
export function sampleEventSub(kind: MockEventSub, at: number): EventSubStatus {
  const all = EVENTSUB_TYPES.map(entry => entry.type);
  const base: EventSubStatus = { state: 'subscribed', signedIn: true, keepaliveSeconds: 10, subscribed: all, failed: [], revoked: [], reconnects: 0, notifications: 128 };
  switch (kind) {
    case 'off': return { ...base, state: 'idle', signedIn: false, keepaliveSeconds: undefined, subscribed: [], notifications: 0 };
    case 'connecting': return { ...base, state: 'connecting', subscribed: [], notifications: 0 };
    case 'partial': {
      const missing = ['channel.cheer', 'channel.hype_train.begin', 'channel.hype_train.end'];
      return { ...base, subscribed: all.filter(type => !missing.includes(type)), failed: missing.map(type => ({ type, error: `Twitch refused it: the sign-in is missing the ${type === 'channel.cheer' ? 'bits:read' : 'channel:read:hype_train'} permission.` })) };
    }
    case 'failed': return { ...base, state: 'stopped', subscribed: [], reconnects: 3, notifications: 0, lastError: 'Twitch closed the event connection three times in a row. Live events are not reaching the comic.' };
    case 'revoked': return revokeAll(base, at);
    default: return base;
  }
}
function revokeAll(status: EventSubStatus, at: number): EventSubStatus {
  const revoked: EventSubRevocation[] = status.subscribed.map(type => ({ type, version: type.startsWith('channel.hype_train') ? '2' : '1', status: 'authorization_revoked', at }));
  return { ...status, state: 'stopped', subscribed: [], revoked: [...status.revoked, ...revoked], lastError: 'Twitch access was withdrawn; sign in to Twitch again.' };
}

export const MOCK_INKME = ['idle', 'creating', 'ready', 'not-affiliate', 'check-failed', 'create-failed', 'invalid', 'signed-out'] as const;
export type MockInkMe = typeof MOCK_INKME[number];
/** Copied from T3b (participation/rewards.ts and twitch-api/errors.ts) so the Sample states read exactly like the server. */
export const INK_ME_AFFILIATE_MESSAGE = 'Ink me needs an Affiliate or Partner channel';
export const INK_ME_CHAT_FALLBACK = 'Chat commands still work: moderators approve or reject panels with !ink yes / !ink no, and viewers vote with !1, !2 or !3.';
const INK_ME_OFF: Record<InkMeOffReason, string> = {
  'signed-out': 'Twitch is not connected.',
  'not-affiliate': INK_ME_AFFILIATE_MESSAGE,
  'check-failed': 'Ink me is off: the Twitch channel type could not be checked (Twitch did not answer in time).',
  'create-failed': 'Twitch could not create the reward: a reward with this title already exists.',
  invalid: 'The reward cost must be between 1 and 1,000,000 points.',
};
/** Reward fields for one Sample state, as GET /api/participation/status would send them. */
export function sampleInkMe(kind: MockInkMe): Pick<InkMeReward, 'status' | 'error' | 'offReason' | 'chatFallback'> {
  if (kind === 'idle' || kind === 'creating' || kind === 'ready') return { status: kind };
  return { status: 'unavailable', offReason: kind, error: INK_ME_OFF[kind], chatFallback: INK_ME_CHAT_FALLBACK };
}

export const MOCK_STATES = ['live', 'loading', 'offline', 'error', 'empty', 'lost'] as const;
export type MockState = typeof MOCK_STATES[number];
/** What the studio server would say if it never answered (the Sample of a failed GET /api/state). */
export const MOCK_UNREACHABLE = 'ComicToons couldn’t reach the studio server on this computer.';

export interface MockOptions {
  look?: LookId;
  twitch?: TwitchAuth['state'] | 'no-affiliate';
  /** Approved panels already on air at start (0 to 40). */
  count?: number;
  /** Panels waiting for approval at start. */
  pending?: number;
  eventsub?: MockEventSub;
  /**
   * UI3 screen states (?state=). loading: nothing has arrived yet. error and offline: the studio server never answered, so
   * there is no data at all. empty: a fresh studio with no stream, panels, chat or issues. lost: the connection dropped
   * mid-stream, so the last panels stay on screen with a banner. Blank states carry no Sample panels, chat or votes.
   */
  state?: MockState;
  fixtureId?: string;
  /** Stop all timers (stable screenshots). */
  freeze?: boolean;
  hidden?: boolean;
  poll?: boolean;
  prediction?: boolean;
  /** Ink me reward state (?inkme=): the T3b statuses and off reasons. */
  inkme?: MockInkMe;
  /** Shot-only: slow the binding progress (?bindms=, ms per step). */
  bindMs?: number;
  /** Start time for the sample clock, so screenshots are stable. */
  now?: number;
}

interface Beat { caption: string; line: string; sfx?: string; alt: string; source: UiPanel['source']; cameo?: string; votes?: number }

const STREAMS: { fixture: Fixture & { channel: string; issueTitle: string }; art: ArtAsset[]; beats: Beat[] }[] = [
  {
    fixture: { id: 'tabletop-night', streamTitle: 'The dice had other plans', channel: 'juniper_rolls', issueTitle: 'Critical Mess' },
    art: storyArt.tabletop,
    beats: [
      { caption: 'The party pushes open the crystal vault.', line: 'Torches up. Nobody touch anything.', alt: 'An explorer and a fox step into a glittering vault.', source: 'generated' },
      { caption: 'Chat begs for one more roll.', line: 'One more! ONE MORE!', sfx: 'CLACK!', alt: 'A hand releases a many-sided die mid-air.', source: 'clip', votes: 41 },
      { caption: 'A natural one. The floor gives way.', line: 'That was the floor, wasn’t it?', sfx: 'KRAK!', alt: 'Cracks race across a stone floor under the party.', source: 'generated' },
      { caption: 'The fox finds the exit first, obviously.', line: 'Follow the fox!', alt: 'A small fox leads the way through a narrow tunnel.', source: 'cameo', cameo: 'lanternfish88' },
      { caption: 'The boss wakes up grumpy.', line: 'Roll for initiative. Please.', sfx: 'GRRR!', alt: 'A huge crystal golem rises from rubble.', source: 'clip' },
      { caption: 'Chat names the golem Kevin.', line: 'Kevin, no!', alt: 'The golem pauses, puzzled, as the heroes shout at it.', source: 'generated', votes: 63 },
      { caption: 'A twenty, at last. The vault goes quiet.', line: 'Nat twenty! We live!', sfx: 'GG!', alt: 'The explorer cheers as the golem crumbles.', source: 'clip' },
      { caption: 'Loot, snacks, and a very tired fox.', line: 'Same time next week?', alt: 'The party rests by a campfire with their loot.', source: 'generated' },
    ],
  },
  {
    fixture: { id: 'speedrun-fail', streamTitle: 'One jump from glory', channel: 'orbit_runs', issueTitle: 'Frame Perfect' },
    art: storyArt.speedrun,
    beats: [
      { caption: 'Personal best pace. Chat holds its breath.', line: 'Don’t talk to me for nine minutes.', alt: 'A runner grips a controller, timer glowing.', source: 'clip' },
      { caption: 'The skip lands first try.', line: 'NO WAY.', sfx: 'ZIP!', alt: 'A character threads a gap between two walls.', source: 'clip', votes: 58 },
      { caption: 'Then the final jump.', line: 'It’s fine. It’s fine. It’s—', sfx: 'BONK', alt: 'The character clips a ledge by a single pixel.', source: 'generated' },
      { caption: 'Chat sends twelve thousand clocks.', line: 'Reset. Obviously.', alt: 'The screen fills with clock emotes.', source: 'generated' },
      { caption: 'Run forty-two. Different energy.', line: 'Snacks are down. Focus is up.', alt: 'The runner cracks their knuckles.', source: 'clip' },
      { caption: 'Glory, by eight hundredths.', line: 'WE DID IT!', sfx: 'PB!', alt: 'Confetti bursts as the timer turns gold.', source: 'clip', votes: 77 },
    ],
  },
  {
    fixture: { id: 'irl-cooking', streamTitle: 'The great pancake comeback', channel: 'clover_cooks', issueTitle: 'Batter Days' },
    art: storyArt.cooking,
    beats: [
      { caption: 'Pancake number one is a warning.', line: 'That one is for science.', alt: 'A lumpy pancake sits sadly in a pan.', source: 'clip' },
      { caption: 'Chat votes for the big flip.', line: 'Three, two, one…', sfx: 'FWUP!', alt: 'A pancake spins through the air above the pan.', source: 'clip', votes: 52 },
      { caption: 'Most of it lands.', line: 'Most is a win.', sfx: 'SPLAT', alt: 'Half a pancake lands in the pan, half on the hob.', source: 'generated' },
      { caption: 'A raid arrives at peak chaos.', line: 'Welcome in! Mind the batter.', alt: 'Waves of tiny cheering figures pour into the kitchen.', source: 'generated' },
      { caption: 'The comeback stack rises.', line: 'Behold. The tower.', alt: 'A tall golden stack of pancakes.', source: 'cameo', cameo: 'syrupqueen' },
      { caption: 'Everyone eats. Nobody mentions pancake one.', line: 'Same time tomorrow!', alt: 'The streamer waves with a fork full of pancake.', source: 'generated' },
    ],
  },
];

const CHAT_USERS = ['lanternfish88', 'pixelmoth', 'nat_twenty', 'quietkettle', 'mapleglitch', 'sundaydragon', 'tinyhaiku', 'syrupqueen'];
const CHAT_LINES = ['that was SO close', '!1', 'kevin deserves better', '!previously', 'clip it clip it', '!2', 'the fox is the real main character', 'LET HIM COOK', '!ink', 'chat writes better than the writers', '!3', 'no way that worked'];
const POLL_CAPTIONS = [['Kevin chooses violence.', 'Kevin just wants a hug.', 'Kevin has seen things.'], ['Gravity: 1, Hero: 0.', 'The floor was a suggestion.', 'Plan B is falling.']];

function readParams(): MockOptions {
  if (typeof location === 'undefined') return {};
  const query = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : location.search.slice(1);
  const params = new URLSearchParams(query);
  const number = (key: string) => (params.has(key) ? Math.max(0, Math.min(40, Number(params.get(key)) || 0)) : undefined);
  const look = params.get('look');
  const twitch = params.get('twitch');
  const state = params.get('state');
  return {
    look: isLook(look) ? look : undefined,
    twitch: (['signed-out', 'connecting', 'connected', 'error', 'no-affiliate'] as const).find(value => value === twitch),
    count: number('count'), pending: number('pending'),
    eventsub: EVENTSUB_STATES.find(value => value === params.get('eventsub')),
    state: MOCK_STATES.find(value => value === state),
    fixtureId: params.get('stream') ?? undefined,
    freeze: params.get('freeze') === '1',
    hidden: params.get('hidden') === '1',
    poll: params.get('poll') !== '0', prediction: params.get('prediction') !== '0',
    inkme: MOCK_INKME.find(value => value === params.get('inkme')),
    bindMs: params.has('bindms') ? Math.max(0, Math.min(20_000, Number(params.get('bindms')) || 0)) : undefined,
  };
}

const LOOK_KEY = 'comictoons-ui-look';

export class MockAdapter implements ComicToonsAdapter {
  readonly kind = 'mock' as const;
  protected snapshot: UiSnapshot;
  private listeners = new Set<() => void>();
  private eventHandlers = new Set<{ names: readonly UiEventName[]; handler: (event: UiEvent) => void }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private cursor = 0;
  private serial = 0;
  private undoTokens = new Map<string, () => void>();
  private options: MockOptions;
  private clock: number;

  constructor(options: MockOptions = readParams()) {
    this.options = options;
    this.clock = options.now ?? Date.UTC(2026, 10, 2, 20, 0, 0);
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LOOK_KEY) : null;
    const look: LookId = options.look ?? resolveLook(stored);
    this.snapshot = this.initial(look);
    if (!options.freeze && options.state !== 'loading') this.start();
    if (typeof window !== 'undefined') {
      // Keep the Look in step across tabs (studio and the `#/overlay` browser source), still with no network.
      window.addEventListener('storage', event => { if (event.key === LOOK_KEY && isLook(event.newValue)) this.patchStudio({ look: event.newValue }); });
    }
  }

  // ---- store plumbing -------------------------------------------------------------------------
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onEvent(names: readonly UiEventName[], handler: (event: UiEvent) => void) {
    const entry = { names, handler };
    this.eventHandlers.add(entry);
    return () => { this.eventHandlers.delete(entry); };
  }
  protected emit(event: UiEvent) { for (const entry of this.eventHandlers) if (entry.names.includes(event.name)) entry.handler(event); }
  protected set(next: Partial<UiSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  protected patchStudio(next: Partial<UiStudioState>) {
    this.set({ studio: { ...this.snapshot.studio, ...next } });
    this.emit({ name: 'state', data: this.snapshot.studio });
  }
  protected patchParticipation(next: Partial<ParticipationStatus>) { this.set({ participation: { ...this.snapshot.participation, ...next } }); }
  private wait(ms = 260) { return new Promise<void>(resolve => setTimeout(resolve, this.options.freeze ? 0 : ms)); }
  private async busyWhile<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    this.set({ busy: label });
    try { await this.wait(); return await work(); } finally { this.set({ busy: '' }); }
  }

  // ---- sample data ----------------------------------------------------------------------------
  private stream() { return STREAMS.find(entry => entry.fixture.id === this.snapshot?.studio.fixtureId) ?? STREAMS.find(entry => entry.fixture.id === this.options.fixtureId) ?? STREAMS[0]!; }
  private makePanel(index: number, stream = this.stream()): UiPanel {
    const issue = sampleStoryIssue(`sample-${stream.fixture.id}`, this.snapshot?.studio.look ?? this.options.look ?? 'festival');
    const panel = issue.storyPanels![index % issue.storyPanels!.length]!;
    this.serial += 1;
    return { ...panel, id: `sample-${stream.fixture.id}-${index}-${this.serial}`, at: index * 120 };
  }

  private initial(look: LookId): UiSnapshot {
    const options = this.options;
    const blank = this.blank();
    const stream = STREAMS.find(entry => entry.fixture.id === options.fixtureId) ?? STREAMS[0]!;
    const count = blank ? 0 : options.count ?? 4;
    const panels = Array.from({ length: count }, (_, index) => this.makePanel(index, stream));
    const pending = Array.from({ length: blank ? 0 : options.pending ?? 1 }, (_, index) => this.makePanel(count + index, stream));
    this.cursor = count + pending.length;
    // ?eventsub= on its own implies a signed-in channel, so each chip state can be shot from one param.
    // ?inkme= on its own implies a signed-in channel too; not-affiliate implies a normal (non-Affiliate) channel.
    const signedIn = options.twitch ?? (options.inkme === 'not-affiliate' ? 'no-affiliate'
      : (options.eventsub && options.eventsub !== 'off') || (options.inkme && options.inkme !== 'signed-out') ? 'connected' : undefined);
    const twitch: TwitchAuth = signedIn === 'no-affiliate'
      ? { state: 'connected', login: 'nova_inks', broadcasterType: '' }
      : signedIn === 'connected' ? { state: 'connected', login: 'nova_inks', broadcasterType: 'affiliate' }
        : signedIn === 'error' ? { state: 'error', error: 'You may have cancelled it, or Twitch didn’t answer.' }
          : { state: signedIn === 'connecting' ? 'connecting' : 'signed-out' };
    const live = twitch.state === 'connected';
    const source: ChatSourceState = live
      ? { requested: 'twitch', active: 'twitch', connection: 'live', channel: 'nova_inks', simulated: true, received: 128 }
      : { requested: 'sample', active: 'sample', connection: 'sample', simulated: false, received: 0 };
    const elapsed = blank ? 0 : Math.min(1440, count * 120 + 95);
    const now = this.clock;
    const studio: UiStudioState = {
      look, mangaTheme: resolveLook(look), source,
      status: blank ? 'idle' : 'running', fixtureId: stream.fixture.id, speed: 60, style: look === 'noir' ? 'noir' : 'risograph',
      approvalMode: true, panels, pendingPanels: pending,
      // A blank studio has no stream yet, so no titles either (the screens say so instead of inventing one).
      streamTitle: blank ? '' : stream.fixture.streamTitle, issueTitle: blank ? '' : stream.fixture.issueTitle,
      elapsed, duration: 1440, hidden: !!options.hidden,
      budget: { perHour: 12, used: Math.min(12, count + pending.length), resetAt: now + 34 * 60_000 },
      latestRecapUrl: count ? `#/recap/sample-${stream.fixture.id}` : undefined,
    };
    const participation: ParticipationStatus = {
      poll: options.poll === false || !pending[0] ? null : {
        id: 'sample-poll-1', panelId: pending[0].id, mode: twitch.broadcasterType ? 'twitch' : 'chat', endsAt: now + 38_000, total: 87,
        choices: POLL_CAPTIONS[0]!.map((caption, index) => ({ key: index + 1, caption, votes: [46, 29, 12][index]! })),
      },
      lastPoll: blank ? undefined : { caption: 'Nat twenty! We live!', voters: 63 },
      prediction: options.prediction === false || blank ? null : {
        id: 'sample-prediction-1', title: 'Does Kevin survive the next roll?', status: 'active', endsAt: now + 95_000,
        outcomes: [{ title: 'Kevin lives', users: 54, points: 12_400 }, { title: 'Kevin crumbles', users: 71, points: 18_950 }],
      },
      reward: {
        title: 'Ink me into the comic', cost: 500, perViewer: 1, cooldownMinutes: 5, cooldownEndsAt: now + 3 * 60_000,
        ...sampleInkMe(options.inkme ?? (twitch.state !== 'connected' ? 'idle' : twitch.broadcasterType ? 'ready' : 'not-affiliate')),
        redemptions: blank ? [] : [
          { id: 'sample-redeem-1', name: 'lanternfish88', at: now - 7 * 60_000, status: 'drawing', note: 'Wants to be the fox’s sidekick.' },
          { id: 'sample-redeem-2', name: 'syrupqueen', at: now - 60_000, status: 'queued', note: 'Holding a giant spoon, please.' },
        ],
      },
      optedOut: blank ? 0 : 2,
      rules: { raidCatchup: true, previouslyCommand: true, modApprove: true },
      lastCatchup: blank ? undefined : { reason: 'raid', at: now - 12 * 60_000, raider: 'mapleglitch', viewers: 42 },
    };
    const chat: ChatLine[] = blank ? [] : CHAT_LINES.slice(0, 6).map((text, index) => ({ id: `sample-chat-${index}`, at: now - (6 - index) * 9_000, user: CHAT_USERS[index % CHAT_USERS.length]!, text, kind: text.startsWith('!') ? 'command' : 'chat' }));
    if (!blank) chat.splice(3, 0, { id: 'sample-raid', at: now - 30_000, user: 'mapleglitch', text: 'raided with 42 viewers', kind: 'raid' });
    return {
      studio, fixtures: STREAMS.map(entry => ({ id: entry.fixture.id, streamTitle: entry.fixture.streamTitle })),
      loading: options.state === 'loading', offline: options.state === 'offline',
      error: options.state === 'error' || options.state === 'offline' ? MOCK_UNREACHABLE : options.state === 'lost' ? 'The studio lost its connection. Your approved panels are safe.' : '',
      // sampleReady is false until the first GET /api/state answers, as on the server adapter.
      busy: '', sampleReady: !this.unreachable() && options.state !== 'loading', twitch, participation, chat,
      eventsub: sampleEventSub(options.eventsub ?? (live ? 'connected' : 'off'), now - 5 * 60_000),
    };
  }

  private start() {
    let tick = 0;
    this.timers.push(setInterval(() => {
      tick += 1;
      const { studio } = this.snapshot;
      if (studio.status !== 'running') return;
      this.clock += 1000;
      const elapsed = Math.min(studio.duration ?? 1440, (studio.elapsed ?? 0) + studio.speed / 10);
      if (tick % 9 === 0 && studio.pendingPanels.length < 3 && studio.budget.used < studio.budget.perHour) {
        const panel = this.makePanel(this.cursor++);
        this.patchStudio({ elapsed, pendingPanels: [...studio.pendingPanels, panel], budget: { ...studio.budget, used: studio.budget.used + 1 } });
      } else this.patchStudio({ elapsed });
      if (tick % 3 === 0) this.pushChat();
      const poll = this.snapshot.participation.poll;
      if (poll && tick % 2 === 0) {
        const key = (tick % 5) % 3;
        this.patchParticipation({ poll: { ...poll, total: poll.total + 1, choices: poll.choices.map((choice, index) => index === key ? { ...choice, votes: choice.votes + 1 } : choice) } });
      }
      if (poll && this.clock >= poll.endsAt) void this.endPoll();
      if (this.options.eventsub === 'revoke-live' && tick === 4) this.revoke();
    }, 1000));
  }

  private pushChat() {
    const index = this.serial++ % CHAT_LINES.length;
    const text = CHAT_LINES[index]!;
    const line: ChatLine = { id: `sample-chat-live-${this.serial}`, at: this.clock, user: CHAT_USERS[(index + 3) % CHAT_USERS.length]!, text, kind: text.startsWith('!') ? 'command' : 'chat' };
    this.set({ chat: [...this.snapshot.chat.slice(-11), line] });
    const event: StreamEvent = { id: line.id, t: Math.round((this.snapshot.studio.elapsed ?? 0)), type: 'chat', user: line.user, name: line.user, text: line.text };
    this.emit({ name: 'stream-event', data: event });
  }

  /** Sample revocation, as the bus would send 'eventsub-revoked' once per withdrawn subscription. */
  private revoke() {
    const before = this.snapshot.eventsub;
    const after = revokeAll(before, this.clock);
    this.set({ eventsub: after });
    for (const revocation of after.revoked.slice(before.revoked.length)) this.emit({ name: 'eventsub-revoked', data: revocation });
  }

  /** No Sample panels, chat or votes in these states. */
  private blank() { return this.options.state === 'loading' || this.options.state === 'empty' || this.unreachable(); }
  private unreachable() { return this.options.state === 'error' || this.options.state === 'offline'; }

  // ---- studio actions -------------------------------------------------------------------------
  /**
   * Try again / Reconnect. Sample: the studio server "comes back", so the Sample studio loads as it would after a
   * successful GET /api/state. From the empty and lost states only the banner clears.
   */
  async refresh() {
    if (this.unreachable() || this.options.state === 'loading') {
      await this.busyWhile('refresh', () => {
        this.options = { ...this.options, state: undefined };
        this.snapshot = this.initial(this.snapshot.studio.look);
        for (const listener of this.listeners) listener();
        this.emit({ name: 'state', data: this.snapshot.studio });
      });
      if (!this.options.freeze && !this.timers.length) this.start();
      return;
    }
    if (this.options.state === 'lost') this.options = { ...this.options, state: undefined };
    this.set({ error: '', offline: false, loading: false });
  }
  now() { return this.clock; }

  async approve(panelId?: string) {
    return this.busyWhile('approve', () => {
      const { studio } = this.snapshot;
      const panel = studio.pendingPanels.find(entry => entry.id === panelId) ?? studio.pendingPanels[0];
      if (!panel) return {};
      this.patchStudio({ pendingPanels: studio.pendingPanels.filter(entry => entry !== panel), panels: [...studio.panels, panel] });
      return { undoToken: this.token(() => {
        const now = this.snapshot.studio;
        this.patchStudio({ panels: now.panels.filter(entry => entry.id !== panel.id), pendingPanels: [panel, ...now.pendingPanels] });
      }) };
    });
  }
  async reject(panelId?: string) {
    return this.busyWhile('reject', () => {
      const { studio } = this.snapshot;
      const panel = studio.pendingPanels.find(entry => entry.id === panelId) ?? studio.pendingPanels[0];
      if (!panel) return {};
      this.patchStudio({ pendingPanels: studio.pendingPanels.filter(entry => entry !== panel) });
      return { undoToken: this.token(() => {
        const now = this.snapshot.studio;
        this.patchStudio({ pendingPanels: [panel, ...now.pendingPanels.filter(entry => entry.id !== panel.id)] });
      }) };
    });
  }
  private token(revert: () => void) { const token = `undo-${++this.serial}`; this.undoTokens.set(token, revert); return token; }
  async undo(token: string) { const revert = this.undoTokens.get(token); this.undoTokens.delete(token); revert?.(); }
  async editCaption(panelId: string, caption: string) {
    await this.busyWhile('caption', () => {
      const edit = (list: UiPanel[]) => list.map(panel => panel.id === panelId ? { ...panel, caption, generatedCaption: false } : panel);
      const { studio } = this.snapshot;
      this.patchStudio({ panels: edit(studio.panels), pendingPanels: edit(studio.pendingPanels) });
    });
  }
  async setLook(look: LookId) {
    try { localStorage.setItem(LOOK_KEY, look); } catch { /* private mode: the Look still applies in this tab */ }
    this.patchStudio({ look, mangaTheme: resolveLook(look), style: look === 'noir' ? 'noir' : 'risograph' });
  }
  async setSpeed(speed: 1 | 10 | 60) { this.patchStudio({ speed }); }
  async setApprovalMode(on: boolean) { this.patchStudio({ approvalMode: on }); }
  async replay(fixtureId: string) {
    // Starting the Sample replay from the empty studio leaves the empty state behind (issues fill up from here).
    if (this.options.state === 'empty') this.options = { ...this.options, state: undefined };
    await this.busyWhile('replay', () => {
      const stream = STREAMS.find(entry => entry.fixture.id === fixtureId) ?? STREAMS[0]!;
      this.cursor = 1;
      this.patchStudio({
        fixtureId: stream.fixture.id, streamTitle: stream.fixture.streamTitle, issueTitle: stream.fixture.issueTitle,
        panels: [], pendingPanels: [this.makePanel(0, stream)], elapsed: 0, status: 'running', hidden: false,
        budget: { ...this.snapshot.studio.budget, used: 1 },
      });
    });
  }
  async useSampleData() {
    this.patchStudio({ source: { requested: 'sample', active: 'sample', connection: 'sample', simulated: false, received: 0 } });
  }
  async useLiveChat(channel?: string) {
    if (this.snapshot.twitch.state !== 'connected') return;
    this.patchStudio({ source: { requested: 'twitch', active: 'twitch', connection: 'live', channel: channel ?? this.snapshot.twitch.login, simulated: true, received: 128 } });
  }
  async panicHide(hidden: boolean) { this.patchStudio({ hidden }); }
  async endStream(title: string, modes: OutputMode[], look: LookId): Promise<BindResult> {
    return this.busyWhile('end', async () => {
      // ?bindms= (shots only) holds the bind open even with freeze=1, so the progress list can be captured.
      if (this.options.bindMs !== undefined) await new Promise<void>(resolve => setTimeout(resolve, this.options.bindMs));
      else await this.wait(900);
      const { studio } = this.snapshot;
      this.patchStudio({ status: 'ended', issueTitle: title || studio.issueTitle });
      const id = `sample-${studio.fixtureId}`;
      return { recapId: id, modes, pageCount: Math.max(1, Math.ceil(studio.panels.length / 4)) + 1, episodeCount: studio.panels.length, look };
    });
  }
  async saveRecap(look: LookId) {
    return this.busyWhile('save', () => ({ recapId: `sample-${this.snapshot.studio.fixtureId}`, look }));
  }

  // ---- Twitch sign-in -------------------------------------------------------------------------
  private connectTimer?: ReturnType<typeof setTimeout>;
  async connectTwitch() {
    this.set({ twitch: { state: 'connecting' } });
    this.connectTimer = setTimeout(() => {
      // A fresh sign-in starts EventSub again, which is the recovery for a revocation.
      this.set({ twitch: { state: 'connected', login: 'nova_inks', broadcasterType: 'affiliate' }, eventsub: sampleEventSub('connected', this.clock) });
      this.patchParticipation({ reward: { ...this.snapshot.participation.reward, ...sampleInkMe('ready') } });
      void this.useLiveChat();
    }, 2200);
  }
  async cancelConnect() { clearTimeout(this.connectTimer); this.set({ twitch: { state: 'signed-out' } }); }
  async disconnectTwitch() { this.set({ twitch: { state: 'signed-out' }, eventsub: sampleEventSub('off', this.clock) }); await this.useSampleData(); }
  async getEventSub() { return this.snapshot.eventsub; }
  async checkTwitch() {
    // Sample: there is no Twitch to ask, so the re-check honestly finds no sign-in and keeps the error up.
    await this.busyWhile('twitch-check', () => this.set({ twitch: { state: 'error', error: TWITCH_STILL_SIGNED_OUT } }));
  }
  dismissTwitchError() { this.set({ twitch: { state: 'signed-out' } }); }

  // ---- participation --------------------------------------------------------------------------
  async startPoll() {
    const { studio, twitch } = this.snapshot;
    const panel = studio.pendingPanels[0] ?? studio.panels.at(-1);
    if (!panel) return;
    const captions = POLL_CAPTIONS[this.serial % POLL_CAPTIONS.length]!;
    this.patchParticipation({ poll: { id: `sample-poll-${++this.serial}`, panelId: panel.id, mode: twitch.broadcasterType ? 'twitch' : 'chat', endsAt: this.clock + 45_000, total: 0, choices: captions.map((caption, index) => ({ key: index + 1, caption, votes: 0 })) } });
  }
  async endPoll() {
    const poll = this.snapshot.participation.poll;
    if (!poll) return;
    const winner = [...poll.choices].sort((a, b) => b.votes - a.votes)[0]!;
    this.patchParticipation({ poll: null, lastPoll: { caption: winner.caption, voters: poll.total } });
  }
  async startPrediction() {
    this.patchParticipation({ prediction: { id: `sample-prediction-${++this.serial}`, title: 'Does the next roll land?', status: 'active', endsAt: this.clock + 120_000, outcomes: [{ title: 'Yes', users: 0, points: 0 }, { title: 'No', users: 0, points: 0 }] } });
  }
  async resolvePrediction(winner: string) {
    const prediction = this.snapshot.participation.prediction;
    if (prediction) this.patchParticipation({ prediction: { ...prediction, status: 'resolved', winner } });
  }
  /** Like T3b enable(): a normal channel stays off with the Affiliate message; otherwise creating, then ready. */
  async setInkMe(on: boolean) {
    const reward = () => this.snapshot.participation.reward;
    const strip = { error: undefined, offReason: undefined, chatFallback: undefined };
    if (!on) { this.patchParticipation({ reward: { ...reward(), ...strip, status: 'idle' } }); return; }
    if (this.snapshot.twitch.state !== 'connected') { this.patchParticipation({ reward: { ...reward(), ...sampleInkMe('signed-out') } }); return; }
    if (!this.snapshot.twitch.broadcasterType) { this.patchParticipation({ reward: { ...reward(), ...sampleInkMe('not-affiliate') } }); return; }
    this.patchParticipation({ reward: { ...reward(), ...strip, status: 'creating' } });
    await this.wait(600);
    this.patchParticipation({ reward: { ...reward(), status: 'ready' } });
  }
  async resolveRedemption(id: string, action: 'fulfil' | 'cancel') {
    const reward = this.snapshot.participation.reward;
    this.patchParticipation({ reward: { ...reward, redemptions: reward.redemptions.map(entry => entry.id === id ? { ...entry, status: action === 'fulfil' ? 'fulfilled' : 'refunded' } : entry) } });
  }
  async playCatchup() {
    const panels = this.snapshot.studio.panels.slice(-3);
    this.patchParticipation({ lastCatchup: { reason: 'manual', at: this.clock } });
    this.emit({ name: 'catchup', data: { reason: 'manual', panelIds: panels.map(panel => panel.id) } });
  }

  // ---- readers --------------------------------------------------------------------------------
  /** Reader loads in the blank states: loading never settles, error and offline fail as if the studio never answered. */
  private async readerGate() {
    if (this.options.state === 'loading') return new Promise<never>(() => {});
    await this.wait(120);
    if (this.unreachable()) throw new Error(MOCK_UNREACHABLE);
  }
  async getIssue(id: string, look: LookId): Promise<IssueView> {
    if(id==='sample-jynxzi-qa')return sampleStoryIssue(id,look);
    await this.readerGate();
    const fixtureId = id.replace(/^sample-/, '');
    const stream = STREAMS.find(entry => entry.fixture.id === fixtureId);
    if (!stream) throw new Error(`There is no issue called “${id}”. It may have been unpublished.`);
    const live = stream.fixture.id === this.snapshot.studio.fixtureId ? this.snapshot.studio.panels : [];
    // Empty: the issue exists but nothing was approved before it was bound.
    const panels = this.options.state === 'empty' ? [] : live.length >= 4 ? live : stream.beats.map((_, index) => this.makePanel(index, stream));
    // Empty: an issue bound with nothing in it has no Sample story either, only a placeholder title.
    if (!panels.length) return { id, title: 'Untitled issue', streamTitle: '', channel: '', panels, sample: true, look };
    return sampleStoryIssue(id, look);
  }
  async listIssues() {
    await this.readerGate();
    return this.options.state === 'empty' ? [] : STREAMS.map(entry => `sample-${entry.fixture.id}`);
  }
  /**
   * The real buildSeries (packages/core) over the Sample issue, so the shape and the chapter and highlight picks match
   * GET /api/series/:id. Sample timing only: chat comes in bursts, so every third beat is followed by a lull of over five minutes,
   * which is what makes buildBook start a new chapter (gap of 300 s or more).
   */
  async getSeries(id: string, look: LookId): Promise<SeriesView> {
    const issue = await this.getIssue(id, look);
    const panels = (issue.storyPanels ?? issue.panels).map((panel, index) => ({ ...panel, at: Math.floor(index / 3) * 600 + (index % 3) * 90 }));
    if (issue.storyPanels) return { id, title: issue.title, sample: true, look, highlightCount: 1, episodes: [{ number: 1, title: issue.title, chapter: 'Chapter 1', highlight: panels[0]!, panels }] };
    return { ...buildSeries(panels, { title: issue.title }), id, sample: true, look };
  }
  exportPagePng(issue: IssueView, page: number | 'cover' | 'back', look: LookId) { return exportIssuePage(issue, page, look); }
  async getCatchup(minutes: number): Promise<CatchupView> {
    await this.readerGate();
    const stream = this.stream();
    if (this.options.state === 'empty') return { channel: '', minutes, panels: [], sample: true };
    const all = this.snapshot.studio.panels.length ? this.snapshot.studio.panels : stream.beats.map((_, index) => this.makePanel(index, stream));
    const keep = Math.max(1, Math.min(all.length, Math.round(minutes / 5)));
    return { channel: stream.fixture.channel, minutes, panels: all.slice(-keep), raidLine: 'Welcome, mapleglitch and 42 raiders! Here’s what you missed.', sample: true };
  }

  dispose() { for (const timer of this.timers) clearInterval(timer); this.timers = []; clearTimeout(this.connectTimer); }
}

// IMPORT-1-WIRE (appended at the end of the file only). Sample data has no Studio server and no Twitch, so a link
// can't be turned into a comic here: both calls reject with plain words, and the card shows them.
export const MOCK_IMPORT_UNAVAILABLE = 'Sample data can’t make comics from links. Start the Studio server to import a Twitch link.';
const mockImportLink: NonNullable<ComicToonsAdapter['importLink']> = async () => { throw new Error(MOCK_IMPORT_UNAVAILABLE); };
const mockAddSeriesChapter: NonNullable<ComicToonsAdapter['addSeriesChapter']> = async () => { throw new Error(MOCK_IMPORT_UNAVAILABLE); };
Object.assign(MockAdapter.prototype, { importLink: mockImportLink, addSeriesChapter: mockAddSeriesChapter });
