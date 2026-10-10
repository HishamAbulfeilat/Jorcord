import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { runSweeps } from '../src/services/sweeper';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const mpart = (filename: string, value: Buffer, type: string) => {
  const b = 'XBOUNDARYX';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), value, Buffer.from(`\r\n--${b}--\r\n`)]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};
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

describe('privacy: DMs, message requests, friend requests', () => {
  const befriend = async (x: Client, y: Client) => { await api.req('PUT', `/users/@me/relationships/${y.id}`, x.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${x.id}`, y.token, { type: 'friend' }); };
  const shared = async () => { const { owner, members: [a, b] } = await guildWith('pa', 'pb'); return { owner, a: a!, b: b! }; };

  it('defaults are complete and PATCH merges partial updates', async () => {
    const a = await api.register('pv');
    expect((await api.req('GET', '/users/@me', a.token)).body.privacy).toEqual({ allowDmsFromServerMembers: true, messageRequests: true, showActivity: true, friendRequests: { everyone: true, friendsOfFriends: true, serverMembers: true } });
    const r = await api.req('PATCH', '/users/@me', a.token, { privacy: { friendRequests: { everyone: false } } });
    expect(r.body.privacy.friendRequests).toEqual({ everyone: false, friendsOfFriends: true, serverMembers: true });
    expect((await api.req('PATCH', '/users/@me', a.token, { privacy: { allowDmsFromServerMembers: false } })).body.privacy.friendRequests.everyone).toBe(false);
    expect((await api.req('PATCH', '/users/@me', a.token, { privacy: { bogus: true } })).status).toBe(400);
    expect((await api.req('GET', `/users/${a.id}`, (await api.register('other')).token)).body.privacy).toBeUndefined(); // never public
  });

  it('refuses DMs from server members when switched off, but friends always get through', async () => {
    const { a, b } = await shared();
    await api.req('PATCH', '/users/@me', b.token, { privacy: { allowDmsFromServerMembers: false } });
    const r = await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] });
    expect(r.status).toBe(403); expect(r.body.code).toBe('DM_DISABLED');
    // group DM with a protected non-friend is refused too
    const c = await api.register('pc'); await befriend(a, c);
    expect((await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [c.id, b.id] })).status).toBe(403);
    await befriend(a, b);
    expect((await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).status).toBe(201);
  });

  it('non-friend DMs become message requests: hidden until the first message, silent, acceptable or ignorable', async () => {
    const { a, b } = await shared();
    const wb = await WsClient.connect(env.port); const ready = await wb.identify(b.token);
    expect(ready.d.messageRequests).toEqual([]);
    const ch = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    // empty request is invisible to the recipient
    expect((await api.req('GET', '/users/@me/channels', b.token)).body.map((c: any) => c.id)).not.toContain(ch.id);
    const sent = await say(a, ch.id, 'hi stranger');
    expect(sent.status).toBe(201);
    const ev = await wb.waitEvent('MESSAGE_REQUEST_UPDATE', (d) => d.channelId === ch.id);
    expect(ev.d.request).toBe(true);
    await wb.waitEvent('CHANNEL_CREATE', (d) => d.id === ch.id);
    expect((await api.req('GET', '/users/@me/channels', b.token)).body.map((c: any) => c.id)).toContain(ch.id);
    const w2 = await WsClient.connect(env.port);
    expect((await w2.identify(b.token)).d.messageRequests).toEqual([ch.id]);
    w2.close();
    // replying accepts it
    await say(b, ch.id, 'hello');
    expect((await wb.waitEvent('MESSAGE_REQUEST_UPDATE', (d) => d.channelId === ch.id && d.request === false)).d.request).toBe(false);
    const w3 = await WsClient.connect(env.port);
    expect((await w3.identify(b.token)).d.messageRequests).toEqual([]);
    w3.close(); wb.close();
  });

  it('accept and ignore endpoints, ignored senders cannot re-open a DM', async () => {
    const { a, b } = await shared();
    const ch = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    await say(a, ch.id, 'psst');
    // only the recipient may act on it
    expect((await api.req('POST', `/channels/${ch.id}/ignore-request`, a.token)).status).toBe(400);
    expect((await api.req('POST', `/channels/${ch.id}/accept-request`, (await api.register('nobody')).token)).status).toBe(404);
    expect((await api.req('POST', `/channels/${ch.id}/accept-request`, b.token)).status).toBe(204);
    expect((await api.req('POST', `/channels/${ch.id}/ignore-request`, b.token)).status).toBe(400); // already accepted
    // a second sender is ignored
    const { a: a2, b: b2 } = await shared();
    const ch2 = (await api.req('POST', '/users/@me/channels', a2.token, { recipientIds: [b2.id] })).body;
    await say(a2, ch2.id, 'spam');
    const wa = await WsClient.connect(env.port); await wa.identify(a2.token);
    expect((await api.req('POST', `/channels/${ch2.id}/ignore-request`, b2.token)).status).toBe(204);
    await wa.waitEvent('CHANNEL_DELETE', (d) => d.id === ch2.id); wa.close();
    expect((await api.req('GET', `/channels/${ch2.id}/messages`, a2.token)).status).toBe(404);
    const again = await api.req('POST', '/users/@me/channels', a2.token, { recipientIds: [b2.id] });
    expect(again.status).toBe(403); expect(again.body.code).toBe('DM_DISABLED');
  });

  it('message requests can be switched off, and friends never create requests', async () => {
    const { a, b } = await shared();
    await api.req('PATCH', '/users/@me', b.token, { privacy: { messageRequests: false } });
    const ch = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    await say(a, ch.id, 'direct');
    const w = await WsClient.connect(env.port); expect((await w.identify(b.token)).d.messageRequests).toEqual([]); w.close();
    const { a: f1, b: f2 } = await shared(); await befriend(f1, f2);
    const ch2 = (await api.req('POST', '/users/@me/channels', f1.token, { recipientIds: [f2.id] })).body;
    await say(f1, ch2.id, 'friend');
    const w2 = await WsClient.connect(env.port); expect((await w2.identify(f2.token)).d.messageRequests).toEqual([]); w2.close();
  });

  it('friend-request controls are enforced server-side; accepting an incoming request always works', async () => {
    const { a, b } = await shared();
    await api.req('PATCH', '/users/@me', b.token, { privacy: { friendRequests: { everyone: false, friendsOfFriends: false, serverMembers: false } } });
    let r = await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' });
    expect(r.status).toBe(403); expect(r.body.code).toBe('FRIEND_REQUEST_BLOCKED');
    // serverMembers only: a shares a server with b
    await api.req('PATCH', '/users/@me', b.token, { privacy: { friendRequests: { serverMembers: true } } });
    const stranger = await api.register('stranger');
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}`, stranger.token, { type: 'friend' })).status).toBe(403);
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' })).body.type).toBe('outgoing');
    // friends of friends only
    const c = await api.register('fof'); const d = await api.register('fofd'); const mid = await api.register('mid');
    await befriend(c, mid); await befriend(d, mid);
    await api.req('PATCH', '/users/@me', d.token, { privacy: { friendRequests: { everyone: false, friendsOfFriends: true, serverMembers: false } } });
    expect((await api.req('PUT', `/users/@me/relationships/${d.id}`, stranger.token, { type: 'friend' })).status).toBe(403);
    // d already has c as friend-of-friend: but c and d are not friends yet
    expect((await api.req('PUT', `/users/@me/relationships/${d.id}`, c.token, { type: 'friend' })).body.type).toBe('outgoing');
    // I may always accept a request I received even with everyone switched off
    const e = await api.register('eacc'); const f = await api.register('facc');
    await api.req('PUT', `/users/@me/relationships/${f.id}`, e.token, { type: 'friend' });
    await api.req('PATCH', '/users/@me', e.token, { privacy: { friendRequests: { everyone: false, friendsOfFriends: false, serverMembers: false } } });
    expect((await api.req('PUT', `/users/@me/relationships/${e.id}`, f.token, { type: 'friend' })).body.type).toBe('friend');
  });
});

describe('message forwarding', () => {
  it('forwards a snapshot (no author, no pings), chains keep the first origin, permissions are enforced', async () => {
    const { owner, guild, members: [a, b], general } = await guildWith('fa', 'fb');
    const other = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'other', type: 'text' })).body;
    const orig = (await say(a!, general.id, `look <@${b!.id}> **this**`)).body;
    const r = await api.req('POST', `/channels/${other.id}/messages`, b!.token, { forward: { channelId: general.id, messageId: orig.id } });
    expect(r.status).toBe(201);
    expect(r.body.content).toBe('');
    expect(r.body.author.id).toBe(b!.id);
    expect(r.body.mentions).toEqual([]);
    expect(r.body.forward).toMatchObject({ content: `look <@${b!.id}> **this**`, sourceChannelId: general.id, sourceMessageId: orig.id, sourceGuildId: guild.id });
    expect(r.body.forward.author).toBeUndefined();
    // the forwarder's mention list is not bumped
    expect((await api.req('GET', '/users/@me/mentions?roles=false&everyone=false', a!.token)).body.length).toBe(0); // the forward quoted <@b> but pinged nobody
    // history shows the snapshot and it survives deletion of the original
    await api.req('DELETE', `/channels/${general.id}/messages/${orig.id}`, a!.token);
    const hist = (await api.req('GET', `/channels/${other.id}/messages`, b!.token)).body;
    expect(hist[0].forward.content).toContain('this');
    // forward of a forward keeps the first origin
    const r2 = await api.req('POST', `/channels/${general.id}/messages`, a!.token, { forward: { channelId: other.id, messageId: r.body.id } });
    expect(r2.status).toBe(201); expect(r2.body.forward.sourceMessageId).toBe(orig.id);
    // cannot combine with content, and nothing to forward from empty/system messages
    expect((await api.req('POST', `/channels/${other.id}/messages`, b!.token, { content: 'x', forward: { channelId: general.id, messageId: r2.body.id } })).status).toBe(400);
    expect((await api.req('POST', `/channels/${other.id}/messages`, b!.token, { forward: { channelId: general.id, messageId: '12345' } })).status).toBe(404);
    // forwarded messages cannot be edited
    expect((await api.req('PATCH', `/channels/${other.id}/messages/${r.body.id}`, b!.token, { content: 'edited' })).status).toBe(400);
    // a channel the forwarder cannot read is a 404; sending into a channel without SEND_MESSAGES is refused
    const priv = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'staff', type: 'text' })).body;
    await api.req('PUT', `/channels/${priv.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    const secret = (await say(owner, priv.id, 'staff only')).body;
    expect((await api.req('POST', `/channels/${other.id}/messages`, b!.token, { forward: { channelId: priv.id, messageId: secret.id } })).status).toBe(404);
    await api.req('PUT', `/channels/${other.id}/permissions/${b!.id}`, owner.token, { type: 'member', allow: '0', deny: String(Perm.SEND_MESSAGES) });
    expect((await api.req('POST', `/channels/${other.id}/messages`, b!.token, { forward: { channelId: general.id, messageId: r2.body.id } })).status).toBe(403);
    // unauthenticated
    expect((await api.req('POST', `/channels/${other.id}/messages`, null, { forward: { channelId: general.id, messageId: r2.body.id } })).status).toBe(401);
  });
  it('forwards into a DM and carries attachments', async () => {
    const { members: [a, b], general } = await guildWith('fda', 'fdb');
    const mp = mpart('dot.png', PNG, 'image/png');
    const up = await api.req('POST', '/uploads', a!.token, mp.payload as any, mp.headers);
    const orig = (await api.req('POST', `/channels/${general.id}/messages`, a!.token, { content: 'pic', attachments: [up.body.id] })).body;
    const dm = (await api.req('POST', '/users/@me/channels', b!.token, { recipientIds: [a!.id] })).body;
    const r = await api.req('POST', `/channels/${dm.id}/messages`, b!.token, { forward: { channelId: general.id, messageId: orig.id } });
    expect(r.status).toBe(201);
    expect(r.body.forward.attachments[0].url).toBe(up.body.url);
    expect((await env.app.inject({ url: up.body.url })).statusCode).toBe(200);
  });
});

describe('saved messages and reminders', () => {
  it('saves and lists messages, rechecks access, caps and cleans up', async () => {
    const { owner, guild, members: [a, b], general } = await guildWith('sa', 'sb');
    const m1 = (await say(b!, general.id, 'keep this')).body, m2 = (await say(b!, general.id, 'and this')).body;
    const w = await WsClient.connect(env.port); await w.identify(a!.token);
    expect((await api.req('PUT', `/users/@me/saved/${general.id}/${m1.id}`, a!.token)).status).toBe(204);
    expect((await w.waitEvent('SAVED_UPDATE', (d) => d.messageId === m1.id)).d.saved).toBe(true);
    await api.req('PUT', `/users/@me/saved/${general.id}/${m2.id}`, a!.token);
    await api.req('PUT', `/users/@me/saved/${general.id}/${m2.id}`, a!.token); // idempotent
    expect((await api.req('GET', '/users/@me/saved', a!.token)).body.map((m: any) => m.id)).toEqual([m2.id, m1.id]);
    expect((await api.req('GET', '/users/@me/saved/ids', a!.token)).body.sort()).toEqual([m1.id, m2.id].sort());
    expect((await api.req('GET', '/users/@me/saved?limit=1&offset=1', a!.token)).body.map((m: any) => m.id)).toEqual([m1.id]);
    // private to me
    expect((await api.req('GET', '/users/@me/saved', b!.token)).body).toEqual([]);
    // wrong channel / unknown message
    expect((await api.req('PUT', `/users/@me/saved/${general.id}/999`, a!.token)).status).toBe(404);
    // losing access hides them (and a stranger cannot save them)
    const priv = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'vault', type: 'text' })).body;
    await api.req('PUT', `/channels/${priv.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    const s1 = (await say(owner, priv.id, 'secret')).body;
    expect((await api.req('PUT', `/users/@me/saved/${priv.id}/${s1.id}`, a!.token)).status).toBe(404);
    await api.req('PUT', `/channels/${priv.id}/permissions/${a!.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL | Perm.READ_MESSAGE_HISTORY), deny: '0' });
    expect((await api.req('PUT', `/users/@me/saved/${priv.id}/${s1.id}`, a!.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me/saved', a!.token)).body.map((m: any) => m.id)).toContain(s1.id);
    await api.req('DELETE', `/channels/${priv.id}/permissions/${a!.id}`, owner.token);
    expect((await api.req('GET', '/users/@me/saved', a!.token)).body.map((m: any) => m.id)).not.toContain(s1.id);
    // unsave + message deletion removes rows
    expect((await api.req('DELETE', `/users/@me/saved/${general.id}/${m1.id}`, a!.token)).status).toBe(204);
    await api.req('DELETE', `/channels/${general.id}/messages/${m2.id}`, b!.token);
    expect((await api.req('GET', '/users/@me/saved', a!.token)).body.map((m: any) => m.id)).not.toContain(m2.id);
    expect((await api.req('GET', '/users/@me/saved', null)).status).toBe(401);
    w.close();
  });

  it('creates, lists, deletes and fires reminders (live event), only for the owner', async () => {
    const { members: [a, b], general } = await guildWith('ra', 'rb');
    const m = (await say(b!, general.id, 'remember me')).body;
    const w = await WsClient.connect(env.port); await w.identify(a!.token);
    const bad = (body: object) => api.req('POST', '/users/@me/reminders', a!.token, { channelId: general.id, messageId: m.id, ...body });
    expect((await bad({})).status).toBe(400);
    expect((await bad({ inSeconds: 2 })).status).toBe(400);
    expect((await bad({ inSeconds: 60, remindAt: new Date(Date.now() + 90_000).toISOString() })).status).toBe(400);
    expect((await bad({ remindAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await api.req('POST', '/users/@me/reminders', a!.token, { channelId: general.id, messageId: '999', inSeconds: 60 })).status).toBe(404);
    const r = await bad({ inSeconds: 3600 });
    expect(r.status).toBe(201); expect(r.body.message.id).toBe(m.id); expect(r.body.firedAt).toBeNull();
    expect((await api.req('GET', '/users/@me/reminders', a!.token)).body.map((x: any) => x.id)).toEqual([r.body.id]);
    expect((await api.req('GET', '/users/@me/reminders', b!.token)).body).toEqual([]);
    // not yet due: sweeping does nothing
    await runSweeps(env.ctx); await w.expectNone((f) => f.t === 'REMINDER_DUE', 200);
    // make it due, sweep, live event + marked fired
    await env.ctx.db.query(`UPDATE reminders SET remind_at = now() - interval '1 second' WHERE id = $1`, [r.body.id]);
    await runSweeps(env.ctx);
    const ev = await w.waitEvent('REMINDER_DUE', (d) => d.id === r.body.id);
    expect(ev.d.message.content).toBe('remember me'); expect(ev.d.firedAt).toBeTruthy();
    await runSweeps(env.ctx); // fires once only
    expect(w.frames.filter((f) => f.t === 'REMINDER_DUE').length).toBe(1);
    expect((await api.req('GET', '/users/@me/reminders', a!.token)).body[0].firedAt).toBeTruthy();
    // another user cannot delete mine; the owner can
    await api.req('DELETE', `/users/@me/reminders/${r.body.id}`, b!.token);
    expect((await api.req('GET', '/users/@me/reminders', a!.token)).body.length).toBe(1);
    expect((await api.req('DELETE', `/users/@me/reminders/${r.body.id}`, a!.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me/reminders', a!.token)).body).toEqual([]);
    // reminders vanish with their message
    const m3 = (await say(b!, general.id, 'gone soon')).body;
    await api.req('POST', '/users/@me/reminders', a!.token, { channelId: general.id, messageId: m3.id, inSeconds: 60 });
    await api.req('DELETE', `/channels/${general.id}/messages/${m3.id}`, b!.token);
    expect((await api.req('GET', '/users/@me/reminders', a!.token)).body).toEqual([]);
    w.close();
  });
});
