import {safeText,type EventBus,type ComicToonsBusEvents} from '@comictoons/core';
import {fitText,type ParticipationEvent,type StudioLike} from './commands.ts';

// Twitch Create Prediction limits (dev.twitch.tv API reference, checked 30 Oct 2026).
export const PREDICTION_LIMITS = { titleMax: 45, outcomesMin: 2, outcomesMax: 10, outcomeMax: 25, windowMin: 30, windowMax: 1800 } as const;
export const HYPE_PREDICTION = { title: 'Will they make it?', outcomes: ['Yes', 'No'], window: 120 } as const;

export interface PredictionInput { title: string; outcomes: string[]; window: number }
export function validatePrediction(input: PredictionInput): string[] {
  const errors: string[] = [];
  if (!input.title.trim() || input.title.length > PREDICTION_LIMITS.titleMax) errors.push(`The prediction title must be 1 to ${PREDICTION_LIMITS.titleMax} characters.`);
  if (input.outcomes.length < PREDICTION_LIMITS.outcomesMin || input.outcomes.length > PREDICTION_LIMITS.outcomesMax) errors.push('A prediction needs 2 to 10 outcomes.');
  input.outcomes.forEach((outcome, index) => { if (!outcome.trim() || outcome.length > PREDICTION_LIMITS.outcomeMax) errors.push(`Outcome ${index + 1} must be 1 to ${PREDICTION_LIMITS.outcomeMax} characters.`); });
  if (!Number.isInteger(input.window) || input.window < PREDICTION_LIMITS.windowMin || input.window > PREDICTION_LIMITS.windowMax) errors.push('The prediction window must be 30 to 1800 seconds.');
  return errors;
}

/** Create Prediction and End Prediction through the Helix client (channel:manage:predictions). endPrediction is live only. */
export interface HelixPredictions {
  createPrediction(input: { title: string; outcomes: { title: string }[]; predictionWindow: number }): Promise<{ id: string; outcomes: { id: string; title: string }[] }>;
  endPrediction?(input: { id: string; status: 'RESOLVED' | 'CANCELED' | 'LOCKED'; winningOutcomeId?: string }): Promise<void>;
}

/** Deterministic punchline from the resolved outcome; no LLM, no viewer names. */
export function punchlineFor(winning: string, predictors?: number): string {
  const tail = predictors && predictors > 0 ? ` ${predictors} called it.` : '';
  if (/^yes\b/i.test(winning)) return fitText(`THEY MADE IT!${tail}`, 60);
  if (/^no\b/i.test(winning)) return fitText(`NOT THIS TIME…${tail}`, 60);
  return fitText(`“${safeText(winning)}” it is!${tail}`, 60);
}

export interface PredictionView { id: string; title: string; status: 'ACTIVE' | 'LOCKED' | 'RESOLVED' | 'CANCELED'; outcomes: { id: string; title: string; users: number }[]; winner?: string }

/**
 * Hype train begin turns the next new panel into a full-page splash and (when allowed) opens a
 * "Will they make it?" prediction. The resolved outcome becomes the next panel's punchline.
 */
/** MEM-1a #8: how many non-pending panel ids observe() remembers. */
const MAX_SEEN = 512;
export class HypeAndPredictions {
  hype?: { level: number; at: number; splashPanelId?: string; phase: 'begin' | 'end' };
  prediction?: PredictionView;
  punchline?: { text: string; panelId?: string };
  error?: string;
  private seen = new Set<string>();
  private splashNext = false;
  private starting=false;
  constructor(private deps: { studio: StudioLike; bus: EventBus<ComicToonsBusEvents>; now: () => number; helix?: HelixPredictions | null; usePredictions: boolean }) {
    for (const panel of deps.studio.state.pendingPanels) this.seen.add(panel.id);
  }
  async onHype(event: ParticipationEvent) {
    const begin = event.type === 'hype_train_begin' || (event.type === 'hype' && (event.phase ?? 'begin') === 'begin');
    const end = event.type === 'hype_train_end' || (event.type === 'hype' && event.phase === 'end');
    if (end && this.hype) { this.hype.phase = 'end'; return; }
    if (!begin || this.hype?.phase === 'begin') return;
    const level = Math.max(1, Math.floor(event.level ?? 1));
    this.hype = { level, at: this.deps.now(), phase: 'begin' };
    this.markSeen();
    this.splashNext = true;
    this.deps.bus.emit('hype-splash', { level, at: this.hype.at });
    if (!this.deps.usePredictions || !this.deps.helix || this.prediction?.status === 'ACTIVE') return;
    try{await this.startPrediction();}catch{/* startPrediction records the error for the studio. */}
  }
  /** Manual and hype-triggered starts share validation and cannot open overlapping predictions. */
  async startPrediction():Promise<PredictionView>{
    if(this.starting||this.prediction?.status==='ACTIVE'||this.prediction?.status==='LOCKED')throw new Error('A prediction is already open.');
    if(!this.deps.usePredictions||!this.deps.helix)throw new Error('Predictions are unavailable.');
    const input={title:HYPE_PREDICTION.title,outcomes:[...HYPE_PREDICTION.outcomes],window:HYPE_PREDICTION.window};
    const errors=validatePrediction(input);
    if(errors.length)throw new Error(errors[0]);
    this.starting=true;
    try{
      const created=await this.deps.helix.createPrediction({title:input.title,outcomes:input.outcomes.map(title=>({title})),predictionWindow:input.window});
      this.prediction={id:created.id,title:input.title,status:'ACTIVE',outcomes:created.outcomes.map(outcome=>({...outcome,users:0}))};
      this.error=undefined;return this.prediction;
    }catch(error){this.error=`Prediction unavailable: ${error instanceof Error?error.message:'unknown error'}`;throw new Error(this.error);}
    finally{this.starting=false;}
  }
  /** The streamer resolves the open prediction: End Prediction RESOLVED on Twitch, then the punchline. */
  async resolvePrediction(winningOutcomeId: string): Promise<PredictionView> {
    const prediction = this.open();
    if (!prediction.outcomes.some(outcome => outcome.id === winningOutcomeId)) throw new Error('That outcome is not part of the prediction.');
    await this.deps.helix?.endPrediction?.({ id: prediction.id, status: 'RESOLVED', winningOutcomeId });
    this.onPrediction({ t: 0, type: 'hype', prediction: { id: prediction.id, status: 'RESOLVED', winningOutcomeId, outcomes: prediction.outcomes.map(({ id, title, users }) => ({ id, title, users })) } } as ParticipationEvent);
    return this.prediction!;
  }
  /** The streamer cancels the open prediction: End Prediction CANCELED refunds every viewer. */
  async cancelPrediction(): Promise<PredictionView> {
    const prediction = this.open();
    await this.deps.helix?.endPrediction?.({ id: prediction.id, status: 'CANCELED' });
    prediction.status = 'CANCELED';
    return prediction;
  }
  private open(): PredictionView {
    if (!this.prediction || (this.prediction.status !== 'ACTIVE' && this.prediction.status !== 'LOCKED')) throw new Error('No prediction is open.');
    return this.prediction;
  }
  /** channel.prediction.progress/lock/end, mapped by S1 to a `prediction` field. */
  onPrediction(event: ParticipationEvent) {
    const update = event.prediction;
    if (!update || !this.prediction || update.id !== this.prediction.id) return;
    this.prediction.status = update.status;
    this.prediction.outcomes = this.prediction.outcomes.map(outcome => ({ ...outcome, users: Math.max(0, Math.floor(update.outcomes.find(entry => entry.id === outcome.id)?.users ?? outcome.users)) }));
    if (update.status === 'RESOLVED') {
      const winner = this.prediction.outcomes.find(outcome => outcome.id === update.winningOutcomeId);
      if (!winner) return;
      this.prediction.winner = winner.title;
      // Lettered into the next panel drafted after this point (see observe).
      this.punchline = { text: punchlineFor(winner.title, winner.users) };
      this.markSeen();
    }
  }
  /** Call on every tick: marks the first panel drafted after hype begin, and letters a waiting punchline. */
  observe() {
    const pending = this.deps.studio.state.pendingPanels;
    const fresh = pending.filter(panel => !this.seen.has(panel.id));
    for (const panel of fresh) this.seen.add(panel.id);
    // MEM-1a #8: seen grew by one id per panel ever drafted. Keep every pending id plus the most recent others
    // (an undone reject can bring a panel back to pending, and it must not count as new).
    if (this.seen.size > MAX_SEEN) {
      const keep = new Set(pending.map(panel => panel.id));
      for (const id of this.seen) { if (this.seen.size <= MAX_SEEN) break; if (!keep.has(id)) this.seen.delete(id); }
    }
    if (this.splashNext && fresh[0] && this.hype) {
      this.splashNext = false; this.hype.splashPanelId = fresh[0].id;
      this.deps.bus.emit('panel-splash', { panelId: fresh[0].id, level: this.hype.level });
    }
    if (this.punchline && !this.punchline.panelId && fresh[0]) this.applyPunchline(fresh[0].id);
  }
  /** Panels already drafted are never the "next" panel. */
  private markSeen() { for (const panel of this.deps.studio.state.pendingPanels) this.seen.add(panel.id); }
  private applyPunchline(target: string) {
    if (!this.punchline) return;
    this.deps.studio.caption(target, this.punchline.text);
    this.punchline.panelId = target;
    this.deps.bus.emit('punchline', { panelId: target, text: this.punchline.text });
  }
  view() { return { hype: this.hype, prediction: this.prediction, punchline: this.punchline, error: this.error }; }
}
