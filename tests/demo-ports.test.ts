import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDemoPorts } from '../scripts/demo-ports.mjs';

test('defaults to the API port 3001 and web port 4173 when unset', () => {
  assert.deepEqual(resolveDemoPorts({}), { apiPort: 3001, webPort: 4173 });
});

test('honours custom COMICTOONS_ port settings', () => {
  const env = { COMICTOONS_API_PORT: '3118', COMICTOONS_WEB_PORT: '4118' };
  assert.deepEqual(resolveDemoPorts(env), { apiPort: 3118, webPort: 4118 });
});

test('falls back to the legacy PANELCAST_ prefix', () => {
  const env = { PANELCAST_API_PORT: '3201', PANELCAST_WEB_PORT: '4201' };
  assert.deepEqual(resolveDemoPorts(env), { apiPort: 3201, webPort: 4201 });
});

test('rejects invalid port values', () => {
  assert.throws(
    () => resolveDemoPorts({ COMICTOONS_API_PORT: '0' }),
    error => error instanceof Error && error.message === 'COMICTOONS_API_PORT must be an integer from 1 to 65535',
  );
  assert.throws(
    () => resolveDemoPorts({ COMICTOONS_WEB_PORT: 'not-a-port' }),
    error => error instanceof Error && error.message === 'COMICTOONS_WEB_PORT must be an integer from 1 to 65535',
  );
  assert.throws(
    () => resolveDemoPorts({ COMICTOONS_API_PORT: '65536' }),
    error => error instanceof Error && error.message === 'COMICTOONS_API_PORT must be an integer from 1 to 65535',
  );
});
