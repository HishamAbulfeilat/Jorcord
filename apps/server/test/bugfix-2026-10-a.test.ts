import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { emptyState } from '../src/services/voice';
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
