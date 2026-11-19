import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const imagePath = process.argv[2] ?? resolve(here, '../artifacts/tmp/real-art');
const jsonPath = process.argv[3] ?? resolve(here, '../artifacts/tmp/real-art.json');

const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(here, 's2-real-art-run.ts'), imagePath, jsonPath], {
  cwd: resolve(here, '..'), stdio: 'inherit',
});
if (result.error) console.error(`Real-art runner failed to start: ${result.error.message}`);
process.exitCode = result.status ?? 1;
