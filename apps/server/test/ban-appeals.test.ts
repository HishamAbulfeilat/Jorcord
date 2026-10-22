import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const MSG = 'I was banned by mistake, I was not the one spamming.';
async function setup() {
  const owner = await api.register('ao');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Appeals HQ', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (n = 'm') => { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); return u; };
  const modRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Mods', permissions: Perm.BAN_MEMBERS.toString() })).body;
  const mod = await join('mod');
  await api.req('PATCH', `/guilds/${guild.id}/members/${mod.id}`, owner.token, { roles: [modRole.id] });
  const plain = await join('plain');
  const bad = await join('bad');
  await api.req('PUT', `/guilds/${guild.id}/bans/${bad.id}`, mod.token, { reason: 'spam' });
  return { owner, guild, mod, plain, bad, code };
}
const appeal = (s: Awaited<ReturnType<typeof setup>>, u = s.bad, message = MSG) => api.req('POST', `/users/@me/bans/${s.guild.id}/appeal`, u.token, { message });

describe('ban appeals: submit', () => {
  it('lets a banned user see their bans and appeal once per ban', async () => {
    const s = await setup();
    const list = (await api.req('GET', '/users/@me/bans', s.bad.token)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ guild: { id: s.guild.id, name: 'Appeals HQ' }, reason: 'spam', appeal: null });
    const r = await appeal(s);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', message: MSG });
    expect((await api.req('GET', '/users/@me/bans', s.bad.token)).body[0].appeal.status).toBe('pending');
    expect((await appeal(s)).body.code).toBe('APPEAL_EXISTS');
  });

  it('rejects non-banned users (no oracle for other people\'s bans), unauthenticated calls, short and over-long text', async () => {
    const s = await setup();
    expect((await appeal(s, s.plain)).status).toBe(404);
    expect((await api.req('POST', `/users/@me/bans/${s.guild.id}/appeal`, null, { message: MSG })).status).toBe(401);
    expect((await appeal(s, s.bad, 'too short')).status).toBe(400);
    expect((await appeal(s, s.bad, 'x'.repeat(1001))).status).toBe(400);
    expect((await api.req('POST', `/users/@me/bans/${s.guild.id}/appeal`, s.bad.token, { message: MSG, userId: s.plain.id })).status).toBe(400); // strict body: no mass assignment
    expect((await api.req('GET', '/users/@me/bans', s.plain.token)).body).toEqual([]);
  });

  it('rate limits appeal attempts per user', async () => {
    const e2 = await startServer({ rateLimit: true });
    try {
      const a2 = new Api(e2);
      const u = await a2.register('rl');
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await a2.req('POST', '/users/@me/bans/123456789012345678/appeal', u.token, { message: MSG })).status);
      expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
      expect(codes[5]).toBe(429);
    } finally { await e2.close(); }
  });
});

describe('ban appeals: moderation queue', () => {
  it('is visible only to BAN_MEMBERS holders; content never leaks to others', async () => {
    const s = await setup(); await appeal(s);
    const q = await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.mod.token);
    expect(q.status).toBe(200);
    expect(q.body).toHaveLength(1);
    expect(q.body[0]).toMatchObject({ message: MSG, banReason: 'spam', status: 'pending', user: { id: s.bad.id } });
    expect((await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.owner.token)).body).toHaveLength(1);
    expect((await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.plain.token)).status).toBe(403);
    expect((await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.bad.token)).status).toBe(404); // banned user is not a member: guild is invisible
    // the appeal text is not in the audit log either
    const log = JSON.stringify((await api.req('GET', `/guilds/${s.guild.id}/audit-logs`, s.owner.token)).body);
    expect(log).toContain('BAN_APPEAL_CREATE'); expect(log).not.toContain(MSG);
    // nor in the other user's view
    expect((await api.req('POST', `/guilds/${s.guild.id}/appeals/${q.body[0].id}`, s.plain.token, { decision: 'approve' })).status).toBe(403);
  });

  it('approve unbans, audits, emails and notifies over the gateway; the user can rejoin', async () => {
    const s = await setup(); await appeal(s);
    const ws = await WsClient.connect(env.port); await ws.identify(s.bad.token);
    const [item] = (await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.mod.token)).body;
    const r = await api.req('POST', `/guilds/${s.guild.id}/appeals/${item.id}`, s.mod.token, { decision: 'approve', reason: 'Sorry about that' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('approved');
    expect((await api.req('GET', `/guilds/${s.guild.id}/bans`, s.mod.token)).body).toHaveLength(0);
    expect((await api.req('POST', `/invites/${s.code}`, s.bad.token)).status).toBeLessThan(300);
    const ev = await ws.waitEvent('BAN_APPEAL_UPDATE'); expect(ev.d).toEqual({ id: item.id, guildId: s.guild.id, status: 'approved', decisionReason: 'Sorry about that' }); ws.close();
    await new Promise((res) => setTimeout(res, 100));
    const mail = env.ctx.mailer.outbox.find((m) => m.to === s.bad.user.email && m.subject.includes('approved'));
    expect(mail?.text).toContain('Sorry about that');
    const log = JSON.stringify((await api.req('GET', `/guilds/${s.guild.id}/audit-logs`, s.owner.token)).body);
    expect(log).toContain('BAN_APPEAL_APPROVE'); expect(log).toContain('MEMBER_BAN_REMOVE');
  });

  it('deny keeps the ban, the user cannot appeal again, a re-ban allows a fresh appeal', async () => {
    const s = await setup(); await appeal(s);
    const [item] = (await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.mod.token)).body;
    expect((await api.req('POST', `/guilds/${s.guild.id}/appeals/${item.id}`, s.mod.token, { decision: 'deny', reason: 'No' })).body.status).toBe('denied');
    expect((await api.req('POST', `/guilds/${s.guild.id}/appeals/${item.id}`, s.mod.token, { decision: 'approve' })).body.code).toBe('APPEAL_DECIDED'); // single decision
    expect((await api.req('GET', `/guilds/${s.guild.id}/bans`, s.mod.token)).body).toHaveLength(1);
    expect((await appeal(s)).body.code).toBe('APPEAL_EXISTS');
    const mine = (await api.req('GET', '/users/@me/bans', s.bad.token)).body[0].appeal;
    expect(mine).toMatchObject({ status: 'denied', decisionReason: 'No' });
    expect(mine.decidedBy).toBeUndefined();
    expect((await api.req('GET', `/guilds/${s.guild.id}/appeals?status=pending`, s.mod.token)).body).toHaveLength(0);
    expect((await api.req('GET', `/guilds/${s.guild.id}/appeals?status=all`, s.mod.token)).body).toHaveLength(1);
    // unban manually then ban again = a new ban, a new appeal
    await api.req('DELETE', `/guilds/${s.guild.id}/bans/${s.bad.id}`, s.mod.token);
    await new Promise((res) => setTimeout(res, 15));
    await api.req('PUT', `/guilds/${s.guild.id}/bans/${s.bad.id}`, s.mod.token, { reason: 'again' });
    expect((await appeal(s)).status).toBe(201);
  });

  it('cannot decide an appeal of another guild (IDOR) and pending appeals vanish when the ban is lifted', async () => {
    const s = await setup(); const other = await setup(); await appeal(s);
    const [item] = (await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.mod.token)).body;
    expect((await api.req('POST', `/guilds/${other.guild.id}/appeals/${item.id}`, other.owner.token, { decision: 'approve' })).status).toBe(404);
    expect((await api.req('GET', `/guilds/${s.guild.id}/bans`, s.mod.token)).body).toHaveLength(1);
    await api.req('DELETE', `/guilds/${s.guild.id}/bans/${s.bad.id}`, s.mod.token);
    expect((await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.mod.token)).body).toHaveLength(0);
  });

  it('validates the decision body', async () => {
    const s = await setup(); await appeal(s);
    const [item] = (await api.req('GET', `/guilds/${s.guild.id}/appeals`, s.mod.token)).body;
    expect((await api.req('POST', `/guilds/${s.guild.id}/appeals/${item.id}`, s.mod.token, { decision: 'maybe' })).status).toBe(400);
    expect((await api.req('POST', `/guilds/${s.guild.id}/appeals/${item.id}`, s.mod.token, { decision: 'deny', status: 'approved' })).status).toBe(400);
  });
});
