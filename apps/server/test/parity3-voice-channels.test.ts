import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE, DISCORD_PERMISSION_BITS, ALL_PERMS, Perm, PERMS_ADDED_IN_110, type PermName } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import { runSweeps } from '../src/services/sweeper';
import { isUnicodeEmoji } from '../src/routes/voice';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const FILE = '/api/v1/files/' + 'b'.repeat(48) + '/e.png';
async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Voice', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const m = await api.register('m'); await api.req('POST', `/invites/${code}`, m.token);
  const voice = guild.channels.find((c: any) => c.type === 'voice');
  return { owner, guild, m, voice, code };
}
const join = async (c: Client, guildId: string, channelId: string) => {
  const w = await WsClient.connect(env.port); await w.identify(c.token);
  w.send({ op: 4, d: { guildId, channelId } }); await w.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === c.id && d.channelId === channelId);
  return w;
};
const grant = async (owner: Client, guildId: string, member: Client, perms: bigint) => {
  const role = (await api.req('POST', `/guilds/${guildId}/roles`, owner.token, { name: 'r' + Math.random().toString(36).slice(2, 6), permissions: perms.toString() })).body;
  await api.req('PATCH', `/guilds/${guildId}/members/${member.id}`, owner.token, { roles: [role.id] });
  return role;
};
const setEveryone = async (owner: Client, guildId: string, perms: bigint) => api.req('PATCH', `/guilds/${guildId}/roles/${guildId}`, owner.token, { permissions: perms.toString() });

describe('new permission bits', () => {
  it('sit above bit 46, are unique, documented for Discord, and in ALL_PERMS', () => {
    expect([Perm.SET_VOICE_CHANNEL_STATUS, Perm.USE_EXTERNAL_SOUNDS, Perm.CREATE_GUILD_EXPRESSIONS, Perm.VIEW_GUILD_INSIGHTS, Perm.USE_EMBEDDED_ACTIVITIES]).toEqual([1n << 47n, 1n << 48n, 1n << 49n, 1n << 50n, 1n << 51n]);
    const bits = Object.values(Perm).map((b) => b.toString(2).length - 1);
    expect(new Set(bits).size).toBe(bits.length);
    const discord = (Object.keys(Perm) as PermName[]).filter((n) => n !== 'RECORD_VOICE').map((n) => DISCORD_PERMISSION_BITS[n]);
    expect(new Set(discord).size).toBe(discord.length);
    expect(DISCORD_PERMISSION_BITS).toMatchObject({ VIEW_GUILD_INSIGHTS: 19, USE_EMBEDDED_ACTIVITIES: 39, CREATE_GUILD_EXPRESSIONS: 43, SET_VOICE_CHANNEL_STATUS: 48 });
    expect(ALL_PERMS & PERMS_ADDED_IN_110).toBe(PERMS_ADDED_IN_110);
    // sounds and activities used to be open to everyone who could connect: new servers keep that; status and expressions are opt-in
    expect(DEFAULT_EVERYONE & Perm.USE_EXTERNAL_SOUNDS).toBe(Perm.USE_EXTERNAL_SOUNDS);
    expect(DEFAULT_EVERYONE & Perm.USE_EMBEDDED_ACTIVITIES).toBe(Perm.USE_EMBEDDED_ACTIVITIES);
    expect(DEFAULT_EVERYONE & (Perm.SET_VOICE_CHANNEL_STATUS | Perm.CREATE_GUILD_EXPRESSIONS | Perm.VIEW_GUILD_INSIGHTS)).toBe(0n);
  });

  it('migration 110 grants each new bit to the holders of the bit it was split from (roles and overwrites)', async () => {
    const { owner, guild, voice } = await setup();
    const mk = async (name: string, p: bigint) => (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name, permissions: p.toString() })).body.id as string;
    const ids = {
      channels: await mk('mc', Perm.MANAGE_CHANNELS), soundboard: await mk('sb', Perm.USE_SOUNDBOARD), emojis: await mk('me', Perm.MANAGE_EMOJIS),
      guild: await mk('mg', Perm.MANAGE_GUILD), connect: await mk('cn', Perm.CONNECT), none: await mk('no', Perm.SEND_MESSAGES),
    };
    // pretend these roles predate the migration: strip any new bit, then run the real SQL
    await env.ctx.db.query('UPDATE roles SET permissions = ((permissions::bigint) & ~$1::bigint)::text WHERE guild_id = $2', [PERMS_ADDED_IN_110.toString(), guild.id]);
    await env.ctx.db.query('INSERT INTO overwrites (channel_id, target_id, type, allow, deny) VALUES ($1,$2,\'role\',$3,$4) ON CONFLICT (channel_id, target_id) DO UPDATE SET allow = $3, deny = $4', [voice.id, ids.channels, Perm.MANAGE_CHANNELS.toString(), '0']);
    await env.ctx.db.query('INSERT INTO overwrites (channel_id, target_id, type, allow, deny) VALUES ($1,$2,\'role\',$3,$4) ON CONFLICT (channel_id, target_id) DO UPDATE SET allow = $3, deny = $4', [voice.id, ids.guild, '0', Perm.MANAGE_GUILD.toString()]);
    const sql = readFileSync(pjoin(__dirname, '..', 'migrations', '110_voice_status_perms.sql'), 'utf8');
    for (const stmt of sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await env.ctx.db.query(stmt);
    const perms = async (id: string) => BigInt((await env.ctx.db.query('SELECT permissions FROM roles WHERE id = $1', [id]))[0]!.permissions);
    expect(await perms(ids.channels) & Perm.SET_VOICE_CHANNEL_STATUS).toBe(Perm.SET_VOICE_CHANNEL_STATUS);
    expect(await perms(ids.soundboard) & Perm.USE_EXTERNAL_SOUNDS).toBe(Perm.USE_EXTERNAL_SOUNDS);
    expect(await perms(ids.emojis) & Perm.CREATE_GUILD_EXPRESSIONS).toBe(Perm.CREATE_GUILD_EXPRESSIONS);
    expect(await perms(ids.guild) & Perm.VIEW_GUILD_INSIGHTS).toBe(Perm.VIEW_GUILD_INSIGHTS);
    expect(await perms(ids.connect) & Perm.USE_EMBEDDED_ACTIVITIES).toBe(Perm.USE_EMBEDDED_ACTIVITIES);
    expect(await perms(ids.none) & PERMS_ADDED_IN_110).toBe(0n);
    expect(await perms(ids.channels) & Perm.VIEW_GUILD_INSIGHTS).toBe(0n);
    const ow = async (id: string) => (await env.ctx.db.query('SELECT allow, deny FROM overwrites WHERE channel_id = $1 AND target_id = $2', [voice.id, id]))[0]!;
    expect(BigInt((await ow(ids.channels)).allow) & Perm.SET_VOICE_CHANNEL_STATUS).toBe(Perm.SET_VOICE_CHANNEL_STATUS);
    expect(BigInt((await ow(ids.guild)).deny) & Perm.VIEW_GUILD_INSIGHTS).toBe(Perm.VIEW_GUILD_INSIGHTS);
  });
});

describe('voice channel status', () => {
  it('needs the permission and a connection, validates, broadcasts, audits and clears when the channel empties', async () => {
    const { owner, guild, m, voice } = await setup();
    const put = (c: Client, status: unknown) => api.req('PUT', `/channels/${voice.id}/voice-status`, c.token, { status });
    const wo = await join(owner, guild.id, voice.id); const wm = await join(m, guild.id, voice.id);
    expect((await put(m, 'hello')).status).toBe(403); // not in DEFAULT_EVERYONE
    await grant(owner, guild.id, m, Perm.SET_VOICE_CHANNEL_STATUS);
    expect((await put(m, 'x'.repeat(501))).status).toBe(400);
    const r = await put(m, '  Movie\u0007   night  ');
    expect(r.status).toBe(200); expect(r.body).toEqual({ channelId: voice.id, status: 'Movie night' });
    const ev = await wo.waitEvent('CHANNEL_VOICE_STATUS_UPDATE'); expect(ev.d).toEqual({ guildId: guild.id, channelId: voice.id, status: 'Movie night' });
    const dto = (await api.req('GET', `/channels/${voice.id}`, owner.token)).body;
    expect(dto.voiceStatus).toBe('Movie night');
    const log = JSON.stringify((await api.req('GET', `/guilds/${guild.id}/audit-logs`, owner.token)).body);
    expect(log).toContain('VOICE_CHANNEL_STATUS_UPDATE');
    wm.close();
    await new Promise((r2) => setTimeout(r2, 100));
    // the channel still has the owner in it: status stays
    expect((await api.req('GET', `/channels/${voice.id}`, owner.token)).body.voiceStatus).toBe('Movie night');
    // text channels have no status
    const text = guild.channels.find((c: any) => c.type === 'text');
    expect((await api.req('PUT', `/channels/${text.id}/voice-status`, owner.token, { status: 'no' })).status).toBe(400);
    // clearing explicitly
    expect((await put(owner, null)).body.status).toBeNull();
    expect((await api.req('GET', `/channels/${voice.id}`, owner.token)).body.voiceStatus).toBeNull();
    expect((await put(owner, 'again')).status).toBe(200);
    // last one leaves: cleared
    wo.send({ op: 4, d: { guildId: guild.id, channelId: null } });
    for (let i = 0; i < 20; i++) { if ((await api.req('GET', `/channels/${voice.id}`, owner.token)).body.voiceStatus === null) break; await new Promise((r2) => setTimeout(r2, 50)); }
    expect((await api.req('GET', `/channels/${voice.id}`, owner.token)).body.voiceStatus).toBeNull();
    wo.close();
  });

  it('the sweeper clears a status that outlived its call', async () => {
    const { guild, voice } = await setup();
    await env.ctx.db.query('UPDATE channels SET voice_status = $2 WHERE id = $1', [voice.id, 'stale']);
    await runSweeps(env.ctx);
    const [row] = await env.ctx.db.query('SELECT voice_status FROM channels WHERE id = $1', [voice.id]);
    expect(row!.voice_status).toBeNull(); void guild;
  });
});

describe('permission enforcement', () => {
  it('USE_EXTERNAL_SOUNDS gates sounds of other servers', async () => {
    const a = await setup(); const b = await setup();
    // m belongs to both servers
    await api.req('POST', `/invites/${b.code}`, a.m.token);
    const mp3 = (() => { const bd = 'XBX'; return { payload: Buffer.concat([Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`), Buffer.alloc(300, 1), Buffer.from(`\r\n--${bd}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${bd}` } }; })();
    const url = (await api.req('POST', '/uploads', b.owner.token, mp3.payload as any, mp3.headers)).body.url;
    const sound = (await api.req('POST', `/guilds/${b.guild.id}/soundboard-sounds`, b.owner.token, { name: 'foreign', url })).body;
    const w = await join(a.m, a.guild.id, a.voice.id);
    const play = () => api.req('POST', `/channels/${a.voice.id}/send-soundboard-sound`, a.m.token, { soundId: sound.id });
    expect((await play()).status).toBe(204);
    await setEveryone(a.owner, a.guild.id, DEFAULT_EVERYONE & ~Perm.USE_EXTERNAL_SOUNDS);
    expect((await play()).status).toBe(403);
    w.close();
  });

  it('CREATE_GUILD_EXPRESSIONS lets a member add emoji and stickers but not edit or delete them', async () => {
    const { owner, guild, m } = await setup();
    expect((await api.req('POST', `/guilds/${guild.id}/emojis`, m.token, { name: 'mine', url: FILE })).status).toBe(403);
    await grant(owner, guild.id, m, Perm.CREATE_GUILD_EXPRESSIONS);
    const e = await api.req('POST', `/guilds/${guild.id}/emojis`, m.token, { name: 'mine', url: FILE });
    expect(e.status).toBe(201);
    expect((await api.req('POST', `/guilds/${guild.id}/stickers`, m.token, { name: 'sticky', url: FILE })).status).toBe(201);
    expect((await api.req('PATCH', `/guilds/${guild.id}/emojis/${e.body.id}`, m.token, { name: 'other' })).status).toBe(403);
    expect((await api.req('DELETE', `/guilds/${guild.id}/emojis/${e.body.id}`, m.token)).status).toBe(403);
  });

  it('VIEW_GUILD_INSIGHTS gates insights (MANAGE_GUILD alone no longer does)', async () => {
    const { owner, guild, m } = await setup();
    const role = await grant(owner, guild.id, m, Perm.MANAGE_GUILD);
    expect((await api.req('GET', `/guilds/${guild.id}/insights`, m.token)).status).toBe(403);
    await api.req('PATCH', `/guilds/${guild.id}/roles/${role.id}`, owner.token, { permissions: (Perm.MANAGE_GUILD | Perm.VIEW_GUILD_INSIGHTS).toString() });
    expect((await api.req('GET', `/guilds/${guild.id}/insights`, m.token)).status).toBe(200);
    expect((await api.req('GET', `/guilds/${guild.id}/insights`, owner.token)).status).toBe(200);
  });

  it('USE_EMBEDDED_ACTIVITIES gates starting an activity', async () => {
    const { owner, guild, m, voice } = await setup();
    const w = await join(m, guild.id, voice.id);
    await setEveryone(owner, guild.id, DEFAULT_EVERYONE & ~Perm.USE_EMBEDDED_ACTIVITIES);
    expect((await api.req('POST', `/channels/${voice.id}/activities`, m.token, { kind: 'tictactoe' })).status).toBe(403);
    await setEveryone(owner, guild.id, DEFAULT_EVERYONE);
    expect((await api.req('POST', `/channels/${voice.id}/activities`, m.token, { kind: 'tictactoe' })).status).toBe(201);
    w.close();
  });
});

describe('permission sync with category', () => {
  it('copies the category overwrites, audits it, and refuses without a category or MANAGE_ROLES', async () => {
    const { owner, guild, m } = await setup();
    const cat = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'Private', type: 'category' })).body;
    const ch = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'room', type: 'text' })).body;
    expect((await api.req('POST', `/channels/${ch.id}/permissions/sync`, owner.token)).status).toBe(400); // no category
    await api.req('PUT', `/channels/${cat.id}/permissions/${guild.id}`, owner.token, { type: 'role', allow: '0', deny: Perm.VIEW_CHANNEL.toString() });
    await api.req('PATCH', `/channels/${ch.id}`, owner.token, { parentId: cat.id });
    await api.req('PUT', `/channels/${ch.id}/permissions/${m.id}`, owner.token, { type: 'member', allow: Perm.SEND_MESSAGES.toString(), deny: '0' });
    expect((await api.req('POST', `/channels/${ch.id}/permissions/sync`, m.token)).status).toBeGreaterThanOrEqual(403);
    const r = await api.req('POST', `/channels/${ch.id}/permissions/sync`, owner.token);
    expect(r.status).toBe(204);
    const after = (await api.req('GET', `/channels/${ch.id}`, owner.token)).body;
    expect(after.overwrites).toEqual([{ id: guild.id, type: 'role', allow: '0', deny: Perm.VIEW_CHANNEL.toString() }]);
    expect(JSON.stringify((await api.req('GET', `/guilds/${guild.id}/audit-logs`, owner.token)).body)).toContain('CHANNEL_PERMISSIONS_SYNC');
    // a category cannot be synced
    expect((await api.req('POST', `/channels/${cat.id}/permissions/sync`, owner.token)).status).toBe(400);
  });
});

describe('thread slowmode and forum default', () => {
  it('threads take slowmode (Manage Threads only) and it is enforced; forum posts start with the default', async () => {
    const { owner, guild, m } = await setup();
    const general = guild.channels.find((c: any) => c.type === 'text');
    const msg = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'start' })).body;
    const th = (await api.req('POST', `/channels/${general.id}/messages/${msg.id}/threads`, owner.token, { name: 'slow' })).body;
    expect((await api.req('PATCH', `/channels/${th.id}`, m.token, { slowmode: 30 })).status).toBe(403);
    const ok = await api.req('PATCH', `/channels/${th.id}`, owner.token, { slowmode: 30 });
    expect(ok.status).toBe(200); expect(ok.body.slowmode).toBe(30);
    expect((await api.req('POST', `/channels/${th.id}/messages`, m.token, { content: 'one' })).status).toBe(201);
    const second = await api.req('POST', `/channels/${th.id}/messages`, m.token, { content: 'two' });
    expect(second.status).toBe(429); expect(second.body.retryAfter ?? second.body.retry_after ?? 1).toBeGreaterThan(0);
    // owner is exempt through BYPASS_SLOWMODE (admin)
    expect((await api.req('POST', `/channels/${th.id}/messages`, owner.token, { content: 'a' })).status).toBe(201);
    expect((await api.req('POST', `/channels/${th.id}/messages`, owner.token, { content: 'b' })).status).toBe(201);

    const forum = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'ideas', type: 'forum' })).body;
    expect((await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultThreadSlowmode: 21601 })).status).toBe(400);
    const p = await api.req('PATCH', `/channels/${forum.id}`, owner.token, { defaultThreadSlowmode: 60 });
    expect(p.body.defaultThreadSlowmode).toBe(60);
    const post = await api.req('POST', `/channels/${forum.id}/forum/posts`, m.token, { name: 'idea', content: 'text' });
    expect(post.status).toBe(201); expect(post.body.channel.slowmode).toBe(60);
    expect((await api.req('POST', `/channels/${post.body.channel.id}/messages`, m.token, { content: 'follow-up' })).status).toBe(429);
  });
});

describe('voice effects', () => {
  it('relays an emoji to the call, rate limits to one per 3 seconds and validates the emoji', async () => {
    const { owner, guild, m, voice } = await setup();
    const effect = (c: Client, emoji: string) => api.req('POST', `/channels/${voice.id}/voice-effect`, c.token, { emoji });
    expect((await effect(m, '🎉')).status).toBe(400); // not connected
    env.ctx.config.rateLimit = true;
    const wo = await join(owner, guild.id, voice.id); const wm = await join(m, guild.id, voice.id);
    const outsider = await api.register('out2'); const wout = await WsClient.connect(env.port); await wout.identify(outsider.token);
    expect((await effect(m, 'hello')).status).toBe(400);
    expect((await effect(m, '🎉')).status).toBe(204);
    const ev = await wo.waitEvent('VOICE_CHANNEL_EFFECT_SEND'); expect(ev.d).toMatchObject({ userId: m.id, channelId: voice.id, emoji: '🎉', emojiId: null });
    expect(ev.d.sound).toBeUndefined();
    await wm.waitEvent('VOICE_CHANNEL_EFFECT_SEND');
    await wout.expectNone((f) => f.t === 'VOICE_CHANNEL_EFFECT_SEND');
    expect((await effect(m, '🔥')).status).toBe(429);
    expect((await effect(owner, '👏')).status).toBe(204); // per-member bucket
    // no USE_SOUNDBOARD and no ADD_REACTIONS: refused
    await setEveryone(owner, guild.id, DEFAULT_EVERYONE & ~Perm.USE_SOUNDBOARD & ~Perm.ADD_REACTIONS);
    expect((await effect(m, '👍')).status).toBe(403);
    env.ctx.config.rateLimit = false;
    wo.close(); wm.close(); wout.close();
  });

  it('accepts only emoji sequences', () => {
    for (const ok of ['🎉', '❤️', '👍🏽', '👨‍👩‍👧', '🇯🇴', '1️⃣']) expect(isUnicodeEmoji(ok)).toBe(true);
    for (const bad of ['hello', '', '1', 'a🎉', '<script>', '🎉 ']) expect(isUnicodeEmoji(bad)).toBe(false);
  });
});
