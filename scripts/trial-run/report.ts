/**
 * Trial-run report builder. Pure: it only turns what the harness measured into numbers, and marks
 * anything it could not measure as a GAP with the reason. It never guesses or fills in a value.
 */

/** The parts of /api/state the report reads. Chat text is never kept. */
export interface SampledPanel { id: string; origin?: string; momentKind?: string }
export interface SampledSource { requested?: string; active?: string; connection?: string; reason?: string; channel?: string; simulated?: boolean; received?: number }
export interface SampledState { status?: string; source?: SampledSource; panels: SampledPanel[]; pendingPanels: SampledPanel[] }
export interface Sample {
  at: number;
  state?: SampledState; stateError?: string;
  participation?: { received?: number; helix?: string }; participationError?: string;
  twitch?: { connected?: boolean; channel?: string }; twitchError?: string;
}
export interface TrialError { at: number; where: string; message: string }
export interface TrialInput {
  source: 'twitch' | 'sample'; channel?: string; fixture?: string;
  requestedMinutes: number; apiPort: number; webPort: number; intervalSeconds: number; outDir: string;
  serverPid?: number; serverExit?: { code: number | null; signal: string | null };
  startedAt: number; ingestStartedAt?: number; endedAt: number;
  directorKeySet: boolean; errors: TrialError[]; samples: Sample[];
}

export type Metric = { value: number; note?: string; gap?: undefined } | { gap: string; value?: undefined; note?: undefined };
export type KindMetric = { value: Record<string, number>; gap?: undefined } | { gap: string; value?: undefined };
export interface TrialReport {
  run: {
    channel?: string; source: 'twitch' | 'sample'; fixture?: string; requestedMinutes: number; apiPort: number; webPort: number;
    intervalSeconds: number; outDir: string; serverPid?: number; serverExit?: { code: number | null; signal: string | null };
    startedAt: string; endedAt: string; samples: number; okSamples: number; directorKeySet: boolean; artNetwork: 'off'; webUi: string;
  };
  metrics: {
    chatLines: Metric; linesPerMinute: Metric; panelsDrafted: Metric; panelsApproved: Metric; samplePanelsShown: Metric;
    reconnects: Metric; fallbackEvents: Metric; liveShareOfSamples: Metric; busEventsReceived: Metric; errors: Metric; durationSeconds: Metric;
  };
  momentsByKind: KindMetric;
  fallbacks: { at: string; reason: string }[];
  fallbackByReason: Record<string, number>;
  errors: { at: string; where: string; message: string }[];
}

/** Connection values that mean the studio fell back to Sample Data (packages/core FallbackReason, minus the manual choice). */
export const FALLBACK_CONNECTIONS = ['empty', 'unauthenticated', 'unreachable', 'disconnected', 'stopped', 'paused'] as const;

const gap = (reason: string): { gap: string } => ({ gap: reason });
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const iso = (at: number) => new Date(at).toISOString();

export function buildReport(input: TrialInput): TrialReport {
  const ok = input.samples.filter((sample): sample is Sample & { state: SampledState } => !!sample.state);
  const noState = 'GAP: no successful /api/state sample in this run';
  const twitchOnly = 'not applicable: the sample source reads no Twitch chat';
  const lowerBound = `seen at ${input.intervalSeconds} s sampling; anything shorter between samples is not seen`;

  // Chat lines: source.received counts admitted chat lines; it restarts at 0 when ingest restarts, so sum segments.
  let chatLines: Metric = gap(noState.slice(5));
  let linesPerMinute: Metric = gap(noState.slice(5));
  if (input.source === 'sample') { chatLines = gap(twitchOnly); linesPerMinute = gap(twitchOnly); }
  else if (ok.length) {
    let total = 0; let previous = 0;
    for (const sample of ok) { const received = sample.state.source?.received ?? 0; if (received < previous) total += previous; previous = received; }
    total += previous;
    chatLines = { value: total, note: `source.received from /api/state; lines after the last sample (at most ${input.intervalSeconds} s) are not counted` };
    const last = ok.at(-1)!.at;
    if (input.ingestStartedAt === undefined) linesPerMinute = gap('the ingest start time was not recorded');
    else if (last <= input.ingestStartedAt) linesPerMinute = gap('no sample after the ingest started');
    else linesPerMinute = { value: round(total / ((last - input.ingestStartedAt) / 60_000)), note: 'chat lines ÷ minutes from ingest start to the last sample' };
  }

  // Panels: unique ids across samples, split by origin.
  const twitchIds = new Set<string>(); const approvedIds = new Set<string>(); const sampleIds = new Set<string>(); const kinds = new Map<string, string>();
  for (const sample of ok) {
    for (const [list, approved] of [[sample.state.pendingPanels, false], [sample.state.panels, true]] as const) {
      for (const panel of list ?? []) {
        if (panel.origin === 'twitch') { twitchIds.add(panel.id); if (approved) approvedIds.add(panel.id); }
        else sampleIds.add(panel.id);
        if (panel.momentKind) kinds.set(panel.id, panel.momentKind);
      }
    }
  }
  const counted = (value: number, note: string): Metric => (ok.length ? { value, note } : gap(noState.slice(5)));

  // Reconnects and fallbacks from the source connection, sample to sample.
  let reconnects: Metric = gap(noState.slice(5));
  let fallbackEvents: Metric = gap(noState.slice(5));
  let liveShare: Metric = gap(noState.slice(5));
  const fallbacks: { at: string; reason: string }[] = [];
  if (ok.length) {
    let seenLive = false; let wasDown = false; let count = 0; let previous: string | undefined;
    for (const sample of ok) {
      const connection = sample.state.source?.connection;
      if (connection === 'live') { if (seenLive && wasDown) count += 1; seenLive = true; wasDown = false; }
      else if (seenLive) wasDown = true;
      if (connection && (FALLBACK_CONNECTIONS as readonly string[]).includes(connection) && connection !== previous) fallbacks.push({ at: iso(sample.at), reason: sample.state.source?.reason ?? connection });
      previous = connection;
    }
    reconnects = input.source === 'sample' ? gap(twitchOnly) : { value: count, note: `returns to live after an outage, ${lowerBound}` };
    fallbackEvents = { value: fallbacks.length, note: `changes into a fallback connection state, ${lowerBound}` };
    liveShare = input.source === 'sample' ? gap(twitchOnly) : { value: round((ok.filter(sample => sample.state.source?.active === 'twitch').length / ok.length) * 100, 1), note: 'share of successful samples with Twitch chat active' };
  }
  const fallbackByReason: Record<string, number> = {};
  for (const event of fallbacks) fallbackByReason[event.reason] = (fallbackByReason[event.reason] ?? 0) + 1;

  const participation = input.samples.filter(sample => typeof sample.participation?.received === 'number');
  const busEventsReceived: Metric = participation.length
    ? { value: participation.at(-1)!.participation!.received!, note: 'bus stream events seen by participation (/api/participation/status received)' }
    : gap('no successful /api/participation/status sample');

  const errors: TrialError[] = [...input.errors];
  for (const sample of input.samples) {
    if (sample.stateError) errors.push({ at: sample.at, where: 'sample /api/state', message: sample.stateError });
    if (sample.participationError) errors.push({ at: sample.at, where: 'sample /api/participation/status', message: sample.participationError });
    if (sample.twitchError) errors.push({ at: sample.at, where: 'sample /api/twitch/status', message: sample.twitchError });
  }
  errors.sort((a, b) => a.at - b.at);

  const momentsByKind: KindMetric = kinds.size
    ? { value: Object.fromEntries([...[...kinds.values()].reduce((map, kind) => map.set(kind, (map.get(kind) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b))) }
    : gap(ok.length ? 'the server does not expose a moment kind (no momentKind on panels, no moments endpoint), so moments cannot be counted by kind' : noState.slice(5));

  return {
    run: {
      channel: input.channel, source: input.source, fixture: input.fixture, requestedMinutes: input.requestedMinutes, apiPort: input.apiPort, webPort: input.webPort,
      intervalSeconds: input.intervalSeconds, outDir: input.outDir, serverPid: input.serverPid, serverExit: input.serverExit,
      startedAt: iso(input.startedAt), endedAt: iso(input.endedAt), samples: input.samples.length, okSamples: ok.length,
      directorKeySet: input.directorKeySet, artNetwork: 'off', webUi: 'not started by the harness',
    },
    metrics: {
      chatLines, linesPerMinute,
      panelsDrafted: counted(twitchIds.size, `unique Twitch-origin panels seen in review or approved, ${lowerBound}`),
      panelsApproved: counted(approvedIds.size, 'unique Twitch-origin panels seen approved'),
      samplePanelsShown: counted(sampleIds.size, 'unique Sample Data panels seen (shown while on the sample source or a fallback)'),
      reconnects, fallbackEvents, liveShareOfSamples: liveShare, busEventsReceived,
      errors: { value: errors.length, note: 'harness, sampling and server-log errors' },
      durationSeconds: { value: round((input.endedAt - input.startedAt) / 1000, 1), note: 'harness start to server stopped' },
    },
    momentsByKind, fallbacks, fallbackByReason,
    errors: errors.map(error => ({ at: iso(error.at), where: error.where, message: error.message })),
  };
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const show = (metric: Metric | KindMetric): [string, string] => {
  if (metric.gap !== undefined) return [`GAP: ${metric.gap}`, ''];
  if (typeof metric.value === 'number') return [String(metric.value), (metric as { note?: string }).note ?? ''];
  const entries = Object.entries(metric.value);
  return [entries.map(([kind, count]) => `${kind}: ${count}`).join(', '), 'unique panels by momentKind'];
};

export function renderMarkdown(report: TrialReport): string {
  const { run, metrics } = report;
  const rows: [string, Metric | KindMetric][] = [
    ['Chat lines received', metrics.chatLines], ['Lines per minute', metrics.linesPerMinute], ['Moments by kind', report.momentsByKind],
    ['Panels drafted (Twitch)', metrics.panelsDrafted], ['Panels approved (Twitch)', metrics.panelsApproved], ['Sample panels shown', metrics.samplePanelsShown],
    ['Reconnects', metrics.reconnects], ['Fallback-to-sample events', metrics.fallbackEvents], ['Share of samples live (%)', metrics.liveShareOfSamples],
    ['Bus events received (participation)', metrics.busEventsReceived], ['Errors', metrics.errors], ['Duration (s)', metrics.durationSeconds],
  ];
  const lines = [
    `# ComicToons trial run: ${run.source === 'twitch' ? `#${run.channel ?? ''}` : `sample source${run.fixture ? ` (${run.fixture})` : ''}`}`,
    '',
    'Every number below was measured in this run. "GAP" means it could not be measured, with the reason.',
    '',
    '## Run', '', '| Setting | Value |', '|---|---|',
    `| Source | ${run.source} |`,
    `| Channel | ${run.channel ?? 'none'} |`,
    `| Requested minutes | ${run.requestedMinutes} |`,
    `| Started (UTC) | ${run.startedAt} |`,
    `| Ended (UTC) | ${run.endedAt} |`,
    `| API port | ${run.apiPort} |`,
    `| Web port | ${run.webPort} (web UI ${run.webUi}) |`,
    `| Server PID | ${run.serverPid ?? 'GAP: the server did not start'} |`,
    `| Server exit | ${run.serverExit ? `code ${run.serverExit.code ?? 'none'}, signal ${run.serverExit.signal ?? 'none'}` : 'GAP: not recorded'} |`,
    `| Art network | off |`,
    `| Director key | ${run.directorKeySet ? 'set (sent as a header, value never written)' : 'not set'} |`,
    `| Samples | ${run.samples} (${run.okSamples} with studio state), every ${run.intervalSeconds} s |`,
    `| Output folder | ${cell(run.outDir)} |`,
    '', '## Results', '', '| Metric | Value | Notes |', '|---|---|---|',
    ...rows.map(([label, metric]) => { const [value, note] = show(metric); return `| ${label} | ${cell(value)} | ${cell(note)} |`; }),
    '', '## Fallback-to-sample reasons', '',
  ];
  const reasons = Object.entries(report.fallbackByReason);
  if (reasons.length) lines.push('| Reason | Count |', '|---|---|', ...reasons.map(([reason, count]) => `| ${cell(reason)} | ${count} |`), '', '| Time (UTC) | Reason |', '|---|---|', ...report.fallbacks.map(event => `| ${event.at} | ${cell(event.reason)} |`));
  else lines.push(metrics.fallbackEvents.gap !== undefined ? `GAP: ${metrics.fallbackEvents.gap}` : 'None seen.');
  lines.push('', '## Errors', '');
  if (report.errors.length) lines.push('| Time (UTC) | Where | Message |', '|---|---|---|', ...report.errors.slice(0, 50).map(error => `| ${error.at} | ${cell(error.where)} | ${cell(error.message)} |`), ...(report.errors.length > 50 ? ['', `${report.errors.length - 50} more in trial-report.json.`] : []));
  else lines.push('None.');
  return `${lines.join('\n')}\n`;
}
