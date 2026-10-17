import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('token-authenticated webhook PATCH', () => {
  it('cannot move the webhook to another channel', async () => {
    const owner = await api.register('o');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Hooks' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    const other = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'other', type: 'text' })).body;
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'CI' })).body;
    const r = await api.req('PATCH', `/webhooks/${hook.id}/${hook.token}`, null, { channelId: other.id });
    expect(r.status).toBe(400);
    expect((await api.req('GET', `/webhooks/${hook.id}`, owner.token)).body.channelId).toBe(general.id);
    expect((await api.req('PATCH', `/webhooks/${hook.id}/${hook.token}`, null, { name: 'Renamed' })).status).toBe(200);
    expect((await api.req('PATCH', `/webhooks/${hook.id}`, owner.token, { channelId: other.id })).body.channelId).toBe(other.id); // MANAGE_WEBHOOKS route still moves
  });
});
