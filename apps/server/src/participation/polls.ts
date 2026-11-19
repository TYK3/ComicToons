import {safeText,type EventBus,type ComicToonsBusEvents} from '@comictoons/core';
import {fitText,isCommandText,type OptOutLedger,type ParticipationEvent,type StudioLike} from './commands.ts';
import type {PanelBudget} from './rewards.ts';

// Twitch Create Poll limits (dev.twitch.tv API reference, checked 30 Oct 2026).
export const POLL_LIMITS = { titleMax: 60, choicesMin: 2, choicesMax: 5, choiceMax: 25, durationMin: 15, durationMax: 1800 } as const;
export const POLL_QUESTION = 'Which chat line goes in the bubble?';
const BUBBLE_MAX = 60;

export interface PollInput { title: string; choices: string[]; duration: number }
export function validatePoll(input: PollInput): string[] {
  const errors: string[] = [];
  const title = input.title.trim();
  if (!title) errors.push('The poll needs a question.');
  if (title.length > POLL_LIMITS.titleMax) errors.push(`The question must be ${POLL_LIMITS.titleMax} characters or fewer.`);
  if (input.choices.length < POLL_LIMITS.choicesMin || input.choices.length > POLL_LIMITS.choicesMax) errors.push(`A poll needs ${POLL_LIMITS.choicesMin} to ${POLL_LIMITS.choicesMax} choices.`);
  input.choices.forEach((choice, index) => {
    if (!choice.trim()) errors.push(`Choice ${index + 1} is empty.`);
    if (choice.length > POLL_LIMITS.choiceMax) errors.push(`Choice ${index + 1} must be ${POLL_LIMITS.choiceMax} characters or fewer.`);
  });
  if (new Set(input.choices.map(choice => choice.trim().toLowerCase())).size !== input.choices.length) errors.push('Choices must be different.');
  if (!Number.isInteger(input.duration) || input.duration < POLL_LIMITS.durationMin || input.duration > POLL_LIMITS.durationMax) errors.push(`Duration must be a whole number from ${POLL_LIMITS.durationMin} to ${POLL_LIMITS.durationMax} seconds.`);
  return errors;
}

/** Create Poll and End Poll through the Helix client (channel:manage:polls). endPoll is live only. */
export interface HelixPolls {
  createPoll(input: { title: string; choices: { title: string }[]; duration: number }): Promise<{ id: string }>;
  endPoll?(input: { id: string; status: 'TERMINATED' | 'ARCHIVED' }): Promise<void>;
}

type Line = { user?: string; name?: string; text: string; at: number };
export interface PollChoice { key: number; title: string; caption: string; author?: string; authorName?: string; votes: number }
export interface PollView { id: string; mode: 'twitch' | 'chat'; panelId: string; panelCaption: string; question: string; duration: number; endsAt: number; choices: PollChoice[]; total: number; fallbackReason?: string }
export interface PollResult { pollId: string; panelId: string; mode: 'twitch' | 'chat'; outcome: 'applied' | 'rendering' | 'image-failed' | 'no-votes' | 'panel-gone' | 'discarded'; caption?: string; voters: number; percent?: number; at: number }

/**
 * Chat votes the bubble. Choices are real chat lines (escaped, never invented, no LLM), cut to
 * 25 characters for the ballot; the winner's full line (up to 60) is lettered into the bubble.
 * Uses a Twitch poll when allowed and falls back to !1/!2… chat votes when it is not.
 */
export class CaptionPolls {
  private lines: Line[] = [];
  private votes = new Map<string, number>();
  private current?: PollView;
  private sequence = 0;
  lastResult?: PollResult;
  /** Last End Poll failure, if any (shown by the studio; the vote itself already finished). */
  endError?: string;
  constructor(private deps: { studio: StudioLike; optOuts: OptOutLedger; bus: EventBus<ComicToonsBusEvents>; now: () => number; budget: PanelBudget; helix?: HelixPolls | null; useHelix: boolean }) {}
  get active() { return this.current; }
  noteChat(event: ParticipationEvent) {
    if (event.type !== 'chat' || event.withdraw || isCommandText(event.text)) return;
    const text = safeText(event.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.lines.push({ user: event.user, name: event.name, text, at: this.deps.now() });
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
  }
  /** Chat lines usable as choices for a panel: its own lines first, then recent chat; opted-out authors never. */
  candidates(panelDialogue: string[] = []): Line[] {
    const now = this.deps.now();
    const usable = this.lines.filter(line => !this.deps.optOuts.has(line.user, line.name) && now - line.at <= 5 * 60_000);
    const own = panelDialogue.map(text => [...usable].reverse().find(line => line.text === text)).filter((line): line is Line => !!line);
    const seen = new Set<string>(); const picked: Line[] = [];
    for (const line of [...own, ...[...usable].reverse()]) {
      const ballot = fitText(line.text, POLL_LIMITS.choiceMax).toLowerCase();
      if (seen.has(ballot)) continue;
      seen.add(ballot); picked.push(line);
      if (picked.length === 3) break;
    }
    return picked;
  }
  async start(options: { panelId?: string; duration?: number } = {}): Promise<PollView> {
    if (this.current) throw new Error('A vote is already running.');
    if (this.deps.budget.exhausted()) throw new Error('Votes are paused until the panel budget resets.');
    const pending = [...this.deps.studio.state.pendingPanels,...this.deps.studio.state.panels].filter(panel=>!panel.releaseBlocked&&panel.imageRevision?.status!=='rendering');
    const panel = options.panelId ? pending.find(entry => entry.id === options.panelId) : pending[0];
    if (!panel) throw new Error('There is no eligible panel to vote on.');
    const lines = this.candidates(panel.dialogue);
    const choices = lines.map((line, index): PollChoice => ({ key: index + 1, title: fitText(line.text, POLL_LIMITS.choiceMax), caption: fitText(line.text, BUBBLE_MAX), author: line.user, authorName: line.name, votes: 0 }));
    const duration = options.duration ?? 45;
    const errors = validatePoll({ title: POLL_QUESTION, choices: choices.map(choice => choice.title), duration });
    if (errors.length) throw new Error(choices.length < POLL_LIMITS.choicesMin ? 'Chat needs at least two different lines before a vote can start.' : errors[0]!);
    let mode: PollView['mode'] = 'chat'; let id = `chat-poll-${++this.sequence}`; let fallbackReason: string | undefined;
    if (this.deps.useHelix && this.deps.helix) {
      try { id = (await this.deps.helix.createPoll({ title: POLL_QUESTION, choices: choices.map(choice => ({ title: choice.title })), duration })).id; mode = 'twitch'; }
      catch (error) { fallbackReason = `Twitch poll unavailable (${error instanceof Error ? error.message : 'unknown error'}); chat votes with !1, !2 or !3 instead.`; }
    } else fallbackReason = 'Twitch polls are off; chat votes with !1, !2 or !3.';
    this.votes.clear();
    this.current = { id, mode, panelId: panel.id, panelCaption: safeText(panel.caption), question: POLL_QUESTION, duration, endsAt: this.deps.now() + duration * 1000, choices, total: 0, fallbackReason };
    this.deps.bus.emit('poll-started', { pollId: id, panelId: panel.id, mode, choices: choices.map(choice => choice.title) });
    return this.view()!;
  }
  /** A `!n` chat vote. One vote per viewer; a later vote replaces an earlier one. */
  vote(event: ParticipationEvent, choice: number): boolean {
    const poll = this.current;
    if (!poll || poll.mode !== 'chat' || !event.user || choice < 1 || choice > poll.choices.length || this.deps.now() >= poll.endsAt) return false;
    this.votes.set(event.user, choice);
    for (const entry of poll.choices) entry.votes = [...this.votes.values()].filter(value => value === entry.key).length;
    poll.total = this.votes.size;
    return true;
  }
  /** channel.poll.progress / channel.poll.end, mapped by S1 to a `poll` StreamEvent. */
  onTwitchPoll(event: ParticipationEvent): PollResult | null {
    const poll = this.current; const update = event.poll;
    if (!poll || poll.mode !== 'twitch' || !update || update.id !== poll.id) return null;
    update.choices.forEach((choice, index) => { const target = poll.choices[index]; if (target) target.votes = Math.max(0, Math.floor(choice.votes)); });
    poll.total = poll.choices.reduce((sum, choice) => sum + choice.votes, 0);
    if (update.status === 'ACTIVE') return null;
    if (update.status === 'COMPLETED' || update.status === 'TERMINATED') return this.finish({ endedOnTwitch: true });
    return this.close('discarded');
  }
  tick(): PollResult | null {
    if (this.current?.mode === 'chat' && this.deps.now() >= this.current.endsAt) return this.finish();
    return null;
  }
  /**
   * Ends the vote now and letters the winner in. Ties go to the lower number. A Twitch poll the studio
   * ends early is also ended on Twitch (End Poll, TERMINATED keeps the result visible); a failure there
   * never blocks the studio, Twitch closes the poll at its duration anyway.
   */
  finish(options: { endedOnTwitch?: boolean } = {}): PollResult | null {
    const poll = this.current;
    if (!poll) return null;
    if (poll.mode === 'twitch' && !options.endedOnTwitch && this.deps.helix?.endPoll && this.deps.now() < poll.endsAt) {
      void this.deps.helix.endPoll({ id: poll.id, status: 'TERMINATED' }).catch(error => { this.endError = `Twitch poll could not be ended (${error instanceof Error ? error.message : 'unknown error'}); it closes on its own.`; });
    }
    const panel = [...this.deps.studio.state.pendingPanels,...this.deps.studio.state.panels].find(entry => entry.id === poll.panelId&&!entry.releaseBlocked);
    if (!panel) return this.close('panel-gone');
    // Someone who opted out while the vote ran is never quoted, even if their line won.
    const eligible = poll.choices.filter(choice => !this.deps.optOuts.has(choice.author, choice.authorName));
    const winner = [...eligible].sort((a, b) => b.votes - a.votes || a.key - b.key)[0];
    if (!winner || winner.votes === 0) return this.close('no-votes');
    let revision:unknown;
    try{revision=this.deps.studio.caption(panel.id,winner.caption,'Chat chose');}catch{return this.close('image-failed',winner.caption);}
    panel.voters = poll.total;
    const result=this.close(revision instanceof Promise?'rendering':'applied',winner.caption,poll.total?Math.round(winner.votes/poll.total*100):undefined);
    if(revision instanceof Promise)void revision.then(()=>{result.outcome='applied';this.deps.bus.emit('poll-result',result);},()=>{result.outcome='image-failed';this.deps.bus.emit('poll-result',result);});
    return result;
  }
  private close(outcome: PollResult['outcome'], caption?: string, percent?: number): PollResult {
    const poll = this.current!;
    this.current = undefined; this.votes.clear();
    this.lastResult = { pollId: poll.id, panelId: poll.panelId, mode: poll.mode, outcome, caption, voters: poll.total, percent, at: this.deps.now() };
    this.deps.bus.emit('poll-result', this.lastResult);
    return this.lastResult;
  }
  /** What the studio shows. Author ids stay on the server. */
  view(): PollView | undefined {
    const poll = this.current;
    if (!poll) return undefined;
    // An author who opts out mid-vote is withdrawn from the ballot view at once (finish() skips them too).
    return { ...poll, choices: poll.choices.map(({ key, title, caption, votes, author, authorName }) => this.deps.optOuts.has(author, authorName) ? { key, title: 'Withdrawn', caption: 'Withdrawn', votes } : { key, title, caption, votes }) };
  }
  forgetUser(user?: string, name?: string) {
    this.lines = this.lines.filter(line => !((user && line.user === user) || (name && line.name?.toLowerCase() === name.toLowerCase())));
  }
}
