import { mkdirSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// IMPORT-1-WIRE: its own config, because the Studio server here talks to a fake Twitch (tests/import-wire/serve.ts).
// The spec is *.e2e.ts so the main e2e run (tests/playwright.config.ts, *.spec.ts) never picks it up.
mkdirSync(new URL('../../artifacts/tmp/', import.meta.url), { recursive: true });
const apiPort = process.env.COMICTOONS_E2E_API_PORT ?? '4302';
const webPort = process.env.COMICTOONS_E2E_WEB_PORT ?? '4274';
export const apiURL = `http://127.0.0.1:${apiPort}`;
const webURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  timeout: 90_000,
  workers: 1,
  use: { baseURL: webURL, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  outputDir: '../../artifacts/playwright-import-wire',
  reporter: 'list',
  webServer: [
    { command: 'node --import tsx tests/import-wire/serve.ts', env: { COMICTOONS_API_PORT: apiPort }, url: `${apiURL}/__import-wire/egress`, reuseExistingServer: false, timeout: 60_000, cwd: '../..' },
    { command: 'npm run dev -w @comictoons/web -- --host 127.0.0.1', env: { COMICTOONS_API_PORT: apiPort, COMICTOONS_WEB_PORT: webPort, COMICTOONS_OPEN: '0' }, url: webURL, reuseExistingServer: false, timeout: 60_000, cwd: '../..' },
  ],
});
