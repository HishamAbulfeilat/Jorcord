import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('message edits', () => {
  it('are subject to AutoMod and blocked while timed out', async () => {
    const owner = await api.register('o');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Edit', template: 'community' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const u = await api.register('m'); await api.req('POST', `/invites/${code}`, u.token);
    const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
    await api.req('POST', `/guilds/${guild.id}/automod/rules`, owner.token, { name: 'kw', trigger: 'keyword', keywords: ['forbidden'], action: 'block' });
    const send = async (c: any, content: string) => (await api.req('POST', `/channels/${general.id}/messages`, c.token, { content })).body;
    const edit = (c: any, id: string, content: string) => api.req('PATCH', `/channels/${general.id}/messages/${id}`, c.token, { content });

    const m = await send(u, 'harmless');
    const blocked = await edit(u, m.id, 'now forbidden stuff');
    expect(blocked.status).toBe(400); expect(blocked.body.code).toBe('AUTOMOD_BLOCKED');
    expect((await edit(u, m.id, 'still fine')).status).toBe(200);
    const om = await send(owner, 'owner msg'); // MANAGE_GUILD members are exempt, like on send
    expect((await edit(owner, om.id, 'forbidden but exempt')).status).toBe(200);

    await env.ctx.db.query("UPDATE members SET timeout_until = now() + interval '1 hour' WHERE guild_id = $1 AND user_id = $2", [guild.id, u.id]);
    await env.ctx.pcache.invalidate({ k: 'member', guildId: guild.id, userId: u.id });
    expect((await edit(u, m.id, 'edited while timed out')).status).toBe(403);
  });
});
