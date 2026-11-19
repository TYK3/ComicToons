import {mkdirSync} from 'node:fs';
import {defineConfig} from '@playwright/test';

// ObsStack owns its API and Vite listeners; the main e2e servers must not run here.
mkdirSync(new URL('../../artifacts/tmp/',import.meta.url),{recursive:true});
export default defineConfig({
  testDir:'.',
  testMatch:'overlay-obs.spec.ts',
  timeout:90_000,
  workers:1,
  use:{trace:'retain-on-failure'},
  outputDir:'../../artifacts/playwright-obs',
  reporter:'list',
});
