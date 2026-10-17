import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('cosmetics', () => {
  it('stores catalog ids only, broadcasts them on the user and rejects unknown ones', async () => {
    const a = await api.register('a'), b = await api.register('b');
    await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' });
    await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'friend' });
    const wb = await WsClient.connect(env.port); await wb.identify(b.token);
    const r = await api.req('PATCH', '/users/@me', a.token, { avatarDecoration: 'aurora', profileEffect: 'snowfall', namePlate: 'gold' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ avatarDecoration: 'aurora', profileEffect: 'snowfall', namePlate: 'gold', serverTag: null });
    const ev = await wb.waitEvent('USER_UPDATE', (d) => d.id === a.id && d.avatarDecoration === 'aurora');
    expect(ev.d).toMatchObject({ profileEffect: 'snowfall', namePlate: 'gold' });
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body).toMatchObject({ avatarDecoration: 'aurora', namePlate: 'gold' });
    expect((await api.req('PATCH', '/users/@me', a.token, { avatarDecoration: 'nope' })).status).toBe(400);
    expect((await api.req('PATCH', '/users/@me', a.token, { namePlate: '<script>' })).status).toBe(400);
    expect((await api.req('PATCH', '/users/@me', a.token, { avatarDecoration: null })).body.avatarDecoration).toBeNull();
    wb.close();
  });

  it('server tags: owner sets tag+badge, members wear it, edits propagate, leaving drops it', async () => {
    const owner = await api.register('o'), m = await api.register('m'), out = await api.register('out');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Tagged' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, m.token);
    const wo = await WsClient.connect(env.port); await wo.identify(owner.token);
    // only managers, only 3-4 alphanumerics, only known badges
    expect((await api.req('PATCH', `/guilds/${guild.id}`, m.token, { tag: 'TAGS' })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { tag: 'ab' })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { tag: 'a b!' })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { tag: 'TAGS', tagBadge: 'dragon' })).status).toBe(400);
    const g = await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { tag: 'TAGS', tagBadge: 'flame' });
    expect(g.body).toMatchObject({ tag: 'TAGS', tagBadge: 'flame' });
    // wearing requires membership and a tagged server
    expect((await api.req('PATCH', '/users/@me', out.token, { serverTagGuildId: guild.id })).status).toBe(400);
    const other = (await api.req('POST', '/guilds', m.token, { name: 'Untagged' })).body;
    expect((await api.req('PATCH', '/users/@me', m.token, { serverTagGuildId: other.id })).status).toBe(400);
    const w = await api.req('PATCH', '/users/@me', m.token, { serverTagGuildId: guild.id });
    expect(w.body.serverTag).toEqual({ guildId: guild.id, tag: 'TAGS', badge: 'flame' });
    expect((await api.req('GET', `/guilds/${guild.id}/members`, owner.token)).body.find((x: any) => x.user.id === m.id).user.serverTag.tag).toBe('TAGS');
    // editing the tag updates the wearers; the guild hears about it
    await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { tag: 'NEWT' });
    await wo.waitEvent('USER_UPDATE', (d) => d.id === m.id && d.serverTag?.tag === 'NEWT');
    // leaving drops the tag
    expect((await api.req('DELETE', `/users/@me/guilds/${guild.id}`, m.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me', m.token)).body.serverTag).toBeNull();
    // removing the tag from the server clears wearers
    await api.req('POST', `/invites/${code}`, m.token);
    await api.req('PATCH', '/users/@me', m.token, { serverTagGuildId: guild.id });
    await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { tag: null });
    expect((await api.req('GET', '/users/@me', m.token)).body.serverTag).toBeNull();
    wo.close();
  });
});
