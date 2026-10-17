import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snowflake } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Boost', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (n = 'm') => { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); return u; };
  const sys = guild.channels.find((c: any) => c.id === guild.systemChannelId) ?? guild.channels.find((c: any) => c.type === 'text');
  await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { systemChannelId: sys.id });
  return { owner, guild, join, sys };
}
const boost = (g: string, c: { token: string }, body?: object) => api.req('POST', `/guilds/${g}/boosts`, c.token, body);
const summary = async (g: string, c: { token: string }) => (await api.req('GET', `/guilds/${g}/boosts`, c.token)).body;
const history = async (c: { token: string }, ch: string) => (await api.req('GET', `/channels/${ch}/messages?limit=50`, c.token)).body as any[];

describe('boost levels', () => {
  it('summarises count, level, perks, next level and boosters; members only', async () => {
    const { guild, join, owner } = await setup(); const a = await join('a'), b = await join('b'); const out = await api.register('out');
    expect((await api.req('GET', `/guilds/${guild.id}/boosts`, out.token)).status).toBe(404);
    const s0 = await summary(guild.id, a);
    expect(s0).toMatchObject({ count: 0, level: 0, boostsToNext: 2, myBoosts: 0, boosters: [], perks: { emojiSlots: 50, stickerSlots: 5 }, nextLevel: { level: 1, boosts: 2 }, settings: { announce: true, boosterRole: true, boosterRoleId: null } });
    expect((await boost(guild.id, a)).status).toBe(201);
    expect((await boost(guild.id, b, { count: 3 })).status).toBe(201);
    const s = await summary(guild.id, a);
    expect(s).toMatchObject({ count: 4, level: 1, myBoosts: 1, boostsToNext: 3, perks: { emojiSlots: 100 } });
    expect(s.boosters.map((x: any) => [x.user.id, x.boosts])).toEqual([[a.id, 1], [b.id, 3]]);
    expect((await boost(guild.id, a, { count: 11 })).status).toBe(400); expect((await boost(guild.id, a, { count: 0 })).status).toBe(400);
    expect((await api.req('GET', `/guilds/${guild.id}`, owner.token)).body).toMatchObject({ boostCount: 4, boostLevel: 1 });
    await boost(guild.id, a, { count: 10 }); expect((await summary(guild.id, a)).level).toBe(3); expect((await summary(guild.id, a)).nextLevel).toBeNull();
  });

  it('booster role: created on first boost, hoisted + managed, kept/removed with the last boost, protected from hand edits', async () => {
    const { guild, join, owner } = await setup(); const a = await join('a'), other = await join('c');
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);
    await boost(guild.id, a);
    const roleId = (await summary(guild.id, a)).settings.boosterRoleId; expect(roleId).toBeTruthy();
    await ws.waitEvent('ROLE_CREATE', (d) => d.id === roleId);
    const upd = await ws.waitEvent('MEMBER_UPDATE', (d) => d.user.id === a.id && d.roles.includes(roleId));
    expect(upd.d.boostingSince).toBeTruthy();
    const role = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.id === roleId);
    expect(role).toMatchObject({ name: 'Server Booster', hoist: true, permissions: '0' });
    expect((await api.req('GET', `/guilds/${guild.id}/members/${a.id}`, owner.token)).body.boostingSince).toBeTruthy();
    // managers cannot hand it out, strip it, or delete it
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${other.id}`, owner.token, { roles: [roleId] })).status).toBe(400);
    const keep = await api.req('PATCH', `/guilds/${guild.id}/members/${a.id}`, owner.token, { roles: [] });
    expect(keep.status).toBe(200); expect(keep.body.roles).toEqual([roleId]);
    expect((await api.req('DELETE', `/guilds/${guild.id}/roles/${roleId}`, owner.token)).status).toBe(400);
    // second boost, take back one: still a booster; the last one removes the role
    await boost(guild.id, a);
    expect((await api.req('DELETE', `/guilds/${guild.id}/boosts`, a.token)).body.myBoosts).toBe(1);
    expect((await api.req('GET', `/guilds/${guild.id}/members/${a.id}`, owner.token)).body.roles).toContain(roleId);
    await api.req('DELETE', `/guilds/${guild.id}/boosts`, a.token);
    const m = (await api.req('GET', `/guilds/${guild.id}/members/${a.id}`, owner.token)).body; expect(m.roles).not.toContain(roleId); expect(m.boostingSince).toBeNull();
    expect((await api.req('DELETE', `/guilds/${guild.id}/boosts`, a.token)).status).toBe(404);
    ws.close();
  });

  it('settings: managers only; turning the booster role off deletes it, on gives it back to current boosters', async () => {
    const { guild, join, owner } = await setup(); const a = await join('a');
    await boost(guild.id, a);
    const roleId = (await summary(guild.id, a)).settings.boosterRoleId;
    expect((await api.req('PATCH', `/guilds/${guild.id}/boosts/settings`, a.token, { boosterRole: false })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/boosts/settings`, owner.token, { boosterRole: 'no' })).status).toBe(400);
    const off = await api.req('PATCH', `/guilds/${guild.id}/boosts/settings`, owner.token, { boosterRole: false });
    expect(off.body.settings).toMatchObject({ boosterRole: false, boosterRoleId: null });
    expect((await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.some((r: any) => r.id === roleId)).toBe(false);
    expect((await api.req('GET', `/guilds/${guild.id}/members/${a.id}`, owner.token)).body.roles).toEqual([]);
    const on = await api.req('PATCH', `/guilds/${guild.id}/boosts/settings`, owner.token, { boosterRole: true });
    expect((await api.req('GET', `/guilds/${guild.id}/members/${a.id}`, owner.token)).body.roles).toEqual([on.body.settings.boosterRoleId]);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs?action=BOOST_UPDATE`, owner.token)).body).toHaveLength(2);
  });

  it('announces boosts in the system channel, with the level when one is reached; can be switched off', async () => {
    const { guild, join, owner, sys } = await setup(); const a = await join('a');
    await boost(guild.id, a);
    await boost(guild.id, a);
    const boosts = (await history(owner, sys.id)).filter((m) => m.type === 'boost').reverse();
    expect(boosts.map((m) => m.content)).toEqual(['', 'level:1']);
    await api.req('PATCH', `/guilds/${guild.id}/boosts/settings`, owner.token, { announce: false });
    await boost(guild.id, a, { count: 5 });
    expect((await history(owner, sys.id)).filter((m) => m.type === 'boost')).toHaveLength(2);
  });

  it('emoji and sticker slots follow the level (free boosts raise them)', async () => {
    const { guild, join, owner } = await setup(); const a = await join('a');
    for (let i = 0; i < 50; i++) await env.ctx.db.query('INSERT INTO emojis (id, guild_id, name, animated, url) VALUES ($1,$2,$3,false,$4)', [snowflake(), guild.id, `e${i}x`, '/api/v1/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.png']);
    for (let i = 0; i < 5; i++) await env.ctx.db.query('INSERT INTO stickers (id, guild_id, name, url, format) VALUES ($1,$2,$3,$4,$5)', [snowflake(), guild.id, `s${i}x`, '/api/v1/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.png', 'png']);
    const emoji = () => api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'extra', url: '/api/v1/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.png' });
    const sticker = () => api.req('POST', `/guilds/${guild.id}/stickers`, owner.token, { name: 'extra', url: '/api/v1/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.png' });
    const e0 = await emoji(); expect(e0.status).toBe(400); expect(e0.body.code).toBe('MAX_EMOJIS'); expect(e0.body.message).toContain('50');
    expect((await sticker()).body.code).toBe('MAX_STICKERS');
    await boost(guild.id, a, { count: 2 });
    expect((await emoji()).status).toBe(201); expect((await sticker()).status).toBe(201);
  });
});
