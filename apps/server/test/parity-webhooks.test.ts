import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

// Webhook full API (CONTRACT.md "Webhooks full API"): tokenless get/patch/delete by webhook id,
// guild-wide list, execute with ?wait=true and threadId, and webhook message get/edit/delete.
let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(): Promise<{ owner: Client; bob: Client; guildId: string; general: any; other: any }> {
  const owner = await api.register('o'), bob = await api.register('b');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Hooks' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  await api.req('POST', `/invites/${code}`, bob.token);
  return { owner, bob, guildId: guild.id, general: guild.channels.find((c: any) => c.name === 'general'), other: (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'other', type: 'text' })).body };
}

describe('webhook full API', () => {
  it('manages webhooks by id without the token (MANAGE_WEBHOOKS only)', async () => {
    const { owner, bob, guildId, general, other } = await guildWith();
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'CI' })).body;
    // guild-wide list, tokenless get
    expect((await api.req('GET', `/guilds/${guildId}/webhooks`, bob.token)).status).toBe(403);
    expect((await api.req('GET', `/guilds/${guildId}/webhooks`, owner.token)).body).toHaveLength(1);
    expect((await api.req('GET', `/webhooks/${hook.id}`, owner.token)).body).toMatchObject({ id: hook.id, name: 'CI', channelId: general.id });
    // rename + move + avatar clear (tokenless, MANAGE_WEBHOOKS on both channels)
    const moved = await api.req('PATCH', `/webhooks/${hook.id}`, owner.token, { name: 'Deploy Bot', channelId: other.id });
    expect(moved.body).toMatchObject({ name: 'Deploy Bot', channelId: other.id, token: hook.token });
    expect((await api.req('PATCH', `/webhooks/${hook.id}`, owner.token, { avatar: null })).body.avatar).toBeNull();
    // execute still lands in the new channel
    expect((await api.req('POST', `/webhooks/${hook.id}/${hook.token}?wait=true`, null, { content: 'moved' })).body.channelId).toBe(other.id);
    // tokenless delete
    expect((await api.req('DELETE', `/webhooks/${hook.id}`, bob.token)).status).toBe(403);
    expect((await api.req('DELETE', `/webhooks/${hook.id}`, owner.token)).status).toBe(204);
    expect((await api.req('GET', `/webhooks/${hook.id}`, owner.token)).status).toBe(404);
  });

  it('gets, patches and deletes with the token alone (no user needed)', async () => {
    const { owner, general } = await guildWith();
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'Watcher' })).body;
    const path = `/webhooks/${hook.id}/${hook.token}`;
    expect((await api.req('GET', path, null)).body).toMatchObject({ name: 'Watcher', url: path });
    expect((await api.req('PATCH', path, null, { username: 'x' })).status).toBe(400); // strict body: field is name
    expect((await api.req('PATCH', path, null, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await api.req('PATCH', `${path}/nope`, null, { name: 'X' })).status).toBe(404);
    expect((await api.req('DELETE', path, null)).status).toBe(204);
    expect((await api.req('POST', path + '?wait=true', null, { content: 'x' })).status).toBe(404);
  });

  it('waits only when asked, posts into threads and edits/deletes its own messages', async () => {
    const { owner, general } = await guildWith();
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'Threads' })).body;
    const path = `/webhooks/${hook.id}/${hook.token}`;
    expect((await api.req('POST', path, null, { content: 'nowait' })).status).toBe(204);
    const msg = (await api.req('POST', path + '?wait=true', null, { content: 'root' })).body;
    expect(msg.webhookId).toBe(hook.id);
    const thread = (await api.req('POST', `/channels/${msg.channelId}/messages/${msg.id}/threads`, owner.token, { name: 'Follow-up' })).body;
    const tmsg = (await api.req('POST', path + '?wait=true', null, { content: 'in thread', threadId: thread.id })).body;
    expect(tmsg.channelId).toBe(thread.id);
    // foreign thread/unknown thread rejected
    expect((await api.req('POST', path + '?wait=true', null, { content: 'x', threadId: general.id })).status).toBe(400);
    // the thread message lives in the thread channel
    const got = await api.req('GET', `${path}/messages/${tmsg.id}`, null);
    expect(got.body.content).toBe('in thread');
    expect((await api.req('PATCH', `${path}/messages/${tmsg.id}`, null, { content: 'edited' })).body.content).toBe('edited');
    // a human message is not ours to touch
    const bob = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'human' })).body;
    expect((await api.req('DELETE', `${path}/messages/${bob.id}`, null)).status).toBe(404); // webhook can only delete its own
    expect((await api.req('GET', `${path}/messages/${bob.id}`, null)).status).toBe(404);
    await api.req('DELETE', `${path}/messages/${tmsg.id}`, null); // thread message
    expect((await api.req('GET', `${path}/messages/${tmsg.id}`, null)).status).toBe(404);
    // deleting one of our live messages dispatches MESSAGE_DELETE
    await api.req('DELETE', `${path}/messages/${msg.id}`, null);
    const wsClient = await WsClient.connect(env.port);
    await wsClient.identify(owner.token);
    const soon = (await api.req('POST', path + '?wait=true', null, { content: 'gone soon' })).body;
    await api.req('DELETE', `${path}/messages/${soon.id}`, null);
    await wsClient.waitEvent('MESSAGE_DELETE', (d) => d.id === soon.id);
    expect((await api.req('GET', `${path}/messages/${soon.id}`, null)).status).toBe(404);
    wsClient.close();
  });
});
