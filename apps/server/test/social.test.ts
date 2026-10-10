import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(...names: string[]) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Social', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: Client[] = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  return { owner, guild, members, general };
}
const say = (c: Client, ch: string, content: string) => api.req('POST', `/channels/${ch}/messages`, c.token, { content });

describe('inbox mentions', () => {
  it('lists user, role and everyone mentions; hides own, blocked, unreadable channels', async () => {
    const { owner, guild, members: [a, b], general } = await guildWith('a', 'b');
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'crew', mentionable: true })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${a!.id}`, owner.token, { roles: [role.id] });
    const m1 = (await say(b!, general.id, `hey <@${a!.id}>`)).body;
    const m2 = (await say(b!, general.id, `crew <@&${role.id}>`)).body;
    const m3 = (await say(owner, general.id, '@everyone hi')).body;
    await say(b!, general.id, 'no mention');
    await say(a!, general.id, `<@${a!.id}> self`);
    const r = await api.req('GET', '/users/@me/mentions', a!.token);
    expect(r.status).toBe(200);
    expect(r.body.map((m: any) => m.id)).toEqual([m3.id, m2.id, m1.id]);
    // filters
    expect((await api.req('GET', '/users/@me/mentions?roles=false&everyone=false', a!.token)).body.map((m: any) => m.id)).toEqual([m1.id]);
    // pagination
    expect((await api.req('GET', `/users/@me/mentions?before=${m3.id}&limit=1`, a!.token)).body.map((m: any) => m.id)).toEqual([m2.id]);
    // a private channel hides its mentions
    const priv = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'secret', type: 'text' })).body;
    const ow = await api.req('PUT', `/channels/${priv.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect(ow.status).toBeLessThan(300);
    await api.req('PUT', `/channels/${priv.id}/permissions/${b!.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES), deny: '0' });
    await api.req('PUT', `/channels/${priv.id}/permissions/${a!.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY), deny: '0' });
    const sec = (await say(b!, priv.id, `psst <@${a!.id}>`)).body;
    expect((await api.req('GET', '/users/@me/mentions', a!.token)).body[0].id).toBe(sec.id);
    await api.req('PUT', `/channels/${priv.id}/permissions/${a!.id}`, owner.token, { type: 'member', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect((await api.req('GET', '/users/@me/mentions', a!.token)).body.map((m: any) => m.id)).not.toContain(sec.id);
    // blocked authors disappear
    await api.req('PUT', `/users/@me/relationships/${b!.id}`, a!.token, { type: 'blocked' });
    expect((await api.req('GET', '/users/@me/mentions', a!.token)).body.map((m: any) => m.id)).toEqual([m3.id]);
    // unauthenticated / another user's view never leaks
    expect((await api.req('GET', '/users/@me/mentions', null)).status).toBe(401);
    expect((await api.req('GET', '/users/@me/mentions?everyone=false', b!.token)).body.length).toBe(0);
  });
});

describe('user notes and mutual friends', () => {
  it('stores private notes (only the author sees them) and pushes the update', async () => {
    const a = await api.register('na'), b = await api.register('nb');
    const w = await WsClient.connect(env.port); await w.identify(a.token);
    expect((await api.req('GET', `/users/@me/notes/${b.id}`, a.token)).status).toBe(404);
    expect((await api.req('PUT', `/users/@me/notes/${b.id}`, a.token, { note: 'met at conf' })).status).toBe(204);
    expect((await w.waitEvent('USER_NOTE_UPDATE', (d) => d.userId === b.id)).d.note).toBe('met at conf');
    expect((await api.req('GET', `/users/${b.id}`, a.token)).body.note).toBe('met at conf');
    expect((await api.req('GET', `/users/${a.id}`, b.token)).body.note).toBeNull();
    expect((await api.req('GET', `/users/@me/notes/${a.id}`, b.token)).status).toBe(404);
    expect((await api.req('PUT', `/users/@me/notes/${b.id}`, a.token, { note: 'x'.repeat(257) })).status).toBe(400);
    expect((await api.req('PUT', `/users/@me/notes/999999999999`, a.token, { note: 'x' })).status).toBe(404);
    expect((await api.req('PUT', `/users/@me/notes/${b.id}`, a.token, { note: '  ' })).status).toBe(204);
    expect((await api.req('GET', `/users/${b.id}`, a.token)).body.note).toBeNull();
    w.close();
  });
  it('shows mutual friends', async () => {
    const a = await api.register('ma'), b = await api.register('mb'), c = await api.register('mc');
    const befriend = async (x: Client, y: Client) => { await api.req('PUT', `/users/@me/relationships/${y.id}`, x.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${x.id}`, y.token, { type: 'friend' }); };
    await befriend(a, c); await befriend(b, c);
    const p = (await api.req('GET', `/users/${b.id}`, a.token)).body;
    expect(p.mutualFriends.map((u: any) => u.id)).toEqual([c.id]);
    expect((await api.req('GET', `/users/${a.id}`, a.token)).body.mutualFriends).toEqual([]);
  });
});
