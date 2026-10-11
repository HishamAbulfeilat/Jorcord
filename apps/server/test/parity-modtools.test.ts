import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { csvCell } from '../src/routes/modtools';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Mods', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (n = 'm') => { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); return u; };
  const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Mod', permissions: (1n << 1n | 1n << 2n | 1n << 40n).toString() })).body; // KICK | BAN | MODERATE (see below)
  return { owner, guild, join, modRole };
}
// resolve real permission bits instead of guessing
import { Perm } from '@jorcord/shared';
async function withMod() {
  const s = await setup(); const mod = await s.join('mod');
  const role = (await api.req('POST', `/guilds/${s.guild.id}/roles`, s.owner.token, { name: 'Mods', permissions: (Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.VIEW_AUDIT_LOG).toString() })).body;
  await api.req('PATCH', `/guilds/${s.guild.id}/members/${mod.id}`, s.owner.token, { roles: [role.id] });
  return { ...s, mod };
}

describe('csv cells', () => {
  it('quotes and neutralises formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"'); expect(csvCell('say "hi"')).toBe('"say ""hi"""'); expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1"); expect(csvCell('-2')).toBe("'-2"); expect(csvCell('@x')).toBe("'@x"); expect(csvCell(null)).toBe(''); expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('mod view, warnings, notes', () => {
  it('shows moderation info with flags; only moderators may look', async () => {
    const { owner, guild, join, mod } = await withMod(); const u = await join('target'); const plain = await join('plain');
    const view = (tok: string, uid = u.id) => api.req('GET', `/guilds/${guild.id}/members/${uid}/mod-view`, tok);
    expect((await view(plain.token)).status).toBe(403);
    const v = (await view(mod.token)).body;
    expect(v).toMatchObject({ isMember: true, banned: false, flags: ['new_account'], counts: { timeouts: 0, bans: 0, kicks: 0, warnings: 0 }, warnings: [], notes: [] });
    expect(v.mutualGuilds.map((g: any) => g.id)).toEqual([guild.id]); expect(v.joinedAt).toBeTruthy(); expect(v.accountCreatedAt).toBeTruthy();
    // flags: old account, raid joined, DM restricted, spam suspect
    await env.ctx.db.query(`UPDATE users SET created_at = now() - interval '30 days', privacy = '{"allowDmsFromServerMembers":false}'::jsonb WHERE id = $1`, [u.id]);
    await env.ctx.db.query('UPDATE members SET raid_flagged = true WHERE user_id = $1', [u.id]);
    for (let i = 0; i < 3; i++) await env.ctx.db.query(`INSERT INTO audit_log (id, guild_id, actor_id, action) VALUES ($1,$2,$3,'AUTOMOD_BLOCK')`, [`9${i}${Date.now()}`, guild.id, u.id]);
    expect((await view(mod.token)).body.flags.sort()).toEqual(['dm_restricted', 'raid_joined', 'spam_suspect']);
    // history: timeout then kick the user
    await api.req('PATCH', `/guilds/${guild.id}/members/${u.id}`, mod.token, { timeoutUntil: new Date(Date.now() + 3600_000).toISOString() });
    const after = (await view(owner.token)).body; expect(after.counts.timeouts).toBe(1); expect(after.timeoutUntil).toBeTruthy(); expect(after.history[0]).toMatchObject({ action: 'MEMBER_TIMEOUT', moderatorId: mod.id });
    await api.req('DELETE', `/guilds/${guild.id}/members/${u.id}`, mod.token);
    const gone = (await view(mod.token)).body; expect(gone).toMatchObject({ isMember: false, counts: { kicks: 1 } });
    expect((await view(mod.token, (await api.register('stranger')).id)).status).toBe(404); // never seen here
  });

  it('warnings: moderators warn lower-ranked members, the warned member is told, history lists them, deletes are audited', async () => {
    const { owner, guild, join, mod } = await withMod(); const u = await join('w'); const peer = await join('peer');
    const ws = await WsClient.connect(env.port); await ws.identify(u.token);
    const warn = (tok: string, uid: string, reason: string) => api.req('POST', `/guilds/${guild.id}/members/${uid}/warnings`, tok, { reason });
    expect((await warn(peer.token, u.id, 'x')).status).toBe(403);
    expect((await warn(mod.token, u.id, '  ')).status).toBe(400); expect((await warn(mod.token, u.id, 'x'.repeat(501))).status).toBe(400);
    expect((await warn(mod.token, mod.id, 'self')).status).toBe(400); expect((await warn(mod.token, owner.id, 'owner')).status).toBe(403);
    const w = await warn(mod.token, u.id, 'Spamming links'); expect(w.status).toBe(201); expect(w.body).toMatchObject({ reason: 'Spamming links', moderatorId: mod.id, source: 'manual' });
    expect((await ws.waitEvent('MOD_WARNING')).d).toMatchObject({ guildId: guild.id, reason: 'Spamming links' });
    await warn(mod.token, u.id, 'Again');
    expect((await api.req('GET', `/guilds/${guild.id}/members/${u.id}/warnings`, mod.token)).body.map((x: any) => x.reason)).toEqual(['Again', 'Spamming links']);
    expect((await api.req('GET', `/guilds/${guild.id}/members/${u.id}/warnings`, u.token)).status).toBe(403); // not even your own list
    expect((await api.req('GET', `/guilds/${guild.id}/members/${u.id}/mod-view`, mod.token)).body.counts.warnings).toBe(2);
    expect((await api.req('DELETE', `/guilds/${guild.id}/warnings/${w.body.id}`, peer.token)).status).toBe(403);
    expect((await api.req('DELETE', `/guilds/${guild.id}/warnings/${w.body.id}`, mod.token)).status).toBe(204);
    expect((await api.req('DELETE', `/guilds/${guild.id}/warnings/${w.body.id}`, mod.token)).status).toBe(404);
    const actions = (await api.req('GET', `/guilds/${guild.id}/audit-logs`, owner.token)).body.map((e: any) => e.action);
    expect(actions).toContain('MEMBER_WARN'); expect(actions).toContain('MEMBER_WARN_DELETE');
    ws.close();
  });

  it('notes: moderators only, capped, author or manager may delete', async () => {
    const { owner, guild, join, mod } = await withMod(); const u = await join('n'); const plain = await join('plain');
    const post = (tok: string, note: string) => api.req('POST', `/guilds/${guild.id}/members/${u.id}/notes`, tok, { note });
    expect((await post(plain.token, 'hi')).status).toBe(403); expect((await post(mod.token, '')).status).toBe(400); expect((await post(mod.token, 'x'.repeat(1001))).status).toBe(400);
    const n = await post(mod.token, 'Asked about rules twice'); expect(n.status).toBe(201); expect(n.body).toMatchObject({ note: 'Asked about rules twice', authorId: mod.id });
    expect((await api.req('GET', `/guilds/${guild.id}/members/${u.id}/mod-view`, owner.token)).body.notes).toHaveLength(1);
    const mod2 = await join('mod2'); const r2 = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === 'Mods');
    await api.req('PATCH', `/guilds/${guild.id}/members/${mod2.id}`, owner.token, { roles: [r2.id] });
    expect((await api.req('DELETE', `/guilds/${guild.id}/notes/${n.body.id}`, mod2.token)).status).toBe(403); // not yours, not a manager
    expect((await api.req('DELETE', `/guilds/${guild.id}/notes/${n.body.id}`, owner.token)).status).toBe(204);
    for (let i = 0; i < 25; i++) await post(mod.token, `n${i}`);
    expect((await post(mod.token, 'one more')).body.code).toBe('LIMIT_REACHED');
  });
});

describe('bulk moderation', () => {
  it('dry run is the default; ids and filters respect hierarchy, self and the owner', async () => {
    const { owner, guild, join, mod } = await withMod(); const a = await join('a'), b = await join('b'), c = await join('c');
    const bulk = (tok: string, body: object) => api.req('POST', `/guilds/${guild.id}/moderation/bulk`, tok, body);
    expect((await bulk(a.token, { action: 'kick', userIds: [b.id] })).status).toBe(403);
    expect((await bulk(mod.token, { action: 'kick' })).status).toBe(400); expect((await bulk(mod.token, { action: 'kick', filter: {} })).status).toBe(400); expect((await bulk(mod.token, { action: 'kick', filter: { noRoles: false } })).status).toBe(400);
    expect((await bulk(mod.token, { action: 'kick', userIds: Array(201).fill('1') })).status).toBe(400); expect((await bulk(mod.token, { action: 'nuke', userIds: ['1'] })).status).toBe(400);
    const dry = (await bulk(mod.token, { action: 'ban', userIds: [a.id, b.id, mod.id, owner.id, '999999'] })).body;
    expect(dry).toMatchObject({ dryRun: true, matched: 5, affected: 2 }); expect(dry.skipped.map((s: any) => s.reason).sort()).toEqual(['Server owner', 'That is you', 'Unknown user']);
    expect((await api.req('GET', `/guilds/${guild.id}/bans`, owner.token)).body).toHaveLength(0); // nothing happened
    const run = (await bulk(mod.token, { action: 'ban', userIds: [a.id, b.id], reason: 'raid', dryRun: false })).body;
    expect(run).toMatchObject({ dryRun: false, affected: 2 });
    expect((await api.req('GET', `/guilds/${guild.id}/bans`, owner.token)).body.map((x: any) => x.user.id).sort()).toEqual([a.id, b.id].sort());
    expect((await api.req('GET', `/guilds/${guild.id}/members/${a.id}`, owner.token)).status).toBe(404);
    expect((await bulk(mod.token, { action: 'ban', userIds: [a.id], dryRun: false })).body.skipped).toEqual([{ userId: a.id, reason: 'Already banned' }]);
    // banning someone who already left is possible, kicking one is not
    await api.req('DELETE', `/guilds/${guild.id}/members/${c.id}`, owner.token);
    expect((await bulk(mod.token, { action: 'kick', userIds: [c.id] })).body.skipped[0].reason).toBe('Not a member');
    expect((await bulk(mod.token, { action: 'ban', userIds: [c.id], dryRun: false })).body.affected).toBe(1);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs`, owner.token)).body.map((e: any) => e.action)).toContain('MEMBER_BULK_BAN');
  });

  it('filters: joined within minutes, no roles, young accounts, raid flagged; a moderator cannot touch higher-ranked members', async () => {
    const { owner, guild, join, mod } = await withMod();
    const old = await join('old'), fresh1 = await join('f1'), fresh2 = await join('f2'), withRole = await join('wr');
    await env.ctx.db.query(`UPDATE members SET joined_at = now() - interval '3 hours' WHERE user_id = $1`, [old.id]);
    await env.ctx.db.query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id = ANY($1::text[])`, [[old.id, fresh2.id]]);
    const vip = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'VIP' })).body; await api.req('PATCH', `/guilds/${guild.id}/members/${withRole.id}`, owner.token, { roles: [vip.id] });
    const dry = async (filter: object) => (await api.req('POST', `/guilds/${guild.id}/moderation/bulk`, mod.token, { action: 'kick', filter })).body;
    const names = (r: any) => r.users.map((u: any) => u.username).sort();
    expect(names(await dry({ joinedWithinMinutes: 60, noRoles: true }))).toEqual([fresh1.username, fresh2.username].sort());
    expect((await dry({ joinedWithinMinutes: 60 })).matched).toBe(5); // the owner and the moderator joined moments ago too and are skipped
    expect(names(await dry({ accountYoungerThanDays: 7, noRoles: true }))).toEqual([fresh1.username]);
    await env.ctx.db.query('UPDATE members SET raid_flagged = true WHERE user_id = $1', [fresh2.id]);
    expect(names(await dry({ raidFlagged: true }))).toEqual([fresh2.username]);
    const live = (await api.req('POST', `/guilds/${guild.id}/moderation/bulk`, mod.token, { action: 'kick', filter: { raidFlagged: true }, dryRun: false })).body; expect(live.affected).toBe(1);
    expect((await api.req('GET', `/guilds/${guild.id}/members/${fresh2.id}`, owner.token)).status).toBe(404);
    // rank: the mod role is below "Boss", so Boss holders are skipped
    const boss = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Boss' })).body; await env.ctx.db.query('UPDATE roles SET position = 99 WHERE id = $1', [boss.id]); await env.ctx.pcache.invalidate({ k: 'guild', guildId: guild.id });
    await api.req('PATCH', `/guilds/${guild.id}/members/${old.id}`, owner.token, { roles: [boss.id] });
    const r = (await api.req('POST', `/guilds/${guild.id}/moderation/bulk`, mod.token, { action: 'ban', userIds: [old.id] })).body; expect(r).toMatchObject({ affected: 0, skipped: [{ userId: old.id, reason: 'Outranks you' }] });
  });

  it('raid detection flags the joiners', async () => {
    const { owner, guild, join } = await withMod();
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { raidProtection: { enabled: true, maxJoins: 4, windowSeconds: 60, lockMinutes: 5 } });
    const us = [await join('r1'), await join('r2'), await join('r3')];
    const flagged = await env.ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1 AND raid_flagged', [guild.id]);
    expect(flagged.map((r) => r.user_id)).toEqual(expect.arrayContaining(us.map((u) => u.id)));
    expect(flagged.map((r) => r.user_id)).not.toContain(owner.id);
  });
});

describe('prune', () => {
  it('dry-run count, then removes inactive role-less members; options respected', async () => {
    const { owner, guild, join, mod } = await withMod(); const general = guild.channels.find((c: any) => c.type === 'text');
    const idle = await join('idle'), talker = await join('talker'), roled = await join('roled'), newbie = await join('newbie');
    const old = `now() - interval '40 days'`;
    for (const u of [idle, talker, roled]) await env.ctx.db.query(`UPDATE members SET joined_at = ${old} WHERE user_id = $1`, [u.id]);
    await api.req('POST', `/channels/${general.id}/messages`, talker.token, { content: 'I am active' });
    const vip = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'VIP' })).body; await api.req('PATCH', `/guilds/${guild.id}/members/${roled.id}`, owner.token, { roles: [vip.id] });
    const prune = (tok: string, body: object) => api.req('POST', `/guilds/${guild.id}/prune`, tok, body);
    expect((await prune(idle.token, { days: 7 })).status).toBe(403);
    for (const bad of [{ days: 0 }, { days: 31 }, { days: 7, includeRoles: ['1'] }, { days: 7, x: 1 }, {}]) expect((await prune(mod.token, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await prune(mod.token, { days: 7 })).body).toMatchObject({ dryRun: true, count: 1 }); // idle only: talker posted, roled has a role, newbie is new, mods hold roles
    expect((await prune(mod.token, { days: 7, includeRoles: [vip.id] })).body.count).toBe(2);
    expect((await api.req('GET', `/guilds/${guild.id}/members/${idle.id}`, owner.token)).status).toBe(200); // dry run removed nobody
    const done = (await prune(mod.token, { days: 7, dryRun: false })).body; expect(done).toMatchObject({ dryRun: false, removed: 1, remaining: 0 });
    expect((await api.req('GET', `/guilds/${guild.id}/members/${idle.id}`, owner.token)).status).toBe(404);
    for (const u of [talker, roled, newbie]) expect((await api.req('GET', `/guilds/${guild.id}/members/${u.id}`, owner.token)).status).toBe(200);
    expect((await api.req('GET', `/guilds/${guild.id}/audit-logs?action=MEMBER_PRUNE`, owner.token)).body).toHaveLength(1);
  });
});

describe('moderation log export', () => {
  it('CSV of moderation actions for people who may view the audit log', async () => {
    const { owner, guild, join, mod } = await withMod(); const u = await join('cmd');
    await api.req('POST', `/guilds/${guild.id}/members/${u.id}/warnings`, mod.token, { reason: '=1+1, "quoted"' });
    await api.req('POST', `/guilds/${guild.id}/members/${u.id}/notes`, mod.token, { note: 'n' });
    await api.req('PUT', `/guilds/${guild.id}/roles`, owner.token, {}).catch(() => {});
    const plain = await join('plain');
    expect((await api.req('GET', `/guilds/${guild.id}/mod-log.csv`, plain.token)).status).toBe(403);
    const res = await api.req('GET', `/guilds/${guild.id}/mod-log.csv`, mod.token);
    expect(res.status).toBe(200); expect(res.raw.headers['content-type']).toContain('text/csv'); expect(res.raw.headers['content-disposition']).toContain('attachment');
    const text = res.raw.body; const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('id,time,action,actor_id,actor_name,target_id,target_name,reason,details');
    const warn = lines.find((l: string) => l.includes('MEMBER_WARN'))!; expect(warn).toContain(`"'=1+1, ""quoted"""`);
    expect(lines.some((l: string) => l.includes(',ROLE_CREATE,'))).toBe(false); // non-moderation entries are left out by default
    expect((await api.req('GET', `/guilds/${guild.id}/mod-log.csv?all=true`, mod.token)).raw.body).toContain('ROLE_CREATE');
    expect((await api.req('GET', `/guilds/${guild.id}/mod-log.csv?from=notadate`, mod.token)).status).toBe(400);
    void owner;
  });
});
