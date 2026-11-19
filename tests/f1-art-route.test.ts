import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';

test('F1-ART-ROUTE: a well-formed but missing art file is a JSON 404, not a 409; real art and bad names behave as before', async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/f1-art-route-'));
  const app = createApp({ recapDirectory });
  try {
    const missing = await app.inject({ method: 'GET', url: '/art/generated/panel-live-doesnotexist1234.png' });
    assert.equal(missing.statusCode, 404);
    assert.match(String(missing.headers['content-type']), /application\/json/);
    assert.deepEqual(missing.json(), { error: 'Art not found.' });

    const missingWebp = await app.inject({ method: 'GET', url: '/art/generated/panel-99-not-here.webp' });
    assert.equal(missingWebp.statusCode, 404);

    const badName = await app.inject({ method: 'GET', url: '/art/generated/..%2Fmanifest.json' });
    assert.equal(badName.statusCode, 404);

    const present = await app.inject({ method: 'GET', url: '/art/generated/panel-01-stream-start.webp' });
    assert.equal(present.statusCode, 200);
    assert.equal(present.headers['content-type'], 'image/webp');
    assert.equal(present.headers['cache-control'], 'public, max-age=86400');
    assert.ok(present.rawPayload.length > 1000);
  } finally {
    await app.close();
    await rm(recapDirectory, { recursive: true, force: true });
  }
});
