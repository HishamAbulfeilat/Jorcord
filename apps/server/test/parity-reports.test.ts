import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

// Reports (mod queue): any reader of a server channel reports another member's message
// (POST /channels/:id/messages/:mid/report); moderators (Mod View gate) list the queue
// and resolve/dismiss reports.see CONTRACT.md "Reports (mod queue)".
let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o'), alice = await api.register('a'), bob = await api.register('b'), eve = await api.register('e');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Reports HQ' })).body;
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  for (const u of [alice, bob, eve]) await api.req('POST', `/invites/${code}`, u.token);
  const msg = (await api.req('POST', `/channels/${general.id}/messages`, bob.token, { content: 'buy frozen accounts <@1111>' })).body;
  return { owner, alice, bob, eve, guildId: guild.id, general, msg };
}

const report = (c: Client, m: { channelId: string; id: string }, body: object) => api.req('POST', `/channels/${m.channelId}/messages/${m.id}/report`, c.token, body);

describe('reports: user side', () => {
  it('a reader reports someone else\'s message; duplicates and self-reports are refused; queue note', async () => {
    const { alice, bob, general, msg } = await setup();
    const ok = await report(alice, msg, { reason: 'spam', description: 'clearly spam' });
    expect(ok.status).toBe(201);
    // same reporter, still-open duplicate
    expect((await report(alice, msg, { reason: 'other' })).status).toBe(409);
    // own message
    const mine = (await api.req('POST', `/channels/${general.id}/messages`, alice.token, { content: 'hi' })).body;
    expect((await report(alice, mine, { reason: 'other' })).status).toBe(400);
    // unknown message, bad reason, no description overflow
    expect((await report(alice, { channelId: msg.channelId, id: '1' }, { reason: 'other' })).status).toBe(404);
    expect((await report(alice, msg, { reason: 'conspiracy' })).status).toBe(400);
    expect((await report(alice, msg, { reason: 'other', description: 'x'.repeat(1001) })).status).toBe(400);
    // non-member cannot report (and cannot tell the message exists)
    const stranger = await api.register('n0');
    expect((await report(stranger, msg, { reason: 'other' })).status).toBe(404);
    void bob;
  });

  it('DMs have no queue', async () => {
    const { alice, bob, general, msg } = await setup();
    void msg; void general;
    const dm = (await api.req('POST', '/users/@me/channels', alice.token, { recipientIds: [bob.id] })).body;
    const m = (await api.req('POST', `/channels/${dm.id}/messages`, bob.token, { content: 'hello' })).body;
    expect((await report(alice, m, { reason: 'other' })).status).toBe(400);
  });
});

describe('reports: moderator queue', () => {
  it('non-mods cannot read the queue; mods see the snapshot with status filters', async () => {
    const { owner, alice, bob, general, msg, guildId } = await setup();
    await report(alice, msg, { reason: 'harassment' });
    const plain = await api.register('plain');
    const code = (await api.req('POST', `/guilds/${guildId}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, plain.token);
    expect((await api.req('GET', `/guilds/${guildId}/reports`, plain.token)).status).toBe(403);
    const queue = (await api.req('GET', `/guilds/${guildId}/reports`, owner.token)).body;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ messageId: msg.id, reason: 'harassment', status: 'open', targetUserId: bob.id });
    expect(queue[0].message.content).toBe('buy frozen accounts <@1111>'); // snapshot
    expect((await api.req('GET', `/guilds/${guildId}/reports?status=dismissed`, owner.token)).body).toHaveLength(0);
    // channel id must be one of this guild's
    const other = await api.register('o2');
    const og = (await api.req('POST', '/guilds', other.token, { name: 'Elsewhere' })).body;
    expect((await api.req('GET', `/guilds/${og.id}/reports`, owner.token)).status).toBe(404); // not a member
    expect((await api.req('GET', `/channels/${general.id}/messages/${msg.id}/report`, owner.token)).status).toBe(404); // no GET on the report subresource
  });

  it('resolve updates handler fields once, dismisses dispatch GUILD_REPORTS_UPDATE, audits actions', async () => {
    const { owner, alice, bob, msg, guildId } = await setup();
    const w = await WsClient.connect(env.port);
    await w.identify(owner.token);
    await report(alice, msg, { reason: 'security' });
    await w.waitEvent('GUILD_REPORTS_UPDATE', (d) => d.guildId === guildId);
    const [rep] = (await api.req('GET', `/guilds/${guildId}/reports`, owner.token)).body;
    const done = await api.req('PATCH', `/guilds/${guildId}/reports/${rep.id}`, owner.token, { status: 'resolved' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'resolved', handledBy: owner.id });
    expect(done.body.handledAt).toBeTruthy();
    expect((await api.req('PATCH', `/guilds/${guildId}/reports/${rep.id}`, owner.token, { status: 'dismissed' })).status).toBe(409);
    await w.waitEvent('GUILD_REPORTS_UPDATE', (d) => d.guildId === guildId); // triage event
    const auditLog = (await api.req('GET', `/guilds/${guildId}/audit-logs`, owner.token)).body;
    expect(auditLog.find((a: any) => a.id === rep.id || a.targetId === msg.id)?.action).toBeDefined();
    expect(auditLog.some((a: any) => a.action === 'REPORT_RESOLVE')).toBe(true);
    expect(auditLog.some((a: any) => a.action === 'REPORT_CREATE')).toBe(true);
    w.close();
    void bob;
  });
});
