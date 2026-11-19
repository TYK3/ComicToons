import type { StoryFlowReport } from '@comictoons/core';
import { sampleStoryIssue } from './sampleStories';
/**
 * Server adapter: ComicToonsAdapter on the real ComicToons API, same origin (the Vite dev server
 * proxies /api, /auth, /exports and /art to the API port).
 *
 * Endpoints follow the current API, including EventSub and
 * Look on save. Anything with no endpoint is marked GAP and falls back to the mock
 * for that view only. The full contract table is in report-ui1.md.
 *
 * Rules: every WRITE goes through `this.write()`, which takes its auth header from directorHeaders()
 * (data/directorKey.ts) and nowhere else. Screens never import this file; main.tsx chooses the
 * adapter. This is the only file in src/ui that uses the
 * network, and the no-network test excludes it by path.
 */
import type { ChatSourceState, StreamEvent } from '@comictoons/core';
import type { Fixture, Panel, StudioState } from '../../types';
import { exportIssuePage } from '../export';
import { SERVER_RESTARTED, twitchAuthFromStatus, type WireTwitch } from './twitch-status';
import {
  listedEventSubStatus,resolveLook,TWITCH_STILL_SIGNED_OUT,type BindResult,type CatchupView,type ChatLine,type ComicToonsAdapter,type EventSubStatus,type EventSubRevocation,type IssueView,type LookId,type SeriesView,
  type OutputMode, type InkMeOffReason, type InkMeStatus, type ParticipationStatus, type PredictionView, type Redemption, type TwitchAuth, type UiEvent, type UiEventName,
  type UiPanel, type UiSnapshot, type UiStudioState,
} from './adapter';
import type { ImportLinkBody, ImportResponse, SavedChapter } from './adapter';
import { directorHeaders, noteDirectorResponse } from './directorKey';
import { MockAdapter } from './mock';

// ---- wire shapes (HEAD 4b12115; only the fields read here) ---------------------------------------
/** nextUp (UI-LIVE-A): the waiting panel a mod's `!ink yes` or the A key approves next; the server decides (director.ts nextUpFor). */
type WireState = StudioState & { undoToken?: string; nextUp?: string | null };
/** GET /api/participation/status `inkChat` (apps/server/src/participation/ink-chat.ts view()); passed through unchanged. */
export interface WireInkChat {
  active: boolean; text: string; cooldownEndsAt?: number; note: string;
  requests: { id: string; name: string; at: number; status: string; note: string; panelId?: string }[];
}
interface WirePoll { id: string; mode: 'twitch' | 'chat'; panelId: string; endsAt: number; total: number; choices: { key: number; caption: string; votes: number }[] }
interface WirePrediction { id: string; title: string; status: 'ACTIVE' | 'LOCKED' | 'RESOLVED' | 'CANCELED'; outcomes: { id: string; title: string; users: number }[]; winner?: string }
interface WireRedemption { id: string; name: string; at: number; status: 'drafted' | 'queued' | 'fulfilled' | 'canceled'; note: string }
interface WireParticipation {
  flags: { polls?: boolean; inkMe?: boolean; catchup?: boolean; director?: boolean; hype?: boolean };
  budget: { perHour: number; used: number; resetAt?: number };
  poll: WirePoll | null;
  lastPollResult: { outcome?:string; caption: string; voters: number } | null;
  /** T3b adds error, offReason and chatFallback (report-t3b.md R3); the field names are used as they are. */
  reward: { status: InkMeStatus; error?: string; offReason?: InkMeOffReason; chatFallback?: string; title: string; cost: number; maxPerUserPerStream: number; cooldownSeconds: number; cooldownEndsAt?: number; redemptions: WireRedemption[] } | null;
  catchups: { reason: 'raid' | 'command' | 'streamer'; at: number; raider?: string; viewers?: number }[];
  hype: { prediction?: WirePrediction } | null;
  optedOut: number;
  inkChat?: WireInkChat;
}
interface WireEnd { recapUrl: string; shareUrl?: string; pageUrls?: string[] }
/** GET /api/series/:id = buildSeries(panels, {title}) + {id, sample}. */
interface WireSeries { id: string; title: string; sample: boolean; highlightCount: number; episodes: { number: number; title: string; highlight: Panel; panels: Panel[]; chapter: string }[] }
interface WireCatchup { channel: string; minutes: number; panels: Panel[]; sample: boolean; raidLine?: string }

const LOOK_KEY = 'comictoons-ui-look';
/** BUG-1: the server bootId this browser last saw Twitch connected on (no login, no token). */
const TWITCH_BOOT_KEY = 'comictoons-twitch-connected-boot';
const recapIdOf = (url?: string) => url?.match(/\/(?:recap|r)\/([a-z0-9-]+)$/)?.[1];

// ---- connection health (UI-LIVE-A) ---------------------------------------------------------------
/**
 * 'ok' while the API answers; 'lost' as soon as the event stream or a request cannot reach it;
 * 'reconnecting' while the adapter retries GET /api/state. On success it re-reads the state, reopens
 * the event stream and goes back to 'ok', with no page reload.
 * REQUEST (adapter.ts, out of scope): add `connection` to UiSnapshot and ComicToonsAdapter,
 * `inkChat` to ParticipationStatus and `nextUp` to the studio state; until then these local types carry them.
 */
export type Connection = 'ok' | 'lost' | 'reconnecting';
export type ServerParticipation = ParticipationStatus & { inkChat?: WireInkChat };
export type ServerSnapshot = Omit<UiSnapshot, 'studio' | 'participation'> & {
  studio: UiStudioState & { nextUp?: string | null };
  participation: ServerParticipation;
  connection: Connection;
};
const RETRY_MS = 1500;
const UNREACHABLE = 'ComicToons can’t reach the studio server on this computer. Check the window that started the studio is still open.';
const LOST = 'The studio lost its connection. Your approved panels are safe. Reconnecting…';
/** A network failure, or a 5xx with no JSON error (the Vite proxy's answer while the API is down). */
class Unreachable extends Error { constructor(readonly status?: number) { super(UNREACHABLE); } }
const failedMessage = (status: number) => `The studio couldn’t do that (error ${status}). Try again.`;

/** GAP: Panel has no art size or still source. Generated art is square-ish; 4:3 keeps layout stable until the server sends sizes. */
function toUiPanel(panel: Panel): UiPanel {
  const legacy = /panel-story-(tabletop|speedrun|cooking)-(\d+)\.png$/.exec(panel.provenance?.asset ?? panel.imageUrl);
  const fixture = legacy ? ({tabletop: 'tabletop-night', speedrun: 'speedrun-fail', cooking: 'irl-cooking'} as const)[legacy[1] as 'tabletop' | 'speedrun' | 'cooking'] : undefined;
  const replacement = fixture && panel.provenance?.provider === 'library'
    ? sampleStoryIssue(`sample-${fixture}`, 'festival').storyPanels![[0, 5, 8, 15, 16, 19][Number(legacy![2])] ?? 0]
    : undefined;
  return {
    ...panel,
    imageUrl: replacement?.imageUrl ?? panel.imageUrl,
    art: panel.provenance?.provider.startsWith('scene-')?{width:1024,height:1536,tone:'colour',lettered:true}:replacement?.art ?? (/^panel-\d\d-.*\.webp$/.test(panel.provenance?.asset ?? '')
      ? { width: 1280, height: 720, tone: 'colour' } : { width: 1024, height: 768, tone: 'colour' }),
    source: panel.provenance?.provider === 'clip' ? 'clip' : 'generated',
    generatedCaption: !panel.releaseBlocked,
  };
}

const SAMPLE_SOURCE: ChatSourceState = { requested: 'sample', active: 'sample', connection: 'sample', simulated: false, received: 0 };
const OFF_EVENTSUB: EventSubStatus = { state: 'idle', signedIn: false, subscribed: [], failed: [], revoked: [], reconnects: 0, notifications: 0 };
const EMPTY_PARTICIPATION: ParticipationStatus = {
  poll: null, prediction: null, optedOut: 0,
  reward: { title: 'Ink me into the comic', cost: 500, perViewer: 1, cooldownMinutes: 5, status: 'idle', redemptions: [] },
  rules: { raidCatchup: false, previouslyCommand: false, modApprove: false },
};

export class ServerAdapter implements ComicToonsAdapter {
  readonly kind = 'server' as const;
  /** Mock fallback for GAP views only (Sample issues on Landing, Series with no saved issue). */
  private fallback = new MockAdapter({ freeze: true });
  private snapshot: ServerSnapshot;
  private listeners = new Set<() => void>();
  private eventHandlers = new Set<{ names: readonly UiEventName[]; handler: (event: UiEvent) => void }>();
  private source?: EventSource;
  private timers: ReturnType<typeof setInterval>[] = [];
  private look: LookId;
  private connecting = false;
  /** A server-side sign-out reason Young dismissed, so the 15 s status poll does not bring the banner back. */
  private dismissedTwitchReason?: string;
  /** BUG-1: the server bootId Twitch was last connected on, so a reasonless sign-out on a new one means a restart. */
  private twitchConnectedBoot?: string;
  private disposed = false;
  private retry?: ReturnType<typeof setTimeout>;
  /** The first GET /api/state attempt, so the shelf can wait for it instead of answering from the mock. */
  private firstLoad: Promise<void>;
  private revokedSeen=new Set<string>();
  private noteRevocation(data:EventSubRevocation){
    const key=JSON.stringify(data);if(this.revokedSeen.has(key))return;
    this.revokedSeen.add(key);if(this.revokedSeen.size>256)this.revokedSeen.delete(this.revokedSeen.values().next().value!);
    this.emit({name:'eventsub-revoked',data});
  }
  private predictionOutcomes: WirePrediction['outcomes'] = [];
  private budget: UiStudioState['budget'] = { perHour: 12, used: 0 };

  constructor() {
    let stored: string | null = null;
    try { stored = localStorage.getItem(LOOK_KEY); } catch { /* private mode */ }
    this.look = resolveLook(stored);
    try { this.twitchConnectedBoot = localStorage.getItem(TWITCH_BOOT_KEY) ?? undefined; } catch { /* private mode */ }
    // #7: nothing from the mock while loading: no Sample titles, recap links or status.
    this.snapshot = {
      studio: { status: 'idle', fixtureId: 'tabletop-night', speed: 60, style: 'risograph', approvalMode: true, panels: [], pendingPanels: [], streamTitle: '', issueTitle: '', elapsed: 0, duration: 0, nextUp: null,
        look: this.look, hidden: false, source: SAMPLE_SOURCE, budget: this.budget },
      fixtures: [], loading: true, offline: false, error: '', busy: '', sampleReady: false, connection: 'ok',
      twitch: { state: 'signed-out' }, participation: EMPTY_PARTICIPATION, chat: [], eventsub: OFF_EVENTSUB,
    };
    let loaded: () => void = () => undefined;
    this.firstLoad = new Promise(resolve => { loaded = resolve; });
    void this.boot(loaded);
  }
  get connection(): Connection { return this.snapshot.connection; }

  // ---- transport ------------------------------------------------------------------------------
  private async read<T>(path: string): Promise<T> {
    const response = await this.reach(() => fetch(path, { headers: { accept: 'application/json' } }));
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw this.failure(response.status, body.error);
    return body;
  }
  /** A fetch that cannot reach the API marks the connection lost (#1) and throws a plain message (#9). */
  private async reach(request: () => Promise<Response>) {
    try { return await request(); } catch { this.lost(); throw new Unreachable(); }
  }
  private failure(status: number, error?: string) {
    if (error) return Object.assign(new Error(error), { status });
    if (status >= 500) { this.lost(); return new Unreachable(status); }
    return Object.assign(new Error(failedMessage(status)), { status });
  }
  /** Every write. The director key header comes only from directorHeaders(). */
  private async write<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.reach(() => fetch(path, {
      method: 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...directorHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    noteDirectorResponse(response.status, path);
    const json = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw this.failure(response.status, json.error);
    return json;
  }

  private async boot(loaded: () => void) {
    await Promise.allSettled([this.refresh().finally(loaded), this.loadFixtures(), this.loadTwitch(), this.loadParticipation(), this.getEventSub()]);
    if (this.disposed) return;
    if (this.snapshot.connection === 'ok') this.listen();
    // #3: polls run only while connected, and every poll handles its own failure.
    this.timers.push(setInterval(() => { if (this.snapshot.connection === 'ok') { this.quietly(this.loadParticipation()); this.quietly(this.getEventSub()); } }, 5000));
    this.timers.push(setInterval(() => { if (this.snapshot.connection === 'ok') this.quietly(this.loadTwitch()); }, 15000));
    // Re-render countdowns once a second (now() is Date.now()).
    this.timers.push(setInterval(() => this.set({}), 1000));
  }
  /** Background work: a failure already shows as the connection state or the next poll, never as an unhandled rejection. */
  private quietly(work: Promise<unknown>) { work.catch(() => undefined); }
  /** #1/#6: the API went away. Close the stream, say so, and start retrying. A first load that never connected keeps its own message. */
  private lost() {
    if (this.disposed || this.snapshot.connection !== 'ok') return;
    this.source?.close();
    this.source = undefined;
    this.set({ connection: 'lost', offline: true, loading: false, error: this.snapshot.sampleReady ? LOST : UNREACHABLE });
    this.scheduleReconnect();
  }
  private scheduleReconnect() {
    if (this.disposed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.reconnect(); }, RETRY_MS);
  }
  private async reconnect() {
    if (this.disposed || this.snapshot.connection === 'ok') return;
    if (this.snapshot.connection !== 'reconnecting') this.set({ connection: 'reconnecting' });
    await this.refresh();
    if (this.connection !== 'ok') this.scheduleReconnect();
  }
  /** Back after a loss: the state was just re-read; reopen the stream and catch up everything else. */
  private resume() {
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    this.listen();
    this.quietly(this.loadFixtures());
    this.quietly(this.loadTwitch());
    this.quietly(this.loadParticipation());
    this.quietly(this.getEventSub());
  }
  private listen() {
    if (typeof EventSource === 'undefined' || this.disposed) return;
    this.source?.close();
    const source = new EventSource('/api/events');
    this.source = source;
    source.addEventListener('state', event => this.applyState(JSON.parse((event as MessageEvent).data) as WireState));
    source.addEventListener('stream-event', event => this.onStreamEvent(JSON.parse((event as MessageEvent).data) as StreamEvent));
    source.addEventListener('catchup', event => {
      const data = JSON.parse((event as MessageEvent).data) as WireCatchup;
      this.emit({ name: 'catchup', data: { reason: data.raidLine ? 'raid' : 'manual', panelIds: data.panels.map(panel => panel.id) } });
    });
    // HYPE-SPLASH: the level and time from the bus event, nothing more. A malformed frame is dropped.
    source.addEventListener('hype-splash', event => {
      const data = JSON.parse((event as MessageEvent).data) as { level?: unknown; at?: unknown };
      if (typeof data.level !== 'number' || !Number.isInteger(data.level) || data.level < 1 || typeof data.at !== 'number' || !Number.isFinite(data.at)) return;
      this.emit({ name: 'hype-splash', data: { level: data.level, at: data.at } });
    });
    source.addEventListener('eventsub-revoked',event=>{
      const data=JSON.parse((event as MessageEvent).data) as import('./adapter').EventSubRevocation;
      this.noteRevocation(data);
      this.quietly(this.getEventSub());
      // BANNERS (queue line 23): a revocation usually means the sign-in went; read it now, not on the 15 s poll.
      this.quietly(this.loadTwitch());
    });
    // #1: a browser EventSource that gets a 500 from the proxy closes for good, so any stream error hands over to the adapter's own retry.
    source.onerror = () => { if (this.source === source) this.lost(); };
  }

  // ---- store plumbing -------------------------------------------------------------------------
  getSnapshot = (): ServerSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onEvent(names: readonly UiEventName[], handler: (event: UiEvent) => void) {
    const entry = { names, handler };
    this.eventHandlers.add(entry);
    return () => { this.eventHandlers.delete(entry); };
  }
  private emit(event: UiEvent) { for (const entry of this.eventHandlers) if (entry.names.includes(event.name)) entry.handler(event); }
  private set(next: Partial<ServerSnapshot>) { this.snapshot = { ...this.snapshot, ...next }; for (const listener of this.listeners) listener(); }
  private patchStudio(next: Partial<UiStudioState>) { this.set({ studio: { ...this.snapshot.studio, ...next } }); this.emit({ name: 'state', data: this.snapshot.studio }); }
  private applyState(state: WireState) {
    if (state.source?.channel !== this.snapshot.studio.source.channel || state.source?.requested !== this.snapshot.studio.source.requested) this.set({chat: []});
    this.patchStudio({
      ...state, look: this.look, hidden: state.overlayHidden??false, budget: this.budget, source: state.source ?? SAMPLE_SOURCE,
      panels: state.panels.map(toUiPanel), pendingPanels: state.pendingPanels.map(toUiPanel),
    });
  }
  private async busyWhile<T>(label: string, work: () => Promise<T>): Promise<T> {
    this.set({ busy: label });
    try { return await work(); } finally { this.set({ busy: '' }); }
  }
  now() { return Date.now(); }

  // ---- reads ----------------------------------------------------------------------------------
  async refresh() {
    try {
      this.applyState(await this.read<WireState>('/api/state'));
      const wasDown = this.snapshot.connection !== 'ok';
      this.set({ loading: false, offline: false, error: '', sampleReady: true, connection: 'ok' });
      if (wasDown) this.resume();
    } catch (cause) {
      // Unreachable: lost() has already set the connection, offline flag and message.
      if (cause instanceof Unreachable) { this.set({ loading: false }); return; }
      this.set({ loading: false, offline: true, error: cause instanceof Error ? cause.message : UNREACHABLE });
    }
  }
  private async loadFixtures() { this.set({ fixtures: await this.read<Fixture[]>('/api/fixtures') }); }
  private async loadTwitch() {
    const status = await this.read<WireTwitch>('/api/twitch/status');
    if (this.connecting && !status.connected) return;
    this.connecting = false;
    if (status.connected) this.dismissedTwitchReason = undefined;
    const twitch: TwitchAuth = twitchAuthFromStatus(status, this.dismissedTwitchReason, this.twitchConnectedBoot);
    if (status.connected && status.bootId) this.rememberTwitchBoot(status.bootId);
    else if (status.reason) this.rememberTwitchBoot(undefined);
    this.set({ twitch,requestedScopes:status.requestedScopes });
  }
  private async loadParticipation() {
    const wire = await this.read<WireParticipation>('/api/participation/status');
    this.budget = { perHour: wire.budget.perHour, used: wire.budget.used, resetAt: wire.budget.resetAt };
    const reward = wire.reward;
    const prediction = wire.hype?.prediction;
    const redemptionStatus: Record<WireRedemption['status'], Redemption['status']> = { drafted: 'drawing', queued: 'queued', fulfilled: 'fulfilled', canceled: 'refunded' };
    const predictionStatus: Record<WirePrediction['status'], PredictionView['status']> = { ACTIVE: 'active', LOCKED: 'locked', RESOLVED: 'resolved', CANCELED: 'resolved' };
    const last = wire.catchups[0];
    const participation: ServerParticipation = {
      poll: wire.poll ? { id: wire.poll.id, panelId: wire.poll.panelId, mode: wire.poll.mode, endsAt: wire.poll.endsAt, total: wire.poll.total, choices: wire.poll.choices.map(({ key, caption, votes }) => ({ key, caption, votes })) } : null,
      lastPoll: wire.lastPollResult ? { caption: wire.lastPollResult.caption, voters: wire.lastPollResult.voters, outcome:wire.lastPollResult.outcome } : undefined,
      // GAP: points per outcome and the lock time are not in the status.
      prediction: prediction ? { id: prediction.id, title: prediction.title, status: predictionStatus[prediction.status], winner: prediction.outcomes.find(outcome => outcome.id === prediction.winner)?.title ?? prediction.winner, outcomes: prediction.outcomes.map(outcome => ({ title: outcome.title, users: outcome.users, points: 0 })) } : null,
      reward: reward ? {
        status: reward.status, error: reward.error, offReason: reward.offReason, chatFallback: reward.chatFallback,
        title: reward.title, cost: reward.cost, perViewer: reward.maxPerUserPerStream, cooldownMinutes: Math.round(reward.cooldownSeconds / 60), cooldownEndsAt: reward.cooldownEndsAt,
        redemptions: reward.redemptions.map(entry => ({ id: entry.id, name: entry.name, at: entry.at, note: entry.note, status: redemptionStatus[entry.status] })),
      } : EMPTY_PARTICIPATION.reward,
      optedOut: wire.optedOut,
      rules: { raidCatchup: !!wire.flags.catchup, previouslyCommand: !!wire.flags.catchup, modApprove: !!wire.flags.director },
      lastCatchup: last ? { reason: last.reason === 'streamer' ? 'manual' : last.reason, at: last.at, raider: last.raider, viewers: last.viewers } : undefined,
      // UI-LIVE-A: chat Ink me (active, text, requests, cooldown, note) exactly as the server sends it.
      ...(wire.inkChat ? { inkChat: wire.inkChat } : {}),
    };
    this.set({ participation });
    this.predictionOutcomes = prediction?.outcomes ?? [];

  }
  /** In flight (T3): GET /api/participation/eventsub. A 404 before T3 lands reads as 'off'. New revocations become 'eventsub-revoked' events. */
  async getStoryFlow(): Promise<StoryFlowReport> { return this.read('/api/story-flow'); }
  async getEventSub(): Promise<EventSubStatus> {
    let next: EventSubStatus;
    try { next = await this.read<EventSubStatus>('/api/participation/eventsub'); }
    catch (cause) { if ((cause as { status?: number }).status !== 404) throw cause; next = OFF_EVENTSUB; }
    // LIVE-FIX-2: count only the Studio's listed types (the server also subscribes to stream.offline), never "16 of 15".
    next = listedEventSubStatus(next);
    const seen = this.snapshot.eventsub.revoked.length;
    const wasSignedIn = this.snapshot.eventsub.signedIn;
    this.set({ eventsub: next });
    // BANNERS (queue line 23, report-live-fix-1.md REQUEST 2): when EventSub sees the sign-in drop while the
    // Twitch line still says Connected, refresh it now instead of waiting up to 15 s for the loadTwitch poll.
    if (wasSignedIn && !next.signedIn) void this.loadTwitch().catch(() => undefined);
    for (const revocation of next.revoked.slice(seen)) this.noteRevocation(revocation);
    return next;
  }
  private onStreamEvent(event: StreamEvent) {
    const wire = event as StreamEvent & { user?: string; name?: string; text?: string; id?: string };
    if (event.type !== 'chat' && event.type !== 'raid' && event.type !== 'redemption') { this.emit({ name: 'stream-event', data: event }); return; }
    const text = wire.text ?? (event.type === 'raid' ? 'raided the channel' : 'redeemed Ink me');
    const line: ChatLine = { id: wire.id ?? `line-${Date.now()}`, at: Date.now(), user: wire.name ?? wire.user ?? 'viewer', text, kind: event.type === 'chat' ? (text.startsWith('!') ? 'command' : 'chat') : event.type };
    this.set({ chat: [...this.snapshot.chat.slice(-11), line] });
    this.emit({ name: 'stream-event', data: event });
  }

  // ---- studio writes --------------------------------------------------------------------------
  async approve(panelId?: string) { const state = await this.busyWhile('approve', () => this.write<WireState>('/api/approve', { panelId })); this.applyState(state); return { undoToken: state.undoToken }; }
  async approveAll(){const state=await this.busyWhile('approve-all',()=>this.write<WireState>('/api/approve',{all:true}));this.applyState(state);return {undoToken:state.undoToken};}
  async reject(panelId?: string) { const state = await this.busyWhile('reject', () => this.write<WireState>('/api/reject', { panelId })); this.applyState(state); return { undoToken: state.undoToken }; }
  async undo(token: string) { this.applyState(await this.write<WireState>('/api/undo', { token })); }
  // IMPORT-1: a Twitch link to a comic, and a chapter in the channel's manga series. Plain writes: the director key comes from write().
  importLink(body: ImportLinkBody) { return this.write<ImportResponse>('/api/import', body); }
  addSeriesChapter(channel: string, body: { importId: string; title?: string }) {
    return this.write<{ chapter: SavedChapter }>(`/api/channel-series/${encodeURIComponent(channel)}/chapters`, body);
  }
  /** Exists for waiting panels only: the server answers 409 for a panel already on air (GAP for on-air edits). */
  async discardImageRevision(panelId:string){this.applyState(await this.write<WireState>('/api/caption/revision/discard',{panelId}));}
  async editCaption(panelId: string, caption: string) { this.applyState(await this.busyWhile('caption', () => this.write<WireState>('/api/caption', { panelId, caption }))); }
  /** The Look is client state; every pick is also saved server-side via mangaTheme, for all 4 Looks. */
  async setLook(look: LookId) {
    this.look = look;
    try { localStorage.setItem(LOOK_KEY, look); } catch { /* this tab only */ }
    this.patchStudio({ look });
    await this.write('/api/settings', { mangaTheme: look }).catch(() => undefined);
  }
  async setSpeed(speed: 1 | 10 | 60) { this.applyState(await this.write<WireState>('/api/settings', { speed })); }
  async setApprovalMode(on: boolean) { this.applyState(await this.write<WireState>('/api/settings', { approvalMode: on })); }
  async replay(fixtureId: string) {
    const { speed } = this.snapshot.studio;
    this.applyState(await this.busyWhile('replay', () => this.write<WireState>('/api/replay', { fixtureId, speed, style: this.look === 'noir' ? 'noir' : 'risograph' })));
  }
  async useSampleData() { this.applyState(await this.write<WireState>('/api/ingest', { mode: 'sample' })); }
  async useLiveChat(selectedChannel?: string, chatOnly = false) {
    const channel = selectedChannel ?? (this.snapshot.studio.source.requested === 'twitch' ? this.snapshot.studio.source.channel : undefined) ?? this.snapshot.twitch.login;
    const state=await this.write<WireState>('/api/ingest',{mode:'twitch',...(channel?{channel,fresh:!!selectedChannel}:{}),...(chatOnly?{chatOnly:true}:{})});
    try{if(channel)sessionStorage.setItem('comictoons-studio-live-channel-v1',channel);}catch{/* this window */}
    this.set({chat:[]});this.applyState(state);
  }
  async panicHide(hidden: boolean) { this.applyState(await this.write<WireState>('/api/hide',{hidden})); }
  async endStream(title: string, modes: OutputMode[], look: LookId): Promise<BindResult> {
    return this.busyWhile('end', async () => {
      const panels = this.snapshot.studio.panels.length;
      // In flight (a build lane): the server reads `look` here instead of the Look locked at first save.
      const end = await this.write<WireEnd>('/api/end', { look });
      const recapId = recapIdOf(end.recapUrl) ?? '';
      if (recapId && title.trim()) await this.write(`/api/comics/${recapId}/title`, { title: title.trim() });
      await this.refresh();
      return { recapId, modes, pageCount: end.pageUrls?.length ?? Math.max(1, Math.ceil(panels / 4)), episodeCount: panels, look };
    });
  }
  async saveRecap(look: LookId) {
    // In flight (a build lane): `look` on POST /api/recaps.
    const saved = await this.busyWhile('save', () => this.write<WireState>('/api/recaps', { look }));
    return { recapId: recapIdOf(saved.recapUrl) ?? '', look };
  }

  // ---- Twitch sign-in -------------------------------------------------------------------------
  async connectTwitch() {
    this.connecting = true;
    this.set({ twitch: { state: 'connecting' } });
    // Local-only OAuth start (403 from another device). The callback returns to ui.html#/connect?twitch=….
    window.location.assign('/auth/twitch/login');
  }
  async cancelConnect() { this.connecting = false; this.set({ twitch: { state: 'signed-out' } }); }
  async disconnectTwitch() { await this.write('/api/twitch/disconnect'); this.connecting = false; await this.loadTwitch(); await this.getEventSub().catch(() => undefined); }
  async checkTwitch() {
    await this.busyWhile('twitch-check', async () => {
      await this.loadTwitch();
      if (this.snapshot.twitch.state === 'signed-out') this.set({ twitch: { state: 'error', error: TWITCH_STILL_SIGNED_OUT } });
    });
  }
  private rememberTwitchBoot(bootId: string | undefined) {
    if (this.twitchConnectedBoot === bootId) return;
    this.twitchConnectedBoot = bootId;
    try { if (bootId) localStorage.setItem(TWITCH_BOOT_KEY, bootId); else localStorage.removeItem(TWITCH_BOOT_KEY); } catch { /* this tab only */ }
  }
  dismissTwitchError() { const current = this.snapshot.twitch; if (current.state === 'error') this.dismissedTwitchReason = current.error; if (current.state === 'error' && current.error === SERVER_RESTARTED) this.rememberTwitchBoot(undefined); this.set({ twitch: { state: 'signed-out' } }); }

  // ---- participation --------------------------------------------------------------------------
  async startPoll() { await this.write('/api/participation/polls', {}); await this.loadParticipation(); }
  async endPoll() { await this.write('/api/participation/polls/end'); await this.loadParticipation(); }
  async startPrediction() { await this.write('/api/participation/predictions/start',{});await this.loadParticipation(); }
  /** In flight (T3b R2): POST /api/participation/predictions/resolve {outcomeId}. The UI passes the outcome title; the id comes from the last status. */
  async resolvePrediction(winner: string) {
    const outcome = this.predictionOutcomes.find(entry => entry.title === winner || entry.id === winner);
    if (!outcome) throw new Error('That outcome is no longer open.');
    await this.write('/api/participation/predictions/resolve', { outcomeId: outcome.id }); await this.loadParticipation();
  }
  /** On: POST /api/participation/rewards/connect (T3b enable(), never throws; the status carries error/offReason/chatFallback).
   *  Off: POST /api/participation/rewards/disconnect (in flight, T3b R2). Before R2 lands, a 404 leaves the reward on and says so. */
  async setInkMe(on: boolean) {
    try { await this.write(on ? '/api/participation/rewards/connect' : '/api/participation/rewards/disconnect'); }
    finally { await this.loadParticipation(); }
  }
  async resolveRedemption(id: string, action: 'fulfil' | 'cancel') { await this.write(`/api/participation/redemptions/${encodeURIComponent(id)}`, { action }); await this.loadParticipation(); }
  async playCatchup() { await this.write('/api/participation/catchup'); await this.loadParticipation(); }

  // ---- readers --------------------------------------------------------------------------------
  /** GET /api/recaps/:id?look=. The server resolves the query to the snapshot's mangaTheme, so the
   * Look shown is the one the server validated, not just whatever the caller asked for. Sample ids
   * fall back to the mock. */
  async getIssue(id: string, look: LookId): Promise<IssueView> {
    if (id.startsWith('sample-')) return this.fallback.getIssue(id, look);
    const snapshot = await this.read<StudioState>(`/api/recaps/${encodeURIComponent(id)}?look=${look}`);
    const resolvedLook = (snapshot.mangaTheme ?? look) as LookId;
    const channel = snapshot.source?.channel || this.snapshot.twitch.login || 'your_channel';
    // GAP: the saved snapshot has no date, so `date` stays unset and the UI shows none.
    return { id, title: snapshot.issueTitle, streamTitle: snapshot.streamTitle, channel, panels: snapshot.panels.map(toUiPanel), sample: snapshot.fixtureId !== 'twitch', look: resolvedLook };
  }
  /** No per-channel issue list: the latest saved issue only, else the Sample issues (mock fallback, labelled Sample).
   *  #5: waits for the studio's first answer (the shelf shows loading) and throws when it never answered (the shelf shows an error). */
  async listIssues() {
    await this.firstLoad;
    if (!this.snapshot.sampleReady) throw new Error(this.snapshot.error || UNREACHABLE);
    const { recapUrl, latestRecapUrl } = this.snapshot.studio;
    const ids = [...new Set([recapIdOf(latestRecapUrl), recapIdOf(recapUrl)].filter((id): id is string => !!id))];
    return ids.length ? ids : this.fallback.listIssues();
  }
  async getSeries(id: string, look: LookId): Promise<SeriesView> {
    if (id.startsWith('sample-')) return this.fallback.getSeries(id, look);
    const wire = await this.read<WireSeries>(`/api/series/${encodeURIComponent(id)}`);
    const episodes = wire.episodes.map(episode => ({ ...episode, highlight: toUiPanel(episode.highlight), panels: episode.panels.map(toUiPanel) }));
    return { id: wire.id, title: wire.title, episodes, highlightCount: wire.highlightCount, sample: wire.sample, look };
  }
  async getCatchup(minutes: number): Promise<CatchupView> {
    const wire = await this.read<WireCatchup>(`/api/catchup?minutes=${minutes}`);
    return { channel: wire.channel, minutes: wire.minutes, panels: wire.panels.map(toUiPanel), raidLine: wire.raidLine, sample: wire.sample };
  }
  exportPagePng(issue: IssueView, page: number | 'cover' | 'back', look: LookId) { return exportIssuePage(issue, page, look); }

  dispose() { this.disposed = true; if (this.retry) clearTimeout(this.retry); this.retry = undefined; this.source?.close(); this.source = undefined; for (const timer of this.timers) clearInterval(timer); this.timers = []; this.fallback.dispose(); }
}
