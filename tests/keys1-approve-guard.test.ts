import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/server/src/app.ts';

type State = { panels: { id: string }[]; pendingPanels: { id: string }[] };
const ids = (panels: { id: string }[]) => panels.map(panel => panel.id);

for (const scenario of ['bare', 'all', 'panelId', 'reject'] as const) {
  test(`KEYS1-APPROVE-${scenario}: ${scenario === 'bare' ? 'bare approval refuses without moving panels' : scenario === 'all' ? 'explicit all approves every waiting panel' : scenario === 'panelId' ? 'explicit panelId approves only that panel' : 'bare rejection refuses without moving panels'}`, async () => {
    const app = createApp({ env: {}, logger: false });
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/api/ingest', payload: { mode: 'sample' } })).statusCode, 200);
      const before = (await app.inject('/api/state')).json<State>();
      assert.ok(before.pendingPanels.length >= 2, 'the fixture must distinguish one panel from all');
      const selected = before.pendingPanels[1]!.id;
      const response = await app.inject({
        method: 'POST', url: scenario === 'reject' ? '/api/reject' : '/api/approve',
        payload: scenario === 'all' ? { all: true } : scenario === 'panelId' ? { panelId: selected } : {},
      });
      const after = (await app.inject('/api/state')).json<State>();
      if (scenario === 'bare' || scenario === 'reject') {
        assert.equal(response.statusCode, 400);
        assert.deepEqual(after.panels, before.panels);
        assert.deepEqual(after.pendingPanels, before.pendingPanels);
      } else {
        assert.equal(response.statusCode, 200);
        if (scenario === 'all') {
          assert.deepEqual(ids(after.panels), ids([...before.panels, ...before.pendingPanels]));
          assert.deepEqual(after.pendingPanels, []);
        } else if (scenario === 'panelId') {
          assert.deepEqual(ids(after.panels), ids([...before.panels, before.pendingPanels[1]!]));
          assert.deepEqual(ids(after.pendingPanels), ids(before.pendingPanels.filter(panel => panel.id !== selected)));
        }
      }
    } finally {
      await app.close();
    }
  });
}
