import { readProductEnv } from '../packages/core/src/env.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? resolve(here, '../../panelcast-xfer/shots-s2');

const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(here, 's2-studio-shoot-run.ts'), outDir], {
  cwd: resolve(here, '..'),
  env: { ...process.env, COMICTOONS_API_PORT: readProductEnv('COMICTOONS_API_PORT') ?? '3102', COMICTOONS_WEB_PORT: readProductEnv('COMICTOONS_WEB_PORT') ?? '4102' },
  stdio: 'inherit',
});
if (result.error) console.error(`Studio-shoot runner failed to start: ${result.error.message}`);
process.exitCode = result.status ?? 1;
