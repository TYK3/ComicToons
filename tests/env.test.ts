import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProductEnv } from '../packages/core/src/env.mjs';
import { loadEnv } from '../apps/server/src/env.ts';

test('a missing .env file is ignored', () => {
  assert.doesNotThrow(() => loadEnv(resolve('artifacts/tmp/comictoons-missing.env')));
});

test('an existing environment variable always wins over the .env file', async () => {
  const directory = await mkdtemp(resolve('artifacts/tmp/env-test-'));
  const file = resolve(directory, '.env');
  process.env.COMICTOONS_ENV_TEST_EXISTING = 'from-process';
  await writeFile(file, 'COMICTOONS_ENV_TEST_EXISTING=from-file\nCOMICTOONS_ENV_TEST_NEW=from-file\n');
  try {
    loadEnv(file);
    assert.equal(process.env.COMICTOONS_ENV_TEST_EXISTING, 'from-process');
    assert.equal(process.env.COMICTOONS_ENV_TEST_NEW, 'from-file');
  } finally {
    delete process.env.COMICTOONS_ENV_TEST_EXISTING;
    delete process.env.COMICTOONS_ENV_TEST_NEW;
    await rm(directory, { recursive: true, force: true });
  }
});


test('product settings accept the legacy prefix for one release and prefer the new name', () => {
  const env: Record<string, string | undefined> = { PANELCAST_API_PORT: '3101' };
  assert.equal(readProductEnv('COMICTOONS_API_PORT', env), '3101');
  env.COMICTOONS_API_PORT = '3102';
  assert.equal(readProductEnv('COMICTOONS_API_PORT', env), '3102');
  env.COMICTOONS_API_PORT = '';
  assert.equal(readProductEnv('COMICTOONS_API_PORT', env), '', 'an explicit new value still wins');
});
