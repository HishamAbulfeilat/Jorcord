import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { authenticator } from 'otplib';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function guildWith(...names: string[]) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Gaps', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: Client[] = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  const ch = (type: string, name?: string) => guild.channels.find((c: any) => c.type === type && (!name || c.name === name));
  return { owner, guild, members, general: ch('text', 'general'), voice: ch('voice'), stage: ch('stage') };
}
async function role(owner: Client, guildId: string, perms: bigint, name = 'r') {
  return (await api.req('POST', `/guilds/${guildId}/roles`, owner.token, { name, permissions: String(perms) })).body;
}
async function ws(c: Client) { const w = await WsClient.connect(env.port); await w.identify(c.token); return w; }
const mailTo = (email: string, subject?: string) => env.ctx.mailer.outbox.filter((m) => m.to === email && (!subject || m.subject.includes(subject)));
const tokenFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get('token')!;
const until = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('until: timeout'); await new Promise((r) => setTimeout(r, 25)); } };

describe('user lookup', () => {
  it('finds exact usernames case-insensitively, tolerates name#0, hides blocked users', async () => {
    const a = await api.register('finder'), b = await api.register('target');
    const q = (name: string, token = a.token) => api.req('GET', `/users?username=${encodeURIComponent(name)}`, token);
    const r = await q(b.username.toUpperCase());
    expect(r.status).toBe(200); expect(r.body.id).toBe(b.id); expect(r.body.email).toBeUndefined();
    expect((await q(`${b.username}#0`)).body.id).toBe(b.id);
    expect((await q(`@${b.username}#0000`)).body.id).toBe(b.id);
    expect((await q(`${b.username}#1234`)).status).toBe(404);   // legacy discriminators that cannot exist
    expect((await q(b.username.slice(0, -1))).status).toBe(404); // exact, not prefix
    expect((await q('no such user!')).status).toBe(404);
    expect((await api.req('GET', '/users', a.token)).status).toBe(400);
    expect((await api.req('GET', `/users?username=${b.username}`, null)).status).toBe(401);
    // block in either direction -> indistinguishable from "no such user"
    await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'blocked' });
    expect((await q(b.username)).status).toBe(404);
    expect((await q(a.username, b.token)).status).toBe(404);
  });
  it('is rate limited when limits are enabled', async () => {
    const lim = await startServer({ rateLimit: true }); const l = new Api(lim);
    const u = await l.register('lim');
    let last = 0; for (let i = 0; i < 32; i++) last = (await l.req('GET', '/users?username=zzzzzz', u.token)).status;
    expect(last).toBe(429); await lim.close();
  });
});

describe('voice moderation', () => {
  it('mutes, deafens, moves and disconnects with permission + hierarchy checks', async () => {
    const { owner, guild, members: [bob, mod, low], voice, general } = await guildWith('bob', 'mod', 'low');
    const lounge2 = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'Second', type: 'voice' })).body;
    const modRole = await role(owner, guild.id, Perm.MUTE_MEMBERS | Perm.DEAFEN_MEMBERS | Perm.MOVE_MEMBERS, 'mods');
    await api.req('PATCH', `/guilds/${guild.id}/members/${mod!.id}`, owner.token, { roles: [modRole.id] });
    const vs = (uid: string) => `/guilds/${guild.id}/voice-states/${uid}`;
    const wBob = await ws(bob!), wOwner = await ws(owner);
    const join = async (w: WsClient, cid: string, c: Client) => { w.send({ op: 4, d: { guildId: guild.id, channelId: cid } }); await wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === c.id && d.channelId === cid); };
    await join(wBob, voice.id, bob!);

    // plain members cannot moderate; outsiders see 404
    expect((await api.req('PATCH', vs(bob!.id), low!.token, { mute: true })).status).toBe(403);
    expect((await api.req('POST', `${vs(bob!.id)}/move`, low!.token, { channelId: lounge2.id })).status).toBe(403);
    expect((await api.req('DELETE', vs(bob!.id), low!.token)).status).toBe(403);
    const outsider = await api.register('out');
    expect((await api.req('PATCH', vs(bob!.id), outsider.token, { mute: true })).status).toBe(404);
    // a moderator cannot act on someone who outranks them (the owner)
    expect((await api.req('PATCH', vs(owner.id), mod!.token, { mute: true })).status).toBe(403);
    // validation
    expect((await api.req('PATCH', vs(bob!.id), mod!.token, {})).status).toBe(400);
    expect((await api.req('PATCH', vs(mod!.id), mod!.token, { mute: true })).status).toBe(400);

    // server mute: event, persisted flag, LiveKit permission revoked, token has no microphone
    const r = await api.req('PATCH', vs(bob!.id), mod!.token, { mute: true });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ serverMute: true, serverDeaf: false });
    const ev = await wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob!.id && d.serverMute === true);
    expect(ev.d.channelId).toBe(voice.id);
    expect(env.livekit.perms.at(-1)).toMatchObject({ room: voice.id, identity: bob!.id, canSpeak: false, canSubscribe: true });
    const tok: any = decodeJwt((await api.req('POST', '/voice/token', bob!.token, { channelId: voice.id })).body.token);
    expect(tok.video.canPublishSources).not.toContain('microphone');
    // deafen -> cannot subscribe
    await api.req('PATCH', vs(bob!.id), mod!.token, { deaf: true });
    expect(env.livekit.perms.at(-1)).toMatchObject({ canSubscribe: false });
    expect(((decodeJwt((await api.req('POST', '/voice/token', bob!.token, { channelId: voice.id })).body.token) as any).video.canSubscribe)).toBe(false);
    // the flags survive leaving and rejoining (cannot dodge a mute by reconnecting)
    wBob.send({ op: 4, d: { guildId: guild.id, channelId: null } });
    await wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob!.id && d.channelId === null);
    wOwner.frames.length = 0;
    await join(wBob, voice.id, bob!);
    expect(wOwner.frames.find((f) => f.t === 'VOICE_STATE_UPDATE' && f.d.userId === bob!.id && f.d.channelId === voice.id)!.d).toMatchObject({ serverMute: true, serverDeaf: true });
    // unmute
    expect((await api.req('PATCH', vs(bob!.id), mod!.token, { mute: false, deaf: false })).body).toMatchObject({ serverMute: false, serverDeaf: false });

    // move: needs a voice channel in this guild
    expect((await api.req('POST', `${vs(bob!.id)}/move`, mod!.token, { channelId: general.id })).status).toBe(400);
    const mv = await api.req('POST', `${vs(bob!.id)}/move`, mod!.token, { channelId: lounge2.id });
    expect(mv.status).toBe(200); expect(mv.body.channelId).toBe(lounge2.id);
    await wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob!.id && d.channelId === lounge2.id);
    expect(env.livekit.removed.at(-1)).toEqual({ room: voice.id, identity: bob!.id });
    // target without CONNECT at the destination cannot be moved there
    await api.req('PUT', `/channels/${voice.id}/permissions/${bob!.id}`, owner.token, { type: 'member', allow: '0', deny: String(Perm.CONNECT) });
    expect((await api.req('POST', `${vs(bob!.id)}/move`, owner.token, { channelId: voice.id })).status).toBe(403);

    // disconnect
    expect((await api.req('DELETE', vs(bob!.id), mod!.token)).status).toBe(204);
    await wOwner.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob!.id && d.channelId === null && d.guildId === guild.id);
    expect(env.livekit.removed.at(-1)).toEqual({ room: lounge2.id, identity: bob!.id });
    expect((await api.req('DELETE', vs(bob!.id), mod!.token)).status).toBe(400); // no longer connected
    const list = await api.req('GET', `/guilds/${guild.id}/voice-states`, owner.token);
    expect(list.body.filter((s: any) => s.userId === bob!.id)).toHaveLength(0);
    wBob.close(); wOwner.close();
  });
});

describe('stage channels', () => {
  it('request to speak, invite, suppress', async () => {
    const { owner, guild, members: [aud, other], stage, general } = await guildWith('aud', 'oth');
    const wA = await ws(aud!), wO = await ws(owner);
    wA.send({ op: 4, d: { guildId: guild.id, channelId: stage.id } });
    const joined = await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === aud!.id && d.channelId === stage.id);
    expect(joined.d.suppress).toBe(true);
    const micOf = async (c: Client) => (decodeJwt((await api.req('POST', '/voice/token', c.token, { channelId: stage.id })).body.token) as any).video.canPublishSources as string[];
    expect(await micOf(aud!)).not.toContain('microphone');
    expect(await micOf(owner)).toContain('microphone'); // moderators speak by default

    expect((await api.req('PUT', `/channels/${general.id}/stage/request`, aud!.token)).status).toBe(400);
    const req = await api.req('PUT', `/channels/${stage.id}/stage/request`, aud!.token);
    expect(req.status).toBe(200); expect(req.body.requestToSpeakAt).toBeTruthy();
    await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === aud!.id && !!d.requestToSpeakAt);
    // someone who is not on the stage cannot request / be invited
    expect((await api.req('PUT', `/channels/${stage.id}/stage/request`, other!.token)).status).toBe(400);
    expect((await api.req('PUT', `/channels/${stage.id}/stage/speakers/${other!.id}`, owner.token)).status).toBe(400);
    // only MUTE_MEMBERS holders can invite or suppress others
    expect((await api.req('PUT', `/channels/${stage.id}/stage/speakers/${aud!.id}`, other!.token)).status).toBe(403);
    expect((await api.req('PUT', `/channels/${stage.id}/stage/speakers/${aud!.id}`, aud!.token)).status).toBe(403);

    const inv = await api.req('PUT', `/channels/${stage.id}/stage/speakers/${aud!.id}`, owner.token);
    expect(inv.status).toBe(200); expect(inv.body).toMatchObject({ suppress: false, requestToSpeakAt: null });
    expect(env.livekit.perms.at(-1)).toMatchObject({ identity: aud!.id, room: stage.id, canSpeak: true });
    expect(await micOf(aud!)).toContain('microphone');
    // toggling self-mute must not re-suppress an invited speaker
    wA.send({ op: 4, d: { guildId: guild.id, channelId: stage.id, selfMute: true } });
    const after = await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === aud!.id && d.selfMute === true);
    expect(after.d.suppress).toBe(false);
    // already a speaker -> cannot "request"
    expect((await api.req('PUT', `/channels/${stage.id}/stage/request`, aud!.token)).status).toBe(409);
    // back to the audience: by a moderator, or by oneself
    const sup = await api.req('DELETE', `/channels/${stage.id}/stage/speakers/${aud!.id}`, owner.token);
    expect(sup.body.suppress).toBe(true);
    expect(env.livekit.perms.at(-1)).toMatchObject({ identity: aud!.id, canSpeak: false });
    await api.req('PUT', `/channels/${stage.id}/stage/speakers/${aud!.id}`, owner.token);
    expect((await api.req('DELETE', `/channels/${stage.id}/stage/speakers/@me`, aud!.token)).body.suppress).toBe(true);
    expect((await api.req('DELETE', `/channels/${stage.id}/stage/speakers/${aud!.id}`, other!.token)).status).toBe(403);
    wA.close(); wO.close();
  });
  it('queue is ordered by time raised: moderators see it, invite from it, audience can lower their hand', async () => {
    const { owner, guild, members: [aud, other], stage, general } = await guildWith('aud', 'oth');
    const wA = await ws(aud!), wO = await ws(other!);
    for (const [w, c] of [[wA, aud] as const, [wO, other] as const]) w.send({ op: 4, d: { guildId: guild.id, channelId: stage.id } });
    await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === aud!.id && d.channelId === stage.id);
    await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === other!.id && d.channelId === stage.id);
    // queue is empty before anyone raises a hand
    expect((await api.req('GET', `/channels/${stage.id}/stage/queue`, owner.token)).body).toEqual([]);
    // not a stage channel -> 400
    expect((await api.req('GET', `/channels/${general.id}/stage/queue`, owner.token)).status).toBe(400);
    // raise hands: `other` first, then `aud` -> the queue must come back in that order
    const first = await api.req('PUT', `/channels/${stage.id}/stage/request`, other!.token);
    expect(first.status).toBe(200);
    await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === other!.id && !!d.requestToSpeakAt);
    const second = await api.req('PUT', `/channels/${stage.id}/stage/request`, aud!.token);
    expect(second.status).toBe(200);
    await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === aud!.id && !!d.requestToSpeakAt);
    const queue = await api.req('GET', `/channels/${stage.id}/stage/queue`, owner.token);
    expect(queue.status).toBe(200);
    expect(queue.body.map((e: any) => e.userId)).toEqual([other!.id, aud!.id]);
    expect(queue.body.map((e: any) => e.requestToSpeakAt)).toEqual(queue.body.map((e: any) => e.requestToSpeakAt).slice().sort());
    // sans hand, an audience member is not in the queue but can still lower their own hand (no-op)
    await api.req('DELETE', `/channels/${stage.id}/stage/request`, other!.token);
    await wO.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === other!.id && d.requestToSpeakAt === null);
    expect((await api.req('GET', `/channels/${stage.id}/stage/queue`, owner.token)).body.map((e: any) => e.userId)).toEqual([aud!.id]);
    // a moderator invites from the queue: the hand is cleared and the member becomes a speaker
    const inv = await api.req('PUT', `/channels/${stage.id}/stage/speakers/${aud!.id}`, owner.token);
    expect(inv.status).toBe(200); expect(inv.body).toMatchObject({ suppress: false, requestToSpeakAt: null });
    expect((await api.req('GET', `/channels/${stage.id}/stage/queue`, owner.token)).body).toEqual([]);
    wA.close(); wO.close();
  });
});

describe('webhooks', () => {
  it('per-message username and avatar overrides', async () => {
    const { owner, general } = await guildWith();
    const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'Deploys' })).body;
    const path = `/webhooks/${hook.id}/${hook.token}`;
    const plain = await api.req('POST', path + '?wait=true', null, { content: 'plain' });
    expect(plain.body.author).toMatchObject({ username: 'Deploys', bot: true });
    const o = await api.req('POST', path + '?wait=true', null, { content: 'custom', username: 'CI Bot', avatarUrl: 'https://cdn.example.com/a.png' });
    expect(o.status).toBe(200);
    expect(o.body.author).toMatchObject({ username: 'CI Bot', displayName: 'CI Bot', avatar: 'https://cdn.example.com/a.png', bot: true });
    expect((await api.req('POST', path + '?wait=true', null, { content: 'snake', avatar_url: '/files/x/y.png' })).body.author.avatar).toBe('/files/x/y.png');
    expect((await api.req('POST', path, null, { content: 'no wait' })).status).toBe(204);
    // history shows the override too, and bad input is rejected
    const hist = (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body;
    expect(hist.find((m: any) => m.content === 'custom').author.username).toBe('CI Bot');
    expect(hist.find((m: any) => m.content === 'plain').author.username).toBe('Deploys');
    expect((await api.req('POST', path, null, { content: 'x', avatarUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await api.req('POST', path, null, { content: 'x', username: 'bad\u0007name' })).status).toBe(400);
    expect((await api.req('POST', path, null, { content: 'x', username: 'a'.repeat(81) })).status).toBe(400);
    expect((await api.req('POST', `/webhooks/${hook.id}/${'x'.repeat(30)}`, null, { content: 'x' })).status).toBe(404);
  });
});

describe('gateway REQUEST_MEMBERS', () => {
  it('returns member chunks to members only', async () => {
    const { owner, guild, members: [a, b] } = await guildWith('alice', 'bobby');
    const w = await ws(owner);
    w.send({ op: 8, d: { guildId: guild.id, query: a!.username.slice(0, 4), nonce: 'n1' } });
    const chunk = await w.waitEvent('GUILD_MEMBERS_CHUNK', (d) => d.nonce === 'n1');
    expect(chunk.d.members.map((m: any) => m.user.id)).toContain(a!.id);
    w.send({ op: 8, d: { guildId: guild.id, userIds: [b!.id, '999'], nonce: 'n2' } });
    const byId = (await w.waitEvent('GUILD_MEMBERS_CHUNK', (d) => d.nonce === 'n2')).d;
    expect(byId.members).toHaveLength(1); expect(byId.notFound).toEqual(['999']);
    w.send({ op: 8, d: { guildId: guild.id, limit: 2, nonce: 'n3' } });
    expect((await w.waitEvent('GUILD_MEMBERS_CHUNK', (d) => d.nonce === 'n3')).d.members).toHaveLength(2);
    const outsider = await api.register('nosy'); const w2 = await ws(outsider);
    w2.send({ op: 8, d: { guildId: guild.id, query: 'a' } });
    expect((await w2.waitEvent('ERROR')).d.code).toBe('NOT_FOUND');
    w2.send({ op: 8, d: { guildId: 'abc' } });
    await until(() => w2.frames.filter((f) => f.t === 'ERROR').length >= 2);
    expect(w2.frames.some((f) => f.t === 'GUILD_MEMBERS_CHUNK')).toBe(false);
    w.close(); w2.close();
  });
});

describe('channel visibility changes', () => {
  it('sends CHANNEL_DELETE to users who lose view access and CHANNEL_CREATE to those who gain it', async () => {
    const { owner, guild, members: [bob, eve], general } = await guildWith('bob', 'eve');
    const extra = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'secret', type: 'text' })).body;
    const wB = await ws(bob!), wE = await ws(eve!);
    // hide #secret from @everyone, then re-allow bob only
    expect((await api.req('PUT', `/channels/${extra.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) })).status).toBe(204);
    for (const w of [wB, wE]) expect((await w.waitEvent('CHANNEL_DELETE', (d) => d.id === extra.id)).d.guildId).toBe(guild.id);
    await api.req('PUT', `/channels/${extra.id}/permissions/${bob!.id}`, owner.token, { type: 'member', allow: String(Perm.VIEW_CHANNEL), deny: '0' });
    const created = await wB.waitEvent('CHANNEL_CREATE', (d) => d.id === extra.id);
    expect(created.d.name).toBe('secret');
    await wE.expectNone((f) => f.t === 'CHANNEL_CREATE' && f.d.id === extra.id);
    // role permission change: strip VIEW_CHANNEL from @everyone entirely
    wB.frames.length = 0;
    const everyone = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.id === guild.id);
    await api.req('PATCH', `/guilds/${guild.id}/roles/${guild.id}`, owner.token, { permissions: String(BigInt(everyone.permissions) & ~Perm.VIEW_CHANNEL) });
    await wB.waitEvent('CHANNEL_DELETE', (d) => d.id === general.id);
    // owner is unaffected
    const wO = await ws(owner); await wO.expectNone((f) => f.t === 'CHANNEL_DELETE', 200);
    // giving the role back restores it
    await api.req('PATCH', `/guilds/${guild.id}/roles/${guild.id}`, owner.token, { permissions: everyone.permissions });
    await wB.waitEvent('CHANNEL_CREATE', (d) => d.id === general.id);
    wB.close(); wE.close(); wO.close();
  });
  it('member role changes and losing access disconnects from voice', async () => {
    const { owner, guild, members: [bob], voice } = await guildWith('bob');
    const r = await role(owner, guild.id, Perm.VIEW_CHANNEL | Perm.CONNECT, 'vip');
    await api.req('PUT', `/channels/${voice.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    await api.req('PUT', `/channels/${voice.id}/permissions/${r.id}`, owner.token, { type: 'role', allow: String(Perm.VIEW_CHANNEL | Perm.CONNECT), deny: '0' });
    const wB = await ws(bob!);
    await api.req('PATCH', `/guilds/${guild.id}/members/${bob!.id}`, owner.token, { roles: [r.id] });
    await wB.waitEvent('CHANNEL_CREATE', (d) => d.id === voice.id);
    wB.send({ op: 4, d: { guildId: guild.id, channelId: voice.id } });
    await until(async () => (await env.ctx.voice.get(bob!.id))?.channelId === voice.id ? true : undefined).catch(() => {}); // async check below
    await new Promise((res) => setTimeout(res, 150));
    expect((await env.ctx.voice.get(bob!.id))?.channelId).toBe(voice.id);
    await api.req('PATCH', `/guilds/${guild.id}/members/${bob!.id}`, owner.token, { roles: [] });
    await wB.waitEvent('CHANNEL_DELETE', (d) => d.id === voice.id);
    await new Promise((res) => setTimeout(res, 150));
    expect(await env.ctx.voice.get(bob!.id)).toBeNull();
    expect(env.livekit.removed.at(-1)).toEqual({ room: voice.id, identity: bob!.id });
    wB.close();
  });
});

describe('threads', () => {
  it('membership, active and archived listings', async () => {
    const { owner, guild, members: [bob, eve], general } = await guildWith('bob', 'eve');
    const m1 = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'start' })).body;
    const t1 = (await api.req('POST', `/channels/${general.id}/messages/${m1.id}/threads`, owner.token, { name: 'topic one' })).body;
    const m2 = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'second' })).body;
    const t2 = (await api.req('POST', `/channels/${general.id}/messages/${m2.id}/threads`, owner.token, { name: 'topic two' })).body;
    const tm = (id: string, t: string) => api.req('GET', `/channels/${id}/thread-members`, t);
    expect((await tm(t1.id, owner.token)).body.map((x: any) => x.userId)).toEqual([owner.id]); // creator follows their thread
    expect((await tm(general.id, owner.token)).status).toBe(400); // not a thread
    const wO = await ws(owner);
    // join / leave
    expect((await api.req('PUT', `/channels/${t1.id}/thread-members/@me`, bob!.token)).status).toBe(204);
    const upd = await wO.waitEvent('THREAD_MEMBERS_UPDATE', (d) => d.id === t1.id && d.addedUserIds.includes(bob!.id));
    expect(upd.d.guildId).toBe(guild.id);
    expect((await tm(t1.id, bob!.token)).body).toHaveLength(2);
    // adding someone else needs MANAGE_THREADS or ownership
    expect((await api.req('PUT', `/channels/${t1.id}/thread-members/${eve!.id}`, bob!.token)).status).toBe(403);
    expect((await api.req('PUT', `/channels/${t1.id}/thread-members/${eve!.id}`, owner.token)).status).toBe(204);
    expect((await api.req('DELETE', `/channels/${t1.id}/thread-members/${eve!.id}`, bob!.token)).status).toBe(403);
    expect((await api.req('DELETE', `/channels/${t1.id}/thread-members/${eve!.id}`, owner.token)).status).toBe(204);
    await wO.waitEvent('THREAD_MEMBERS_UPDATE', (d) => d.removedUserIds.includes(eve!.id));
    expect((await api.req('DELETE', `/channels/${t1.id}/thread-members/@me`, bob!.token)).status).toBe(204);
    // posting in a thread follows it
    await api.req('POST', `/channels/${t1.id}/messages`, eve!.token, { content: 'hi thread' });
    expect((await tm(t1.id, owner.token)).body.map((x: any) => x.userId)).toContain(eve!.id);
    // a user who cannot see the parent cannot see or join the thread
    const stranger = await api.register('str');
    expect((await api.req('PUT', `/channels/${t1.id}/thread-members/@me`, stranger.token)).status).toBe(404);
    expect((await tm(t1.id, stranger.token)).status).toBe(404);

    // listings
    await api.req('PATCH', `/channels/${t2.id}`, owner.token, { archived: true });
    const active = (await api.req('GET', `/channels/${general.id}/threads/active`, bob!.token)).body;
    expect(active.threads.map((t: any) => t.id)).toEqual([t1.id]);
    const archived = (await api.req('GET', `/channels/${general.id}/threads/archived`, bob!.token)).body;
    expect(archived.threads.map((t: any) => t.id)).toEqual([t2.id]); expect(archived.hasMore).toBe(false);
    expect((await api.req('GET', `/channels/${general.id}/threads/archived?before=${t2.id}`, bob!.token)).body.threads).toEqual([]);
    expect((await api.req('GET', `/channels/${general.id}/threads?archived=true`, bob!.token)).body.map((t: any) => t.id)).toEqual([t2.id]);
    const guildActive = (await api.req('GET', `/guilds/${guild.id}/threads/active`, owner.token)).body;
    expect(guildActive.threads.map((t: any) => t.id)).toEqual([t1.id]);
    expect(guildActive.members.map((m: any) => m.threadId)).toEqual([t1.id]); // my memberships only
    expect((await api.req('GET', `/guilds/${guild.id}/threads/active`, stranger.token)).status).toBe(404);
    expect((await api.req('PUT', `/channels/${t2.id}/thread-members/@me`, bob!.token)).status).toBe(400); // archived
    // hiding the parent hides its threads from listings
    await api.req('PUT', `/channels/${general.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect((await api.req('GET', `/guilds/${guild.id}/threads/active`, bob!.token)).body.threads).toEqual([]);
    expect((await api.req('GET', `/channels/${general.id}/threads/active`, bob!.token)).status).toBe(404);
    wO.close();
  });
});

describe('group DMs', () => {
  it('add and remove recipients', async () => {
    const a = await api.register('ga'), b = await api.register('gb'), c = await api.register('gc'), d = await api.register('gd');
    for (const u of [b, c]) { await api.req('PUT', `/users/@me/relationships/${u.id}`, a.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${a.id}`, u.token, { type: 'friend' }); }
    const group = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id, c.id] })).body;
    expect(group.type).toBe('group_dm');
    const wD = await ws(d), wB = await ws(b);
    // d is a stranger to a: not friends, no shared server
    expect((await api.req('PUT', `/channels/${group.id}/recipients/${d.id}`, a.token)).status).toBe(403);
    expect((await api.req('PUT', `/channels/${group.id}/recipients/${d.id}`, d.token)).status).toBe(404); // not a participant
    await api.req('PUT', `/users/@me/relationships/${d.id}`, a.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${a.id}`, d.token, { type: 'friend' });
    // a block between the new person and an existing member stops the add
    await api.req('PUT', `/users/@me/relationships/${d.id}`, c.token, { type: 'blocked' });
    expect((await api.req('PUT', `/channels/${group.id}/recipients/${d.id}`, a.token)).body.code).toBe('BLOCKED');
    await api.req('DELETE', `/users/@me/relationships/${d.id}`, c.token);
    expect((await api.req('PUT', `/channels/${group.id}/recipients/${d.id}`, b.token)).status).toBe(403); // b has no tie to d either
    await api.req('PUT', `/users/@me/relationships/${d.id}`, b.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${b.id}`, d.token, { type: 'friend' });
    const added = await api.req('PUT', `/channels/${group.id}/recipients/${d.id}`, b.token);
    expect(added.status).toBe(200); expect(added.body.recipients.map((r: any) => r.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    await wD.waitEvent('CHANNEL_CREATE', (x) => x.id === group.id);
    await wB.waitEvent('CHANNEL_UPDATE', (x) => x.id === group.id && x.recipients.length === 4);
    expect((await api.req('POST', `/channels/${group.id}/messages`, d.token, { content: 'hello group' })).status).toBe(201);
    expect((await api.req('PUT', `/channels/${group.id}/recipients/${d.id}`, a.token)).status).toBe(200); // idempotent
    // only the owner removes others; anyone can leave
    expect((await api.req('DELETE', `/channels/${group.id}/recipients/${c.id}`, b.token)).status).toBe(403);
    expect((await api.req('DELETE', `/channels/${group.id}/recipients/${c.id}`, a.token)).status).toBe(204);
    expect((await api.req('GET', `/channels/${group.id}`, c.token)).status).toBe(404);
    expect((await api.req('POST', `/channels/${group.id}/messages`, c.token, { content: 'nope' })).status).toBe(404);
    await wD.waitEvent('CHANNEL_UPDATE', (x) => x.id === group.id && x.recipients.length === 3);
    // owner leaving hands the group over
    expect((await api.req('DELETE', `/channels/${group.id}/recipients/@me`, a.token)).status).toBe(204);
    const now = (await api.req('GET', `/channels/${group.id}`, b.token)).body;
    expect(now.ownerId).not.toBe(a.id); expect(now.recipients).toHaveLength(2);
    // 1:1 DMs cannot take recipients
    const dm = (await api.req('POST', '/users/@me/channels', b.token, { recipientIds: [d.id] })).body;
    expect((await api.req('PUT', `/channels/${dm.id}/recipients/${c.id}`, b.token)).status).toBe(400);
    wD.close(); wB.close();
  });
  it('caps a group at 10 people', async () => {
    const host = await api.register('big'); const others: Client[] = [];
    for (let i = 0; i < 10; i++) { const u = await api.register('m'); others.push(u); await api.req('PUT', `/users/@me/relationships/${u.id}`, host.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${host.id}`, u.token, { type: 'friend' }); }
    const g = (await api.req('POST', '/users/@me/channels', host.token, { recipientIds: others.slice(0, 8).map((u) => u.id) })).body; // host + 8 = 9
    expect((await api.req('PUT', `/channels/${g.id}/recipients/${others[8]!.id}`, host.token)).status).toBe(200);
    const full = await api.req('PUT', `/channels/${g.id}/recipients/${others[9]!.id}`, host.token);
    expect(full.status).toBe(400); expect(full.body.code).toBe('MAX_RECIPIENTS');
  });
});

describe('message search in DMs', () => {
  it('searches one DM and across all DMs, never someone else\'s', async () => {
    const a = await api.register('sa'), b = await api.register('sb'), c = await api.register('sc');
    for (const u of [b, c]) { await api.req('PUT', `/users/@me/relationships/${u.id}`, a.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${a.id}`, u.token, { type: 'friend' }); }
    const ab = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    const ac = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [c.id] })).body;
    await api.req('POST', `/channels/${ab.id}/messages`, a.token, { content: 'the pineapple plan' });
    await api.req('POST', `/channels/${ab.id}/messages`, b.token, { content: 'unrelated chatter' });
    await api.req('POST', `/channels/${ac.id}/messages`, a.token, { content: 'pineapple with c' });
    const one = await api.req('GET', `/channels/${ab.id}/messages/search?q=PINEAPPLE`, a.token);
    expect(one.body.map((m: any) => m.content)).toEqual(['the pineapple plan']);
    expect((await api.req('GET', `/channels/${ab.id}/messages/search?q=pine&authorId=${b.id}`, a.token)).body).toEqual([]);
    expect((await api.req('GET', `/users/@me/messages/search?q=pineapple`, a.token)).body).toHaveLength(2);
    expect((await api.req('GET', `/users/@me/messages/search?q=pineapple`, b.token)).body).toHaveLength(1); // b only sees the a-b DM
    expect((await api.req('GET', `/channels/${ab.id}/messages/search?q=pineapple`, c.token)).status).toBe(404);
    expect((await api.req('GET', `/channels/${ab.id}/messages/search`, a.token)).status).toBe(400);
    expect((await api.req('GET', `/users/@me/messages/search?q=50%25_off`, a.token)).body).toEqual([]); // LIKE wildcards are escaped
  });
});

describe('email verification', () => {
  it('mails a single-use token on sign-up, supports resend, rejects bad tokens', async () => {
    const u = await api.register('ver');
    expect(u.user.verified).toBe(false);
    const first = await until(() => mailTo(u.user.email, 'Verify')[0]);
    const token = tokenFrom(first.text);
    expect((await api.req('POST', '/auth/verify-email', null, { token: 'x'.repeat(40) })).body.code).toBe('INVALID_TOKEN');
    // resend invalidates the earlier link
    expect((await api.req('POST', '/auth/verify-email/send', u.token)).status).toBe(204);
    const second = mailTo(u.user.email, 'Verify').at(-1)!;
    expect(tokenFrom(second.text)).not.toBe(token);
    expect((await api.req('POST', '/auth/verify-email', null, { token })).status).toBe(400);
    expect((await api.req('POST', '/auth/verify-email/send', null)).status).toBe(401);
    const ok = await api.req('POST', '/auth/verify-email', null, { token: tokenFrom(second.text) });
    expect(ok.status).toBe(204);
    expect((await api.req('GET', '/users/@me', u.token)).body.verified).toBe(true);
    expect((await api.req('POST', '/auth/verify-email', null, { token: tokenFrom(second.text) })).status).toBe(400); // single use
    expect((await api.req('POST', '/auth/verify-email/send', u.token)).status).toBe(409); // already verified
    // only the hash is stored
    const rows = await env.ctx.db.query('SELECT token_hash FROM auth_tokens WHERE user_id = $1', [u.id]);
    expect(rows.every((r) => r.token_hash !== token && r.token_hash.length === 64)).toBe(true);
  });
  it('expired tokens are rejected', async () => {
    const u = await api.register('exp');
    const token = tokenFrom((await until(() => mailTo(u.user.email, 'Verify')[0])).text);
    await env.ctx.db.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u.id]);
    expect((await api.req('POST', '/auth/verify-email', null, { token })).status).toBe(400);
  });
});

describe('password reset', () => {
  it('does not enumerate accounts, resets once, revokes sessions', async () => {
    const u = await api.register('rst');
    const login = await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'correct horse battery' });
    const w = await ws({ ...u, token: login.body.accessToken });
    const unknown = await api.req('POST', '/auth/password/forgot', null, { email: 'ghost@example.com' });
    const known = await api.req('POST', '/auth/password/forgot', null, { email: u.user.email.toUpperCase() });
    expect(unknown.status).toBe(204); expect(known.status).toBe(204); expect(known.raw.body).toBe(unknown.raw.body);
    expect(mailTo('ghost@example.com')).toHaveLength(0);
    const mail = await until(() => mailTo(u.user.email, 'Reset')[0]);
    const token = tokenFrom(mail.text);
    expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'short' })).status).toBe(400);
    expect((await api.req('POST', '/auth/password/reset', null, { token: 'y'.repeat(40), newPassword: 'a brand new password' })).status).toBe(400);
    expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'a brand new password' })).status).toBe(204);
    expect((await api.req('POST', '/auth/password/reset', null, { token, newPassword: 'another password!!' })).status).toBe(400); // single use
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'correct horse battery' })).status).toBe(401);
    expect((await api.req('POST', '/auth/login', null, { email: u.user.email, password: 'a brand new password' })).status).toBe(200);
    expect((await api.req('GET', '/users/@me', login.body.accessToken)).status).toBe(401); // old sessions died
    expect((await w.waitClose()).code).toBe(4004);
    expect((await api.req('GET', '/users/@me', u.token)).status).toBe(401);
  });
  it('caps reset mails per address', async () => {
    const lim = await startServer({ rateLimit: true }); const l = new Api(lim);
    const u = await l.register('cap');
    for (let i = 0; i < 5; i++) await l.req('POST', '/auth/password/forgot', null, { email: u.user.email });
    await new Promise((r) => setTimeout(r, 150));
    expect(lim.ctx.mailer.outbox.filter((m) => m.to === u.user.email && m.subject.includes('Reset'))).toHaveLength(3);
    await lim.close();
  });
});

describe('account deletion and export', () => {
  it('requires the password, refuses while owning servers, then anonymises', async () => {
    const { owner, guild, members: [bob], general } = await guildWith('del');
    await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'my last words' });
    await api.req('PUT', `/users/@me/relationships/${owner.id}`, bob!.token, { type: 'friend' });
    const w = await ws(owner);
    expect((await api.req('DELETE', '/users/@me', bob!.token, { password: 'wrong wrong wrong' })).status).toBe(401);
    expect((await api.req('DELETE', '/users/@me', null, { password: 'x' })).status).toBe(401);
    const blocked = await api.req('DELETE', '/users/@me', owner.token, { password: 'correct horse battery' });
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('OWNS_GUILDS');

    expect((await api.req('DELETE', '/users/@me', bob!.token, { password: 'correct horse battery' })).status).toBe(204);
    await w.waitEvent('MEMBER_REMOVE', (d) => d.userId === bob!.id);
    await w.waitEvent('USER_UPDATE', (d) => d.id === bob!.id && d.username === `deleted_${bob!.id}`);
    expect((await api.req('GET', '/users/@me', bob!.token)).status).toBe(401);
    expect((await api.req('POST', '/auth/login', null, { email: bob!.user.email, password: 'correct horse battery' })).status).toBe(401);
    expect((await api.req('GET', `/users?username=${bob!.username}`, owner.token)).status).toBe(404);
    const [row] = await env.ctx.db.query('SELECT * FROM users WHERE id = $1', [bob!.id]);
    expect(row).toMatchObject({ email: null, password_hash: null, display_name: 'Deleted User' });
    expect((await env.ctx.db.query('SELECT 1 FROM members WHERE user_id = $1', [bob!.id]))).toHaveLength(0);
    // messages stay, attributed to the anonymous author
    const hist = (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body;
    expect(hist.find((m: any) => m.content === 'my last words').author).toMatchObject({ id: bob!.id, displayName: 'Deleted User' });
    expect((await api.req('GET', `/guilds/${guild.id}/members`, owner.token)).body.some((m: any) => m.user.id === bob!.id)).toBe(false);
    // the username is free again
    expect((await api.req('POST', '/auth/register', null, { email: 'new@example.com', username: bob!.username, password: 'correct horse battery' })).status).toBe(201);
    // once the owner deletes the server the account can go too
    await api.req('DELETE', `/guilds/${guild.id}`, owner.token);
    expect((await api.req('DELETE', '/users/@me', owner.token, { password: 'correct horse battery' })).status).toBe(204);
    w.close();
  });
  it('asks for a 2FA code when enabled', async () => {
    const u = await api.register('mfadel');
    const setup = (await api.req('POST', '/auth/mfa/setup', u.token)).body;
    await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(setup.secret) });
    const r = await api.req('DELETE', '/users/@me', u.token, { password: 'correct horse battery' });
    expect(r.status).toBe(401); expect(r.body.code).toBe('MFA_REQUIRED');
    expect((await api.req('DELETE', '/users/@me', u.token, { password: 'correct horse battery', totp: authenticator.generate(setup.secret) })).status).toBe(204);
  });
  it('exports own data without secrets', async () => {
    const { owner, general, members: [bob] } = await guildWith('exp');
    await api.req('POST', `/channels/${general.id}/messages`, bob!.token, { content: 'exportable' });
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'not bobs' });
    const setup = (await api.req('POST', '/auth/mfa/setup', bob!.token)).body;
    const r = await api.req('GET', '/users/@me/export', bob!.token);
    expect(r.status).toBe(200);
    expect(r.raw.headers['content-disposition']).toContain('attachment');
    expect(r.body.messages.map((m: any) => m.content)).toEqual(['exportable']);
    expect(r.body.user.id).toBe(bob!.id); expect(r.body.guilds).toHaveLength(1);
    const txt = r.raw.body;
    expect(txt).not.toContain(setup.secret); expect(txt).not.toMatch(/password_hash|argon2/i);
    expect((await api.req('GET', '/users/@me/export', null)).status).toBe(401);
  });
});

describe('postgres full-text search mode', () => {
  it('matches word prefixes and punctuated tokens (SQL validated on PGlite, which speaks Postgres)', async () => {
    const fts = await startServer({ searchMode: 'fts' }); const f = new Api(fts);
    expect(fts.ctx.search).toBe('fts');
    const o = await f.register('fo'); const g = (await f.req('POST', '/guilds', o.token, { name: 'Fts' })).body;
    const ch = g.channels.find((c: any) => c.name === 'general');
    const say = (content: string) => f.req('POST', `/channels/${ch.id}/messages`, o.token, { content });
    await say('Deploying the Kubernetes cluster tonight'); await say('see https://docs.example.com/guide for details'); await say("it's 50% off; DROP TABLE messages; --"); await say('nothing relevant');
    const find = async (q: string) => (await f.req('GET', `/guilds/${g.id}/messages/search?q=${encodeURIComponent(q)}`, o.token)).body.map((m: any) => m.content);
    expect(await find('kube')).toHaveLength(1);
    expect(await find('KUBERNETES cluster')).toHaveLength(1);      // AND of words, any order
    expect(await find('cluster kubernetes')).toHaveLength(1);
    expect(await find('kubernetes tomorrow')).toHaveLength(0);
    expect(await find('example.com')).toHaveLength(1);              // punctuation splits words
    expect(await find('docs.example')).toHaveLength(1);
    expect(await find("'; DROP TABLE")).toHaveLength(1);            // operators in user input are inert
    expect(await find('&|!():*<->')).toEqual([]);                   // no searchable word -> substring fallback, never a syntax error
    expect(await find('50%')).toHaveLength(1);                      // punctuation-only tail -> still finds via words
    expect((await f.req('GET', `/channels/${ch.id}/messages/search?q=cluster`, o.token)).body).toHaveLength(1);
    await fts.close();
  });
  it('builds a parameterised, index-friendly statement', async () => {
    const { buildSearchSql, toTsQuery } = await import('../src/services/search');
    expect(toTsQuery('Hello, wörld! 42')).toBe('hello:* & wörld:* & 42:*');
    expect(toTsQuery('***')).toBeNull();
    const { sql, params } = buildSearchSql('fts', { channelIds: ['1'], q: 'a b', limit: 5 });
    expect(sql).toContain("to_tsvector('simple', regexp_replace(content, '[^[:alnum:]]+', ' ', 'g')) @@ to_tsquery('simple', $2)");
    expect(params).toEqual([['1'], 'a:* & b:*', 5]);
    expect(buildSearchSql('ilike', { channelIds: ['1'], q: '100%', limit: 5 }).params[1]).toBe('%100\\%%');
  });
});

describe('issues reported by the web/e2e work', () => {
  it('READY.presences includes the current user; joining announces presence both ways', async () => {
    const { owner, guild } = await guildWith();
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const wOwner = await WsClient.connect(env.port); const ready = await wOwner.identify(owner.token);
    expect(ready.d.presences).toContainEqual({ userId: owner.id, presence: 'online' });
    const bob = await api.register('joiner');
    const wBob = await ws(bob); // connected *before* being a member, so no audience at connect time
    await api.req('POST', `/invites/${code}`, bob.token);
    await wOwner.waitEvent('PRESENCE_UPDATE', (d) => d.userId === bob.id && d.presence === 'online');
    await wBob.waitEvent('PRESENCE_UPDATE', (d) => d.userId === owner.id && d.presence === 'online');
    // invisible users stay invisible to others but see themselves as invisible
    await api.req('PUT', '/users/@me/presence', bob.token, { presence: 'invisible' });
    const again = await ws(bob);
    expect((await again.waitEvent('READY')).d.presences.find((p: any) => p.userId === bob.id).presence).toBe('invisible');
    wOwner.close(); wBob.close(); again.close();
  });
  it('accepting a friend request sends each side the other\'s presence', async () => {
    const a = await api.register('fra'), b = await api.register('frb');
    const wA = await ws(a), wB = await ws(b);
    await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'friend' }); // request
    await api.req('PUT', `/users/@me/relationships/${a.id}`, b.token, { type: 'friend' }); // accept
    await wA.waitEvent('PRESENCE_UPDATE', (d) => d.userId === b.id && d.presence === 'online');
    await wB.waitEvent('PRESENCE_UPDATE', (d) => d.userId === a.id && d.presence === 'online');
    wA.close(); wB.close();
  });
  it('voice tokens allow updating own metadata (priority speaker / attributes)', async () => {
    const { members: [bob], voice } = await guildWith('meta');
    const claims: any = decodeJwt((await api.req('POST', '/voice/token', bob!.token, { channelId: voice.id })).body.token);
    expect(claims.video.canUpdateOwnMetadata).toBe(true);
  });
  it('keeps voice state through a brief gateway reconnect (grace period) and clears it afterwards', async () => {
    const g = await startServer({ voiceGraceMs: 500 }); const a = new Api(g);
    const owner = await a.register('gr'); const bob = await a.register('gr2');
    const guild = (await a.req('POST', '/guilds', owner.token, { name: 'Grace', template: 'default' })).body;
    await a.req('POST', `/invites/${(await a.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code}`, bob.token);
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    const obs = await WsClient.connect(g.port); await obs.identify(owner.token);
    const b1 = await WsClient.connect(g.port); await b1.identify(bob.token);
    b1.send({ op: 4, d: { guildId: guild.id, channelId: voice.id } });
    await obs.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.channelId === voice.id);
    b1.close(); await new Promise((r) => setTimeout(r, 150));
    const b2 = await WsClient.connect(g.port); const rdy = await b2.identify(bob.token); // back inside the grace window
    expect(rdy.d.voiceStates.some((v: any) => v.userId === bob.id && v.channelId === voice.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    expect((await g.ctx.voice.get(bob.id))?.channelId).toBe(voice.id);
    expect(obs.frames.some((f) => f.t === 'VOICE_STATE_UPDATE' && f.d.userId === bob.id && f.d.channelId === null)).toBe(false);
    b2.close(); // gone for good
    await obs.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.channelId === null);
    obs.close(); await g.close();
  });
});
