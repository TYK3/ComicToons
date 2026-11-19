import { expect, test } from '@playwright/test';

/**
 * S6-srv (THEMES-4 edition), requirement (f): data/server.ts (ServerAdapter) is a browser module
 * (fetch, localStorage), so its contract is exercised here in a real browser against the real API,
 * through the new UI's own Look picker and reader screens (hash routes on index.html) — no mocked
 * Twitch, no mocked server, loopback only.
 */
const LOOKS = [
  { id: 'festival', name: 'Festival colour' },
  { id: 'sunset', name: 'Sunset glow' },
  { id: 'lagoon', name: 'Lagoon' },
  { id: 'blossom', name: 'Blossom' },
] as const;

test('S6-SRV-F: the Look picker sends mangaTheme to the server for every Look', async ({ page, request }) => {
  await request.post('/api/stop');
  await request.post('/api/settings', { data: { mangaTheme: 'festival' } });
  await page.goto('/#/studio');
  const group = page.getByRole('radiogroup', { name: 'Look' });
  await expect(group).toBeVisible();
  for (const look of LOOKS) {
    const settingsPost = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'POST');
    await group.getByRole('radio', { name: new RegExp(`^${look.name},`) }).click();
    const response = await settingsPost;
    expect(response.request().postDataJSON(), `picking ${look.name} must post mangaTheme to /api/settings`).toEqual({ mangaTheme: look.id });
    expect(response.ok()).toBe(true);
    expect((await response.json()).mangaTheme).toBe(look.id);
    expect((await (await request.get('/api/state')).json()).mangaTheme, `the server must keep ${look.id}`).toBe(look.id);
  }
});

test('S6-SRV-G: the reader asks the server for the Look currently picked, and the server resolves ?look=', async ({ page, request }) => {
  await request.post('/api/stop');
  await request.post('/api/settings', { data: { approvalMode: true, mangaTheme: 'festival' } });
  await request.post('/api/ingest', { data: { mode: 'sample' } });
  await request.post('/api/approve', { data: { all: true } });
  const saved = await (await request.post('/api/recaps', { data: { look: 'festival' } })).json();
  const id = saved.recapUrl.split('/').at(-1) as string;
  await page.goto('/#/studio');
  const group = page.getByRole('radiogroup', { name: 'Look' });
  await expect(group).toBeVisible();
  for (const look of LOOKS) {
    await group.getByRole('radio', { name: new RegExp(`^${look.name},`) }).click();
    const recapsGet = page.waitForResponse(response => response.url().includes(`/api/recaps/${id}?look=`) && response.request().method() === 'GET');
    await page.goto(`/#/recap/${id}`);
    const response = await recapsGet;
    expect(new URL(response.url()).searchParams.get('look'), `the request must carry ?look=${look.id}`).toBe(look.id);
    expect(response.status(), `the server must resolve ?look=${look.id} instead of ignoring it`).toBe(200);
    expect((await response.json()).mangaTheme).toBe(look.id);
    await page.goto('/#/studio');
  }
});
