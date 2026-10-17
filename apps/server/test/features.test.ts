import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { authenticator } from 'otplib';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';
import { isPrivateIp } from '../src/lib/ssrf';
import { unfurl } from '../src/services/unfurl';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(...names: string[]) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Feat' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  return { owner, guild, general: guild.channels.find((c: any) => c.name === 'general'), members };
}
const multipart = (parts: { name: string; value: string | Buffer; filename?: string; type?: string }[]) => {
  const b = 'XBOUNDARYX'; const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};
// 1x1 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('auth', () => {
  it('validates registration, rejects duplicates and weak input', async () => {
    const u = await api.register('dupe');
    expect((await api.req('POST', '/auth/register', null, { email: u.user.email, username: 'other_name', password: 'longenoughpw' })).status).toBe(409);
    expect((await api.req('POST', '/auth/register', null, { email: 'a@b.co', username: 'x', password: 'longenoughpw' })).status).toBe(400);
    expect((await api.req('POST', '/auth/register', null, { email: 'a@b.co', username: 'okname', password: 'short' })).status).toBe(400);
    expect((await api.req('POST', '/auth/register', null, { email: 'a@b.co', username: 'okname', password: 'longenoughpw', admin: true })).status).toBe(400);
    expect(u.user.passwordHash).toBeUndefined();
  });

  it('login, refresh rotation and reuse detection', async () => {
    const u = await api.register('rot');
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'wrong password!' })).status).toBe(401);
    expect((await api.req('POST', '/auth/login', null, { email: 'nobody@example.com', password: 'wrong password!' })).status).toBe(401);
    const login = await api.req('POST', '/auth/login', null, { email: u.user.email.toUpperCase(), password: 'correct horse battery' });
    expect(login.status).toBe(200);
    const exp = decodeJwt(login.body.accessToken);
    expect(exp.exp! - exp.iat!).toBe(15 * 60);
    const r1 = await api.req('POST', '/auth/refresh', null, { refreshToken: login.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    expect((await api.req('GET', '/users/@me', r1.body.accessToken)).status).toBe(200);
    // replaying the old token kills the session
    const replay = await api.req('POST', '/auth/refresh', null, { refreshToken: login.body.refreshToken });
    expect(replay.status).toBe(401); expect(replay.body.code).toBe('TOKEN_REUSED');
    expect((await api.req('POST', '/auth/refresh', null, { refreshToken: r1.body.refreshToken })).status).toBe(401);
    expect((await api.req('GET', '/users/@me', r1.body.accessToken)).status).toBe(401);
  });

  it('MFA flow', async () => {
    const u = await api.register('mfa');
    const setup = (await api.req('POST', '/auth/mfa/setup', u.token)).body;
    expect((await api.req('POST', '/auth/mfa/enable', u.token, { code: '000000' })).status).toBe(400);
    expect((await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(setup.secret) })).body.mfaEnabled).toBe(true);
    const noCode = await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'correct horse battery' });
    expect(noCode.status).toBe(401); expect(noCode.body.code).toBe('MFA_REQUIRED');
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'correct horse battery', totp: '123456' })).status).toBe(401);
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'correct horse battery', totp: authenticator.generate(setup.secret) })).status).toBe(200);
  });

  it('password change revokes other sessions', async () => {
    const u = await api.register('pw');
    const second = (await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'correct horse battery' })).body;
    expect((await api.req('POST', '/auth/password', u.token, { currentPassword: 'nope nope nope', newPassword: 'another long pass' })).status).toBe(401);
    expect((await api.req('POST', '/auth/password', u.token, { currentPassword: 'correct horse battery', newPassword: 'another long pass' })).status).toBe(204);
    expect((await api.req('GET', '/users/@me', second.accessToken)).status).toBe(401);
    expect((await api.req('GET', '/users/@me', u.token)).status).toBe(200);
  });

  it('rate limiting kicks in on auth routes when enabled', async () => {
    const rl = await startServer({ rateLimit: true });
    const a = new Api(rl);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await a.req('POST', '/auth/login', null, { email: `x${i}@example.com`, password: 'whatever pass' })).status;
    expect(last).toBe(429);
    await rl.close();
  });
});

describe('users, relationships and DMs', () => {
  it('friend requests, blocks and DMs', async () => {
    const a = await api.register('fa'), b = await api.register('fb'), c = await api.register('fc');
    // cannot DM strangers
    expect((await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).status).toBe(403);
    const wsB = await WsClient.connect(env.port); await wsB.identify(b.token);
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' })).body.type).toBe('outgoing');
    await wsB.waitEvent('RELATIONSHIP_ADD', (d) => d.user.id === a.id && d.type === 'incoming');
    expect((await api.req('GET', '/users/@me/relationships', b.token)).body[0].type).toBe('incoming');
    expect((await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'friend' })).body.type).toBe('friend');
    expect((await api.req('GET', '/users/@me/relationships', a.token)).body[0].type).toBe('friend');
    const dm = await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] });
    expect(dm.status).toBe(201); expect(dm.body.type).toBe('dm'); expect(dm.body.recipients).toHaveLength(2);
    expect((await api.req('POST', '/users/@me/channels', b.token, { recipientIds: [a.id] })).body.id).toBe(dm.body.id); // deduped
    await wsB.waitEvent('CHANNEL_CREATE', (d) => d.id === dm.body.id);
    const m = await api.req('POST', `/channels/${dm.body.id}/messages`, a.token, { content: 'psst' });
    expect(m.status).toBe(201);
    await wsB.waitEvent('MESSAGE_CREATE', (d) => d.content === 'psst');
    expect((await api.req('GET', `/channels/${dm.body.id}/messages`, c.token)).status).toBe(404); // outsider
    // block stops DMs
    await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'blocked' });
    expect((await api.req('POST', `/channels/${dm.body.id}/messages`, a.token, { content: 'hello?' })).status).toBe(403);
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' })).status).toBe(403);
    expect((await api.req('DELETE', `/users/@me/relationships/${a.id}`, b.token)).status).toBe(204);
    // group DM
    await api.req('PUT', `/users/@me/relationships/${c.id}`, a.token, { type: 'friend' });
    await api.req('PUT', `/users/@me/relationships/${a.id}`, c.token, { type: 'friend' });
    const grp = await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [c.id, b.id] });
    expect(grp.status === 403 || grp.body.type === 'group_dm').toBe(true);
    wsB.close();
  });

  it('profile update and public profile', async () => {
    const a = await api.register('pf'), b = await api.register('pg');
    const p = await api.req('PATCH', '/users/@me', a.token, { displayName: 'Alice', bio: 'hi', customStatus: { text: 'busy', emoji: null }, theme: 'amoled', avatar: 'javascript:alert(1)' });
    expect(p.status).toBe(400);
    const ok = await api.req('PATCH', '/users/@me', a.token, { displayName: 'Alice', bio: 'hi', customStatus: { text: 'busy', emoji: null }, theme: 'amoled' });
    expect(ok.body.theme).toBe('amoled');
    const prof = (await api.req('GET', `/users/${a.id}`, b.token)).body;
    expect(prof.displayName).toBe('Alice'); expect(prof.email).toBeUndefined(); expect(prof.mutualGuilds).toEqual([]);
    expect((await api.req('PUT', '/users/@me/presence', a.token, { presence: 'dnd' })).status).toBe(204);
  });
});

describe('messages', () => {
  it('edit, delete, reply, reactions, pins, search, bulk delete', async () => {
    const { owner, general, guild, members: [bob] } = await guildWith('bob');
    const ws = await WsClient.connect(env.port); await ws.identify(bob!.token);
    const m1 = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'first needle message' })).body;
    const m2 = (await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'reply here', replyTo: m1.id })).body;
    expect(m2.type).toBe('reply'); expect(m2.referenced.id).toBe(m1.id);
    expect((await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'x', replyTo: '1' })).status).toBe(400);
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: '' })).status).toBe(400);
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'a'.repeat(4001) })).status).toBe(400);

    // edit: only author
    expect((await api.req('PATCH', `/channels/${general.id}/messages/${m1.id}`, bob!.token, { content: 'hax' })).status).toBe(403);
    const ed = await api.req('PATCH', `/channels/${general.id}/messages/${m1.id}`, owner.token, { content: 'first needle edited' });
    expect(ed.body.editedAt).toBeTruthy();
    await ws.waitEvent('MESSAGE_UPDATE', (d) => d.id === m1.id && d.content.endsWith('edited'));

    // reactions
    const e = encodeURIComponent('👍');
    expect((await api.req('PUT', `/channels/${general.id}/messages/${m1.id}/reactions/${e}/@me`, bob!.token)).status).toBe(204);
    await ws.waitEvent('MESSAGE_REACTION_ADD', (d) => d.messageId === m1.id && d.emoji === '👍');
    await api.req('PUT', `/channels/${general.id}/messages/${m1.id}/reactions/${e}/@me`, owner.token);
    const got = (await api.req('GET', `/channels/${general.id}/messages?limit=10`, bob!.token)).body.find((m: any) => m.id === m1.id);
    expect(got.reactions).toEqual([{ emoji: '👍', emojiId: null, count: 2, me: true }]);
    expect((await api.req('GET', `/channels/${general.id}/messages/${m1.id}/reactions/${e}`, bob!.token)).body).toHaveLength(2);
    expect((await api.req('DELETE', `/channels/${general.id}/messages/${m1.id}/reactions/${e}/${owner.id}`, bob!.token)).status).toBe(403);
    expect((await api.req('DELETE', `/channels/${general.id}/messages/${m1.id}/reactions/${e}/@me`, bob!.token)).status).toBe(204);
    await ws.waitEvent('MESSAGE_REACTION_REMOVE', (d) => d.userId === bob!.id);

    // pins: need MANAGE_MESSAGES
    expect((await api.req('PUT', `/channels/${general.id}/pins/${m1.id}`, bob!.token)).status).toBe(403);
    expect((await api.req('PUT', `/channels/${general.id}/pins/${m1.id}`, owner.token)).status).toBe(204);
    await ws.waitEvent('CHANNEL_PINS_UPDATE');
    expect((await api.req('GET', `/channels/${general.id}/pins`, bob!.token)).body.map((m: any) => m.id)).toEqual([m1.id]);

    // search
    const s = await api.req('GET', `/guilds/${guild.id}/messages/search?q=needle`, bob!.token);
    expect(s.body.map((m: any) => m.id)).toEqual([m1.id]);
    expect((await api.req('GET', `/guilds/${guild.id}/messages/search?q=%25`, bob!.token)).body).toEqual([]); // LIKE wildcards are escaped
    expect((await api.req('GET', `/guilds/${guild.id}/messages/search?authorId=${bob!.id}`, bob!.token)).body.some((m: any) => m.id === m2.id)).toBe(true);

    // pagination
    const page = (await api.req('GET', `/channels/${general.id}/messages?limit=2`, bob!.token)).body;
    expect(page).toHaveLength(2); expect(BigInt(page[0].id) > BigInt(page[1].id)).toBe(true);
    const older = (await api.req('GET', `/channels/${general.id}/messages?before=${page[1].id}`, bob!.token)).body;
    expect(older.every((m: any) => BigInt(m.id) < BigInt(page[1].id))).toBe(true);
    const after = (await api.req('GET', `/channels/${general.id}/messages?after=${m1.id}&limit=50`, bob!.token)).body;
    expect(after.every((m: any) => BigInt(m.id) > BigInt(m1.id))).toBe(true);

    // delete + bulk
    expect((await api.req('DELETE', `/channels/${general.id}/messages/${m2.id}`, bob!.token)).status).toBe(204);
    await ws.waitEvent('MESSAGE_DELETE', (d) => d.id === m2.id);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: `bulk ${i}` })).body.id);
    expect((await api.req('POST', `/channels/${general.id}/messages/bulk-delete`, bob!.token, { messageIds: ids })).status).toBe(403);
    expect((await api.req('POST', `/channels/${general.id}/messages/bulk-delete`, owner.token, { messageIds: ids })).status).toBe(204);
    expect((await api.req('GET', `/channels/${general.id}/messages?limit=100`, bob!.token)).body.some((m: any) => ids.includes(m.id))).toBe(false);
    ws.close();
  });

  it('typing is delivered to other viewers only', async () => {
    const { owner, general, members: [bob] } = await guildWith('t');
    const ws = await WsClient.connect(env.port); await ws.identify(bob!.token);
    const wsO = await WsClient.connect(env.port); await wsO.identify(owner.token);
    await api.req('POST', `/channels/${general.id}/typing`, owner.token);
    await ws.waitEvent('TYPING_START', (d) => d.userId === owner.id);
    await wsO.expectNone((f) => f.t === 'TYPING_START');
    ws.close(); wsO.close();
  });

  it('@everyone requires MENTION_EVERYONE; role mentions respect mentionable', async () => {
    const { owner, general, guild, members: [bob] } = await guildWith('m');
    const a = (await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: '@everyone hi' })).body;
    expect(a.mentionEveryone).toBe(false);
    const b = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: '@everyone hi' })).body;
    expect(b.mentionEveryone).toBe(true);
    const rs = (await api.req('GET', '/users/@me/read-states', bob!.token)).body.find((r: any) => r.channelId === general.id);
    expect(rs.mentionCount).toBe(1);
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'pingable', mentionable: false })).body;
    expect((await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: `<@&${role.id}>` })).body.mentionRoles).toEqual([]);
    await api.req('PATCH', `/guilds/${guild.id}/roles/${role.id}`, owner.token, { mentionable: true });
    expect((await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: `<@&${role.id}>` })).body.mentionRoles).toEqual([role.id]);
  });

  it('slowmode and automod', async () => {
    const { owner, general, guild, members: [bob] } = await guildWith('s');
    await api.req('PATCH', `/channels/${general.id}`, owner.token, { slowmode: 30 });
    expect((await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'one' })).status).toBe(201);
    const second = await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'two' });
    expect(second.status).toBe(429); expect(second.body.code).toBe('SLOWMODE');
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'a' })).status).toBe(201); // managers bypass
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'b' })).status).toBe(201);
    await api.req('PATCH', `/channels/${general.id}`, owner.token, { slowmode: 0 });

    expect((await api.req('POST', `/guilds/${guild.id}/automod/rules`, bob!.token, { name: 'x', trigger: 'keyword', action: 'block' })).status).toBe(403);
    const rule = await api.req('POST', `/guilds/${guild.id}/automod/rules`, owner.token, { name: 'bad words', trigger: 'keyword', keywords: ['badword'], action: 'block' });
    expect(rule.status).toBe(201);
    const blocked = await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'this is a BadWord ok' });
    expect(blocked.status).toBe(400); expect(blocked.body.code).toBe('AUTOMOD_BLOCKED');
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'badword from admin' })).status).toBe(201);
    expect((await api.req('DELETE', `/guilds/${guild.id}/automod/rules/${rule.body.id}`, owner.token)).status).toBe(204);
    expect((await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'badword' })).status).toBe(201);
  });

  it('threads and forum posts', async () => {
    const { owner, general, guild, members: [bob] } = await guildWith('th');
    const msg = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'topic' })).body;
    const ws = await WsClient.connect(env.port); await ws.identify(bob!.token);
    const th = await api.req('POST', `/channels/${general.id}/messages/${msg.id}/threads`, bob!.token, { name: 'discussion' });
    expect(th.status).toBe(201); expect(th.body.type).toBe('thread'); expect(th.body.parentId).toBe(general.id);
    await ws.waitEvent('THREAD_CREATE', (d) => d.id === th.body.id);
    expect((await api.req('POST', `/channels/${general.id}/messages/${msg.id}/threads`, bob!.token, { name: 'again' })).status).toBe(409);
    expect((await api.req('POST', `/channels/${th.body.id}/messages`, owner.token, { content: 'in thread' })).status).toBe(201);
    await ws.waitEvent('MESSAGE_CREATE', (d) => d.content === 'in thread');
    expect((await api.req('PATCH', `/channels/${th.body.id}`, owner.token, { archived: true })).status).toBe(200); // MANAGE_THREADS
    expect((await api.req('PATCH', `/channels/${th.body.id}`, bob!.token, { archived: false })).body.archived).toBe(false); // owner
    // forum
    const forum = guild.channels.find((c: any) => c.type === 'forum') ?? (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'ideas', type: 'forum' })).body;
    const post = await api.req('POST', `/channels/${forum.id}/forum/posts`, bob!.token, { name: 'My idea', content: 'let us do X' });
    expect(post.status).toBe(201); expect(post.body.message.content).toBe('let us do X'); expect(post.body.channel.parentId).toBe(forum.id);
    expect((await api.req('POST', `/channels/${forum.id}/messages`, bob!.token, { content: 'direct' })).status).toBe(400);
    expect((await api.req('GET', `/channels/${forum.id}/threads`, bob!.token)).body.map((c: any) => c.id)).toContain(post.body.channel.id);
    ws.close();
  });

  it('media channels only accept posts with an image or video', async () => {
    const { owner, general, guild, members: [bob] } = await guildWith('med');
    const media = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'clips', type: 'media' })).body;
    expect(media.type).toBe('media');
    // direct messages never post into a media channel (it behaves like a forum)
    expect((await api.req('POST', `/channels/${media.id}/messages`, owner.token, { content: 'hi' })).status).toBe(400);
    // a post without any media is rejected and leaves no thread behind
    expect((await api.req('POST', `/channels/${media.id}/forum/posts`, owner.token, { name: 'text only', content: 'no picture' })).status).toBe(400);
    expect((await api.req('GET', `/channels/${media.id}/threads`, owner.token)).body).toHaveLength(0);
    // a non-image attachment is rejected, and the claim rolls back so the file is reusable
    const up = multipart([{ name: 'file', value: Buffer.from('hello'), filename: 'notes.txt', type: 'text/plain' }]);
    const txt = (await api.req('POST', '/uploads', owner.token, up.payload as any, up.headers)).body;
    expect((await api.req('POST', `/channels/${media.id}/forum/posts`, owner.token, { name: 'not media', attachments: [txt.id] })).status).toBe(400);
    expect((await api.req('GET', `/channels/${media.id}/threads`, owner.token)).body).toHaveLength(0);
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { attachments: [txt.id] })).status).toBe(201);
    // an image post works even with no caption text
    const img = multipart([{ name: 'file', value: PNG, filename: 'shot.png', type: 'image/png' }]);
    const pic = (await api.req('POST', '/uploads', bob!.token, img.payload as any, img.headers)).body;
    const post = await api.req('POST', `/channels/${media.id}/forum/posts`, bob!.token, { name: 'Sunset', attachments: [pic.id] });
    expect(post.status).toBe(201); expect(post.body.message.content).toBe(''); expect(post.body.message.attachments).toHaveLength(1); expect(post.body.channel.parentId).toBe(media.id);
    expect((await api.req('GET', `/channels/${media.id}/threads`, owner.token)).body.map((c: any) => c.id)).toContain(post.body.channel.id);
    // the media post's own thread still accepts plain text replies
    expect((await api.req('POST', `/channels/${post.body.channel.id}/messages`, owner.token, { content: 'nice shot' })).status).toBe(201);
  });

  it('emojis, boosts, discovery, webhooks', async () => {
    const { owner, general, guild, members: [bob] } = await guildWith('w');
    expect((await api.req('POST', `/guilds/${guild.id}/emojis`, bob!.token, { name: 'wave', url: '/api/v1/files/x/y.png' })).status).toBe(403);
    const em = await api.req('POST', `/guilds/${guild.id}/emojis`, owner.token, { name: 'wave', url: '/api/v1/files/x/y.png' });
    expect(em.status).toBe(201);
    const r = await api.req('PUT', `/channels/${general.id}/messages/${(await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'e' })).body.id}/reactions/wave:${em.body.id}/@me`, bob!.token);
    expect(r.status).toBe(204);
    expect((await api.req('POST', `/guilds/${guild.id}/boosts`, bob!.token)).body.boostCount).toBe(1);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { discoverable: true, description: 'cool place' })).status).toBe(200);
    expect((await api.req('GET', '/discover/guilds', bob!.token)).body.some((g: any) => g.id === guild.id)).toBe(true);

    expect((await api.req('POST', `/channels/${general.id}/webhooks`, bob!.token, { name: 'hook' })).status).toBe(403);
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'CI Bot' })).body;
    expect((await api.req('POST', `/webhooks/${hook.id}/wrongtokenwrongtoken`, null, { content: 'x' })).status).toBe(404);
    const ex = await api.req('POST', `/webhooks/${hook.id}/${hook.token}?wait=true`, null, { content: 'build passed' });
    expect(ex.status).toBe(200); expect(ex.body.author.bot).toBe(true); expect(ex.body.webhookId).toBe(hook.id);
  });
});

describe('files', () => {
  it('uploads with dimensions, attaches to messages, serves range requests', async () => {
    const { owner, general, members: [bob] } = await guildWith('f');
    const mp = multipart([{ name: 'file', value: PNG, filename: 'dot.png', type: 'image/png' }]);
    const up = await api.req('POST', '/uploads', owner.token, mp.payload as any, mp.headers);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ filename: 'dot.png', contentType: 'image/png', width: 1, height: 1, size: PNG.length });
    // attach by id; someone else cannot claim it
    expect((await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { attachments: [up.body.id] })).status).toBe(404);
    const msg = await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'img', attachments: [up.body.id] });
    expect(msg.status).toBe(201); expect(msg.body.attachments[0].url).toBe(up.body.url);
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'again', attachments: [up.body.id] })).status).toBe(404);
    // download + range
    const full = await env.app.inject({ url: up.body.url });
    expect(full.statusCode).toBe(200); expect(full.headers['content-type']).toBe('image/png'); expect(full.rawPayload.equals(PNG)).toBe(true);
    const part = await env.app.inject({ url: up.body.url, headers: { range: 'bytes=0-7' } });
    expect(part.statusCode).toBe(206); expect(part.headers['content-range']).toBe(`bytes 0-7/${PNG.length}`); expect(part.rawPayload.length).toBe(8);
    expect((await env.app.inject({ url: up.body.url, headers: { range: 'bytes=-4' } })).rawPayload.equals(PNG.subarray(PNG.length - 4))).toBe(true);
    expect((await env.app.inject({ url: up.body.url, headers: { range: 'bytes=9999-' } })).statusCode).toBe(416);
    expect((await env.app.inject({ url: '/api/v1/files/' + 'a'.repeat(48) + '/x.png' })).statusCode).toBe(404);

    // active content is never served inline
    const html = multipart([{ name: 'file', value: '<script>alert(1)</script>', filename: '../../evil.html', type: 'text/html' }]);
    const h = (await api.req('POST', '/uploads', owner.token, html.payload as any, html.headers)).body;
    expect(h.filename).toBe('evil.html');
    const served = await env.app.inject({ url: h.url });
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(String(served.headers['content-disposition'])).toMatch(/^attachment/);
    expect(served.headers['x-content-type-options']).toBe('nosniff');

    // multipart message creation
    const mm = multipart([{ name: 'content', value: 'with file' }, { name: 'files[]', value: PNG, filename: 'a.png', type: 'image/png' }]);
    const m = await api.req('POST', `/channels/${general.id}/messages`, owner.token, mm.payload as any, mm.headers);
    expect(m.status).toBe(201); expect(m.body.attachments).toHaveLength(1);
  });

  it('enforces the upload size limit', async () => {
    const small = await startServer({ maxUploadBytes: 1000 });
    const a = new Api(small); const u = await a.register('big');
    const mp = multipart([{ name: 'file', value: Buffer.alloc(5000, 1), filename: 'big.bin', type: 'application/octet-stream' }]);
    const r = await a.req('POST', '/uploads', u.token, mp.payload as any, mp.headers);
    expect(r.status).toBe(413);
    await small.close();
  });
});

describe('ssrf', () => {
  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it('refuses to fetch loopback / metadata / odd schemes / odd ports', async () => {
    const cfg = { config: { allowPrivateUnfurl: false } } as any;
    for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'file:///etc/passwd', 'http://example.com:22/', 'http://0x7f.0.0.1/', 'http://user:pw@8.8.8.8/'])
      expect(await unfurl(cfg, u), u).toBeNull();
  });
  it('the /unfurl route rejects private targets', async () => {
    const u = await api.register('unf');
    expect((await api.req('GET', '/unfurl?url=http%3A%2F%2F127.0.0.1%3A' + env.port + '%2Fhealth', u.token)).status).toBe(404);
    expect((await api.req('GET', '/unfurl?url=ftp%3A%2F%2Fexample.com', u.token)).status).toBe(400);
  });
  it('unfurls pages when private addresses are allowed (local fixture)', async () => {
    const http = await import('node:http');
    const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<html><head><title>T</title><meta property="og:title" content="Hello &amp; welcome"><meta property="og:description" content="desc"><meta property="og:image" content="/i.png"></head></html>'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    const e = await unfurl({ config: { allowPrivateUnfurl: true } } as any, `http://127.0.0.1:${port}/`);
    expect(e).toMatchObject({ type: 'link', title: 'Hello & welcome', description: 'desc', thumbnail: `http://127.0.0.1:${port}/i.png` });
    srv.close();
  });
});

describe('gateway protocol', () => {
  it('HELLO/heartbeat/identify, rejects bad tokens, resumes with replay', async () => {
    const { owner, general, members: [bob] } = await guildWith('gw');
    const bad = await WsClient.connect(env.port);
    const hello = await bad.waitFor((f) => f.op === 10);
    expect(hello.d.heartbeatInterval).toBe(30000);
    bad.send({ op: 2, d: { token: 'nope' } });
    expect((await bad.waitClose()).code).toBe(4004);

    const c = await WsClient.connect(env.port);
    await c.identify(bob!.token);
    c.send({ op: 1 });
    await c.waitFor((f) => f.op === 11);
    const sessionId = c.sessionId; const seq = c.lastSeq;
    c.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'while you were away' });
    await new Promise((r) => setTimeout(r, 150));
    const c2 = await WsClient.connect(env.port);
    await c2.waitFor((f) => f.op === 10);
    c2.send({ op: 6, d: { token: bob!.token, sessionId, seq } });
    const replay = await c2.waitEvent('MESSAGE_CREATE', (d) => d.content === 'while you were away');
    expect(replay.s).toBeGreaterThan(seq);
    await c2.waitEvent('RESUMED');
    // invalid resume -> RECONNECT
    const c3 = await WsClient.connect(env.port);
    await c3.waitFor((f) => f.op === 10);
    c3.send({ op: 6, d: { token: bob!.token, sessionId: 'unknown', seq: 0 } });
    await c3.waitFor((f) => f.op === 7);
    // someone else's session cannot be resumed
    const c4 = await WsClient.connect(env.port);
    await c4.waitFor((f) => f.op === 10);
    c4.send({ op: 6, d: { token: owner.token, sessionId, seq } });
    await c4.waitFor((f) => f.op === 7);
    c2.close();
  });

  it('revoking a session closes its socket', async () => {
    const u = await api.register('rv');
    const c = await WsClient.connect(env.port); await c.identify(u.token);
    await api.req('POST', '/auth/logout', u.token);
    expect((await c.waitClose()).code).toBe(4004);
  });

  it('presence updates and voice state via gateway', async () => {
    const { owner, guild, members: [bob] } = await guildWith('vc');
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    const a = await WsClient.connect(env.port); await a.identify(owner.token);
    const b = await WsClient.connect(env.port); await b.identify(bob!.token);
    b.send({ op: 3, d: { presence: 'dnd' } });
    await a.waitEvent('PRESENCE_UPDATE', (d) => d.userId === bob!.id && d.presence === 'dnd');
    b.send({ op: 4, d: { guildId: guild.id, channelId: voice.id, selfMute: true } });
    const vs = await a.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob!.id && d.channelId === voice.id);
    expect(vs.d).toMatchObject({ guildId: guild.id, selfMute: true });
    b.close();
    await a.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob!.id && d.channelId === null);
    a.close();
  });
});

describe('voice', () => {
  it('issues LiveKit tokens with permission-scoped grants', async () => {
    const { owner, guild, members: [bob] } = await guildWith('lk');
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    const r = await api.req('POST', '/voice/token', bob!.token, { channelId: voice.id });
    expect(r.status).toBe(200);
    expect(r.body.room).toBe(voice.id); expect(r.body.url).toBe('ws://localhost:7880');
    const claims: any = decodeJwt(r.body.token);
    expect(claims.iss).toBe('devkey'); expect(claims.sub).toBe(bob!.id);
    expect(claims.video).toMatchObject({ room: voice.id, roomJoin: true, canPublish: true });
    expect(JSON.parse(claims.metadata).userId).toBe(bob!.id);
    // text channel is not joinable
    const text = guild.channels.find((c: any) => c.name === 'general');
    expect((await api.req('POST', '/voice/token', bob!.token, { channelId: text.id })).status).toBe(400);
    // deny CONNECT -> 403
    await api.req('PUT', `/channels/${voice.id}/permissions/${bob!.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL), deny: String(Perm.CONNECT) });
    expect((await api.req('POST', '/voice/token', bob!.token, { channelId: voice.id })).status).toBe(403);
    // deny SPEAK + STREAM -> listen-only token
    await api.req('PUT', `/channels/${voice.id}/permissions/${bob!.id}`, owner.token, { type: 'member', allow: String(Perm.CONNECT), deny: String(Perm.SPEAK | Perm.STREAM) });
    const lo: any = decodeJwt((await api.req('POST', '/voice/token', bob!.token, { channelId: voice.id })).body.token);
    expect(lo.video.canPublish).toBe(false);
  });
  it('webhook receiver rejects unsigned calls', async () => {
    const r = await api.req('POST', '/voice/webhook', null, '{"event":"participant_left"}', { 'content-type': 'application/webhook+json' });
    expect(r.status).toBe(401);
  });
});
