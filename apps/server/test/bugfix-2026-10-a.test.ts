import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { emptyState } from '../src/services/voice';
import { nextOccurrences } from '../src/services/scheduled';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('leaving or being removed from a guild', () => {
  for (const how of ['leave', 'kick'] as const) {
    it(`${how}: drops private-thread membership (a rejoin must not restore access) and voice`, async () => {
      const owner = await api.register('o');
      const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Leave', template: 'community' })).body;
      const general = guild.channels.find((c: any) => c.type === 'text');
      const voice = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'vc', type: 'voice' })).body;
      await api.req('PUT', `/channels/${general.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: String(Perm.CREATE_PRIVATE_THREADS), deny: '0' });
      const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, { maxAgeSeconds: 0 })).body.code;
      const u = await api.register('m'); await api.req('POST', `/invites/${code}`, u.token);
      const t = (await api.req('POST', `/channels/${general.id}/threads`, owner.token, { name: 'secret', type: 'private' })).body;
      expect((await api.req('PUT', `/channels/${t.id}/thread-members/${u.id}`, owner.token)).status).toBe(204);
      expect((await api.req('GET', `/channels/${t.id}`, u.token)).status).toBe(200);
      await env.ctx.voice.set({ ...emptyState(u.id), guildId: guild.id, channelId: voice.id });
      const r = how === 'leave' ? await api.req('DELETE', `/users/@me/guilds/${guild.id}`, u.token) : await api.req('DELETE', `/guilds/${guild.id}/members/${u.id}`, owner.token);
      expect(r.status).toBe(204);
      expect((await env.ctx.voice.get(u.id))?.channelId ?? null).toBeNull();
      expect(env.livekit.removed).toContainEqual({ room: voice.id, identity: u.id });
      expect((await api.req('POST', `/invites/${code}`, u.token)).status).toBe(200); // rejoin
      expect((await api.req('GET', `/channels/${t.id}`, u.token)).status).toBe(404);
      expect((await api.req('GET', `/channels/${t.id}/thread-members`, owner.token)).body.map((m: any) => m.userId)).not.toContain(u.id);
    });
  }
});

describe('read markers', () => {
  it('deleting the newest message re-points last_message_id; acks never move backwards; Mark Unread persists', async () => {
    const o = await api.register('rd');
    const g = (await api.req('POST', '/guilds', o.token, { name: 'Reads', template: 'community' })).body;
    const ch = g.channels.find((c: any) => c.type === 'text');
    const m1 = (await api.req('POST', `/channels/${ch.id}/messages`, o.token, { content: 'one' })).body;
    const m2 = (await api.req('POST', `/channels/${ch.id}/messages`, o.token, { content: 'two' })).body;
    expect((await api.req('DELETE', `/channels/${ch.id}/messages/${m2.id}`, o.token)).status).toBe(204);
    expect((await api.req('GET', `/channels/${ch.id}`, o.token)).body.lastMessageId).toBe(m1.id);
    expect((await api.req('POST', `/channels/${ch.id}/ack`, o.token, { messageId: m1.id })).status).toBe(200); // "mark as read" on the new newest message works
    const m3 = (await api.req('POST', `/channels/${ch.id}/messages`, o.token, { content: 'three' })).body;
    await api.req('POST', `/channels/${ch.id}/ack`, o.token, { messageId: m3.id });
    const stale = await api.req('POST', `/channels/${ch.id}/ack`, o.token, { messageId: m1.id });
    expect(stale.body.lastReadId).toBe(m3.id); // a late ack from an old tab does not regress
    const un = await api.req('POST', `/channels/${ch.id}/ack`, o.token, { messageId: m3.id, unread: true });
    expect(un.status).toBe(200); expect(BigInt(un.body.lastReadId)).toBe(BigInt(m3.id) - 1n);
    const rs = (await api.req('GET', '/users/@me/read-states', o.token)).body.find((r: any) => r.channelId === ch.id);
    expect(rs.lastReadId).toBe(un.body.lastReadId);
  });
});

describe('monthly recurrence', () => {
  it('keeps the start day (clamped to month end) and does not drift or depend on the server time zone', () => {
    const iso = (d: Date[]) => d.map((x) => x.toISOString());
    expect(iso(nextOccurrences({ frequency: 'monthly' } as any, new Date('2027-01-31T20:30:00Z'), 4))).toEqual([
      '2027-02-28T20:30:00.000Z', '2027-03-31T20:30:00.000Z', '2027-04-30T20:30:00.000Z', '2027-05-31T20:30:00.000Z']);
    expect(iso(nextOccurrences({ frequency: 'monthly', interval: 5 } as any, new Date('2027-10-15T00:00:00Z'), 2))).toEqual(['2028-03-15T00:00:00.000Z', '2028-08-15T00:00:00.000Z']);
    expect(iso(nextOccurrences({ frequency: 'monthly', until: '2027-04-01T00:00:00Z' } as any, new Date('2027-01-31T20:30:00Z'), 5))).toHaveLength(2);
  });
});

describe('group DM removal ends the call', () => {
  it('kicking a participant removes their LiveKit participant, not just the voice state', async () => {
    const befriend = async (x: any, y: any) => { await api.req('PUT', `/users/@me/relationships/${y.id}`, x.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${x.id}`, y.token, { type: 'friend' }); };
    const a = await api.register('ga'), b = await api.register('gb'), c = await api.register('gc');
    await befriend(a, b); await befriend(a, c);
    const g = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id, c.id] })).body;
    await env.ctx.voice.set({ ...emptyState(b.id), guildId: null as any, channelId: g.id });
    expect((await api.req('DELETE', `/channels/${g.id}/recipients/${b.id}`, a.token)).status).toBe(204);
    expect((await env.ctx.voice.get(b.id))?.channelId ?? null).toBeNull();
    expect(env.livekit.removed).toContainEqual({ room: g.id, identity: b.id });
  });
});
