import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubbedEnv } from './test-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, 'artifacts', 'tmp'), { recursive: true });
const names = readdirSync(join(root, 'tests'), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map(entry => entry.name)
  .sort();
if (names.length === 0) throw new Error('No tests/*.test.ts files discovered');
console.log(`Discovered ${names.length} test files:`);
for (const name of names) console.log(`  tests/${name}`);
const result = spawnSync(process.execPath, [
  '--import', 'tsx', '--test', ...names.map(name => join(root, 'tests', name)),
], { cwd: root, stdio: 'inherit', env: scrubbedEnv(process.env) });
if (result.error) console.error(`Test runner failed to start: ${result.error.message}`);
if (result.signal) console.error(`Test runner terminated by signal: ${result.signal}`);
process.exitCode = result.status ?? 1;
