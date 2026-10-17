import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_GIF_FAVORITES } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('GIF favorites', () => {
  it('adds idempotently, lists newest first, syncs other sessions, deletes only my own', async () => {
    const a = await api.register('a'), b = await api.register('b');
    const ws = await WsClient.connect(env.port); await ws.identify(a.token);
    const one = await api.req('POST', '/users/@me/gif-favorites', a.token, { url: 'https://media.example/one.gif', preview: 'https://media.example/one-s.gif', title: 'one', width: 200, height: 100 });
    expect(one.status).toBe(201); expect(one.body).toMatchObject({ url: 'https://media.example/one.gif', title: 'one', width: 200 });
    await ws.waitEvent('GIF_FAVORITES_UPDATE', (d) => d.item?.id === one.body.id);
    expect((await api.req('POST', '/users/@me/gif-favorites', a.token, { url: 'https://media.example/one.gif' })).status).toBe(200); // same url: no duplicate
    const two = await api.req('POST', '/users/@me/gif-favorites', a.token, { url: 'https://media.example/two.gif' });
    const list = (await api.req('GET', '/users/@me/gif-favorites', a.token)).body; expect(list.map((x: any) => x.id)).toEqual([two.body.id, one.body.id]);
    expect((await api.req('GET', '/users/@me/gif-favorites', b.token)).body).toEqual([]);
    expect((await api.req('DELETE', `/users/@me/gif-favorites/${one.body.id}`, b.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me/gif-favorites', a.token)).body).toHaveLength(2); // b could not delete it
    expect((await api.req('DELETE', `/users/@me/gif-favorites/${one.body.id}`, a.token)).status).toBe(204);
    await ws.waitEvent('GIF_FAVORITES_UPDATE', (d) => d.removedId === one.body.id);
    expect((await api.req('GET', '/users/@me/gif-favorites', a.token)).body).toHaveLength(1);
    ws.close();
  });
  it('accepts https and own uploads only, validates sizes, enforces the cap', async () => {
    const a = await api.register('cap');
    const bad = (body: object) => api.req('POST', '/users/@me/gif-favorites', a.token, body);
    expect((await bad({ url: 'http://insecure.example/x.gif' })).status).toBe(400);
    expect((await bad({ url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await bad({ url: 'data:image/gif;base64,AAAA' })).status).toBe(400);
    expect((await bad({ url: 'https://ok.example/a.gif', width: 0 })).status).toBe(400);
    expect((await bad({ url: 'https://ok.example/a.gif', extra: 1 })).status).toBe(400);
    expect((await bad({ url: `/api/v1/files/${'a'.repeat(48)}/cat.gif` })).status).toBe(201);
    for (let i = 0; i < MAX_GIF_FAVORITES - 1; i++) await env.ctx.db.query('INSERT INTO gif_favorites (id, user_id, url) VALUES ($1,$2,$3)', [String(900000000000 + i), a.id, `https://bulk.example/${i}.gif`]);
    const full = await bad({ url: 'https://over.example/x.gif' }); expect(full.status).toBe(400); expect(full.body.code).toBe('LIMIT_REACHED');
    expect((await bad({ url: 'https://bulk.example/3.gif' })).status).toBe(200); // existing ones still resolve when full
  });
});
