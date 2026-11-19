import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = process.argv[2] ?? resolve(here, '../artifacts/tmp/replay-report.json');

const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(here, 's2-replay-run.ts'), outputPath], {
  cwd: resolve(here, '..'), stdio: 'inherit',
});
if (result.error) console.error(`Replay runner failed to start: ${result.error.message}`);
process.exitCode = result.status ?? 1;
