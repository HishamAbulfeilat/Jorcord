import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import { canUseEmoji } from '../src/services/emojis';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const FILE = '/api/v1/files/' + 'a'.repeat(48) + '/e.png';
async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Emoji', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: Client[] = [];
  for (const n of ['vip', 'pleb']) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  const vipRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'vip', permissions: '0' })).body;
  await api.req('PATCH', `/guilds/${guild.id}/members/${members[0]!.id}`, owner.token, { roles: [vipRole.id] });
  return { owner, guild, members, general, vipRole };
}

describe('canUseEmoji', () => {
  it('allows unrestricted emoji, matching roles and emoji managers only', () => {
    expect(canUseEmoji([], ['r1'], 0n)).toBe(true);
    expect(canUseEmoji(undefined, undefined, 0n)).toBe(true);
    expect(canUseEmoji(['r1'], ['r2'], 0n)).toBe(false);
    expect(canUseEmoji(['r1'], ['r2', 'r1'], 0n)).toBe(true);
    expect(canUseEmoji(['r1'], [], Perm.MANAGE_EMOJIS)).toBe(true);
  });
});

describe('role-restricted emoji', () => {
  it('stores roleIds, validates them and exposes them on the guild', async () => {
    const { owner, guild, vipRole } = await setup();
    const bad = await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'gem', url: FILE, roleIds: ['123'] });
    expect(bad.status).toBe(400);
    const everyone = await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'gem', url: FILE, roleIds: [guild.id] });
    expect(everyone.status).toBe(400); // @everyone is not a valid restriction
    const e = await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'gem', url: FILE, roleIds: [vipRole.id] });
    expect(e.status).toBe(201); expect(e.body.roleIds).toEqual([vipRole.id]);
    const plain = (await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'free', url: FILE })).body;
    expect(plain.roleIds).toBeUndefined();
    expect((await api.req('GET', `/guilds/${guild.id}`, owner.token)).body.emojis.find((x: any) => x.id === e.body.id).roleIds).toEqual([vipRole.id]);
    const cleared = await api.req('PATCH', `/guilds/${guild.id}/emojis/${e.body.id}`, owner.token, { roleIds: [] });
    expect(cleared.body.roleIds).toBeUndefined();
    expect((await api.req('PATCH', `/guilds/${guild.id}/emojis/${e.body.id}`, owner.token, {})).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}/emojis/${e.body.id}`, owner.token, { name: 'gem2', roleIds: [vipRole.id] })).body).toMatchObject({ name: 'gem2', roleIds: [vipRole.id] });
  });

  it('blocks messages and reactions from members without a matching role', async () => {
    const { owner, guild, members: [vip, pleb], general, vipRole } = await setup();
    const e = (await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'gem', url: FILE, roleIds: [vipRole.id] })).body;
    const tag = `<:gem:${e.id}>`;
    const post = (c: Client, content: string) => api.req('POST', `/channels/${general.id}/messages`, c.token, { content });
    expect((await post(pleb!, `hi ${tag}`)).status).toBe(403);
    expect((await post(pleb!, `hi ${tag}`)).body.code).toBe('EMOJI_RESTRICTED');
    expect((await post(pleb!, 'plain text')).status).toBe(201);
    const ok = await post(vip!, `hi ${tag}`);
    expect(ok.status).toBe(201);
    expect((await post(owner, `hi ${tag}`)).status).toBe(201); // emoji manager
    const react = (c: Client) => api.req('PUT', `/channels/${general.id}/messages/${ok.body.id}/reactions/${encodeURIComponent(`gem:${e.id}`)}/@me`, c.token);
    expect((await react(pleb!)).status).toBe(403);
    expect((await react(vip!)).status).toBe(204);
    // dropping the restriction opens it up to everybody
    await api.req('PATCH', `/guilds/${guild.id}/emojis/${e.id}`, owner.token, { roleIds: [] });
    expect((await post(pleb!, `hi ${tag}`)).status).toBe(201);
  });

  it('deleting a role lifts it from restricted emoji and pushes EMOJIS_UPDATE on changes', async () => {
    const { owner, guild, vipRole } = await setup();
    const w = await WsClient.connect(env.port); await w.identify(owner.token);
    const e = (await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'gem', url: FILE, roleIds: [vipRole.id] })).body;
    const upd = await w.waitEvent('EMOJIS_UPDATE', (d) => d.emojis.some((x: any) => x.id === e.id));
    expect(upd.d.emojis.find((x: any) => x.id === e.id).roleIds).toEqual([vipRole.id]);
    await api.req('DELETE', `/guilds/${guild.id}/roles/${vipRole.id}`, owner.token);
    const list = (await api.req('GET', `/guilds/${guild.id}/emojis`, owner.token)).body;
    expect(list.find((x: any) => x.id === e.id).roleIds).toBeUndefined();
    w.close();
  });
});
