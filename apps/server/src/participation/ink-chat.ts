import {safeText,type ComicPanel,type ComicToonsBusEvents,type EventBus} from '@comictoons/core';
import {fitText,type OptOutLedger,type ParticipationEvent,type StudioLike} from './commands.ts';
import type {DirectorAction} from './director.ts';
import {INK_ME,type PanelBudget} from './rewards.ts';

/** What the studio shows while channel points are refused (broadcaster_type ''). */
export const INK_CHAT_FALLBACK_TEXT = 'Not an Affiliate or Partner? Viewers type !ink in chat instead. You or a mod answer with !ink yes or !ink no.';

export type InkChatStatus = 'queued' | 'drafted' | 'approved' | 'rejected' | 'withdrawn';
export interface InkChatRequest { id: string; user?: string; name: string; login: string; at: number; status: InkChatStatus; panelId?: string; note: string }

const CAMEO_ART = ['panel-story-tabletop-1.png', 'panel-story-tabletop-3.png', 'panel-story-tabletop-5.png'];
const key = (value: string) => value.trim().toLowerCase();

/**
 * Ink me without channel points. While Twitch refuses the custom reward, a viewer's `!ink` asks for
 * a cameo instead. The same limits as the reward apply (1 per viewer per stream, 5-minute global
 * cooldown, the hourly panel budget, and !noink is final), and every cameo goes to the review
 * queue, where the streamer or a mod answers with `!ink yes` / `!ink no` (DirectorDesk) or the studio.
 */
export class InkChatRequests {
  readonly requests: InkChatRequest[] = [];
  note?: string;
  private lastAccepted = -Infinity;
  private askedThisStream = new Set<string>();
  private sequence = 0;
  constructor(private deps: { studio: StudioLike; optOuts: OptOutLedger; bus: EventBus<ComicToonsBusEvents>; now: () => number; budget: PanelBudget; active: () => boolean; decisions?: () => DirectorAction[]; recentLine?: (user?: string) => string | undefined }) {}
  get active() { return this.deps.active(); }
  newStream() { this.askedThisStream.clear(); }
  cooldownEndsAt(): number | undefined {
    const end = this.lastAccepted + INK_ME.globalCooldownSeconds * 1000;
    return Number.isFinite(end) && end > this.deps.now() ? end : undefined;
  }
  /** A viewer's `!ink`. Returns the queued request, or why it was ignored. */
  request(event: ParticipationEvent): InkChatRequest | { ignored: string } {
    if (!this.active) return { ignored: 'Channel points are on: viewers redeem Ink me instead.' };
    const name = safeText(event.name ?? event.user ?? '').trim() || 'viewer';
    const login = key(name).replace(/\s+/g, '');
    const viewer = key(event.user ?? login);
    if (this.deps.optOuts.has(event.user, name)) return { ignored: 'This viewer opted out with !noink.' };
    if (this.askedThisStream.has(viewer)) return { ignored: '1 per viewer per stream.' };
    if (this.cooldownEndsAt() !== undefined) { this.note = 'Cooldown: the last !ink was under 5 minutes ago, so this one was skipped.'; return { ignored: this.note }; }
    this.askedThisStream.add(viewer);
    this.lastAccepted = this.deps.now();
    this.note = undefined;
    const entry: InkChatRequest = { id: `ink-chat-${++this.sequence}`, user: event.user, name, login, at: this.deps.now(), status: 'queued', note: '' };
    this.requests.unshift(entry);
    if (this.requests.length > 50) this.requests.length = 50;
    if (!this.draft(entry)) entry.note = 'Waiting: panel budget used up. Not lost; drafted when the hour frees up.';
    return entry;
  }
  /** Drafts waiting requests once the hourly budget has room again. */
  tick() {
    this.sync();
    for (const entry of [...this.requests].reverse()) if (entry.status === 'queued') { if (!this.draft(entry)) break; }
  }
  private draft(entry: InkChatRequest): boolean {
    if (!this.deps.budget.take()) return false;
    const art = CAMEO_ART[this.sequence % CAMEO_ART.length]!;
    const imageUrl = `/art/generated/${art}`;
    const line = this.deps.recentLine?.(entry.user);
    const dialogue = line ? [fitText(line, 60)] : [];
    const caption = fitText(`Cameo: ${entry.name} joins the panel`, 60);
    const scene = `Original illustration with a cameo drawn for ${entry.name}, who asked with !ink.`;
    const panel: ComicPanel = { id: `cameo-${entry.id}`, origin: 'twitch', caption, storyCaption: caption, dialogue, scene, altText: scene, characters: [entry.name], mood: 'playful', imageUrl, at: this.deps.studio.state.elapsed, cameo: entry.login,
      provenance: { provider: 'library', asset: art, style: 'pop-ink', fallback: false }, storyBeats: [{ frame: 0, imageUrl, scene, dialogue: [...dialogue] }] };
    // Always into the review queue: nothing reaches the overlay without the streamer or a mod.
    this.deps.studio.state.pendingPanels.push(panel);
    entry.status = 'drafted'; entry.panelId = panel.id; entry.note = 'Cameo drafted; waiting for !ink yes or !ink no.';
    this.deps.bus.emit('cameo', { requestId: entry.id, panelId: panel.id, login: entry.login });
    return true;
  }
  /** The cameo `!ink yes` / `!ink no` is about: the oldest one still waiting for review. */
  waiting(): string | undefined {
    const pending = new Set(this.deps.studio.state.pendingPanels.map(panel => panel.id));
    return [...this.requests].reverse().find(entry => entry.status === 'drafted' && entry.panelId && pending.has(entry.panelId))?.panelId;
  }
  /** Reads the answer back from the review queue: approved, or gone without approval. */
  sync() {
    const { panels, pendingPanels } = this.deps.studio.state;
    const decisions = this.deps.decisions?.() ?? [];
    for (const entry of this.requests) {
      if (entry.status !== 'drafted' || !entry.panelId) continue;
      if (pendingPanels.some(panel => panel.id === entry.panelId)) continue;
      const decision = decisions.find(action => action.panelId === entry.panelId);
      const approved = decision ? decision.action === 'approve' : panels.some(panel => panel.id === entry.panelId);
      entry.status = approved ? 'approved' : 'rejected';
      entry.note = decision ? `${approved ? 'Approved' : 'Rejected'} by ${decision.by}.` : approved ? 'Approved.' : 'Rejected.';
    }
  }
  /** !noink after asking: the cameo leaves every panel list and the request is withdrawn. */
  forgetUser(user?: string, name?: string) {
    const lower = name ? key(name) : undefined;
    const matches = (entry: InkChatRequest) => (!!user && entry.user === user) || (!!lower && (entry.login === lower || key(entry.name) === lower));
    const ids = new Set(this.requests.filter(matches).map(entry => entry.panelId).filter((id): id is string => !!id));
    const state = this.deps.studio.state;
    state.pendingPanels = state.pendingPanels.filter(panel => !ids.has(panel.id));
    state.panels = state.panels.filter(panel => !ids.has(panel.id));
    for (const entry of this.requests.filter(matches)) { entry.panelId = undefined; entry.status = 'withdrawn'; entry.note = 'Withdrawn: this viewer opted out with !noink.'; }
  }
  view() {
    this.sync();
    return { active: this.active, text: INK_CHAT_FALLBACK_TEXT, cooldownEndsAt: this.cooldownEndsAt(), note: this.note,
      requests: this.requests.slice(0, 8).map(({ id, user, login, name, at, status, note, panelId }) => ({ id, name: this.deps.optOuts.has(user, login) || this.deps.optOuts.has(user, name) ? 'Opted-out viewer' : name, at, status, note, panelId })) };
  }
}
