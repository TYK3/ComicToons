import {safeText,type ComicPanel,type EventBus,type ComicToonsBusEvents} from '@comictoons/core';
import {fitText,type OptOutLedger,type ParticipationEvent,type StudioLike} from './commands.ts';
import {INK_ME_AFFILIATE_MESSAGE,TwitchApiError,TwitchForbiddenError,TwitchSignedOutError} from '../twitch-api/errors.ts';

// Lead decision: 500 points, 1 per viewer per stream, 5-minute global cooldown. The name is a placeholder (GAP).
export const INK_ME = { title: 'Ink me', cost: 500, maxPerUserPerStream: 1, globalCooldownSeconds: 300, prompt: 'Become a manga panel. Only people who redeem are drawn in.' } as const;
// Twitch Create Custom Rewards limits (dev.twitch.tv API reference, checked 30 Oct 2026).
export const REWARD_LIMITS = { titleMax: 45, costMin: 1, promptMax: 200, cooldownMin: 1, cooldownMax: 604_800 } as const;

export interface RewardInput { title: string; cost: number; prompt: string; isMaxPerUserPerStreamEnabled: boolean; maxPerUserPerStream: number; isGlobalCooldownEnabled: boolean; globalCooldownSeconds: number }
export function inkMeReward(): RewardInput {
  return { title: INK_ME.title, cost: INK_ME.cost, prompt: INK_ME.prompt, isMaxPerUserPerStreamEnabled: true, maxPerUserPerStream: INK_ME.maxPerUserPerStream, isGlobalCooldownEnabled: true, globalCooldownSeconds: INK_ME.globalCooldownSeconds };
}
export function validateReward(input: RewardInput): string[] {
  const errors: string[] = [];
  if (!input.title.trim() || input.title.length > REWARD_LIMITS.titleMax) errors.push(`The reward title must be 1 to ${REWARD_LIMITS.titleMax} characters.`);
  if (!Number.isInteger(input.cost) || input.cost < REWARD_LIMITS.costMin) errors.push('The reward must cost at least 1 point.');
  if (input.prompt.length > REWARD_LIMITS.promptMax) errors.push(`The prompt must be ${REWARD_LIMITS.promptMax} characters or fewer.`);
  if (input.isMaxPerUserPerStreamEnabled && (!Number.isInteger(input.maxPerUserPerStream) || input.maxPerUserPerStream < 1)) errors.push('The per-viewer limit must be at least 1.');
  if (input.isGlobalCooldownEnabled && (!Number.isInteger(input.globalCooldownSeconds) || input.globalCooldownSeconds < REWARD_LIMITS.cooldownMin || input.globalCooldownSeconds > REWARD_LIMITS.cooldownMax)) errors.push('The cooldown must be 1 to 604800 seconds.');
  return errors;
}

/** Custom rewards through the Helix client (channel:manage:redemptions). Throws on 403 for non-Affiliates. */
export interface HelixRewards {
  createCustomReward(input: RewardInput): Promise<{ id: string }>;
  updateRedemptionStatus(input: { rewardId: string; redemptionIds: string[]; status: 'FULFILLED' | 'CANCELED' }): Promise<void>;
  /** Live only (Get Users). '' is a normal channel with no channel points; undefined means not checked (the fake). */
  getBroadcasterType?(): Promise<'affiliate' | 'partner' | '' | undefined>;
  /** Live only: a reward this app already manages with that title (reused after a restart). */
  findCustomReward?(title: string): Promise<{ id: string } | undefined>;
  /** Live only: pauses the reward while it has to be kept for refunds, and unpauses it when Ink me is back on. */
  updateCustomReward?(input: { rewardId: string; isPaused?: boolean }): Promise<void>;
  /** Live only: removes the reward when the streamer turns Ink me off. */
  deleteCustomReward?(input: { rewardId: string }): Promise<void>;
}

/** Why Ink me is off. `not-affiliate` always carries INK_ME_AFFILIATE_MESSAGE. */
export type InkMeOffReason = 'signed-out' | 'not-affiliate' | 'check-failed' | 'create-failed' | 'invalid' | 'refund-failed';
/** What still works without channel points; shown next to the off message. */
export const INK_ME_CHAT_FALLBACK = 'Chat commands still work: moderators approve or reject panels with !ink yes / !ink no, and viewers vote with !1, !2 or !3.';

/** Rolling one-hour panel budget (lead decision: 12 per hour). */
export class PanelBudget {
  private taken: number[] = [];
  constructor(readonly perHour: number, private now: () => number) {}
  private prune() { const cutoff = this.now() - 3_600_000; this.taken = this.taken.filter(at => at > cutoff); }
  used() { this.prune(); return this.taken.length; }
  remaining() { return Math.max(0, this.perHour - this.used()); }
  exhausted() { return this.remaining() === 0; }
  take(): boolean { if (this.exhausted()) return false; this.taken.push(this.now()); return true; }
  /** When the oldest panel in the window drops out, or undefined if there is room now. */
  resetAt(): number | undefined { this.prune(); return this.exhausted() ? this.taken[0]! + 3_600_000 : undefined; }
  view() { return { perHour: this.perHour, used: this.used(), remaining: this.remaining(), resetAt: this.resetAt() }; }
}

export type RedemptionStatus = 'drafted' | 'queued' | 'fulfilled' | 'canceled';
export interface Redemption { id: string; user?: string; name: string; login: string; at: number; status: RedemptionStatus; panelId?: string; note: string }

/** Update Redemption Status accepts at most 50 ids per call (https://dev.twitch.tv/docs/api/reference/#update-redemption-status). */
export const REDEMPTION_BATCH_MAX = 50;

const CAMEO_ART = ['panel-story-tabletop-1.png', 'panel-story-tabletop-3.png', 'panel-story-tabletop-5.png'];

/**
 * The "Ink me" channel-point reward: create on connect, draft a named cameo for each accepted
 * redemption, then fulfil or cancel (refund). Twitch enforces the per-viewer and cooldown limits;
 * they are checked here too so a mocked or replayed event can never draw someone twice.
 */
export class InkMeRewards {
  status: 'idle' | 'creating' | 'ready' | 'unavailable' = 'idle';
  rewardId?: string;
  error?: string;
  /** Set whenever status is 'unavailable'. */
  offReason?: InkMeOffReason;
  readonly redemptions: Redemption[] = [];
  private enabling?: Promise<void>;
  private settling = new Set<string>();
  /** UNFULFILLED redemption ids on Twitch, per reward id; kept apart from the 50-entry display list. */
  private pending = new Map<string, Set<string>>();
  /** The streamer turned Ink me off but the reward had to be kept because refunds failed. */
  private offRequested = false;
  private finishingOff = false;
  private paused = false;
  private lastAccepted = -Infinity;
  private redeemedThisStream = new Set<string>();
  /** Where failures are reported (never with tokens: messages come from Twitch's `message` field). */
  log: (message: string) => void = message => this.deps.log?.(message);
  constructor(private deps: { studio: StudioLike; optOuts: OptOutLedger; bus: EventBus<ComicToonsBusEvents>; now: () => number; budget: PanelBudget; helix?: HelixRewards | null; recentLine?: (user?: string) => string | undefined; log?: (message: string) => void }) {}
  /** Kept for the existing `twitch-connected` hook and route: same as enable(). The route passes `recheck` (LIVE-FIX-1b). */
  async connect(options: { recheck?: boolean } = {}): Promise<void> { return this.enable(options); }
  /**
   * The streamer turned Ink me on. Idempotent: a live reward id is reused, a reward this app already
   * manages on Twitch is found and reused, and only otherwise is one created. Checks broadcaster_type
   * first: a normal channel ('') never calls Create Custom Rewards. Never throws; failures leave Ink me
   * off with a message and the chat-command fallback.
   */
  async enable(options: { recheck?: boolean } = {}): Promise<void> {
    if (this.enabling) return this.enabling;
    // LIVE-FIX-1b: a streamer's press (`recheck`) on a ready reward still asks Twitch for the channel type
    // (Get Users, a read), so a lost sign-in is found now and the Studio leaves Live, instead of "ready".
    if (this.status === 'ready' && this.rewardId && !options.recheck) return;
    this.enabling = this.doEnable().finally(() => { this.enabling = undefined; });
    return this.enabling;
  }
  private off(reason: InkMeOffReason, message: string) { this.status = 'unavailable'; this.offReason = reason; this.error = message; }
  private async doEnable(): Promise<void> {
    const helix = this.deps.helix;
    this.offRequested = false;
    if (!helix) return this.off('signed-out', 'Twitch is not connected.');
    const input = inkMeReward();
    const errors = validateReward(input);
    if (errors.length) return this.off('invalid', errors[0]!);
    if (this.status !== 'ready') this.status = 'creating';
    let type: 'affiliate' | 'partner' | '' | undefined;
    try { type = await helix.getBroadcasterType?.(); }
    catch (error) {
      if (error instanceof TwitchSignedOutError) return this.off('signed-out', 'Twitch is not connected.');
      return this.off('check-failed', `Ink me is off: the Twitch channel type could not be checked (${messageOf(error)}).`); }
    if (type === '') return this.off('not-affiliate', INK_ME_AFFILIATE_MESSAGE);
    try {
      if (!this.rewardId) this.rewardId = (await helix.findCustomReward?.(INK_ME.title))?.id;
      if (!this.rewardId) this.rewardId = (await helix.createCustomReward(input)).id;
      if (this.paused && helix.updateCustomReward) { await helix.updateCustomReward({ rewardId: this.rewardId, isPaused: false }); this.paused = false; }
      this.status = 'ready'; this.error = undefined; this.offReason = undefined;
    } catch (error) {
      if (error instanceof TwitchForbiddenError && error.reason === 'not-affiliate') return this.off('not-affiliate', INK_ME_AFFILIATE_MESSAGE);
      const message = error instanceof Error ? error.message : 'The reward could not be created.';
      this.off(/partner or affiliate/i.test(message) ? 'not-affiliate' : 'create-failed', message);
    }
  }
  /**
   * The streamer turned Ink me off. Every UNFULFILLED redemption is refunded first (CANCELED), with one
   * retry. Only when nothing is left pending is the reward deleted: deleting it would make Twitch mark
   * the rest FULFILLED and the viewers would lose their points. If refunds still fail, the reward is
   * kept (paused), the failed ids stay pending, Ink me shows offReason 'refund-failed' with the reason,
   * and a later disable() or cancelPending() finishes the job. Never throws.
   */
  async disable(): Promise<void> {
    if (this.enabling) await this.enabling;
    this.offRequested = true;
    await this.finishOff();
  }
  private async finishOff(): Promise<void> {
    if (this.finishingOff) return;
    this.finishingOff = true;
    try {
      const id = this.rewardId;
      const note = 'Refunded: Ink me was turned off.';
      let refunds = await this.refundPending(note);
      if (refunds.failed) refunds = await this.refundPending(note);
      if (refunds.failed || this.pendingIds().length) return await this.keepForRefunds(id, refunds.lastError);
      this.status = 'idle'; this.error = undefined; this.offReason = undefined;
      if (!id) { this.offRequested = false; return; }
      if (!this.deps.helix?.deleteCustomReward) { this.rewardId = undefined; this.paused = false; this.offRequested = false; return; }
      try { await this.deps.helix.deleteCustomReward({ rewardId: id }); this.forgetReward(id); }
      catch (error) {
        if (error instanceof TwitchApiError && error.status === 404) { this.forgetReward(id); return; }
        this.offRequested = false;
        this.error = `The Ink me reward could not be removed from Twitch (${messageOf(error)}). Delete it on Twitch or try again.`;
      }
    } finally { this.finishingOff = false; }
  }
  private forgetReward(id: string) { this.rewardId = undefined; this.pending.delete(id); this.paused = false; this.offRequested = false; }
  /** Refunds failed: keep the reward (paused, so nothing new is redeemed) and say why. */
  private async keepForRefunds(id: string | undefined, reason = 'unknown error'): Promise<void> {
    if (id && !this.paused && this.deps.helix?.updateCustomReward) {
      try { await this.deps.helix.updateCustomReward({ rewardId: id, isPaused: true }); this.paused = true; }
      catch (error) { this.log(`Ink me: the kept reward could not be paused (${messageOf(error)}).`); }
    }
    const count = this.pendingIds().length;
    this.off('refund-failed', `${count} Ink me redemption(s) could not be refunded on Twitch (${reason}). The reward is kept${this.paused ? ' (paused)' : ''} so their points are not lost; turn Ink me off again to retry.`);
    this.log(`Ink me: ${count} refund(s) failed after one retry (${reason}); the reward was kept, not deleted.`);
  }
  /** UNFULFILLED Ink me redemption ids still waiting for a decision (all rewards). */
  pendingIds(): string[] { return [...this.pending.values()].flatMap(ids => [...ids]); }
  /**
   * Refunds every redemption still UNFULFILLED on Twitch (status CANCELED), in batches of at most 50
   * ids per reward. Call it when the stream ends; disable() calls it before deleting the reward.
   * Never throws: failed ids stay pending (so a later call retries) and their entries say so.
   */
  async cancelPending(note = 'Refunded: the stream ended before this cameo was decided.'): Promise<{ canceled: number; failed: number }> {
    const { canceled, failed } = await this.refundPending(note);
    // Ink me was turned off but kept for refunds: once nothing is pending, finish the off (delete).
    if (this.offRequested && !this.finishingOff && !this.pendingIds().length) await this.finishOff();
    return { canceled, failed };
  }
  private async refundPending(note: string): Promise<{ canceled: number; failed: number; lastError?: string }> {
    let canceled = 0; let failed = 0; let lastError: string | undefined;
    for (const [rewardId, set] of [...this.pending]) {
      const ids = [...set].filter(id => !this.settling.has(id));
      for (let at = 0; at < ids.length; at += REDEMPTION_BATCH_MAX) {
        const batch = ids.slice(at, at + REDEMPTION_BATCH_MAX);
        const entries = this.redemptions.filter(entry => batch.includes(entry.id));
        batch.forEach(id => this.settling.add(id));
        try {
          if (!this.deps.helix) throw new Error('Twitch is not connected.');
          await this.deps.helix.updateRedemptionStatus({ rewardId, redemptionIds: batch, status: 'CANCELED' });
          batch.forEach(id => set.delete(id));
          const panelIds = new Set(entries.map(entry => entry.panelId).filter((panelId): panelId is string => !!panelId));
          const state = this.deps.studio.state;
          if (panelIds.size) state.pendingPanels = state.pendingPanels.filter(panel => !panelIds.has(panel.id));
          for (const entry of entries) { entry.status = 'canceled'; entry.note = note; }
          canceled += batch.length;
        } catch (error) {
          failed += batch.length; lastError = messageOf(error);
          for (const entry of entries) entry.note = `Refund failed (${messageOf(error)}); refund it on Twitch.`;
        } finally { batch.forEach(id => this.settling.delete(id)); }
      }
      if (!set.size) this.pending.delete(rewardId);
    }
    return { canceled, failed, lastError };
  }
  /** A new live stream resets "1 per viewer per stream". */
  newStream() { this.redeemedThisStream.clear(); }
  cooldownEndsAt(): number | undefined {
    const end = this.lastAccepted + INK_ME.globalCooldownSeconds * 1000;
    return Number.isFinite(end) && end > this.deps.now() ? end : undefined;
  }
  async onRedemption(event: ParticipationEvent): Promise<Redemption | null> {
    const detail = event.redemption;
    if (!detail || this.status !== 'ready' || detail.rewardId !== this.rewardId) return null;
    if (this.redemptions.some(entry => entry.id === detail.id)) return null;
    const name = safeText(event.name ?? detail.userLogin ?? 'viewer').trim() || 'viewer';
    const login = safeText(detail.userLogin ?? event.name ?? name).trim().toLowerCase();
    const viewer = (event.user ?? login).toLowerCase();
    const entry: Redemption = { id: detail.id, user: event.user, name, login, at: this.deps.now(), status: 'queued', note: '' };
    this.redemptions.unshift(entry);
    if (this.redemptions.length > 50) this.redemptions.length = 50;
    if (this.deps.optOuts.has(event.user, login) || this.deps.optOuts.has(event.user, name)) return this.cancel(entry, 'Refunded: this viewer opted out with !noink.');
    if (this.redeemedThisStream.has(viewer)) return this.cancel(entry, 'Refunded: 1 per viewer per stream.');
    if (this.cooldownEndsAt() !== undefined) return this.cancel(entry, 'Refunded: the 5-minute cooldown was still running.');
    this.redeemedThisStream.add(viewer);
    this.lastAccepted = this.deps.now();
    if (this.rewardId) { const set = this.pending.get(this.rewardId) ?? new Set<string>(); set.add(entry.id); this.pending.set(this.rewardId, set); }
    if (!this.draft(entry)) entry.note = 'Waiting: panel budget used up. Not lost; drafted when the hour frees up.';
    return entry;
  }
  /** Drafts queued redemptions once the hourly budget has room again, and settles decided cameos. */
  tick() {
    for (const entry of [...this.redemptions].reverse()) if (entry.status === 'queued' && !entry.panelId) { if (!this.draft(entry)) break; }
    void this.settleDecided();
  }
  /**
   * The ink-me decision: once a drafted cameo leaves the review queue, approved (now in panels) marks
   * the redemption FULFILLED and rejected (gone) marks it CANCELED, which refunds the points.
   */
  async settleDecided(): Promise<void> {
    const state = this.deps.studio.state;
    for (const entry of this.redemptions) {
      if (entry.status !== 'drafted' || !entry.panelId || this.settling.has(entry.id)) continue;
      if (state.pendingPanels.some(panel => panel.id === entry.panelId)) continue;
      const approved = state.panels.some(panel => panel.id === entry.panelId);
      this.settling.add(entry.id);
      try {
        await this.update(entry, approved ? 'FULFILLED' : 'CANCELED');
        entry.status = approved ? 'fulfilled' : 'canceled';
        entry.note = approved ? 'Fulfilled: the cameo was approved.' : 'Refunded: the cameo was rejected.';
      } catch (error) { entry.note = `Twitch could not be updated (${messageOf(error)}); settle it on Twitch.`; entry.panelId = undefined; }
      finally { this.settling.delete(entry.id); }
    }
  }
  private draft(entry: Redemption): boolean {
    if (!this.deps.budget.take()) return false;
    const art = CAMEO_ART[this.redemptions.length % CAMEO_ART.length]!;
    const imageUrl = `/art/generated/${art}`;
    const line = this.deps.recentLine?.(entry.user);
    const caption = fitText(`Cameo: ${entry.name} joins the panel`, 60);
    const scene = `Original illustration with a cameo drawn for ${entry.name}, who redeemed Ink me.`;
    const panel: ComicPanel = { id: `cameo-${entry.id}`, origin: 'twitch', caption, storyCaption: caption, dialogue: line ? [fitText(line, 60)] : [], scene, altText: scene, characters: [entry.name], mood: 'playful', imageUrl, at: this.deps.studio.state.elapsed, cameo: entry.login,
      provenance: { provider: 'library', asset: art, style: 'pop-ink', fallback: false }, storyBeats: [{ frame: 0, imageUrl, scene, dialogue: line ? [fitText(line, 60)] : [] }] };
    // Always into the review queue: nothing reaches the overlay without the streamer.
    this.deps.studio.state.pendingPanels.push(panel);
    entry.status = 'drafted'; entry.panelId = panel.id; entry.note = 'Cameo drafted; waiting for your review.';
    this.deps.bus.emit('cameo', { redemptionId: entry.id, panelId: panel.id, login: entry.login });
    return true;
  }
  async resolve(id: string, action: 'fulfil' | 'cancel'): Promise<Redemption> {
    const entry = this.redemptions.find(candidate => candidate.id === id);
    if (!entry) throw new Error('That redemption could not be found.');
    if (entry.status === 'fulfilled' || entry.status === 'canceled' || this.settling.has(entry.id)) throw new Error('That redemption is already settled.');
    if (action === 'cancel') return this.cancel(entry, 'Refunded by the streamer.');
    if (entry.status !== 'drafted') throw new Error('The cameo is not drafted yet.');
    await this.update(entry, 'FULFILLED');
    entry.status = 'fulfilled'; entry.note = 'Fulfilled.';
    return entry;
  }
  private async cancel(entry: Redemption, note: string): Promise<Redemption> {
    await this.update(entry, 'CANCELED');
    if (entry.panelId) { const state = this.deps.studio.state; state.pendingPanels = state.pendingPanels.filter(panel => panel.id !== entry.panelId); }
    entry.status = 'canceled'; entry.note = note;
    return entry;
  }
  private async update(entry: Redemption, status: 'FULFILLED' | 'CANCELED') {
    if (!this.deps.helix || !this.rewardId) throw new Error('Twitch is not connected.');
    await this.deps.helix.updateRedemptionStatus({ rewardId: this.rewardId, redemptionIds: [entry.id], status });
    for (const [rewardId, set] of this.pending) { set.delete(entry.id); if (!set.size) this.pending.delete(rewardId); }
  }
  /** !noink after redeeming: refund anything unsettled and take their cameo out of every panel list. */
  async forgetUser(user?: string, name?: string) {
    const lower = name?.toLowerCase();
    const matches = (entry: Redemption) => (!!user && entry.user === user) || (!!lower && (entry.login === lower || entry.name.toLowerCase() === lower));
    const state = this.deps.studio.state;
    const cameoIds = new Set(this.redemptions.filter(matches).map(entry => entry.panelId).filter((id): id is string => !!id));
    state.pendingPanels = state.pendingPanels.filter(panel => !cameoIds.has(panel.id));
    state.panels = state.panels.filter(panel => !cameoIds.has(panel.id));
    for (const entry of this.redemptions.filter(matches)) {
      entry.panelId = undefined;
      if (entry.status === 'drafted' || entry.status === 'queued') { try { await this.cancel(entry, 'Refunded: this viewer opted out with !noink.'); } catch { entry.note = 'Opted out; refund failed, settle it on Twitch.'; } }
    }
  }
  view() {
    return { status: this.status, error: this.error, offReason: this.status === 'unavailable' ? this.offReason : undefined, chatFallback: this.status === 'unavailable' ? INK_ME_CHAT_FALLBACK : undefined, title: INK_ME.title, cost: INK_ME.cost, maxPerUserPerStream: INK_ME.maxPerUserPerStream, cooldownSeconds: INK_ME.globalCooldownSeconds, cooldownEndsAt: this.cooldownEndsAt(),
      redemptions: this.redemptions.slice(0, 8).map(({ id, user, login, name, at, status, note, panelId }) => ({ id, name: this.deps.optOuts.has(user, login) || this.deps.optOuts.has(user, name) ? 'Opted-out viewer' : name, at, status, note, panelId })) };
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : 'unknown error'; }
