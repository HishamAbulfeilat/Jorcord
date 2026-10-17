import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyState } from '../src/services/voice';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('removing a member disconnects voice', () => {
  for (const mode of ['kick', 'ban'] as const) {
    it(`${mode} clears voice state and removes the LiveKit participant`, async () => {
      const owner = await api.register('o');
      const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Voice', template: 'community' })).body;
      const voice = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'vc', type: 'voice' })).body;
      const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
      const u = await api.register('m'); await api.req('POST', `/invites/${code}`, u.token);
      await env.ctx.voice.set({ ...emptyState(u.id), guildId: guild.id, channelId: voice.id });
      const r = mode === 'kick' ? await api.req('DELETE', `/guilds/${guild.id}/members/${u.id}`, owner.token) : await api.req('PUT', `/guilds/${guild.id}/bans/${u.id}`, owner.token, {});
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      expect((await env.ctx.voice.get(u.id))?.channelId ?? null).toBeNull();
      expect(env.livekit.removed).toContainEqual({ room: voice.id, identity: u.id });
    });
  }
  it('voice tokens live at most 10 minutes', async () => {
    const owner = await api.register('o');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Voice', template: 'community' })).body;
    const voice = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'vc', type: 'voice' })).body;
    const t: any = decodeJwt((await api.req('POST', '/voice/token', owner.token, { channelId: voice.id })).body.token);
    expect(t.exp - t.nbf).toBeLessThanOrEqual(600);
  });
});
