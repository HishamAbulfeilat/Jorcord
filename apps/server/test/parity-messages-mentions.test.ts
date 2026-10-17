import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type Client, type TestEnv } from './helpers';

// allowed_mentions (CONTRACT.md): when omitted every parsed mention pings; when present
// it overrides — only `parse` entries ping, plus the explicit `users`/`roles` id lists.
let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

interface Fixture { owner: Client; bob: Client; carol: Client; dave: Client; guildId: string; role1: string; role2: string }

async function fixture(): Promise<Fixture> {
  const owner = await api.register('own'), bob = await api.register('bob'), carol = await api.register('car'), dave = await api.register('dave');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Mentions' })).body;
  for (const c of [bob, carol, dave]) {
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, c.token);
  }
  const role1 = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'r1', mentionable: true })).body.id;
  const role2 = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'r2', mentionable: true })).body.id;
  for (const [c, roles] of [[bob, [role1]], [carol, [role1]], [dave, [role2]]] as [Client, string[]][]) {
    await api.req('PATCH', `/guilds/${guild.id}/members/${c.id}`, owner.token, { roles });
  }
  return { owner, bob, carol, dave, guildId: guild.id, role1, role2 };
}

const badge = (c: Client, channelId: string) =>
  api.req('GET', '/users/@me/read-states', c.token).then((r) => r.body.find((s: any) => s.channelId === channelId)?.mentionCount ?? 0);

describe('allowed_mentions', () => {
  it('parses mentions the same way but echoes the field', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'echo', type: 'text' })).body;
    const a = (await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: `hi <@${f.bob.id}>`, allowedMentions: { parse: ['users'] } })).body;
    expect(a.mentions).toEqual([f.bob.id]);
    expect(a.allowedMentions).toEqual({ parse: ['users'] });
    expect((await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: 'plain' })).body.allowedMentions).toBeNull();
    expect((await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { allowedMentions: { parse: ['everyone'], users: ['badid'] } }).then((r) => r.status))).toBe(400);
  });

  it('omitted allowed_mentions keeps pinging everything', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'default', type: 'text' })).body;
    const m = (await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: `hi <@${f.bob.id}> <@&${f.role2}> @everyone` })).body;
    expect(m.mentions).toEqual([f.bob.id]);
    expect(m.mentionRoles).toEqual([f.role2]);
    expect(m.mentionEveryone).toBe(true);
    // mentionCount counts messages, not ping reasons (targets are a Set), so 1 per message, at most
    for (const c of [f.bob, f.carol, f.dave]) expect(await badge(c, ch.id)).toBe(1);
  });

  it('parse [] suppresses every ping while mentions still render', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'silent', type: 'text' })).body;
    await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: `hi <@${f.bob.id}> <@&${f.role1}> @everyone`, allowedMentions: { parse: [] } });
    for (const c of [f.bob, f.carol, f.dave]) expect(await badge(c, ch.id)).toBe(0);
  });

  it('parse users: everyone and roles do not ping, listed plus mentioned users do', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'users', type: 'text' })).body;
    await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: `hi <@${f.bob.id}> <@&${f.role1}> @everyone`, allowedMentions: { parse: ['users'] } });
    expect(await badge(f.bob, ch.id)).toBe(1);
    expect(await badge(f.carol, ch.id)).toBe(0); // only via role1 / everyone, both suppressed
    expect(await badge(f.dave, ch.id)).toBe(0);
  });

  it('the users id list only permits pings for users actually mentioned in the content', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'allow', type: 'text' })).body;
    await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: `hi <@${f.bob.id}> <@${f.carol.id}> @everyone`, allowedMentions: { parse: [], users: [f.bob.id] } });
    expect(await badge(f.bob, ch.id)).toBe(1);
    expect(await badge(f.carol, ch.id)).toBe(0); // mentioned in the content but not on the list
    expect(await badge(f.dave, ch.id)).toBe(0); // @everyone suppressed
  });

  it('a roles id list allows only listed roles when roles is not parsed', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'roles', type: 'text' })).body;
    await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: `hi <@&${f.role1}> <@&${f.role2}>`, allowedMentions: { parse: [], roles: [f.role1] } });
    expect(await badge(f.bob, ch.id)).toBe(1);
    expect(await badge(f.carol, ch.id)).toBe(1);
    expect(await badge(f.dave, ch.id)).toBe(0);
  });

  it('parse everyone pings exactly the @everyone/@here targets', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'everyone', type: 'text' })).body;
    await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: `hi <@${f.bob.id}> @everyone`, allowedMentions: { parse: ['everyone'] } });
    for (const c of [f.bob, f.carol, f.dave]) expect(await badge(c, ch.id)).toBe(1);
  });

  it('replied_user pings the replied author only when parsed', async () => {
    const f = await fixture();
    const ch = (await api.req('POST', `/guilds/${f.guildId}/channels`, f.owner.token, { name: 'replies', type: 'text' })).body;
    const base = (await api.req('POST', `/channels/${ch.id}/messages`, f.dave.token, { content: 'root' })).body;
    await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: 'no ping', replyTo: base.id });
    expect(await badge(f.dave, ch.id)).toBe(0);
    await api.req('POST', `/channels/${ch.id}/messages`, f.owner.token, { content: 'ping', replyTo: base.id, allowedMentions: { parse: ['replied_user'] } });
    expect(await badge(f.dave, ch.id)).toBe(1);
    expect(await badge(f.bob, ch.id)).toBe(0);
  });

  it('DM recipients always collect a badge (they are recipients, not parsed mentions)', async () => {
    const f = await fixture();
    await api.req('PUT', `/users/@me/relationships/${f.bob.id}`, f.owner.token, { type: 'friend' });
    await api.req('PUT', `/users/@me/relationships/${f.owner.id}`, f.bob.token, { type: 'friend' });
    const dm = (await api.req('POST', '/users/@me/channels', f.owner.token, { recipientIds: [f.bob.id] })).body;
    await api.req('POST', `/channels/${dm.id}/messages`, f.owner.token, { content: 'hello', allowedMentions: { parse: [] } });
    expect(await badge(f.bob, dm.id)).toBe(1);
  });
});
