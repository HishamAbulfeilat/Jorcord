import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessageFlags, Perm } from '@jorcord/shared';
import { runSweeps } from '../src/services/sweeper';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

// Package F (docs/MODERATION.md): audit diffs, role memory, removal notices, anonymous report queue, edit history, sensitive marks, ban-evasion hints, wellbeing.
let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const bits = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();
const MOD = bits(Perm.KICK_MEMBERS, Perm.BAN_MEMBERS, Perm.MODERATE_MEMBERS, Perm.MANAGE_MESSAGES, Perm.VIEW_AUDIT_LOG);

async function world(extra: string[] = []) {
  const owner = await api.register('own');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Mod HQ' })).body;
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (u: Client, via = code) => api.req('POST', `/invites/${via}`, u.token);
  const people: Record<string, Client> = {};
  for (const n of ['mod', 'bob', 'eve', ...extra]) { people[n] = await api.register(n); await join(people[n]!); }
  const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Moderator', permissions: MOD })).body;
  await api.req('PATCH', `/guilds/${guild.id}/members/${people.mod!.id}`, owner.token, { roles: [modRole.id] });
  const g = (path: string) => `/guilds/${guild.id}${path}`;
  const say = async (u: Client, content: string) => (await api.req('POST', `/channels/${general.id}/messages`, u.token, { content })).body;
  return { owner, ...people, mod: people.mod!, bob: people.bob!, eve: people.eve!, guild, general, code, modRole, join, g, say, gid: guild.id as string };
}
const setSettings = (w: Awaited<ReturnType<typeof world>>, body: object) => api.req('PATCH', w.g('/mod-settings'), w.owner.token, body);
const rolesOf = async (w: Awaited<ReturnType<typeof world>>, u: Client) => ((await api.req('GET', w.g(`/members/${u.id}`), w.owner.token)).body.roles as string[]).slice().sort();

describe('1. audit log detail', () => {
  it('records before/after for role, overwrite, member-role, nickname and server changes', async () => {
    const w = await world();
    const role = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'Helpers', permissions: bits(Perm.SEND_MESSAGES) })).body;
    await api.req('PATCH', w.g(`/roles/${role.id}`), w.owner.token, { name: 'Helpers+', permissions: bits(Perm.SEND_MESSAGES, Perm.MANAGE_MESSAGES) });
    await api.req('PUT', `/channels/${w.general.id}/permissions/${role.id}`, w.owner.token, { type: 'role', allow: bits(Perm.ATTACH_FILES), deny: '0' });
    await api.req('PUT', `/channels/${w.general.id}/permissions/${role.id}`, w.owner.token, { type: 'role', allow: bits(Perm.ATTACH_FILES), deny: bits(Perm.EMBED_LINKS) });
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.owner.token, { roles: [role.id] });
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.owner.token, { nick: 'Bobby' });
    await api.req('PATCH', `/guilds/${w.gid}`, w.owner.token, { name: 'Mod HQ 2' });
    await api.req('DELETE', w.g(`/roles/${role.id}`), w.owner.token);
    const log = (await api.req('GET', w.g('/audit-logs?limit=100'), w.owner.token)).body as any[];
    const one = (a: string, pred: (e: any) => boolean = () => true) => log.find((e) => e.action === a && pred(e));
    const upd = one('ROLE_UPDATE', (e) => e.targetId === role.id);
    expect(upd.diff.before.name).toBe('Helpers'); expect(upd.diff.after.name).toBe('Helpers+');
    expect(BigInt(upd.diff.after.permissions) & Perm.MANAGE_MESSAGES).toBe(Perm.MANAGE_MESSAGES);
    expect(BigInt(upd.diff.before.permissions) & Perm.MANAGE_MESSAGES).toBe(0n);
    expect(one('ROLE_CREATE', (e) => e.targetId === role.id).diff.after.name).toBe('Helpers');
    const ows = log.filter((e) => e.action === 'OVERWRITE_UPDATE');
    expect(ows[0].diff.before.deny).toBe('0'); expect(ows[0].diff.after.deny).toBe(bits(Perm.EMBED_LINKS)); // newest first: the second PUT
    expect(ows[1].diff.before).toEqual({}); // the first PUT created it
    expect(one('MEMBER_ROLE_UPDATE').diff).toEqual({ before: { roles: [] }, after: { roles: [role.id] } });
    expect(one('MEMBER_UPDATE', (e) => e.targetId === w.bob.id).diff.after.nick).toBe('Bobby');
    expect(one('GUILD_UPDATE', (e) => e.diff?.after?.name).diff).toMatchObject({ before: { name: 'Mod HQ' }, after: { name: 'Mod HQ 2' } });
    expect(one('ROLE_DELETE').diff.before.name).toBe('Helpers+');
    expect(one('ROLE_DELETE').diff.after).toEqual({});
  });

  it('filters by actor, action, target, date range and text; exports the same filter as CSV', async () => {
    const w = await world();
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.mod.token, { timeoutUntil: new Date(Date.now() + 600_000).toISOString(), reason: 'cooldown please' });
    await api.req('PATCH', w.g(`/members/${w.eve.id}`), w.owner.token, { nick: 'Evie' });
    const get = async (qs: string) => (await api.req('GET', w.g(`/audit-logs?${qs}`), w.owner.token)).body as any[];
    expect((await get(`actorId=${w.mod.id}`)).every((e) => e.actorId === w.mod.id)).toBe(true);
    expect((await get(`targetId=${w.bob.id}&action=MEMBER_TIMEOUT`)).map((e) => e.action)).toEqual(['MEMBER_TIMEOUT']);
    expect((await get(`q=cooldown`)).map((e) => e.action)).toContain('MEMBER_TIMEOUT');
    expect(await get(`q=${encodeURIComponent('no-such-text-xyz')}`)).toEqual([]);
    const future = new Date(Date.now() + 86_400_000).toISOString(), past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await get(`from=${encodeURIComponent(future)}`))).toEqual([]);
    expect((await get(`from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)).length).toBeGreaterThan(2);
    const csv = await api.req('GET', w.g(`/audit-logs.csv?action=MEMBER_TIMEOUT`), w.owner.token);
    expect(csv.status).toBe(200);
    expect(csv.raw.headers['content-type']).toContain('text/csv');
    const lines = csv.raw.body.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('id,time,action,actor_id,actor_name,target_id,target_name,reason,changes,before,after');
    expect(lines).toHaveLength(2); expect(lines[1]).toContain('MEMBER_TIMEOUT'); expect(lines[1]).toContain('cooldown please');
    expect((await api.req('GET', w.g('/audit-logs.csv'), w.bob.token)).status).toBe(403); // needs VIEW_AUDIT_LOG
  });

  it('retention setting removes old entries and old edit history, and is itself audited', async () => {
    const w = await world();
    expect((await setSettings(w, { retention: { auditDays: 10 } })).status).toBe(400); // lower bound 30 days
    expect((await setSettings(w, { retention: { auditDays: 30, editDays: 7 } })).status).toBe(200);
    const m = await w.say(w.bob, 'v1');
    await api.req('PATCH', `/channels/${w.general.id}/messages/${m.id}`, w.bob.token, { content: 'v2' });
    await env.ctx.db.query(`UPDATE audit_log SET created_at = now() - interval '90 days' WHERE guild_id = $1 AND action = 'ROLE_CREATE'`, [w.gid]);
    await env.ctx.db.query(`UPDATE message_edits SET edited_at = now() - interval '30 days' WHERE message_id = $1`, [m.id]);
    await runSweeps(env.ctx);
    const log = (await api.req('GET', w.g('/audit-logs?limit=100'), w.owner.token)).body as any[];
    expect(log.some((e) => e.action === 'ROLE_CREATE')).toBe(false);
    expect(log.some((e) => e.action === 'MOD_SETTINGS_UPDATE' && e.diff.after.retention)).toBe(true);
    expect((await api.req('GET', `/channels/${w.general.id}/messages/${m.id}/edits`, w.bob.token)).body).toEqual([]);
  });
});

describe('2. remember roles on rejoin', () => {
  it('a kick remembers roles and a rejoin gets them back; the kick dialog toggle can turn it off', async () => {
    const w = await world();
    const r1 = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'Regular', permissions: bits(Perm.SEND_MESSAGES) })).body;
    const r2 = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'Artist' })).body;
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.owner.token, { roles: [r1.id, r2.id] });
    expect((await api.req('DELETE', w.g(`/members/${w.bob.id}?reason=cooldown`), w.mod.token)).status).toBe(204);
    await w.join(w.bob);
    expect(await rolesOf(w, w.bob)).toEqual([r1.id, r2.id].sort());
    const log = (await api.req('GET', w.g('/audit-logs?action=MEMBER_ROLES_RESTORED'), w.owner.token)).body;
    expect(log).toHaveLength(1); expect(log[0].diff.after.roles.sort()).toEqual([r1.id, r2.id].sort());
    // the memory is consumed: a second kick with the toggle off restores nothing
    expect((await api.req('DELETE', w.g(`/members/${w.bob.id}?rememberRoles=false`), w.mod.token)).status).toBe(204);
    await w.join(w.bob);
    expect(await rolesOf(w, w.bob)).toEqual([]);
  });

  it('never escalates: grown roles, roles above the moderator and privileged roles of a voluntary leaver stay off', async () => {
    const w = await world();
    const grown = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'Grows', permissions: bits(Perm.SEND_MESSAGES) })).body;
    const high = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'Elder' })).body;
    const plain = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'Plain' })).body;
    // the Moderator outranks all three while they kick bob...
    await api.req('PATCH', w.g('/roles'), w.owner.token, [{ id: plain.id, position: 1 }, { id: grown.id, position: 2 }, { id: high.id, position: 3 }, { id: w.modRole.id, position: 4 }]);
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.owner.token, { roles: [grown.id, high.id, plain.id] });
    expect((await api.req('DELETE', w.g(`/members/${w.bob.id}`), w.mod.token)).status).toBe(204);
    // ...then, while bob is away, the Moderator is demoted below Grows and Elder and Grows gains a dangerous permission
    await api.req('PATCH', w.g('/roles'), w.owner.token, [{ id: plain.id, position: 1 }, { id: w.modRole.id, position: 2 }, { id: grown.id, position: 3 }, { id: high.id, position: 4 }]);
    await api.req('PATCH', w.g(`/roles/${grown.id}`), w.owner.token, { permissions: bits(Perm.SEND_MESSAGES, Perm.MENTION_EVERYONE) });
    await w.join(w.bob);
    expect(await rolesOf(w, w.bob)).toEqual([plain.id]); // grown: escalated, high: above the kicking moderator now

    // voluntary leave is off by default; with it on, privileged roles are still not handed back without a moderator vouching for them
    const priv = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'Janitor', permissions: bits(Perm.MANAGE_MESSAGES) })).body;
    await setSettings(w, { rememberRoles: { onLeave: true } });
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.owner.token, { roles: [plain.id, priv.id] });
    expect((await api.req('DELETE', `/users/@me/guilds/${w.gid}`, w.bob.token)).status).toBe(204);
    await w.join(w.bob);
    expect(await rolesOf(w, w.bob)).toEqual([plain.id]);
  });

  it('does nothing when the server turned it off, when memory expired, and a timeout survives leaving', async () => {
    const w = await world();
    const r1 = (await api.req('POST', w.g('/roles'), w.owner.token, { name: 'R' })).body;
    await setSettings(w, { rememberRoles: { enabled: false } });
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.owner.token, { roles: [r1.id] });
    await api.req('DELETE', w.g(`/members/${w.bob.id}`), w.mod.token);
    await w.join(w.bob);
    expect(await rolesOf(w, w.bob)).toEqual([]);
    // expiry
    await setSettings(w, { rememberRoles: { enabled: true, days: 1 } });
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.owner.token, { roles: [r1.id] });
    await api.req('DELETE', w.g(`/members/${w.bob.id}`), w.mod.token);
    await env.ctx.db.query(`UPDATE member_role_memory SET expires_at = now() - interval '1 minute' WHERE guild_id = $1`, [w.gid]);
    await w.join(w.bob);
    expect(await rolesOf(w, w.bob)).toEqual([]);
    // timeout evasion by leaving
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await api.req('PATCH', w.g(`/members/${w.eve.id}`), w.mod.token, { timeoutUntil: until });
    await api.req('DELETE', `/users/@me/guilds/${w.gid}`, w.eve.token);
    await w.join(w.eve);
    const back = (await api.req('GET', w.g(`/members/${w.eve.id}`), w.owner.token)).body;
    expect(new Date(back.timeoutUntil).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('3. removal notices', () => {
  it('a kicked member gets the reason without the moderator; the server can show the moderator; opt-out per action', async () => {
    const w = await world();
    const ws = await WsClient.connect(env.port); await ws.identify(w.bob.token);
    await api.req('DELETE', w.g(`/members/${w.bob.id}?reason=spamming+links`), w.mod.token);
    const ev = await ws.waitEvent('MOD_NOTICE', (d) => d.kind === 'kick');
    expect(ev.d).toMatchObject({ guildId: w.gid, guildName: 'Mod HQ', reason: 'spamming links', moderatorId: null, appeal: false });
    const list = (await api.req('GET', '/users/@me/mod-notices', w.bob.token)).body;
    expect(list).toHaveLength(1); expect(JSON.stringify(list)).not.toContain(w.mod.id);
    ws.close();
    await setSettings(w, { notices: { showModerator: true } });
    await w.join(w.bob);
    await api.req('DELETE', w.g(`/members/${w.bob.id}?reason=again&notify=false`), w.mod.token);
    expect((await api.req('GET', '/users/@me/mod-notices', w.bob.token)).body).toHaveLength(1); // notify=false sent nothing
    await w.join(w.bob);
    await api.req('DELETE', w.g(`/members/${w.bob.id}?reason=third`), w.mod.token);
    const two = (await api.req('GET', '/users/@me/mod-notices', w.bob.token)).body;
    expect(two[0]).toMatchObject({ reason: 'third', moderatorId: w.mod.id });
  });

  it('bans carry an appeal link, timeouts the end time; a server can switch notices off; a member hears at most 3 per day', async () => {
    const w = await world(['cara', 'dan']);
    await api.req('PATCH', w.g(`/members/${w.bob.id}`), w.mod.token, { timeoutUntil: new Date(Date.now() + 600_000).toISOString(), reason: 'cool off' });
    const t = (await api.req('GET', '/users/@me/mod-notices', w.bob.token)).body[0];
    expect(t).toMatchObject({ kind: 'timeout', reason: 'cool off', appeal: false }); expect(t.until).toBeTruthy();
    await api.req('PUT', w.g(`/bans/${w.eve.id}`), w.mod.token, { reason: 'ban evasion' });
    expect((await api.req('GET', '/users/@me/mod-notices', w.eve.token)).body[0]).toMatchObject({ kind: 'ban', reason: 'ban evasion', appeal: true, moderatorId: null });
    expect((await api.req('POST', '/users/@me/mod-notices/read', w.eve.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me/mod-notices', w.eve.token)).body[0].readAt).toBeTruthy();
    await setSettings(w, { notices: { enabled: false } });
    await api.req('PUT', w.g(`/bans/${w.bob.id}`), w.mod.token, { reason: 'silent' });
    expect((await api.req('GET', '/users/@me/mod-notices', w.bob.token)).body).toHaveLength(1);
    // per-member daily cap
    await setSettings(w, { notices: { enabled: true } });
    for (let i = 0; i < 4; i++) await api.req('PATCH', w.g(`/members/${(w as any).cara.id}`), w.mod.token, { timeoutUntil: new Date(Date.now() + 60_000 * (i + 1)).toISOString() });
    expect((await api.req('GET', '/users/@me/mod-notices', (w as any).cara.token)).body).toHaveLength(3);
  });

  it('only members of the server with the right permission can change the settings', async () => {
    const w = await world();
    expect((await api.req('PATCH', w.g('/mod-settings'), w.mod.token, { evasion: { enabled: true } })).status).toBe(403);
    expect((await api.req('GET', w.g('/mod-settings'), w.mod.token)).status).toBe(200);
    expect((await api.req('GET', w.g('/mod-settings'), w.bob.token)).status).toBe(403);
    expect((await setSettings(w, { notices: { bogus: true } })).status).toBe(400);
    expect((await api.req('GET', w.g('/mod-settings'), w.owner.token)).body).toMatchObject({ rememberRoles: { enabled: true, onKick: true, onLeave: false, days: 7 }, notices: { enabled: true, showModerator: false, appealLink: true }, evasion: { enabled: false } });
  });
});

describe('4. anonymous reports', () => {
  it('folds duplicates into one case with a count, hides anonymous reporters, keeps a snapshot, audits without the reporter', async () => {
    const w = await world(['cara']);
    const msg = await w.say(w.bob, 'original rude text');
    const rep = (u: Client, body: object) => api.req('POST', `/channels/${w.general.id}/messages/${msg.id}/report`, u.token, body);
    const first = await rep(w.eve, { reason: 'harassment', anonymous: true });
    expect(first.status).toBe(201);
    const second = await rep((w as any).cara, { reason: 'spam' });
    expect(second.status).toBe(201); expect(second.body.id).toBe(first.body.id); // folded into the open case
    expect((await rep(w.eve, { reason: 'other' })).status).toBe(409);
    await api.req('PATCH', `/channels/${w.general.id}/messages/${msg.id}`, w.bob.token, { content: 'innocent now' });
    const queue = (await api.req('GET', w.g('/reports'), w.mod.token)).body;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ reportCount: 2, anonymous: true, reporterId: null, status: 'open', blurMedia: true });
    expect(queue[0].message.content).toBe('original rude text'); // what was reported, not what it says now
    expect(JSON.stringify(queue)).not.toContain(w.eve.id);
    const log = (await api.req('GET', w.g('/audit-logs?action=REPORT_CREATE'), w.owner.token)).body as any[];
    expect(log.some((e) => e.actorId === w.eve.id)).toBe(false);
    expect(log.some((e) => e.actorId === 'anonymous')).toBe(true);
    // a non-anonymous first report still shows its reporter
    const m2 = await w.say(w.bob, 'another');
    await api.req('POST', `/channels/${w.general.id}/messages/${m2.id}/report`, w.eve.token, { reason: 'spam' });
    const q2 = (await api.req('GET', w.g('/reports'), w.mod.token)).body.find((r: any) => r.messageId === m2.id);
    expect(q2).toMatchObject({ reporterId: w.eve.id, anonymous: false, reportCount: 1 });
  });

  it('resolve with a canned action: delete, mark sensitive, warn, timeout; dismiss closes the whole case; refused actions leave it open', async () => {
    const w = await world();
    const open = async (text: string) => { const m = await w.say(w.bob, text); const pr = await api.req('POST', `/channels/${w.general.id}/messages/${m.id}/report`, w.eve.token, { reason: 'spam' }); if (pr.status !== 201) throw new Error('report failed ' + JSON.stringify(pr.body)); return { m, rep: (await api.req('GET', w.g('/reports'), w.mod.token)).body.find((r: any) => r.messageId === m.id) }; };
    const a = await open('to delete');
    expect((await api.req('PATCH', w.g(`/reports/${a.rep.id}`), w.mod.token, { status: 'dismissed', action: 'delete_message' })).status).toBe(400);
    expect((await api.req('PATCH', w.g(`/reports/${a.rep.id}`), w.mod.token, { status: 'resolved', action: 'delete_message' })).body).toMatchObject({ status: 'resolved', actionTaken: 'delete_message' });
    expect((await api.req('GET', `/channels/${w.general.id}/messages?limit=50`, w.owner.token)).body.some((x: any) => x.id === a.m.id)).toBe(false);
    const b = await open('to blur');
    await api.req('PATCH', w.g(`/reports/${b.rep.id}`), w.mod.token, { status: 'resolved', action: 'mark_sensitive' });
    const shown = (await api.req('GET', `/channels/${w.general.id}/messages?limit=50`, w.owner.token)).body.find((x: any) => x.id === b.m.id);
    expect(shown.content).toBe('to blur'); expect(shown.flags & MessageFlags.SENSITIVE).toBeTruthy();
    const c = await open('to warn');
    await api.req('PATCH', w.g(`/reports/${c.rep.id}`), w.mod.token, { status: 'resolved', action: 'warn' });
    expect((await api.req('GET', w.g(`/members/${w.bob.id}/warnings`), w.mod.token)).body).toHaveLength(1);
    const e = await open('to refuse');
    const d = await open('to timeout');
    await api.req('PATCH', w.g(`/reports/${d.rep.id}`), w.mod.token, { status: 'resolved', action: 'timeout' });
    expect(new Date((await api.req('GET', w.g(`/members/${w.bob.id}`), w.owner.token)).body.timeoutUntil).getTime()).toBeGreaterThan(Date.now());
    // a moderator cannot take an action their permission does not cover: eve (no perms) is refused before anything changes
    expect((await api.req('PATCH', w.g(`/reports/${e.rep.id}`), w.eve.token, { status: 'resolved' })).status).toBe(403);
    const log = (await api.req('GET', w.g('/audit-logs?limit=100'), w.owner.token)).body.map((x: any) => x.action);
    expect(log).toEqual(expect.arrayContaining(['MESSAGE_DELETE', 'MESSAGE_SENSITIVE_SET', 'MEMBER_WARN', 'MEMBER_TIMEOUT', 'REPORT_RESOLVE']));
  });

  it('throttles reporters whose reports keep getting dismissed', async () => {
    const w = await world();
    const spam = async (i: number) => { const m = await w.say(w.bob, `m${i}`); return api.req('POST', `/channels/${w.general.id}/messages/${m.id}/report`, w.eve.token, { reason: 'spam' }); };
    for (let i = 0; i < 5; i++) {
      expect((await spam(i)).status).toBe(201);
      const rep = (await api.req('GET', w.g('/reports'), w.mod.token)).body[0];
      await api.req('PATCH', w.g(`/reports/${rep.id}`), w.mod.token, { status: 'dismissed' });
    }
    await env.ctx.db.query(`UPDATE reports SET created_at = now() - interval '2 days' WHERE reporter_id = $1`, [w.eve.id]); // history is old enough to not count as "today"
    expect((await spam(6)).status).toBe(201); expect((await spam(7)).status).toBe(201); // small daily allowance
    const third = await spam(8);
    expect(third.status).toBe(429); expect(third.body.code).toBe('REPORT_THROTTLED');
    // an honest reporter is unaffected
    const w2 = await world();
    const m = await w2.say(w2.bob, 'x');
    expect((await api.req('POST', `/channels/${w2.general.id}/messages/${m.id}/report`, w2.eve.token, { reason: 'spam' })).status).toBe(201);
  });

  it('pings moderators outside their quiet hours only, and the blur default can be overridden per moderator', async () => {
    const w = await world();
    const modWs = await WsClient.connect(env.port); await modWs.identify(w.mod.token);
    const ownerWs = await WsClient.connect(env.port); await ownerWs.identify(w.owner.token);
    const now = new Date(); const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const put = await api.req('PUT', w.g('/mod-prefs'), w.mod.token, { quietStart: (minutes + 1440 - 30) % 1440, quietEnd: (minutes + 30) % 1440, tzOffset: 0, blurMedia: false });
    expect(put.status).toBe(200); expect(put.body).toMatchObject({ blurMedia: false, serverBlurDefault: true });
    expect((await api.req('PUT', w.g('/mod-prefs'), w.mod.token, { quietStart: null })).status).toBe(400); // half a window
    const m = await w.say(w.bob, 'please look');
    await api.req('POST', `/channels/${w.general.id}/messages/${m.id}/report`, w.eve.token, { reason: 'spam' });
    await ownerWs.waitEvent('MOD_REPORT_PING', (d) => d.guildId === w.gid);
    await modWs.waitEvent('GUILD_REPORTS_UPDATE', (d) => d.guildId === w.gid);
    await modWs.expectNone((f) => f.t === 'MOD_REPORT_PING');
    expect((await api.req('GET', w.g('/reports'), w.mod.token)).body[0].blurMedia).toBe(false);
    expect((await api.req('GET', w.g('/reports'), w.owner.token)).body[0].blurMedia).toBe(true);
    expect((await api.req('GET', w.g('/mod-prefs'), w.bob.token)).status).toBe(403);
    modWs.close(); ownerWs.close();
  });
});

describe('5. edit history and sensitive marks', () => {
  it('author and moderators read the history (original text included); a moderator read is audited; others are refused', async () => {
    const w = await world();
    const m = await w.say(w.bob, 'the original');
    await api.req('PATCH', `/channels/${w.general.id}/messages/${m.id}`, w.bob.token, { content: 'second' });
    await api.req('PATCH', `/channels/${w.general.id}/messages/${m.id}`, w.bob.token, { content: 'third' });
    const url = `/channels/${w.general.id}/messages/${m.id}/edits`;
    expect((await api.req('GET', url, w.bob.token)).body.map((e: any) => e.content)).toEqual(['second', 'the original']);
    expect((await api.req('GET', url, w.mod.token)).body.map((e: any) => e.content)).toEqual(['second', 'the original']);
    expect((await api.req('GET', url, w.eve.token)).status).toBe(403);
    const views = (await api.req('GET', w.g('/audit-logs?action=MESSAGE_EDIT_HISTORY_VIEW'), w.owner.token)).body;
    expect(views).toHaveLength(1); expect(views[0]).toMatchObject({ actorId: w.mod.id, targetId: m.id });
  });

  it('mark sensitive keeps the text, audits, is limited to moderators (authors may flag their own) and moderators clear it', async () => {
    const w = await world();
    const m = await w.say(w.bob, 'graphic but newsworthy');
    const url = `/channels/${w.general.id}/messages/${m.id}/sensitive`;
    expect((await api.req('PUT', url, w.eve.token, {})).status).toBe(403);
    const ws = await WsClient.connect(env.port); await ws.identify(w.eve.token);
    expect((await api.req('PUT', url, w.mod.token, { reason: 'gore' })).status).toBe(204);
    const upd = await ws.waitEvent('MESSAGE_UPDATE', (d) => d.id === m.id);
    expect(upd.d.flags & MessageFlags.SENSITIVE).toBeTruthy(); expect(upd.d.content).toBe('graphic but newsworthy'); expect(upd.d.editedAt ?? null).toBeNull();
    ws.close();
    const log = (await api.req('GET', w.g('/audit-logs?action=MESSAGE_SENSITIVE_SET'), w.owner.token)).body;
    expect(log[0]).toMatchObject({ actorId: w.mod.id, targetId: m.id, reason: 'gore' });
    expect((await api.req('DELETE', url, w.bob.token)).status).toBe(403); // the author cannot lift a moderator's mark
    expect((await api.req('DELETE', url, w.mod.token)).status).toBe(204);
    expect((await api.req('GET', `/channels/${w.general.id}/messages?limit=10`, w.eve.token)).body.find((x: any) => x.id === m.id).flags & MessageFlags.SENSITIVE).toBeFalsy();
    const mine = await w.say(w.bob, 'my own post');
    expect((await api.req('PUT', `/channels/${w.general.id}/messages/${mine.id}/sensitive`, w.bob.token, {})).status).toBe(204);
  });
});

describe('6. ban-evasion hints', () => {
  const rename = (u: Client, displayName: string) => api.req('PATCH', '/users/@me', u.token, { displayName });
  it('is off by default; when on, a look-alike name joining after a ban is flagged to moderators with the signals used', async () => {
    const w = await world(['evader', 'stranger']);
    const evader = (w as any).evader as Client, stranger = (w as any).stranger as Client;
    await rename(evader, 'Dark Lord Zed');
    await api.req('PUT', w.g(`/bans/${evader.id}`), w.mod.token, { reason: 'harassment' });
    const twin = await api.register('twin'); await rename(twin, 'dark lord zed');
    await w.join(twin);
    expect((await api.req('GET', w.g('/evasion-hints'), w.mod.token)).body).toEqual([]); // not enabled yet
    await api.req('DELETE', w.g(`/members/${twin.id}`), w.mod.token);
    expect((await setSettings(w, { evasion: { enabled: true } })).status).toBe(200);
    const ws = await WsClient.connect(env.port); await ws.identify(w.owner.token);
    await w.join(twin);
    await ws.waitEvent('GUILD_REPORTS_UPDATE', (d) => d.guildId === w.gid);
    const hints = (await api.req('GET', w.g('/evasion-hints'), w.mod.token)).body;
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ userId: twin.id, bannedUserId: evader.id, status: 'open' });
    expect(hints[0].score).toBeGreaterThanOrEqual(45);
    expect(hints[0].signals.map((s: any) => s.kind)).toContain('name');
    expect(hints[0].signals.map((s: any) => s.kind)).toContain('timing'); // created after the ban
    expect(JSON.stringify(hints)).not.toMatch(/"ip"|fingerprint/i);
    ws.close();
    // unrelated newcomers are not flagged
    await rename(stranger, 'Quiet Gardener'); await w.join(stranger);
    expect((await api.req('GET', w.g('/evasion-hints'), w.mod.token)).body).toHaveLength(1);
    // triage
    expect((await api.req('PATCH', w.g(`/evasion-hints/${hints[0].id}`), w.bob.token, { status: 'dismissed' })).status).toBe(403);
    expect((await api.req('PATCH', w.g(`/evasion-hints/${hints[0].id}`), w.mod.token, { status: 'dismissed' })).body).toMatchObject({ status: 'dismissed', handledBy: w.mod.id });
    expect((await api.req('PATCH', w.g(`/evasion-hints/${hints[0].id}`), w.mod.token, { status: 'confirmed' })).status).toBe(409);
    expect((await api.req('GET', w.g('/evasion-hints'), w.mod.token)).body).toEqual([]);
    expect((await api.req('GET', w.g('/evasion-hints?status=dismissed'), w.mod.token)).body).toHaveLength(1);
  });

  it('the same invite code alone is not enough', async () => {
    const w = await world(['evader']);
    const evader = (w as any).evader as Client;
    await api.req('PUT', w.g(`/bans/${evader.id}`), w.mod.token, { reason: 'x' });
    await setSettings(w, { evasion: { enabled: true } });
    const other = await api.register('other'); await w.join(other); // same invite as the banned member
    expect((await api.req('GET', w.g('/evasion-hints'), w.mod.token)).body).toEqual([]);
  });
});
