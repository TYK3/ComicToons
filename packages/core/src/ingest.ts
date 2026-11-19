export type FallbackReason = 'manual' | 'empty' | 'unauthenticated' | 'unreachable' | 'disconnected' | 'stopped' | 'paused' | 'ended';
export interface ChatSourceState {
  requested: 'sample' | 'twitch';
  active: 'sample' | 'twitch';
  connection: 'sample' | 'connecting' | 'live' | FallbackReason;
  reason?: FallbackReason;
  channel?: string;
  simulated: boolean;
  received: number;
  /** Ordinary chat lines skipped by the 60-per-second admission limit on this connection. Privacy controls are never counted. */
  throttled?: number;
  /** IRC leg the adapter was welcomed on: TLS 6697 first, WSS 443 as its fallback. Absent for Sample Data and EventSub chat. */
  transport?: 'tls' | 'wss';
}
export const sampleSource = (): ChatSourceState => ({requested:'sample',active:'sample',connection:'sample',simulated:false,received:0});
export const isSampleSource = (source?: ChatSourceState) => source?.active !== 'twitch' || source.simulated;
export const chatSourceLabel = (source?: ChatSourceState) => isSampleSource(source)
  ? (source?.simulated && source.active === 'twitch' ? 'Simulated IRC · Sample Data' : 'Sample Data') : 'Live chat';
/** Short name of the chat transport for real live chat only, e.g. "WSS 443". */
export const chatTransportLabel = (source?: ChatSourceState) => !source || isSampleSource(source) || !source.transport ? undefined
  : source.transport === 'wss' ? 'WSS 443' : 'TLS 6697';
export function panelSourceLabel(panels: readonly {origin?: 'sample' | 'twitch'}[]) {
  if (panels.length && panels.every(panel => panel.origin === 'twitch')) return 'Live chat · Original illustration';
  if (panels.some(panel => panel.origin === 'twitch')) return 'Mixed sources · includes Sample Data';
  return 'Sample Data · Invented chat';
}
