import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('app directory', () => {
  it('only public bots with a description and summary can be listed; owners only; input validated', async () => {
    const o = await api.register('o'), x = await api.register('x');
    const app = (await api.req('POST', '/applications', o.token, { name: 'Dice', description: 'short' })).body;
    expect(app.directory).toMatchObject({ listed: false, category: 'other', tags: [] });
    const patch = (tok: string, b: object) => api.req('PATCH', `/applications/${app.id}`, tok, b);
    expect((await patch(x.token, { directoryListed: true })).status).toBe(404);
    expect((await patch(o.token, { directoryListed: true })).status).toBe(400); // description too short
    await patch(o.token, { description: 'Rolls dice and flips coins for your server.' });
    expect((await patch(o.token, { directoryListed: true })).status).toBe(400); // no summary
    for (const bad of [{ directoryCategory: 'weapons' }, { directoryTags: ['UPPER'] }, { directoryTags: ['a'] }, { directoryTags: Array(6).fill('tag-x') }, { directorySummary: 'x'.repeat(141) }, { directoryPermissions: 'lots' }]) expect((await patch(o.token, bad)).status, JSON.stringify(bad)).toBe(400);
    await patch(o.token, { botPublic: false });
    expect((await patch(o.token, { directorySummary: 'Dice and coins, one slash command away.', directoryListed: true })).status).toBe(400); // private bot
    await patch(o.token, { botPublic: true });
    const ok = await patch(o.token, { directorySummary: 'Dice and coins, one slash command away.', directoryCategory: 'fun', directoryTags: ['dice', 'games', 'dice'], directoryPermissions: '2048', directoryListed: true });
    expect(ok.status).toBe(200); expect(ok.body.directory).toEqual({ listed: true, category: 'fun', summary: 'Dice and coins, one slash command away.', tags: ['dice', 'games'], permissions: '2048' });
  });

  it('lists, searches, filters and sorts by installs; exposes no owner or secrets; unlisting and going private hide it', async () => {
    const o = await api.register('lister'); const mk = async (name: string, category: string, tags: string[], listed = true) => {
      const a = (await api.req('POST', '/applications', o.token, { name, description: `${name} does useful things in servers.` })).body;
      await api.req('PATCH', `/applications/${a.id}`, o.token, { directorySummary: `${name}: summary text here`, directoryCategory: category, directoryTags: tags, directoryListed: listed });
      return a;
    };
    const a = await mk('ZetaMod', 'moderation', ['automod']), b = await mk('ZetaTunes', 'music', ['radio']), hidden = await mk('ZetaHidden', 'music', [], false);
    const viewer = await api.register('v');
    const list = (qs = '') => api.req('GET', `/directory/apps${qs}`, viewer.token);
    expect((await api.req('GET', '/directory/apps', null)).status).toBe(401);
    const all = (await list('?q=zeta')).body; expect(all.total).toBe(2); expect(all.items.map((i: any) => i.name).sort()).toEqual(['ZetaMod', 'ZetaTunes']);
    expect(Object.keys(all.items[0]).sort()).toEqual(['botUserId', 'category', 'description', 'icon', 'id', 'installs', 'listedAt', 'name', 'official', 'permissions', 'summary', 'tags']);
    expect(JSON.stringify(all)).not.toMatch(/token|secret|owner|redirect|endpoint/i);
    expect((await list('?q=zeta&category=music')).body.items.map((i: any) => i.name)).toEqual(['ZetaTunes']);
    expect((await list('?q=automod')).body.items.map((i: any) => i.name)).toEqual(['ZetaMod']); // tags are searchable
    expect((await list('?q=%25')).body.total).toBe(0); // wildcard characters are literal
    expect((await list('?category=bogus')).status).toBe(400); expect((await list('?limit=1&q=zeta')).body.items).toHaveLength(1); expect((await list('?limit=1&offset=1&q=zeta')).body.items).toHaveLength(1);
    // installs: add ZetaTunes to a server through the normal OAuth flow
    const guild = (await api.req('POST', '/guilds', o.token, { name: 'Home' })).body;
    expect((await api.req('POST', '/oauth2/authorize', o.token, { clientId: b.id, scope: 'bot', permissions: '0', guildId: guild.id })).status).toBe(200);
    const pop = (await list('?q=zeta')).body; expect(pop.items.map((i: any) => [i.name, i.installs])).toEqual([['ZetaTunes', 1], ['ZetaMod', 0]]);
    expect((await api.req('GET', `/directory/apps/${b.id}`, viewer.token)).body).toMatchObject({ name: 'ZetaTunes', installs: 1, category: 'music' });
    expect((await api.req('GET', `/directory/apps/${hidden.id}`, viewer.token)).status).toBe(404);
    const cats = (await api.req('GET', '/directory/categories', viewer.token)).body; expect(cats.find((c: any) => c.id === 'music').count).toBeGreaterThanOrEqual(1); expect(cats.map((c: any) => c.id)).toContain('moderation');
    // private bots vanish at once, unlisting too
    await api.req('PATCH', `/applications/${a.id}`, o.token, { botPublic: false });
    expect((await list('?q=zetamod')).body.total).toBe(0); expect((await api.req('GET', `/applications/${a.id}`, o.token)).body.directory.listed).toBe(false);
    await api.req('PATCH', `/applications/${b.id}`, o.token, { directoryListed: false });
    expect((await api.req('GET', `/directory/apps/${b.id}`, viewer.token)).status).toBe(404);
  });
});
