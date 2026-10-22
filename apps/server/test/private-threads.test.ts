import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'PT', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: Client[] = [];
  for (const n of ['ann', 'bob', 'cat']) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  // @everyone may start private threads in #general
  await api.req('PUT', `/channels/${general.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: String(Perm.CREATE_PRIVATE_THREADS), deny: '0' });
  return { owner, guild, members, general };
}
const create = (token: string, parentId: string, body: object) => api.req('POST', `/channels/${parentId}/threads`, token, body);

describe('private threads', () => {
  it('creates public and private threads without a starter message', async () => {
    const { members: [ann], general } = await setup();
    const pub = await create(ann!.token, general.id, { name: 'open' });
    expect(pub.status).toBe(201); expect(pub.body).toMatchObject({ type: 'thread', parentId: general.id, name: 'open' }); expect(pub.body.private).toBeUndefined();
    const priv = await create(ann!.token, general.id, { name: 'secret', type: 'private' });
    expect(priv.status).toBe(201); expect(priv.body).toMatchObject({ private: true, invitable: true, ownerId: ann!.id });
    expect((await create(ann!.token, general.id, { name: '' })).status).toBe(400);
  });

  it('hides a private thread from non-members everywhere, until they are invited', async () => {
    const { owner, guild, members: [ann, bob, cat], general } = await setup();
    const t = (await create(ann!.token, general.id, { name: 'secret', type: 'private' })).body;
    const listed = async (c: Client) => (await api.req('GET', `/channels/${general.id}/threads/active`, c.token)).body.threads.map((x: any) => x.id);
    expect(await listed(ann!)).toEqual([t.id]);
    expect(await listed(bob!)).toEqual([]);
    expect(await listed(owner)).toEqual([t.id]); // the owner holds MANAGE_THREADS via ADMINISTRATOR
    expect((await api.req('GET', `/channels/${t.id}`, bob!.token)).status).toBe(404);
    expect((await api.req('POST', `/channels/${t.id}/messages`, bob!.token, { content: 'x' })).status).toBe(404);
    expect((await api.req('PUT', `/channels/${t.id}/thread-members/@me`, bob!.token)).status).toBe(404);
    expect((await api.req('GET', `/guilds/${guild.id}/threads/active`, bob!.token)).body.threads).toEqual([]);
    expect((await api.req('GET', `/guilds/${guild.id}`, bob!.token)).body.channels.some((c: any) => c.id === t.id)).toBe(false);

    // invite bob (invitable defaults to true: a plain member may add others)
    const wb = await WsClient.connect(env.port); await wb.identify(bob!.token);
    expect((await api.req('PUT', `/channels/${t.id}/thread-members/${bob!.id}`, ann!.token)).status).toBe(204);
    expect((await wb.waitEvent('THREAD_CREATE', (d) => d.id === t.id)).d.private).toBe(true);
    expect(await listed(bob!)).toEqual([t.id]);
    expect((await api.req('POST', `/channels/${t.id}/messages`, bob!.token, { content: 'hello' })).status).toBe(201);
    expect((await api.req('GET', `/guilds/${guild.id}`, bob!.token)).body.channels.some((c: any) => c.id === t.id)).toBe(true);
    // cat still cannot see it, and bob leaving hides it again
    expect(await listed(cat!)).toEqual([]);
    await api.req('DELETE', `/channels/${t.id}/thread-members/@me`, bob!.token);
    await wb.waitEvent('THREAD_DELETE', (d) => d.id === t.id);
    expect((await api.req('GET', `/channels/${t.id}`, bob!.token)).status).toBe(404);
    wb.close();
  });

  it('non-invitable private threads only accept invites from the owner or MANAGE_THREADS', async () => {
    const { members: [ann, bob, cat], general } = await setup();
    const t = (await create(ann!.token, general.id, { name: 'closed', type: 'private', invitable: false })).body;
    expect(t.invitable).toBe(false);
    expect((await api.req('PUT', `/channels/${t.id}/thread-members/${bob!.id}`, ann!.token)).status).toBe(204); // the owner may
    expect((await api.req('PUT', `/channels/${t.id}/thread-members/${cat!.id}`, bob!.token)).status).toBe(403); // a plain member may not
  });

  it('requires CREATE_PRIVATE_THREADS and a text parent', async () => {
    const { owner, guild, members: [ann], general } = await setup();
    await api.req('PUT', `/channels/${general.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.CREATE_PRIVATE_THREADS) });
    expect((await create(ann!.token, general.id, { name: 'nope', type: 'private' })).status).toBe(403);
    expect((await create(ann!.token, general.id, { name: 'fine' })).status).toBe(201);
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    expect((await create(owner.token, voice.id, { name: 'x' })).status).toBe(400);
  });

  it('sends THREAD_LIST_SYNC after READY with only the threads the session may see', async () => {
    const { members: [ann, bob], guild, general } = await setup();
    const pub = (await create(ann!.token, general.id, { name: 'pub' })).body;
    const priv = (await create(ann!.token, general.id, { name: 'priv', type: 'private' })).body;
    const wa = await WsClient.connect(env.port); await wa.identify(ann!.token);
    const sa = await wa.waitEvent('THREAD_LIST_SYNC', (d) => d.guildId === guild.id);
    expect(sa.d.threads.map((t: any) => t.id).sort()).toEqual([pub.id, priv.id].sort());
    expect(sa.d.members.map((m: any) => m.threadId).sort()).toEqual([pub.id, priv.id].sort());
    const wb = await WsClient.connect(env.port); await wb.identify(bob!.token);
    const sb = await wb.waitEvent('THREAD_LIST_SYNC', (d) => d.guildId === guild.id);
    expect(sb.d.threads.map((t: any) => t.id)).toEqual([pub.id]); expect(sb.d.members).toEqual([]);
    wa.close(); wb.close();
  });

  it('lists archived private threads only for members', async () => {
    const { members: [ann, bob], general } = await setup();
    const t = (await create(ann!.token, general.id, { name: 'old', type: 'private' })).body;
    expect((await api.req('PATCH', `/channels/${t.id}`, ann!.token, { archived: true })).status).toBe(200);
    const arch = async (c: Client) => (await api.req('GET', `/channels/${general.id}/threads/archived`, c.token)).body.threads.map((x: any) => x.id);
    expect(await arch(ann!)).toEqual([t.id]);
    expect(await arch(bob!)).toEqual([]);
  });

  it('sends THREAD_LIST_SYNC with channelIds when a user gains access to a parent channel', async () => {
    const { owner, guild, members: [bob] } = await setup();
    const hidden = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'hidden', type: 'text' })).body;
    await api.req('PUT', `/channels/${hidden.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    const th = (await create(owner.token, hidden.id, { name: 'inside' })).body;
    const wb = await WsClient.connect(env.port); await wb.identify(bob!.token);
    await api.req('DELETE', `/channels/${hidden.id}/permissions/${guild.id}`, owner.token);
    const sync = await wb.waitEvent('THREAD_LIST_SYNC', (d) => Array.isArray(d.channelIds) && d.channelIds.includes(hidden.id));
    expect(sync.d.threads.map((t: any) => t.id)).toEqual([th.id]);
    wb.close();
  });
});
