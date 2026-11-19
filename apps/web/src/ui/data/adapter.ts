import type { StoryFlowReport } from '@comictoons/core';
/**
 * ComicToons UI data adapter.
 *
 * Every screen in src/ui reads and writes through this ONE interface. Today it is backed by
 * `mock.ts` (timers, no network). Wiring to the server means writing `server.ts` that implements
 * the same interface on top of the existing endpoints; the screens do not change.
 *
 * Shapes mirror apps/web/src/types.ts (Panel, StudioState, Fixture), hooks/useStudio.ts (the
 * snapshot fields) and hooks/useEventStream.ts (named events: 'state', 'stream-event', 'catchup').
 * The comment on each method names the endpoint the server adapter should call.
 */
import { mangaThemes, resolveMangaTheme, type MangaThemeId } from '@comictoons/core';
import type { ChatSourceState, StreamEvent } from '@comictoons/core';
import type { Fixture, Panel, StudioState } from '../../types';

/**
 * One Look for every view (THEMES-4: festival, sunset, lagoon, blossom, festival first and default).
 * `ink`, `noir` and `pop` are legacy ids still accepted as input (data/server.ts and data/mock.ts
 * defaults, stored localStorage values); resolveLook always turns them into one of the four current
 * ids. Each Look renders distinctly (core `lookStyles` and export.ts), all of them in colour.
 * The Look is client state that travels explicitly with every export, recap and PNG action below.
 */
export type LookId = MangaThemeId | 'ink' | 'noir' | 'pop';
export type LookTone = 'bw' | 'colour';
export interface LookInfo { id: LookId; name: string; short: string; tone: LookTone; blurb: string }
export const LOOKS: readonly LookInfo[] = mangaThemes.map((theme) => ({ id: theme.id, name: theme.name, short: theme.short, tone: 'colour', blurb: theme.blurb }));
export const isLook = (value: unknown): value is LookId => LOOKS.some(look => look.id === value);
/** A valid id stays; any legacy or unknown value (including a missing one) resolves to festival. */
export const resolveLook = (value: unknown): MangaThemeId => resolveMangaTheme(value);
/** The connected branch of Connect.tsx shows a "Sample account" badge only for the mock adapter:
 * a real /api/twitch/status connected account on the server adapter is never a sample. */
export const showSampleAccountBadge = (kind: 'mock' | 'server', twitch: TwitchAuth) => kind === 'mock' && twitch.state === 'connected';

/** Where a still came from. Stills only: an inked Twitch clip frame, generated art, or an Ink me cameo. */
export type PanelSource = 'clip' | 'generated' | 'cameo';

/** A studio Panel (types.ts) plus the art facts the UI needs to lay it out without layout shift. */
export interface UiPanel extends Panel {
  art: { lettered?: boolean; replaceBubble?: boolean; bubbleLabel?: string; bubble?: { x: number; y: number; width: number; height: number }; width: number; height: number; tone: 'grey' | 'colour'; atlas?: { columns: number; rows: number; cell: number; rowEdges?: number[]; colEdges?: number[] }; themes?: Partial<Record<LookId, string>> };
  source: PanelSource;
  /** "Chat chose · 52%" when a vote picked the caption. */
  chosenBy?: { votes: number; pct: number };
  cameo?: string;
  /** True when the caption came from the writer, not the streamer. Shown as "Generated caption". */
  generatedCaption: boolean;
}

/** StudioState (types.ts) with the Look and the lists the UI shows. */
export interface UiStudioState extends StudioState {
  look: LookId;
  panels: UiPanel[];
  pendingPanels: UiPanel[];
  /** Panic hide: overlay is blank until the streamer resumes. */
  hidden: boolean;
  budget: { perHour: number; used: number; resetAt?: number };
  source: ChatSourceState;
}

/** Twitch sign-in (proposed GET /api/twitch/status shape from design D1c). */
export interface TwitchAuth {
  state: 'signed-out' | 'connecting' | 'connected' | 'error';
  login?: string;
  /** Get Users broadcaster_type: channel-point rewards, polls and predictions need 'affiliate' or 'partner'. */
  broadcasterType?: 'partner' | 'affiliate' | '';
  error?: string;
}
/** W4: what 'Try again' reports when a re-check finds no sign-in. Connect (purple) is the only way to start a new one. */
export const TWITCH_STILL_SIGNED_OUT = 'Twitch still says you’re not signed in. Connect with Twitch to start a new sign-in.';
export const canUseChannelFeatures = (auth: TwitchAuth) => auth.state === 'connected' && (auth.broadcasterType === 'affiliate' || auth.broadcasterType === 'partner');

/** Mirrors GET /api/participation/status (ParticipationPanel.tsx), trimmed to what the UI shows. */
export interface PollView { id: string; panelId: string; mode: 'twitch' | 'chat'; endsAt: number; total: number; choices: { key: number; caption: string; votes: number }[] }
export interface PredictionView { id: string; title: string; status: 'active' | 'locked' | 'resolved'; endsAt?: number; outcomes: { title: string; users: number; points: number }[]; winner?: string }
export interface Redemption { id: string; name: string; at: number; status: 'queued' | 'drawing' | 'fulfilled' | 'refunded'; note: string }
/**
 * Ink me reward state, field names exactly as GET /api/participation/status `reward` (T3b, report-t3b.md R3).
 * `offReason` and `chatFallback` are only set while `status === 'unavailable'`; `error` then holds the message to show
 * (exactly "Ink me needs an Affiliate or Partner channel" for a normal channel).
 */
export type InkMeStatus = 'idle' | 'creating' | 'ready' | 'unavailable';
export type InkMeOffReason = 'signed-out' | 'not-affiliate' | 'check-failed' | 'create-failed' | 'invalid';
export interface InkMeReward {
  status: InkMeStatus;
  error?: string;
  offReason?: InkMeOffReason;
  chatFallback?: string;
  title: string; cost: number; perViewer: number; cooldownMinutes: number; cooldownEndsAt?: number;
  redemptions: Redemption[];
}
export interface ParticipationStatus {
  poll: PollView | null;
  lastPoll?: { caption: string; voters: number; outcome?:string };
  prediction: PredictionView | null;
  reward: InkMeReward;
  /** How many viewers typed !noink. A count only, like the server: names are never shown, drawn or quoted. */
  optedOut: number;
  rules: { raidCatchup: boolean; previouslyCommand: boolean; modApprove: boolean };
  lastCatchup?: { reason: 'raid' | 'command' | 'manual'; at: number; raider?: string; viewers?: number };
}

/**
 * Mirrors GET /api/participation/eventsub (T3, apps/server/src/eventsub/messages.ts EventSubStatus,
 * plus signedIn). Read-only: no tokens, no session secrets.
 */
export interface EventSubRevocation { type: string; version: string; status: string; at: number }
export interface EventSubStatus {
  state: 'idle' | 'connecting' | 'welcomed' | 'subscribed' | 'reconnecting' | 'stopped';
  signedIn: boolean;
  keepaliveSeconds?: number;
  subscribed: string[];
  failed: { type: string; error: string }[];
  revoked: EventSubRevocation[];
  reconnects: number;
  notifications: number;
  lastError?: string;
}
/** What the Studio chip shows. 'off' means not signed in; 'connecting' covers connecting, welcomed and reconnecting. */
export type EventSubHealth = 'off' | 'connecting' | 'connected' | 'partial' | 'failed' | 'revoked';
/** The 15 subscriptions T3 asks for (EVENTSUB_SUBSCRIPTIONS). Used for "12 of 15" and the per-feature list. */
export const EVENTSUB_TYPES: readonly { type: string; feature: string }[] = [
  { type: 'channel.chat.message', feature: 'Chat' },
  { type: 'channel.chat.message_delete', feature: 'Deleted messages' },
  { type: 'channel.raid', feature: 'Raids' },
  { type: 'channel.cheer', feature: 'Cheers' },
  { type: 'channel.channel_points_custom_reward_redemption.add', feature: 'Ink me redemptions' },
  { type: 'channel.poll.begin', feature: 'Polls' },
  { type: 'channel.poll.progress', feature: 'Polls' },
  { type: 'channel.poll.end', feature: 'Polls' },
  { type: 'channel.prediction.begin', feature: 'Predictions' },
  { type: 'channel.prediction.progress', feature: 'Predictions' },
  { type: 'channel.prediction.lock', feature: 'Predictions' },
  { type: 'channel.prediction.end', feature: 'Predictions' },
  { type: 'channel.hype_train.begin', feature: 'Hype trains' },
  { type: 'channel.hype_train.end', feature: 'Hype trains' },
  { type: 'stream.online', feature: 'Going live' },
];
export const eventSubFeature = (type: string) => EVENTSUB_TYPES.find(entry => entry.type === type)?.feature ?? type;
/** The status as the Studio counts it: only the listed types, so the server's extra stream.offline never reads "16 of 15". */
export function listedEventSubStatus(status: EventSubStatus): EventSubStatus {
  const listed = (type: string) => EVENTSUB_TYPES.some(entry => entry.type === type);
  return { ...status, subscribed: status.subscribed.filter(listed), failed: status.failed.filter(entry => listed(entry.type)) };
}
export function eventSubHealth(status: EventSubStatus): EventSubHealth {
  if (status.revoked.length) return 'revoked';
  if (!status.signedIn) return 'off';
  if (status.state === 'subscribed') return !status.subscribed.length ? 'failed' : status.failed.length ? 'partial' : 'connected';
  if (status.state === 'connecting' || status.state === 'welcomed' || status.state === 'reconnecting') return 'connecting';
  return status.lastError || status.failed.length ? 'failed' : 'off';
}

export interface ChatLine { id: string; at: number; user: string; text: string; kind: 'chat' | 'command' | 'raid' | 'redemption' }

/** The useStudio() return, minus the transport. */
export interface UiSnapshot {
  broadcast?: { id: string; kind: 'panel' | 'vote' | 'vote-result' | 'inkme' | 'prediction' | 'prediction-result' | 'catchup' | 'stream-end'; createdAt: number; title?: string; detail?: string; panelIds?: string[] };
  sampleReplay?: { running: boolean; revealed: number; total: number; runId?:string };
  studio: UiStudioState;
  fixtures: Fixture[];
  loading: boolean;
  offline: boolean;
  error: string;
  busy: string;
  sampleSimulation?: {guided: boolean;paused?: boolean;viewers: number;events: {id:string;text:string;at:number}[];arrival?: {name:string;at:number;panelIds:string[]}};
  sampleReady: boolean;
  twitch: TwitchAuth;
  requestedScopes?: string[];
  participation: ParticipationStatus;
  chat: ChatLine[];
  eventsub: EventSubStatus;
}

/** Named events, as useEventStream delivers them from /api/events and /api/comics/events. */
/** The level and server time of a hype train that just began; nothing else is on the wire. */
export interface HypeSplashEvent { level: number; at: number }
export interface CatchupEvent { reason: 'raid' | 'command' | 'manual'; raider?: string; viewers?: number; panelIds: string[] }
export type UiEvent =
  | { name: 'state'; data: UiStudioState }
  | { name: 'stream-event'; data: StreamEvent }
  | { name: 'catchup'; data: CatchupEvent }
  /** Bus 'eventsub-revoked', forwarded on /api/events and reconciled with polled subscription status. */
  | { name: 'eventsub-revoked'; data: EventSubRevocation }
  /** Bus 'hype-splash' (participation/predictions.ts:58), forwarded on /api/events when a hype train begins. */
  | { name: 'hype-splash'; data: HypeSplashEvent };
export type UiEventName = UiEvent['name'];

/** Reader data (GET /api/recaps/:id, /api/book/:id, /api/series/:id, /api/catchup). `look` is the Look it was asked for. */
export interface IssueView { id: string; title: string; streamTitle: string; channel: string; /** GAP: no issue date on the wire (recap snapshot or series); left out rather than invented. */ date?: string; panels: UiPanel[]; storyPanels?: UiPanel[]; sample: boolean; look: LookId }
/**
 * GET /api/series/:id, field for field: buildSeries(panels, {title}) from packages/core/src/manga.ts plus `id` and `sample`.
 * One episode per chapter of the stream; `highlight` is its peak panel and `panels` up to four neighbours around it.
 * GAP: the wire has no channel, no date and no per-channel list of series, so the UI shows none of them.
 */
export interface SeriesEpisode { number: number; title: string; highlight: UiPanel; panels: UiPanel[]; chapter: string }
export interface SeriesView { id: string; title: string; episodes: SeriesEpisode[]; highlightCount: number; sample: boolean; look: LookId }
export interface CatchupView { channel: string; minutes: number; panels: UiPanel[]; raidLine?: string; sample: boolean }
export type OutputMode = 'book' | 'series' | 'catchup';
export interface BindResult { recapId: string; modes: OutputMode[]; pageCount: number; episodeCount: number; look: LookId }
/** One page PNG, drawn in the Look passed in (never a Look locked at first save). */
export interface PagePng { blob: Blob; filename: string; look: LookId }

// IMPORT-1: make a comic from a Twitch link (POST /api/import) and add it to the channel's manga series.
export interface ImportLinkBody { input: string; chatLog?: string; chatLogFormat?: 'txt' | 'json' }
export interface ImportPanel { id: string; caption: string; imageUrl: string; altText: string; dialogue: string[]; at?: number }
export interface ImportResponse {
  importId?: string; kind: 'vod' | 'clip' | 'live'; channel?: string; title?: string; panels?: ImportPanel[];
  /** Plain words when only part of the source was used, e.g. "Used the first 10 min of a 47 min video." */
  note?: string;
  window?: { vodSeconds: number; usedSeconds: number; capped: boolean; note?: string }; missing?: string[];
}
export interface SavedChapter { number: number; title: string; note?: string }

export interface ComicToonsAdapter {
  readonly kind: 'mock' | 'server';
  /** Current snapshot. Must return the same object until something changes (useSyncExternalStore). */
  getSnapshot(): UiSnapshot;
  subscribe(listener: () => void): () => void;
  /** Same contract as useEventStream(path, onMessage, eventNames). */
  onEvent(names: readonly UiEventName[], handler: (event: UiEvent) => void): () => void;
  refresh(): Promise<void>;                                            // GET /api/state
  /** Clock for countdowns (ms), derived client-side: Date.now() on the server adapter, a fixed Sample clock in the mock. */
  now(): number;

  // Studio
  approve(panelId?: string): Promise<{ undoToken?: string }>;          // POST /api/approve
  approveAll?(): Promise<{ undoToken?: string }>;
  pauseReplay?(): void;
  castSampleVote?(key: number): void;
  redeemSampleInk?(): void;
  castSamplePrediction?(outcome: string): void;
  sendSampleChat?(text: string): void;
  simulateSampleRaid?(): void;
  simulateSampleArrival?(): void;
  startSampleDemo?(fixtureId?: string): Promise<void>;
  resumeSampleDemo?(): void;
  stopSampleDemo?(): void;
  reject(panelId?: string): Promise<{ undoToken?: string }>;           // POST /api/reject
  undo(token: string): Promise<void>;                                  // POST /api/undo
  discardImageRevision?(panelId:string):Promise<void>;
  editCaption(panelId: string, caption: string): Promise<void>;        // POST /api/caption
  setLook(look: LookId): Promise<void>;                                // POST /api/settings {mangaTheme}
  setSpeed(speed: 1 | 10 | 60): Promise<void>;                         // POST /api/settings {speed}
  setApprovalMode(on: boolean): Promise<void>;                         // POST /api/settings {approvalMode}
  replay(fixtureId: string): Promise<void>;                            // POST /api/replay {fixtureId, speed, style}
  useSampleData(): Promise<void>;                                      // POST /api/ingest {mode:'sample'}
  useLiveChat(channel?: string, chatOnly?: boolean): Promise<void>; // Explicit chat-only ingestion does not create panels.
  panicHide(hidden: boolean): Promise<void>;                           // POST /api/stop (hide) / /api/replay (resume)
  /** The current Look travels with the bind: the server must not reuse the Look locked at first save. */
  endStream(title: string, modes: OutputMode[], look: LookId): Promise<BindResult>; // POST /api/end {look}, then /api/comics/:id/title
  saveRecap(look: LookId): Promise<{ recapId: string; look: LookId }>; // POST /api/recaps {look}

  // Twitch sign-in
  connectTwitch(): Promise<void>;                                      // GET /auth/twitch/login (OAuth redirect)
  getEventSub(): Promise<EventSubStatus>;                              // GET /api/participation/eventsub
  cancelConnect(): Promise<void>;
  disconnectTwitch(): Promise<void>;                                   // POST /api/twitch/disconnect
  /** W4: re-reads the sign-in (GET /api/twitch/status) without starting a new OAuth. Behind the ink 'Try again'. */
  checkTwitch(): Promise<void>;
  dismissTwitchError(): void;

  // Audience participation
  startPoll(): Promise<void>;                                          // POST /api/participation/polls
  endPoll(): Promise<void>;                                            // POST /api/participation/polls/end
  startPrediction(): Promise<void>;                                    // GAP: no route. T3b opens one on hype-train begin
  resolvePrediction(winner: string): Promise<void>;                    // GAP: no route. Twitch resolves it; status shows the result
  /** The Ink me toggle. On: POST /api/participation/rewards/connect (T3b enable(), idempotent). Off: POST /api/participation/rewards/disconnect (in flight, T3b R2). */
  setInkMe(on: boolean): Promise<void>;
  resolveRedemption(id: string, action: 'fulfil' | 'cancel'): Promise<void>; // POST /api/participation/redemptions/:id
  playCatchup(): Promise<void>;                                        // POST /api/participation/catchup

  // Readers
  getIssue(id: string, look: LookId): Promise<IssueView>;              // GET /api/recaps/:id?look= (book and series derive from it)
  /** Issues this adapter can open (Series and the Landing shelf). No per-channel list: the server adapter knows the latest saved issue only. */
  listIssues(): Promise<string[]>;
  getSeries(id: string, look: LookId): Promise<SeriesView>;            // GET /api/series/:id (no look on the wire: the Look is applied here)
  /** Page PNG for Recap and Output, in the Look passed in. Drawn client-side (export.ts) by both adapters,
   *  with the speech bubbles and SFX. `page` is a story page index, or the 'cover' or 'back' page of the book. */
  exportPagePng(issue: IssueView, page: number | 'cover' | 'back', look: LookId): Promise<PagePng>;
  getCatchup(minutes: number): Promise<CatchupView>;                   // GET /api/catchup?minutes=

  getStoryFlow?(): Promise<StoryFlowReport>; // GET /api/story-flow, evidence only

  // Make a comic from a link (IMPORT-1). Both reject with the server's error text. Optional, so an adapter
  // without them (a test stub) still type-checks; the card then says the feature isn't available.
  importLink?(body: ImportLinkBody): Promise<ImportResponse>;          // POST /api/import
  addSeriesChapter?(channel: string, body: { importId: string; title?: string }): Promise<{ chapter: SavedChapter }>; // POST /api/channel-series/:channel/chapters
}
