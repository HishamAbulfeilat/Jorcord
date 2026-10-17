import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Source', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const m = await api.register('m'); await api.req('POST', `/invites/${code}`, m.token);
  return { owner, guild, m, code };
}
const raw = (url: string) => env.app.inject({ method: 'GET', url: `/api/v1${url}` }); // no auth header

describe('server templates', () => {
  it('snapshots roles, channels and role overwrites; detects drift; creates new servers from it', async () => {
    const { owner, guild, m } = await setup();
    const mod = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Moderator', color: 0x00ff00, hoist: true, permissions: String(Perm.KICK_MEMBERS) })).body;
    const staff = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'staff-only', type: 'text' })).body;
    await api.req('PUT', `/channels/${staff.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    await api.req('PUT', `/channels/${staff.id}/permissions/${mod.id}`, owner.token, { type: 'role', allow: String(Perm.VIEW_CHANNEL), deny: '0' });
    await api.req('PUT', `/channels/${staff.id}/permissions/${m.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL), deny: '0' }); // member overwrites are not carried
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { verificationLevel: 2 });
    expect((await api.req('POST', `/guilds/${guild.id}/templates`, m.token, { name: 'x' })).status).toBe(403);
    const t = await api.req('POST', `/guilds/${guild.id}/templates`, owner.token, { name: 'Community kit', description: 'starter' });
    expect(t.status).toBe(201); expect(t.body.code).toMatch(/^[A-Za-z0-9]{12}$/); expect(t.body).toMatchObject({ name: 'Community kit', usageCount: 0, isDirty: false });
    expect((await api.req('POST', `/guilds/${guild.id}/templates`, owner.token, { name: 'again' })).status).toBe(409);
    // preview for any signed-in user
    const pv = (await api.req('GET', `/guilds/templates/${t.body.code}`, m.token)).body;
    expect(pv.preview.roles.map((r: any) => r.name)).toContain('Moderator'); expect(pv.preview.channels.map((c: any) => c.name)).toContain('staff-only'); expect(pv.sourceGuild.name).toBe('Source');
    expect((await api.req('GET', `/guilds/templates/aaaaaaaaaaaa`, m.token)).status).toBe(404);
    expect((await api.req('GET', `/guilds/templates/${t.body.code}`, null)).status).toBe(401);
    // drift
    await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'later', type: 'text' });
    expect((await api.req('GET', `/guilds/${guild.id}/templates`, owner.token)).body[0].isDirty).toBe(true);
    const synced = await api.req('PUT', `/guilds/${guild.id}/templates/${t.body.code}`, owner.token); expect(synced.body.isDirty).toBe(false);
    expect((await api.req('PATCH', `/guilds/${guild.id}/templates/${t.body.code}`, owner.token, { name: 'Renamed', description: null })).body).toMatchObject({ name: 'Renamed', description: null });
    // create from it
    const wm = await WsClient.connect(env.port); await wm.identify(m.token);
    const made = await api.req('POST', `/guilds/templates/${t.body.code}`, m.token, { name: 'My Copy' });
    expect(made.status).toBe(201); expect(made.body.name).toBe('My Copy'); expect(made.body.ownerId).toBe(m.id); expect(made.body.verificationLevel).toBe(2);
    await wm.waitEvent('GUILD_CREATE', (d) => d.id === made.body.id);
    const full = (await api.req('GET', `/guilds/${made.body.id}`, m.token)).body;
    const role = full.roles.find((r: any) => r.name === 'Moderator'); expect(role).toMatchObject({ hoist: true, color: 0x00ff00, permissions: String(Perm.KICK_MEMBERS) });
    expect(full.members).toHaveLength(1);
    const copy = full.channels.find((c: any) => c.name === 'staff-only');
    expect(copy.overwrites.map((o: any) => o.id).sort()).toEqual([made.body.id, role.id].sort()); // remapped to the new guild's ids, member overwrite dropped
    expect(full.channels.find((c: any) => c.name === 'later')).toBeTruthy(); expect(full.channels.find((c: any) => c.type === 'category')).toBeTruthy();
    expect(full.channels.find((c: any) => c.name === 'rules').parentId).toBe(full.channels.find((c: any) => c.name === 'Info').id);
    expect((await api.req('GET', `/guilds/templates/${t.body.code}`, m.token)).body.usageCount).toBe(1);
    expect((await api.req('POST', `/guilds/templates/${t.body.code}`, m.token, { name: 'x' })).status).toBe(400);
    // delete
    expect((await api.req('DELETE', `/guilds/${guild.id}/templates/${t.body.code}`, owner.token)).status).toBe(204);
    expect((await api.req('POST', `/guilds/templates/${t.body.code}`, m.token, { name: 'Gone' })).status).toBe(404);
    wm.close();
  });
});

describe('widget', () => {
  it('is off by default, public JSON/SVG once enabled, shows only open voice channels and online members', async () => {
    const { owner, guild, m } = await setup();
    expect((await raw(`/guilds/${guild.id}/widget.json`)).statusCode).toBe(404);
    expect((await api.req('GET', `/guilds/${guild.id}/widget`, m.token)).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/widget`, m.token, { enabled: true })).status).toBe(403);
    const general = guild.channels.find((c: any) => c.name === 'general');
    expect((await api.req('PATCH', `/guilds/${guild.id}/widget`, owner.token, { enabled: true, channelId: '1' })).status).toBe(400);
    const s = await api.req('PATCH', `/guilds/${guild.id}/widget`, owner.token, { enabled: true, channelId: general.id });
    expect(s.body).toMatchObject({ enabled: true, channelId: general.id }); expect(s.body.instantInvite).toMatch(/\/invite\/\w{8}$/);
    const vip = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'VIP', type: 'voice' })).body;
    await api.req('PUT', `/channels/${vip.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    const wo = await WsClient.connect(env.port); await wo.identify(owner.token);
    await api.req('PUT', '/users/@me/activities', owner.token, { activities: [{ type: 'playing', name: 'Chess' }] });
    const r = await raw(`/guilds/${guild.id}/widget.json`);
    expect(r.statusCode).toBe(200); expect(r.headers['access-control-allow-origin']).toBe('*');
    const w = r.json();
    expect(w).toMatchObject({ id: guild.id, name: 'Source', presenceCount: 1 });
    expect(w.channels.map((c: any) => c.name)).toContain('Lounge'); expect(w.channels.map((c: any) => c.name)).not.toContain('VIP');
    expect(w.members).toHaveLength(1); expect(w.members[0]).toMatchObject({ username: expect.any(String), status: 'online', activity: 'Chess' });
    expect(JSON.stringify(w)).not.toContain(owner.id); // no real ids or emails
    // the invite works
    const invite = s.body.instantInvite.split('/invite/')[1];
    const joiner = await api.register('j'); expect((await api.req('POST', `/invites/${invite}`, joiner.token)).status).toBe(200);
    const svg = await raw(`/guilds/${guild.id}/widget.svg?theme=light`);
    expect(svg.statusCode).toBe(200); expect(svg.headers['content-type']).toContain('image/svg+xml'); expect(svg.body).toContain('1 online'); expect(svg.body).toContain('Source');
    // names are escaped
    await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { name: '<script>x</script>' });
    expect((await raw(`/guilds/${guild.id}/widget.svg`)).body).not.toContain('<script>');
    await api.req('PATCH', `/guilds/${guild.id}/widget`, owner.token, { enabled: false });
    expect((await raw(`/guilds/${guild.id}/widget.json`)).statusCode).toBe(404);
    wo.close();
  });
});

describe('insights', () => {
  it('counts joins/leaves/messages, top channels and chatters; managers only', async () => {
    const { owner, guild, m } = await setup();
    const general = guild.channels.find((c: any) => c.name === 'general'); const intro = guild.channels.find((c: any) => c.name === 'introductions');
    for (let i = 0; i < 3; i++) await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: `a${i}` });
    await api.req('POST', `/channels/${intro.id}/messages`, m.token, { content: 'hi' });
    const leaver = await api.register('l'); const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, leaver.token); await api.req('DELETE', `/users/@me/guilds/${guild.id}`, leaver.token);
    expect((await api.req('GET', `/guilds/${guild.id}/insights`, m.token)).status).toBe(403);
    expect((await api.req('GET', `/guilds/${guild.id}/insights?days=5`, owner.token)).status).toBe(400);
    const wo = await WsClient.connect(env.port); await wo.identify(owner.token);
    const r = (await api.req('GET', `/guilds/${guild.id}/insights?days=7`, owner.token)).body;
    expect(r.days).toBe(7); expect(r.joins).toHaveLength(7); expect(r.messages).toHaveLength(7);
    expect(r.memberCount).toBe(2); expect(r.onlineNow).toBe(1);
    expect(r.totals).toMatchObject({ joins: 2, leaves: 1, messages: 4, activeChatters: 2 }); // m and leaver joined (the owner's own creation is not a join)
    expect(r.messages[6].count).toBe(4);
    expect(r.topChannels[0]).toMatchObject({ channelId: general.id, count: 3 }); expect(r.topChannels[1]).toMatchObject({ name: 'introductions', count: 1 });
    wo.close();
  });
});
