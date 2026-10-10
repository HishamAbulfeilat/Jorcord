import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snowflake, type LinkedCriterion } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { allMet, evalCriterion, needsOf, type Facts } from '../src/services/linkedroles';
import { sweepLinkedRoles } from '../src/services/sweeper';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });
const botReq = (method: string, url: string, token: string, body?: unknown) => api.req(method, url, null, body, { authorization: `Bot ${token}` });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Linked', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (n = 'm') => { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); return u; };
  const role = async (name: string) => (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name })).body;
  const link = (roleId: string, criteria: LinkedCriterion[], extra: object = {}) => api.req('POST', `/guilds/${guild.id}/linked-roles`, owner.token, { roleId, criteria, ...extra });
  const rolesOf = async (uid: string) => (await api.req('GET', `/guilds/${guild.id}/members/${uid}`, owner.token)).body.roles as string[];
  return { owner, guild, join, role, link, rolesOf };
}
const facts = (o: Partial<Facts> = {}): Facts => ({ accountCreatedAt: Date.now() - 10 * 86400_000, joinedAt: Date.now() - 3 * 86400_000, now: Date.now(), messageCount: 7, verifiedConnections: [], appValues: {}, ...o });

describe('criteria (pure)', () => {
  it('account age, join age, message count, connections', () => {
    expect(evalCriterion({ type: 'account_age_days', value: 10 }, facts())).toEqual({ met: true, current: 10 });
    expect(evalCriterion({ type: 'account_age_days', value: 11 }, facts()).met).toBe(false);
    expect(evalCriterion({ type: 'join_age_days', value: 3 }, facts())).toEqual({ met: true, current: 3 });
    expect(evalCriterion({ type: 'join_age_days', value: 4 }, facts()).met).toBe(false);
    expect(evalCriterion({ type: 'message_count', value: 7 }, facts())).toEqual({ met: true, current: 7 });
    expect(evalCriterion({ type: 'message_count', value: 8 }, facts()).met).toBe(false);
    expect(evalCriterion({ type: 'connection' }, facts()).met).toBe(false);
    expect(evalCriterion({ type: 'connection' }, facts({ verifiedConnections: ['github'] })).met).toBe(true);
    expect(evalCriterion({ type: 'connection', provider: 'twitch' }, facts({ verifiedConnections: ['github'] })).met).toBe(false);
    expect(evalCriterion({ type: 'connection', provider: 'github' }, facts({ verifiedConnections: ['github'] })).met).toBe(true);
  });
  it('app metadata: operators, types, and "no value reported"', () => {
    const f = facts({ appValues: { a1: { level: 5, pro: true } } });
    const c = (op: any, value: any, key = 'level'): LinkedCriterion => ({ type: 'app_metadata', appId: 'a1', key, op, value });
    expect([c('>=', 5), c('>=', 6), c('<=', 5), c('=', 5), c('!=', 5), c('=', 4)].map((x) => evalCriterion(x, f).met)).toEqual([true, false, true, true, false, false]);
    expect(evalCriterion(c('=', true, 'pro'), f).met).toBe(true); expect(evalCriterion(c('=', 1, 'pro'), f).met).toBe(false); // type must match
    expect(evalCriterion(c('>=', 1, 'missing'), f)).toEqual({ met: false, current: null });
    expect(evalCriterion({ ...c('!=', 1), appId: 'other' }, f).met).toBe(true);
  });
  it('all criteria must hold; an empty list never grants', () => {
    const cs: LinkedCriterion[] = [{ type: 'message_count', value: 5 }, { type: 'account_age_days', value: 100 }];
    expect(allMet(cs, facts())).toBe(false); expect(allMet(cs.slice(0, 1), facts())).toBe(true); expect(allMet([], facts())).toBe(false);
    expect(needsOf(cs)).toEqual({ messages: true, connections: false, apps: false });
  });
});

describe('linked roles API', () => {
  it('managers only; validates the role, its position, and every criterion', async () => {
    const { owner, guild, join, role, link } = await setup(); const m = await join('m'); const r = await role('Regular');
    const post = (tok: string, body: object) => api.req('POST', `/guilds/${guild.id}/linked-roles`, tok, body);
    expect((await post(m.token, { roleId: r.id, criteria: [{ type: 'message_count', value: 1 }] })).status).toBe(403);
    expect((await api.req('GET', `/guilds/${guild.id}/linked-roles`, (await api.register('out')).token)).status).toBe(404);
    const bad: [string, any][] = [['no criteria', []], ['too many', Array(6).fill({ type: 'message_count', value: 1 })], ['neg days', [{ type: 'account_age_days', value: -1 }]], ['huge days', [{ type: 'join_age_days', value: 99999 }]], ['zero msgs', [{ type: 'message_count', value: 0 }]],
      ['junk type', [{ type: 'is_cool' }]], ['extra key', [{ type: 'message_count', value: 1, x: 1 }]], ['bad provider', [{ type: 'connection', provider: 'myspace' }]], ['unknown app', [{ type: 'app_metadata', appId: '1', key: 'k', op: '>=', value: 1 }]]];
    for (const [name, criteria] of bad) expect((await post(owner.token, { roleId: r.id, criteria })).status, name).toBe(400);
    expect((await post(owner.token, { roleId: guild.id, criteria: [{ type: 'message_count', value: 1 }] })).status).toBe(404); // @everyone
    expect((await post(owner.token, { roleId: snowflake(), criteria: [{ type: 'message_count', value: 1 }] })).status).toBe(404);
    const ok = await link(r.id, [{ type: 'message_count', value: 3 }], { description: 'Chatty folks' });
    expect(ok.status).toBe(201); expect(ok.body).toMatchObject({ roleId: r.id, description: 'Chatty folks', granted: false, holders: 0, role: { name: 'Regular' }, progress: [{ met: false, current: 0 }] });
    expect((await link(r.id, [{ type: 'message_count', value: 3 }])).status).toBe(400); // a linked role is managed already
    const booster = await role('Other'); await env.ctx.db.query(`UPDATE roles SET managed_kind = 'booster' WHERE id = $1`, [booster.id]);
    expect((await link(booster.id, [{ type: 'message_count', value: 1 }])).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/linked-roles/${ok.body.id}`, m.token, { description: 'x' })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/linked-roles/${ok.body.id}`, owner.token, { criteria: [] })).status).toBe(400);
    const up = await api.req('PATCH', `/guilds/${guild.id}/linked-roles/${ok.body.id}`, owner.token, { description: null, criteria: [{ type: 'join_age_days', value: 1 }] });
    expect(up.body).toMatchObject({ description: null, criteria: [{ type: 'join_age_days', value: 1 }] });
    expect((await api.req('DELETE', `/guilds/${guild.id}/linked-roles/${ok.body.id}`, m.token)).status).toBe(403);
  });

  it('a moderator cannot link a role above them or one carrying permissions they lack', async () => {
    const { owner, guild, join, role, link } = await setup(); const mod = await join('mod');
    const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Mod', permissions: '268435456' /* MANAGE_ROLES */ })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${mod.id}`, owner.token, { roles: [modRole.id] });
    const high = await role('High'); await api.req('PATCH', `/guilds/${guild.id}/roles/${high.id}`, owner.token, { position: 50 }).catch(() => {});
    const strong = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Strong', permissions: '8' /* ADMINISTRATOR */ })).body;
    await env.ctx.db.query('UPDATE roles SET position = 1 WHERE id = $1', [strong.id]); await env.ctx.db.query('UPDATE roles SET position = 5 WHERE id = $1', [modRole.id]);
    const post = (roleId: string) => api.req('POST', `/guilds/${guild.id}/linked-roles`, mod.token, { roleId, criteria: [{ type: 'message_count', value: 1 }] });
    expect((await post(strong.id)).status).toBe(403); // would escalate
    await env.ctx.db.query('UPDATE roles SET position = 9 WHERE id = $1', [high.id]);
    expect((await post(high.id)).status).toBe(403); // above the moderator's top role
    void link;
  });

  it('grants on join, on refresh and on sync; revokes when criteria stop holding; managed roles cannot be hand-assigned', async () => {
    const { owner, guild, join, role, link, rolesOf } = await setup();
    const early = await join('early'); const r = await role('Veteran'); const msgRole = await role('Chatty');
    const ws = await WsClient.connect(env.port); await ws.identify(owner.token);
    // account age >= 0 days holds for everybody: existing members are synced after creation, new ones on join
    const v = await link(r.id, [{ type: 'account_age_days', value: 0 }]); expect(v.status).toBe(201);
    await ws.waitEvent('LINKED_ROLES_UPDATE', (d) => d.guildId === guild.id);
    await ws.waitEvent('MEMBER_UPDATE', (d) => d.user.id === early.id && d.roles.includes(r.id));
    const late = await join('late'); expect(await rolesOf(late.id)).toContain(r.id);
    const bot = (await api.req('GET', `/guilds/${guild.id}/members?limit=100`, owner.token)).body; void bot;
    // hand assignment of a linked role is refused, and a full-list PATCH cannot strip it either
    const third = await join('third'); await env.ctx.db.query('DELETE FROM member_roles WHERE user_id = $1', [third.id]); await env.ctx.pcache.invalidate({ k: 'member', guildId: guild.id, userId: third.id });
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${third.id}`, owner.token, { roles: [r.id] })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${early.id}`, owner.token, { roles: [] })).body.roles).toEqual([r.id]);
    // message count with refresh (the message hook is throttled to once a minute)
    await link(msgRole.id, [{ type: 'message_count', value: 2 }]);
    const general = guild.channels.find((c: any) => c.type === 'text');
    const say = (tok: string) => api.req('POST', `/channels/${general.id}/messages`, tok, { content: 'hello there' });
    await say(late.token);
    const refresh = () => api.req('POST', `/guilds/${guild.id}/linked-roles/refresh`, late.token);
    expect((await refresh()).body.find((x: any) => x.roleId === msgRole.id)).toMatchObject({ granted: false, progress: [{ met: false, current: 1 }] });
    await say(late.token);
    expect((await refresh()).body.find((x: any) => x.roleId === msgRole.id)).toMatchObject({ granted: true, holders: 1, progress: [{ met: true, current: 2 }] });
    expect(await rolesOf(late.id)).toContain(msgRole.id);
    // criteria raised: the next sync takes it back
    const lr = (await api.req('GET', `/guilds/${guild.id}/linked-roles`, owner.token)).body.find((x: any) => x.roleId === msgRole.id);
    await api.req('PATCH', `/guilds/${guild.id}/linked-roles/${lr.id}`, owner.token, { criteria: [{ type: 'message_count', value: 50 }] });
    const sync = await api.req('POST', `/guilds/${guild.id}/linked-roles/sync`, owner.token); expect(sync.status).toBe(200); expect(sync.body.checked).toBeGreaterThanOrEqual(3);
    expect(await rolesOf(late.id)).not.toContain(msgRole.id);
    expect((await api.req('POST', `/guilds/${guild.id}/linked-roles/sync`, late.token)).status).toBe(403);
    // unlinking keeps holders and makes the role assignable again
    await api.req('DELETE', `/guilds/${guild.id}/linked-roles/${v.body.id}`, owner.token);
    expect(await rolesOf(late.id)).toContain(r.id);
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${third.id}`, owner.token, { roles: [r.id] })).status).toBe(200);
    ws.close();
  });

  it('verified connections and join age; the sweeper applies time-based criteria', async () => {
    const { owner, guild, join, role, link, rolesOf } = await setup(); const u = await join('u'); const r = await role('Linked'); const old = await role('Old');
    await link(r.id, [{ type: 'connection', provider: 'github' }]); await link(old.id, [{ type: 'join_age_days', value: 7 }]);
    const refresh = () => api.req('POST', `/guilds/${guild.id}/linked-roles/refresh`, u.token);
    await refresh(); expect(await rolesOf(u.id)).toEqual([]);
    await env.ctx.db.query(`INSERT INTO connections (id, user_id, type, handle, url, verified, verify_token) VALUES ($1,$2,'github','x','https://github.com/x',false,'t')`, [snowflake(), u.id]);
    await refresh(); expect(await rolesOf(u.id)).toEqual([]); // unverified does not count
    await env.ctx.db.query(`UPDATE connections SET verified = true WHERE user_id = $1`, [u.id]);
    await refresh(); expect(await rolesOf(u.id)).toEqual([r.id]);
    await env.ctx.db.query(`UPDATE members SET joined_at = now() - interval '8 days' WHERE user_id = $1 AND guild_id = $2`, [u.id, guild.id]);
    expect(await sweepLinkedRoles(env.ctx, true)).toBeGreaterThanOrEqual(1);
    expect((await rolesOf(u.id)).sort()).toEqual([r.id, old.id].sort());
    void owner;
  });
});

describe('app-provided metadata (bot API)', () => {
  async function appInGuild(owner: any, guild: any, name = 'Rank') {
    const app = (await api.req('POST', '/applications', owner.token, { name })).body;
    const z = await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot', permissions: '0', guildId: guild.id }); expect(z.status).toBe(200);
    return { app, token: app.token as string };
  }
  it('declare fields, set per-member values, role follows the value; strict ownership and typing', async () => {
    const { owner, guild, join, role, link, rolesOf } = await setup(); const u = await join('u'); const stranger = await api.register('s');
    const { app, token } = await appInGuild(owner, guild); const other = await appInGuild(owner, guild, 'Other');
    expect((await api.req('PUT', '/applications/@me/role-metadata', owner.token, [])).status).toBe(403); // users cannot
    expect((await botReq('PUT', '/applications/@me/role-metadata', token, [{ key: 'Bad Key', name: 'x', type: 'integer' }])).status).toBe(400);
    expect((await botReq('PUT', '/applications/@me/role-metadata', token, [{ key: 'a', name: 'a', type: 'integer' }, { key: 'a', name: 'b', type: 'integer' }])).status).toBe(400);
    expect((await botReq('PUT', '/applications/@me/role-metadata', token, Array(6).fill(0).map((_, i) => ({ key: `k${i}`, name: 'x', type: 'integer' })))).status).toBe(400);
    const decl = await botReq('PUT', '/applications/@me/role-metadata', token, [{ key: 'level', name: 'Level', type: 'integer' }, { key: 'pro', name: 'Pro', type: 'boolean', description: 'Subscriber' }]);
    expect(decl.status).toBe(200); expect((await botReq('GET', '/applications/@me/role-metadata', token)).body.map((f: any) => f.key)).toEqual(['level', 'pro']);
    expect((await api.req('GET', `/guilds/${guild.id}/linked-roles/apps`, owner.token)).body).toMatchObject([{ appId: app.id, name: 'Rank', fields: [{ key: 'level' }, { key: 'pro' }] }]);
    expect((await api.req('GET', `/guilds/${guild.id}/linked-roles/apps`, u.token)).status).toBe(403);
    const r = await role('Level 5');
    const crit = (key: string, op: string, value: any) => [{ type: 'app_metadata', appId: app.id, key, op, value }] as LinkedCriterion[];
    expect((await link(r.id, crit('nope', '>=', 1))).status).toBe(400); expect((await link(r.id, crit('level', '>=', true))).status).toBe(400); expect((await link(r.id, crit('pro', '>=', true))).status).toBe(400);
    expect((await link(r.id, [{ type: 'app_metadata', appId: other.app.id, key: 'level', op: '>=', value: 1 }])).status).toBe(400); // other app declared nothing
    expect((await link(r.id, crit('level', '>=', 5))).status).toBe(201);
    const put = (values: object, uid = u.id, tok = token) => botReq('PUT', `/applications/@me/users/${uid}/role-metadata`, tok, { values });
    expect((await put({ level: 'high' })).status).toBe(400); expect((await put({ unknown: 1 })).status).toBe(400); expect((await put({ pro: 1 })).status).toBe(400);
    expect((await put({ level: 3 }, stranger.id)).status).toBe(404); // shares no server with the bot
    expect((await api.req('PUT', `/applications/@me/users/${u.id}/role-metadata`, u.token, { values: { level: 9 } })).status).toBe(403); // a member cannot grant themselves
    expect((await put({ level: 3 })).status).toBe(200); expect(await rolesOf(u.id)).toEqual([]);
    expect((await put({ level: 9, pro: true })).status).toBe(200); expect(await rolesOf(u.id)).toEqual([r.id]);
    expect((await botReq('GET', `/applications/@me/users/${u.id}/role-metadata`, token)).body.values).toEqual({ level: 9, pro: true });
    // another app cannot influence this app's criteria
    await botReq('PUT', '/applications/@me/role-metadata', other.token, [{ key: 'level', name: 'Level', type: 'integer' }]);
    expect((await put({ level: 1 }, u.id, other.token)).status).toBe(200); expect(await rolesOf(u.id)).toEqual([r.id]);
    expect((await put({ level: 2 })).status).toBe(200); expect(await rolesOf(u.id)).toEqual([]);
    await put({ level: 9 }); expect(await rolesOf(u.id)).toEqual([r.id]);
    expect((await botReq('DELETE', `/applications/@me/users/${u.id}/role-metadata`, token)).status).toBe(204); expect(await rolesOf(u.id)).toEqual([]);
    expect((await botReq('GET', `/applications/@me/users/${u.id}/role-metadata`, token)).status).toBe(404);
  });
});
