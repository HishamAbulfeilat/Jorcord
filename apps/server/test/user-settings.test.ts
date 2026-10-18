import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('account settings (cross-device preferences)', () => {
  it('stores and returns the preference blob through PATCH /users/@me', async () => {
    const u = await api.register('prefs');
    const settings = { prefs: { theme: 'light', density: 'compact', reducedMotion: true, keybinds: { quickSwitcher: 'Ctrl+K' } }, prefsUpdatedAt: 123 };
    const r = await api.req('PATCH', '/users/@me', u.token, { settings });
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual(settings);
    expect((await api.req('GET', '/users/@me', u.token)).body.settings).toEqual(settings);
  });

  it('rejects an oversized settings object', async () => {
    const u = await api.register('bigprefs');
    const r = await api.req('PATCH', '/users/@me', u.token, { settings: { blob: 'x'.repeat(17_000) } });
    expect(r.status).toBe(400);
  });
});
