import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import { readProductEnv } from '../packages/core/src/env.mjs';
import { scrubEnvInPlace, scrubbedEnvOverrides } from '../scripts/test-env.mjs';
import { defineConfig } from '@playwright/test';

mkdirSync(new URL('../artifacts/tmp/',import.meta.url),{recursive:true});
// IRC-ENV-1: no ambient anonymous chat, real-run switch, network art or credential reaches the
// runner, its workers (fixture apps) or the web servers, and every Node process runs under
// tests/net-guard.mjs, which refuses and logs any non-loopback lookup or connect.
scrubEnvInPlace(process.env);
const guard = new URL('./net-guard.mjs', import.meta.url).href;
const guardLog = process.env.COMICTOONS_NET_GUARD_LOG || fileURLToPath(new URL('../artifacts/tmp/net-guard.jsonl', import.meta.url));
if (process.env.TEST_WORKER_INDEX === undefined) writeFileSync(guardLog, '');
process.env.COMICTOONS_NET_GUARD_LOG = guardLog;
if (!(process.env.NODE_OPTIONS ?? '').includes(guard)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${guard}`.trim();
const serverEnv = {...scrubbedEnvOverrides(process.env), NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', COMICTOONS_NET_GUARD_LOG: guardLog};
const apiPort = readProductEnv('COMICTOONS_E2E_API_PORT') ?? '4301';
const webPort = readProductEnv('COMICTOONS_E2E_WEB_PORT') ?? '4273';
const apiURL = `http://127.0.0.1:${apiPort}`;
const webURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/obs/**',
  timeout: 90_000,
  workers: 1,
  use: { baseURL: webURL, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  outputDir: '../artifacts/playwright',
  reporter: 'list',
  webServer: [
    { command: 'npm run dev -w @comictoons/server', env: { ...serverEnv, COMICTOONS_API_PORT: apiPort }, url: `${apiURL}/api/state`, reuseExistingServer: false, timeout: 60_000, cwd: '..' },
    { command: 'npm run dev -w @comictoons/web -- --host 127.0.0.1', env: { ...serverEnv, COMICTOONS_API_PORT: apiPort, COMICTOONS_WEB_PORT: webPort, COMICTOONS_OPEN: '0' }, url: webURL, reuseExistingServer: false, timeout: 60_000, cwd: '..' },
  ],
});
