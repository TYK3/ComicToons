/** Entry point: `npm run trial-run -- --channel <name> --minutes <n>`. See harness.ts and --help.
 * `--signed-in` is a separate mode (see signed-in.ts and docs/SIGNED_IN_RUN.md); without that flag
 * everything below runs exactly as it always has. */
import { resolve } from 'node:path';
import { parseArgs, runTrial, USAGE } from './harness.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');

if (wantsSignedInArg(process.argv.slice(2))) {
  const { runSignedInCli } = await import('./signed-in.ts');
  await runSignedInCli(process.argv.slice(2), { repoRoot, env: process.env, now: Date.now() });
} else {
  let options;
  try { options = parseArgs(process.argv.slice(2), { repoRoot, env: process.env, now: Date.now() }); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); console.error(USAGE); process.exit(2); }
  if ('help' in options) { console.log(USAGE); process.exit(0); }
  const { report, files } = await runTrial(options, { env: process.env });
  const show = (metric: { value?: unknown; gap?: string }) => (metric.gap !== undefined ? `GAP (${metric.gap})` : String(metric.value));
  console.log(`chat lines: ${show(report.metrics.chatLines)}; lines/min: ${show(report.metrics.linesPerMinute)}; panels drafted: ${show(report.metrics.panelsDrafted)}; fallbacks: ${show(report.metrics.fallbackEvents)}; errors: ${show(report.metrics.errors)}; duration: ${show(report.metrics.durationSeconds)} s`);
  for (const file of files) console.log(`wrote ${file}`);
  process.exitCode = report.run.okSamples > 0 ? 0 : 1;
}

/** Inlined so this check never depends on signed-in.ts loading; kept identical to wantsSignedIn there. */
function wantsSignedInArg(argv: string[]): boolean { return argv.includes('--signed-in'); }
