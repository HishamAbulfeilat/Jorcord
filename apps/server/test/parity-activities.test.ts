import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function pair() {
  const a = await api.register('a'), b = await api.register('b');
  await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' });
  await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'friend' });
  return { a, b };
}

describe('rich presence', () => {
  it('publishes activities to friends, includes them in READY and profiles, and clears them offline', async () => {
    const { a, b } = await pair();
    const wb = await WsClient.connect(env.port); await wb.identify(b.token);
    const wa = await WsClient.connect(env.port); await wa.identify(a.token);
    const set = await api.req('PUT', '/users/@me/activities', a.token, { activities: [{ type: 'playing', name: 'Chess', details: 'Ranked', state: 'Move 12' }, { type: 'listening', name: 'Lo-fi' }] });
    expect(set.status).toBe(200); expect(set.body.activities).toHaveLength(2); expect(set.body.activities[0]).toMatchObject({ type: 'playing', name: 'Chess', details: 'Ranked', url: null });
    const ev = await wb.waitEvent('PRESENCE_UPDATE', (d) => d.userId === a.id && d.activities?.length === 2);
    expect(ev.d.activities.map((x: any) => x.name)).toEqual(['Chess', 'Lo-fi']);
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.activities).toHaveLength(2);
    // a late joiner sees it in READY
    const wb2 = await WsClient.connect(env.port); const ready = await wb2.identify(b.token);
    expect(ready.d.presences.find((p: any) => p.userId === a.id).activities).toHaveLength(2);
    // privacy: showActivity off hides it from others (not from me) and clears it for peers at once
    await api.req('PATCH', '/users/@me', a.token, { privacy: { showActivity: false } });
    await wb.waitEvent('PRESENCE_UPDATE', (d) => d.userId === a.id && d.activities?.length === 0);
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.activities).toEqual([]);
    expect((await api.req('GET', `/users/${a.id}`, a.token)).body.activities).toHaveLength(2);
    await api.req('PATCH', '/users/@me', a.token, { privacy: { showActivity: true } });
    await wb.waitEvent('PRESENCE_UPDATE', (d) => d.userId === a.id && d.activities?.length === 2);
    // going offline drops them
    wa.close();
    await wb.waitEvent('PRESENCE_UPDATE', (d) => d.userId === a.id && d.presence === 'offline' && d.activities?.length === 0);
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.activities).toEqual([]);
    expect((await api.req('GET', '/users/@me/activities', a.token)).body.activities).toEqual([]);
    wb.close(); wb2.close();
  });

  it('validates input, supports the gateway op and DELETE, and bots can set their own', async () => {
    const { a, b } = await pair();
    const bad = (activities: unknown) => api.req('PUT', '/users/@me/activities', a.token, { activities });
    expect((await bad([{ type: 'flying', name: 'x' }])).status).toBe(400);
    expect((await bad([{ type: 'playing', name: '' }])).status).toBe(400);
    expect((await bad(Array.from({ length: 6 }, () => ({ type: 'playing', name: 'x' })))).status).toBe(400);
    expect((await bad([{ type: 'streaming', name: 's', url: 'javascript:alert(1)' }])).status).toBe(400);
    const okS = await bad([{ type: 'streaming', name: 'Live', url: 'https://example.com/live', startedAt: new Date(Date.now() + 3600_000).toISOString() }]);
    expect(okS.body.activities[0].url).toBe('https://example.com/live');
    expect(Date.parse(okS.body.activities[0].startedAt)).toBeLessThanOrEqual(Date.now()); // never in the future
    const wb = await WsClient.connect(env.port); await wb.identify(b.token);
    const wa = await WsClient.connect(env.port); await wa.identify(a.token);
    wa.send({ op: 3, d: { activities: [{ type: 'competing', name: 'Tournament' }] } });
    await wb.waitEvent('PRESENCE_UPDATE', (d) => d.userId === a.id && d.activities?.[0]?.name === 'Tournament');
    expect((await api.req('DELETE', '/users/@me/activities', a.token)).status).toBe(204);
    await wb.waitEvent('PRESENCE_UPDATE', (d) => d.userId === a.id && d.activities?.length === 0);
    // a bot sets its own activity with its bot token
    const app = (await api.req('POST', '/applications', a.token, { name: 'ActBot' })).body;
    const r = await env.app.inject({ method: 'PUT', url: '/api/v1/users/@me/activities', headers: { authorization: `Bot ${app.token}` }, payload: { activities: [{ type: 'watching', name: 'the server' }] } });
    expect(r.statusCode).toBe(200);
    wa.close(); wb.close();
  });
});
