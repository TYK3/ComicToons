import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/server/src/app.ts';

type State = { panels: { id: string }[]; pendingPanels: { id: string }[] };
const ids = (panels: { id: string }[]) => panels.map(panel => panel.id);

for (const scenario of ['bare', 'all', 'panelId', 'undo-all'] as const) {
  test(`REJECT1-${scenario}: ${scenario === 'bare' ? 'bare rejection refuses without moving panels' : scenario === 'all' ? 'explicit all rejects every waiting panel without putting any on air' : scenario === 'panelId' ? 'explicit panelId rejects only that panel' : 'undo after rejecting all restores every waiting panel'}`, async () => {
    const app = createApp({ env: {}, logger: false });
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/api/ingest', payload: { mode: 'sample' } })).statusCode, 200);
      const before = (await app.inject('/api/state')).json<State>();
      assert.ok(before.pendingPanels.length >= 2, 'the fixture must distinguish one panel from all');
      const selected = before.pendingPanels[1]!.id;
      const response = await app.inject({
        method: 'POST', url: '/api/reject',
        payload: scenario === 'all' || scenario === 'undo-all' ? { all: true } : scenario === 'panelId' ? { panelId: selected } : {},
      });
      const after = (await app.inject('/api/state')).json<State>();
      assert.deepEqual(after.panels, before.panels, 'rejection must never put panels on air');
      if (scenario === 'bare') {
        assert.equal(response.statusCode, 400);
        assert.deepEqual(after.pendingPanels, before.pendingPanels);
      } else {
        assert.equal(response.statusCode, 200);
        if (scenario === 'panelId') {
          assert.deepEqual(ids(after.pendingPanels), ids(before.pendingPanels.filter(panel => panel.id !== selected)));
        } else {
          assert.deepEqual(after.pendingPanels, []);
          if (scenario === 'undo-all') {
            const { undoToken } = response.json<{ undoToken: string }>();
            assert.ok(undoToken, 'reject all must return an undo token');
            assert.equal((await app.inject({ method: 'POST', url: '/api/undo', payload: { token: undoToken } })).statusCode, 200);
            const restored = (await app.inject('/api/state')).json<State>();
            assert.deepEqual(restored.pendingPanels, before.pendingPanels);
            assert.deepEqual(restored.panels, before.panels);
          }
        }
      }
    } finally {
      await app.close();
    }
  });
}
