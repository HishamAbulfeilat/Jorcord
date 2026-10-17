import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(...names: string[]) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Profiles' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  return { owner, guild, members };
}

describe('per-server member profiles', () => {
  it('lets a member set and clear their own banner, bio, pronouns and avatar', async () => {
    const { guild, members } = await guildWith('self');
    const me = members[0]!;
    const r = await api.req('PATCH', `/guilds/${guild.id}/members/@me`, me.token, { avatar: '/files/avatars/a.png', banner: 'https://cdn.example/b.png', bio: 'Hello **world**', pronouns: 'she/her' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ avatar: '/files/avatars/a.png', banner: 'https://cdn.example/b.png', bio: 'Hello **world**', pronouns: 'she/her' });
    // persisted and visible to other members
    const list = (await api.req('GET', `/guilds/${guild.id}/members`, me.token)).body;
    expect(list.find((m: any) => m.user.id === me.id)).toMatchObject({ bio: 'Hello **world**', pronouns: 'she/her' });
    // clearing stores NULL so the user-level value shows through again
    const cleared = await api.req('PATCH', `/guilds/${guild.id}/members/@me`, me.token, { bio: '', pronouns: '' });
    expect(cleared.body).toMatchObject({ bio: null, pronouns: null });
    const one = (await api.req('GET', `/guilds/${guild.id}/members/${me.id}`, me.token)).body;
    expect(one.bio).toBeNull(); expect(one.pronouns).toBeNull();
  });

  it('refuses to let one member edit another member\'s profile', async () => {
    const { owner, guild, members } = await guildWith('victim');
    const victim = members[0]!;
    const r = await api.req('PATCH', `/guilds/${guild.id}/members/${victim.id}`, owner.token, { bio: 'not yours' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_SELF');
    // a moderator renaming someone still works (unchanged behaviour)
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${victim.id}`, owner.token, { nick: 'renamed' })).body.nick).toBe('renamed');
  });

  it('validates profile limits and asset URLs', async () => {
    const { guild, members } = await guildWith('limits');
    const me = members[0]!;
    const status = async (body: unknown) => (await api.req('PATCH', `/guilds/${guild.id}/members/@me`, me.token, body)).status;
    expect(await status({ bio: 'x'.repeat(401) })).toBe(400);
    expect(await status({ pronouns: 'x'.repeat(41) })).toBe(400);
    expect(await status({ nick: 'x'.repeat(33) })).toBe(400);
    expect(await status({ avatar: 'javascript:alert(1)' })).toBe(400);
    expect(await status({ banner: '//evil.example/x.png' })).toBe(400);
  });
});
