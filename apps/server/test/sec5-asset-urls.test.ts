import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const own = `/api/v1/files/${'ab'.repeat(24)}/pic.png`;
const bad = ['https://evil.example/pixel.png', 'http://evil.example/p.gif', '//evil.example/p.png', '/some/other/path.png', '/api/v1/files/short/x.png', `/api/v1/files/${'ab'.repeat(24)}/../x.png`];

describe('asset URLs only accept this server\'s own files', () => {
  it('profile, guild, webhook, emoji and sticker fields', async () => {
    const owner = await api.register('o');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Assets', template: 'community' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    for (const u of bad) {
      expect((await api.req('PATCH', '/users/@me', owner.token, { avatar: u })).status, u).toBe(400);
      expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { icon: u })).status, u).toBe(400);
      expect((await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'h', avatar: u })).status, u).toBe(400);
      expect((await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'emo', url: u })).status, u).toBe(400);
      expect((await api.req('POST', `/guilds/${guild.id}/stickers`, owner.token, { name: 'stk', url: u })).status, u).toBe(400);
    }
    expect((await api.req('PATCH', '/users/@me', owner.token, { avatar: own })).status).toBe(200);
    expect((await api.req('PATCH', '/users/@me', owner.token, { banner: null })).status).toBe(200);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { icon: own })).status).toBe(200);
    expect((await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'h', avatar: own })).status).toBe(201);
    expect((await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'emo', url: own })).status).toBe(201);
  });
});
