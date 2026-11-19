import {safeText} from '@comictoons/core';
import {isModerator,type ParticipationEvent,type StudioLike} from './commands.ts';

export interface DirectorAction { action: 'approve' | 'reject'; panelId: string; by: string; via: 'chat' | 'phone'; at: number }
export interface DirectorCard { id: string; caption: string; dialogue: string[]; imageUrl: string; altText: string; cameo?: string; voters?: number }

/** Chat Ink me cameo panels are named `cameo-ink-chat-N`, N rising in request order (ink-chat.ts). */
const INK_CHAT_CAMEO = /^cameo-ink-chat-(\d+)$/;

/**
 * UI-LIVE-A: the one rule for "which panel does a mod's `!ink yes` (or the A key) act on next".
 * GET /api/state reports it as `nextUp`, and DirectorDesk.chat uses the same function, so the
 * studio page, the phone and chat always agree. `prefer` wins while it is still waiting; otherwise
 * the oldest-requested chat Ink me cameo (what routes.ts passes as `prefer` via inkChat.waiting());
 * otherwise the oldest waiting panel. Undefined when nothing is waiting.
 */
export function nextUpFor(pending: readonly { id: string; at: number }[], prefer?: string): string | undefined {
  if (prefer && pending.some(panel => panel.id === prefer)) return prefer;
  const cameo = pending
    .map(panel => ({ id: panel.id, n: Number(INK_CHAT_CAMEO.exec(panel.id)?.[1] ?? NaN) }))
    .filter(entry => Number.isFinite(entry.n))
    .sort((a, b) => a.n - b.n)[0];
  if (cameo) return cameo.id;
  return [...pending].sort((a, b) => a.at - b.at)[0]?.id;
}

/**
 * Streamer director mode: the broadcaster or a mod approves or rejects the oldest waiting panel
 * with `!ink yes` / `!ink no`, or from the /director phone page. Everyone else is ignored.
 * A short debounce stops two mods typing at once from approving two panels.
 */
export class DirectorDesk {
  readonly log: DirectorAction[] = [];
  private lastAction = -Infinity;
  constructor(private deps: { studio: StudioLike; now: () => number; debounceMs?: number }) {}
  /**
   * `!ink yes|no` from chat. Returns the action taken, or a reason it was ignored. `prefer` names the
   * panel the command is about (a viewer's chat Ink me cameo); otherwise nextUpFor() picks, which is
   * the same panel GET /api/state reports as `nextUp`.
   */
  chat(event: ParticipationEvent, action: 'approve' | 'reject', prefer?: string): DirectorAction | { ignored: string } {
    if (!isModerator(event)) return { ignored: 'Only the broadcaster or a moderator can approve from chat.' };
    if (this.deps.now() - this.lastAction < (this.deps.debounceMs ?? 2000)) return { ignored: 'Another approval just happened.' };
    const panelId = nextUpFor(this.deps.studio.state.pendingPanels, prefer);
    if (!panelId) return { ignored: 'No panel is waiting for review.' };
    return this.act(action, panelId, safeText(event.name ?? 'moderator'), 'chat');
  }
  /** A tap on the phone page. Needs the exact panel the phone was showing, so a stale tap never hits a different panel. */
  phone(action: 'approve' | 'reject', panelId: string): DirectorAction {
    if (!this.deps.studio.state.pendingPanels.some(panel => panel.id === panelId)) throw new Error('That panel is no longer waiting for review.');
    return this.act(action, panelId, 'streamer', 'phone');
  }
  private act(action: 'approve' | 'reject', panelId: string, by: string, via: DirectorAction['via']): DirectorAction {
    this.deps.studio.moderate(action, panelId);
    this.lastAction = this.deps.now();
    const entry = { action, panelId, by, via, at: this.lastAction };
    this.log.unshift(entry);
    if (this.log.length > 20) this.log.length = 20;
    return entry;
  }
  view() {
    const pending = [...this.deps.studio.state.pendingPanels].sort((a, b) => a.at - b.at);
    const cards: DirectorCard[] = pending.slice(0, 3).map(panel => ({ id: panel.id, caption: safeText(panel.caption), dialogue: panel.dialogue.map(line => safeText(line)), imageUrl: panel.imageUrl, altText: safeText(panel.altText), cameo: panel.cameo, voters: panel.voters }));
    return { pending: cards, pendingCount: pending.length, approvedCount: this.deps.studio.state.panels.length, log: this.log.slice(0, 5) };
  }
}
