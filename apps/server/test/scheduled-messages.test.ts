import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { runSweeps } from '../src/services/sweeper';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ sweepIntervalMs: 0 }); api = new Api(env); });
afterAll(async () => { await env.close(); });

const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const due = (id: string) => env.ctx.db.query("UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1", [id]);
async function setup() {
  const owner = await api.register('so');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Sched' })).body;
  const general = guild.channels.find((c: any) => c.name === 'general');
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const member = await api.register('sm'); await api.req('POST', `/invites/${code}`, member.token);
  return { owner, guild, general, member };
}

describe('scheduled messages', () => {
  it('schedules, lists, cancels; validates time, content, reply target; only the author sees them', async () => {
    const { general, member, owner } = await setup();
    const url = `/channels/${general.id}/scheduled-messages`;
    expect((await api.req('POST', url, member.token, { content: 'x', sendAt: inSeconds(1) })).status).toBe(400); // too soon
    expect((await api.req('POST', url, member.token, { content: 'x', sendAt: inSeconds(40 * 86400) })).status).toBe(400); // too far
    expect((await api.req('POST', url, member.token, { content: '   ', sendAt: inSeconds(60) })).status).toBe(400);
    expect((await api.req('POST', url, member.token, { content: 'x', sendAt: inSeconds(60), replyTo: '1' })).status).toBe(400);
    expect((await api.req('POST', url, member.token, { content: 'x', sendAt: 'tomorrow' })).status).toBe(400);
    const s = await api.req('POST', url, member.token, { content: 'later', sendAt: inSeconds(3600) });
    expect(s.status).toBe(201); expect(s.body).toMatchObject({ channelId: general.id, content: 'later', status: 'pending', error: null });
    const mine = (await api.req('GET', '/users/@me/scheduled-messages', member.token)).body;
    expect(mine.map((x: any) => x.id)).toEqual([s.body.id]);
    expect((await api.req('GET', '/users/@me/scheduled-messages', owner.token)).body).toEqual([]);
    expect((await api.req('DELETE', `/users/@me/scheduled-messages/${s.body.id}`, owner.token)).status).toBe(404); // not theirs
    expect((await api.req('DELETE', `/users/@me/scheduled-messages/${s.body.id}`, member.token)).status).toBe(204);
    const after = (await api.req('GET', '/users/@me/scheduled-messages', member.token)).body;
    expect(after[0]).toMatchObject({ id: s.body.id, status: 'canceled' });
    await due(s.body.id); await runSweeps(env.ctx); // a canceled one never goes out
    const msgs = (await api.req('GET', `/channels/${general.id}/messages`, member.token)).body;
    expect(msgs.some((m: any) => m.content === 'later')).toBe(false);
    expect((await api.req('DELETE', `/users/@me/scheduled-messages/${s.body.id}`, member.token)).status).toBe(204); // clears the finished entry
    expect((await api.req('GET', '/users/@me/scheduled-messages', member.token)).body).toEqual([]);
  });

  it('the worker posts due messages as the author, once, and tells the author', async () => {
    const { general, member } = await setup();
    const ws = await WsClient.connect(env.port); await ws.identify(member.token);
    const ref = (await api.req('POST', `/channels/${general.id}/messages`, member.token, { content: 'anchor' })).body;
    const s = (await api.req('POST', `/channels/${general.id}/scheduled-messages`, member.token, { content: 'from the past', sendAt: inSeconds(60), replyTo: ref.id })).body;
    await runSweeps(env.ctx); // not due yet
    expect((await api.req('GET', `/channels/${general.id}/messages`, member.token)).body.some((m: any) => m.content === 'from the past')).toBe(false);
    await due(s.id);
    await Promise.all([runSweeps(env.ctx), runSweeps(env.ctx)]); // two nodes sweeping at once
    const sent = (await api.req('GET', `/channels/${general.id}/messages`, member.token)).body.filter((m: any) => m.content === 'from the past');
    expect(sent).toHaveLength(1); expect(sent[0].author.id).toBe(member.id); expect(sent[0].replyTo).toBe(ref.id);
    const ev = await ws.waitEvent('SCHEDULED_MESSAGE_UPDATE', (d) => d.id === s.id && d.status === 'sent');
    expect(ev.d.sentMessageId).toBe(sent[0].id);
    ws.close();
  });

  it('re-checks permissions at send time and records the failure', async () => {
    const { general, member, owner, guild } = await setup();
    const s = (await api.req('POST', `/channels/${general.id}/scheduled-messages`, member.token, { content: 'revoked', sendAt: inSeconds(60) })).body;
    // deny SEND_MESSAGES for @everyone in the channel after scheduling
    const ow = await api.req('PUT', `/channels/${general.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.SEND_MESSAGES) });
    expect(ow.status).toBeLessThan(300);
    await due(s.id); await runSweeps(env.ctx);
    const row = (await api.req('GET', '/users/@me/scheduled-messages', member.token)).body.find((x: any) => x.id === s.id);
    expect(row.status).toBe('failed'); expect(row.error).toBeTruthy();
    expect((await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body.some((m: any) => m.content === 'revoked')).toBe(false);
    // and scheduling into a channel the user cannot post in is refused up front
    expect((await api.req('POST', `/channels/${general.id}/scheduled-messages`, member.token, { content: 'no', sendAt: inSeconds(60) })).status).toBe(403);
  });

  it('caps pending messages per user and refuses channels the user cannot reach', async () => {
    const { general, member } = await setup();
    const outsider = await api.register('sx');
    expect((await api.req('POST', `/channels/${general.id}/scheduled-messages`, outsider.token, { content: 'x', sendAt: inSeconds(60) })).status).toBe(404);
    for (let i = 0; i < 25; i++) expect((await api.req('POST', `/channels/${general.id}/scheduled-messages`, member.token, { content: `m${i}`, sendAt: inSeconds(3600 + i) })).status).toBe(201);
    expect((await api.req('POST', `/channels/${general.id}/scheduled-messages`, member.token, { content: 'one too many', sendAt: inSeconds(3600) })).status).toBe(400);
  });
});
