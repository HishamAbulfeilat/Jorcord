import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { SAFETY_ALERT_PREFIX, WAVE_STICKER_ID, encodeEnvelope } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import { sweepExpiredMessages } from '../src/services/disappearing';
import { alertMassDm } from '../src/services/safetyAlerts';
import { runSweeps } from '../src/services/sweeper';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const befriend = async (x: Client, y: Client) => { await api.req('PUT', `/users/@me/relationships/${y.id}`, x.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${x.id}`, y.token, { type: 'friend' }); };
const say = (c: Client, ch: string, content = 'hi') => api.req('POST', `/channels/${ch}/messages`, c.token, { content });
const readState = async (u: Client, ch: string) => (await env.ctx.db.query('SELECT * FROM read_states WHERE user_id = $1 AND channel_id = $2', [u.id, ch]))[0];
async function guildSetup(n = 'o') {
  const owner = await api.register(n);
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Soc', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (name = 'm') => { const u = await api.register(name); const r = await api.req('POST', `/invites/${code}`, u.token); return { u, r }; };
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  return { owner, guild, code, join, general };
}

describe('ignore user', () => {
  it('is separate from block: lists, persists next to a friendship, syncs over the gateway, and is reversible', async () => {
    const a = await api.register('iga'); const b = await api.register('igb');
    await befriend(a, b);
    const ws = await WsClient.connect(env.port); await ws.identify(a.token);
    expect((await api.req('PUT', `/users/@me/ignored/${a.id}`, a.token)).status).toBe(400); // not oneself
    expect((await api.req('PUT', `/users/@me/ignored/${b.id}`, a.token)).status).toBe(204);
    expect((await ws.waitEvent('IGNORE_UPDATE', (d) => d.userId === b.id)).d.ignored).toBe(true);
    expect((await api.req('GET', '/users/@me/ignored', a.token)).body.users.map((u: any) => u.id)).toEqual([b.id]);
    // still friends, not blocked, and the other side sees nothing
    expect((await api.req('GET', '/users/@me/relationships', a.token)).body.find((r: any) => r.user.id === b.id).type).toBe('friend');
    expect((await api.req('GET', '/users/@me/ignored', b.token)).body.users).toEqual([]);
    // DMs still work both ways (no block)
    const dm = (await api.req('POST', '/users/@me/channels', b.token, { recipientIds: [a.id] })).body;
    expect((await say(b, dm.id, 'still delivered')).status).toBe(201);
    expect((await api.req('GET', `/channels/${dm.id}/messages`, a.token)).body.some((m: any) => m.content === 'still delivered')).toBe(true);
    expect((await api.req('DELETE', `/users/@me/ignored/${b.id}`, a.token)).status).toBe(204);
    expect((await ws.waitEvent('IGNORE_UPDATE', (d) => d.userId === b.id && d.ignored === false)).d.ignored).toBe(false);
    expect((await api.req('GET', '/users/@me/ignored', a.token)).body.users).toEqual([]);
    ws.close();
  });

  it('also works through the relationships endpoint and silences ping badges from the ignored author only', async () => {
    const { owner, join, general } = await guildSetup('igo');
    const { u: a } = await join('iga2'); const { u: b } = await join('igb2'); const { u: c } = await join('igc2');
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}`, a.token, { type: 'ignored' })).body).toEqual({ type: 'ignored' });
    await say(b, general.id, `hey <@${a.id}> and <@${owner.id}>`);
    expect((await readState(a, general.id))?.mention_count ?? 0).toBe(0); // ignored author: no badge
    expect((await readState(owner, general.id))?.mention_count).toBe(1); // everyone else still pinged
    await say(c, general.id, `hey <@${a.id}>`);
    expect((await readState(a, general.id)).mention_count).toBe(1); // someone not ignored still pings
    // the mentions inbox is unaffected (clients hide ignored text; the server still delivers)
    expect((await api.req('GET', '/users/@me/mentions', a.token)).status).toBe(200);
  });
});

describe('friend nicknames', () => {
  it('are private, friend-only, trimmed, clearable and reach the relationships list', async () => {
    const a = await api.register('nka'); const b = await api.register('nkb'); const s = await api.register('nks');
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}/nickname`, a.token, { nickname: 'buddy' })).status).toBe(404); // not friends yet
    await befriend(a, b);
    const ws = await WsClient.connect(env.port); await ws.identify(a.token);
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}/nickname`, a.token, { nickname: 'x'.repeat(33) })).status).toBe(400);
    expect((await api.req('PUT', `/users/@me/relationships/${b.id}/nickname`, a.token, { nickname: '  Best Buddy ' })).status).toBe(204);
    expect((await ws.waitEvent('FRIEND_NICKNAME_UPDATE')).d).toEqual({ userId: b.id, nickname: 'Best Buddy' });
    expect((await api.req('GET', '/users/@me/relationships', a.token)).body.find((r: any) => r.user.id === b.id).nickname).toBe('Best Buddy');
    expect((await api.req('GET', '/users/@me/relationships', b.token)).body.find((r: any) => r.user.id === a.id).nickname).toBeUndefined(); // private to the owner
    expect((await api.req('PUT', `/users/@me/relationships/${s.id}/nickname`, a.token, { nickname: 'stranger' })).status).toBe(404);
    await api.req('PUT', `/users/@me/relationships/${b.id}/nickname`, a.token, { nickname: null });
    expect((await api.req('GET', '/users/@me/relationships', a.token)).body.find((r: any) => r.user.id === b.id).nickname).toBeUndefined();
    ws.close();
  });
});

describe('disappearing DMs', () => {
  it('sets a per-channel timer for participants only, announces it, stamps new messages and sweeps them away', async () => {
    const a = await api.register('tta'); const b = await api.register('ttb'); const x = await api.register('ttx');
    await befriend(a, b);
    const dm = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    const old = (await say(a, dm.id, 'from before')).body;
    expect((await api.req('PUT', `/channels/${dm.id}/disappearing`, x.token, { seconds: 3600 })).status).toBe(404); // not a participant
    expect((await api.req('PUT', `/channels/${dm.id}/disappearing`, a.token, { seconds: 123 })).status).toBe(400);
    const wsB = await WsClient.connect(env.port); await wsB.identify(b.token);
    const set = await api.req('PUT', `/channels/${dm.id}/disappearing`, a.token, { seconds: 3600 });
    expect(set.status).toBe(200); expect(set.body.messageTtlSeconds).toBe(3600);
    expect((await wsB.waitEvent('CHANNEL_UPDATE', (d) => d.id === dm.id)).d.messageTtlSeconds).toBe(3600);
    const list = (await api.req('GET', `/channels/${dm.id}/messages`, b.token)).body;
    expect(list.find((m: any) => m.type === 'ttl_update')).toMatchObject({ content: '3600', author: { id: a.id } });
    const fresh = (await say(b, dm.id, 'vanishing')).body;
    const rows = await env.ctx.db.query('SELECT id, expires_at FROM messages WHERE channel_id = $1', [dm.id]);
    const exp = (id: string) => rows.find((r) => r.id === id)?.expires_at;
    expect(exp(fresh.id)).toBeTruthy(); expect(new Date(exp(fresh.id)).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(exp(old.id)).toBeNull(); // earlier messages stay
    expect(exp(list.find((m: any) => m.type === 'ttl_update').id)).toBeNull(); // so does the notice

    expect(await sweepExpiredMessages(env.ctx)).toBe(0); // nothing due yet
    await env.ctx.db.query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, [fresh.id]);
    await runSweeps(env.ctx); // the regular sweeper runs the job
    expect((await wsB.waitEvent('MESSAGE_DELETE', (d) => d.id === fresh.id)).d.channelId).toBe(dm.id);
    const after = (await api.req('GET', `/channels/${dm.id}/messages`, a.token)).body.map((m: any) => m.id);
    expect(after).not.toContain(fresh.id); expect(after).toContain(old.id);

    // turning it off stops stamping
    expect((await api.req('PUT', `/channels/${dm.id}/disappearing`, b.token, { seconds: 0 })).body.messageTtlSeconds).toBeUndefined();
    const keep = (await say(a, dm.id, 'stays')).body;
    expect((await env.ctx.db.query('SELECT expires_at FROM messages WHERE id = $1', [keep.id]))[0].expires_at).toBeNull();
    wsB.close();
  });

  it('erases the ciphertext of a secret chat and works in group DMs', async () => {
    const a = await api.register('tsa'); const b = await api.register('tsb'); const c = await api.register('tsc');
    await befriend(a, b); await befriend(a, c);
    const rb = (n: number) => randomBytes(n).toString('base64url');
    const key = () => { const e = createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey().toString('base64url'); };
    const secret = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id], encrypted: true })).body;
    const da = (await api.req('POST', '/users/@me/e2ee/devices', a.token, { publicKey: key() })).body, db = (await api.req('POST', '/users/@me/e2ee/devices', b.token, { publicKey: key() })).body;
    const env1 = encodeEnvelope({ v: 1, from: da.id, epk: rb(65), iv: rb(12), ct: rb(40), keys: { [da.id]: { iv: rb(12), wk: rb(48) }, [db.id]: { iv: rb(12), wk: rb(48) } } });
    expect((await api.req('PUT', `/channels/${secret.id}/disappearing`, a.token, { seconds: 86_400 })).body.messageTtlSeconds).toBe(86_400);
    const sent = await api.req('POST', `/channels/${secret.id}/messages`, a.token, { content: env1 });
    expect(sent.status).toBe(201);
    await env.ctx.db.query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, [sent.body.id]);
    await sweepExpiredMessages(env.ctx);
    expect((await env.ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [sent.body.id])).length).toBe(0); // the ciphertext row is gone, not just hidden

    const group = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id, c.id] })).body;
    expect((await api.req('PUT', `/channels/${group.id}/disappearing`, c.token, { seconds: 604_800 })).body.messageTtlSeconds).toBe(604_800);
  });
});

describe('wave to say hi', () => {
  it('replies to a join message with the wave sticker, once per person, never to anything else', async () => {
    const { owner, guild, join, general } = await guildSetup('wvo');
    const sys = guild.systemChannelId ?? general.id;
    const { u: newbie } = await join('wvn'); const { u: friendly } = await join('wvf');
    const msgs = (await api.req('GET', `/channels/${sys}/messages`, owner.token)).body;
    const joinMsg = msgs.find((m: any) => m.type === 'join' && m.author.id === newbie.id);
    expect(joinMsg).toBeTruthy();
    const w = await api.req('POST', `/channels/${sys}/messages/${joinMsg.id}/wave`, friendly.token);
    expect(w.status).toBe(201); expect(w.body).toMatchObject({ replyTo: joinMsg.id, stickerIds: [WAVE_STICKER_ID], author: { id: friendly.id } });
    expect((await api.req('POST', `/channels/${sys}/messages/${joinMsg.id}/wave`, friendly.token)).status).toBe(409);
    expect((await api.req('POST', `/channels/${sys}/messages/${joinMsg.id}/wave`, newbie.token)).status).toBe(400); // not at oneself
    const plain = (await say(owner, sys, 'not a join')).body;
    expect((await api.req('POST', `/channels/${sys}/messages/${plain.id}/wave`, friendly.token)).status).toBe(400);
    const outsider = await api.register('wvx');
    expect((await api.req('POST', `/channels/${sys}/messages/${joinMsg.id}/wave`, outsider.token)).status).toBe(404);
  });
});

describe('inbox unreads and threads', () => {
  it('lists channels with unread messages, drops them once read or muted', async () => {
    const { owner, join, general } = await guildSetup('inu');
    const { u: a } = await join('inua');
    await say(owner, general.id, 'one'); const last = (await say(owner, general.id, 'two')).body;
    const un = (await api.req('GET', '/users/@me/inbox/unreads', a.token)).body;
    expect(un.find((c: any) => c.channelId === general.id)).toMatchObject({ guildId: general.guildId, name: 'general', lastMessageId: last.id });
    expect((await api.req('GET', '/users/@me/inbox/unreads', owner.token)).body.some((c: any) => c.channelId === general.id)).toBe(false); // own messages are read
    await api.req('POST', `/channels/${general.id}/ack`, a.token, { messageId: last.id });
    expect((await api.req('GET', '/users/@me/inbox/unreads', a.token)).body.some((c: any) => c.channelId === general.id)).toBe(false);
    await say(owner, general.id, 'three');
    expect((await api.req('GET', '/users/@me/inbox/unreads', a.token)).body.some((c: any) => c.channelId === general.id)).toBe(true);
    await api.req('PUT', `/users/@me/notification-settings/channels/${general.id}`, a.token, { muted: true });
    expect((await api.req('GET', '/users/@me/inbox/unreads', a.token)).body.some((c: any) => c.channelId === general.id)).toBe(false);
    // a DM that has an unread message shows up too
    await befriend(owner, a);
    const dm = (await api.req('POST', '/users/@me/channels', owner.token, { recipientIds: [a.id] })).body;
    await say(owner, dm.id, 'psst');
    expect((await api.req('GET', '/users/@me/inbox/unreads', a.token)).body.find((c: any) => c.channelId === dm.id)).toMatchObject({ guildId: null });
  });

  it('lists followed threads with activity and stores a per-thread level (none also mutes push)', async () => {
    const { owner, join, general } = await guildSetup('inth');
    const { u: a } = await join('itha');
    const t = (await api.req('POST', `/channels/${general.id}/threads`, owner.token, { name: 'topic' })).body;
    expect((await api.req('PUT', `/channels/${t.id}/thread-members/@me`, a.token)).status).toBe(204);
    await say(owner, t.id, 'news');
    let threads = (await api.req('GET', '/users/@me/inbox/threads', a.token)).body;
    expect(threads.find((x: any) => x.threadId === t.id)).toMatchObject({ unread: true, level: 'mentions', parentId: general.id, name: 'topic' });
    const last = (await api.req('GET', `/channels/${t.id}/messages`, a.token)).body[0];
    await api.req('POST', `/channels/${t.id}/ack`, a.token, { messageId: last.id });
    threads = (await api.req('GET', '/users/@me/inbox/threads', a.token)).body;
    expect(threads.find((x: any) => x.threadId === t.id).unread).toBe(false);

    expect((await api.req('PUT', `/users/@me/notification-settings/threads/${t.id}`, a.token, { level: 'loud' })).status).toBe(400);
    expect((await api.req('PUT', `/users/@me/notification-settings/threads/${general.id}`, a.token, { level: 'all' })).status).toBe(400); // not a thread
    expect((await api.req('PUT', `/users/@me/notification-settings/threads/${t.id}`, a.token, { level: 'all' })).body).toEqual({ threadId: t.id, level: 'all' });
    expect((await api.req('GET', '/users/@me/inbox/threads', a.token)).body.find((x: any) => x.threadId === t.id).level).toBe('all');
    // "all" -> the follower is a push candidate for every thread message
    const delivered: string[][] = [];
    const real = env.ctx.push.deliver; env.ctx.push.deliver = async (ids) => { delivered.push(ids); };
    try {
      await say(owner, t.id, 'ping all');
      await new Promise((r) => setTimeout(r, 300));
    } finally { env.ctx.push.deliver = real; }
    expect(delivered.flat()).toContain(a.id);
    await api.req('PUT', `/users/@me/notification-settings/threads/${t.id}`, a.token, { level: 'none' });
    expect((await env.ctx.db.query(`SELECT muted FROM notification_settings WHERE user_id = $1 AND scope = 'channel' AND target_id = $2`, [a.id, t.id]))[0].muted).toBe(true);
    await api.req('PUT', `/users/@me/notification-settings/threads/${t.id}`, a.token, { level: 'mentions' });
    expect((await env.ctx.db.query(`SELECT muted FROM notification_settings WHERE user_id = $1 AND scope = 'channel' AND target_id = $2`, [a.id, t.id]))[0].muted).toBe(false);
    expect((await env.ctx.db.query(`SELECT 1 FROM notification_settings WHERE user_id = $1 AND scope = 'thread'`, [a.id])).length).toBe(0);
  });
});

describe('safety alerts', () => {
  const press = (c: Client, ch: string, mid: string, customId: string) => api.req('POST', '/interactions', c.token, { type: 3, channelId: ch, messageId: mid, data: { customId } });
  async function raidSetup() {
    const s = await guildSetup('sao');
    const mod = (await api.req('POST', `/guilds/${s.guild.id}/channels`, s.owner.token, { name: 'mod-alerts', type: 'text' })).body;
    return { ...s, mod };
  }
  const alertsIn = async (ch: string, token: string) => (await api.req('GET', `/channels/${ch}/messages`, token)).body.filter((m: any) => m.embeds?.[0]?.footer?.startsWith('Safety alert'));

  it('is configured in Safety Setup and validated', async () => {
    const { owner, guild, mod, join, general } = await raidSetup(); const { u } = await join('sau');
    expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, u.token, { safetyAlerts: { channelId: mod.id } })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { safetyAlerts: { channelId: 'nope' } })).status).toBe(400);
    const voice = guild.channels.find((c: any) => c.type === 'voice');
    if (voice) expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { safetyAlerts: { channelId: voice.id } })).status).toBe(400);
    expect((await api.req('GET', `/guilds/${guild.id}/safety`, owner.token)).body.safetyAlerts).toEqual({ channelId: null, raid: true, massDm: true });
    const r = await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { safetyAlerts: { channelId: mod.id, massDm: false } });
    expect(r.body.safetyAlerts).toEqual({ channelId: mod.id, raid: true, massDm: false });
    expect((await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { safetyAlerts: { channelId: general.id } })).body.safetyAlerts.channelId).toBe(general.id);
  });

  it('posts a raid alert with buttons; moderators lock invites or kick the flagged joiners, others cannot', async () => {
    const { owner, guild, mod, join } = await raidSetup();
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { raidProtection: { enabled: true, maxJoins: 3, windowSeconds: 60 }, safetyAlerts: { channelId: mod.id } });
    const joiners: Client[] = [];
    for (let i = 0; i < 3; i++) joiners.push((await join(`raid${i}`)).u);
    const [alert] = await alertsIn(mod.id, owner.token);
    expect(alert).toBeTruthy();
    expect(alert.author.bot).toBe(true);
    expect(alert.embeds[0].title).toBe('Possible raid detected');
    const ids = alert.components[0].components.map((c: any) => c.customId);
    expect(ids).toEqual([`${SAFETY_ALERT_PREFIX}lock`, `${SAFETY_ALERT_PREFIX}kick`, `${SAFETY_ALERT_PREFIX}dismiss`]);

    // a plain member who can see the channel still has no moderation power, whatever the button says
    expect((await press(joiners[0]!, mod.id, alert.id, ids[2])).status).toBe(403);
    expect((await press(joiners[0]!, mod.id, alert.id, ids[0])).status).toBe(403);
    expect((await press(joiners[0]!, mod.id, alert.id, ids[1])).status).toBe(403);

    expect((await press(owner, mod.id, alert.id, ids[0])).status).toBe(202);
    const g = (await api.req('GET', `/guilds/${guild.id}`, owner.token)).body;
    expect(new Date(g.invitesPausedUntil).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const done = (await api.req('GET', `/channels/${mod.id}/messages`, owner.token)).body.find((m: any) => m.id === alert.id);
    expect(done.components).toEqual([]); // buttons are spent
    expect(done.embeds[0].footer).toContain('invites locked');
    expect((await press(owner, mod.id, alert.id, ids[1])).status).toBe(400); // already handled
  });

  it('kick removes the flagged raid joiners and audit-logs it; dismiss closes the alert', async () => {
    const { owner, guild, mod, join } = await raidSetup();
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { raidProtection: { enabled: true, maxJoins: 3, windowSeconds: 60 }, safetyAlerts: { channelId: mod.id } });
    const joiners: Client[] = [];
    for (let i = 0; i < 3; i++) joiners.push((await join(`rk${i}`)).u);
    const [alert] = await alertsIn(mod.id, owner.token);
    expect((await press(owner, mod.id, alert.id, `${SAFETY_ALERT_PREFIX}kick`)).status).toBe(202);
    for (const j of joiners) expect((await api.req('GET', `/guilds/${guild.id}`, j.token)).status).toBe(404);
    expect((await env.ctx.db.query(`SELECT 1 FROM audit_log WHERE guild_id = $1 AND action = 'MEMBER_KICK' AND actor_id = $2`, [guild.id, owner.id])).length).toBe(3);

    // dismiss on a fresh alert
    const s2 = await raidSetup();
    await api.req('PATCH', `/guilds/${s2.guild.id}/safety`, s2.owner.token, { raidProtection: { enabled: true, maxJoins: 3, windowSeconds: 60 }, safetyAlerts: { channelId: s2.mod.id } });
    for (let i = 0; i < 3; i++) await s2.join(`rd${i}`);
    const [a2] = await alertsIn(s2.mod.id, s2.owner.token);
    expect((await press(s2.owner, s2.mod.id, a2.id, `${SAFETY_ALERT_PREFIX}dismiss`)).status).toBe(202);
    expect((await alertsIn(s2.mod.id, s2.owner.token))[0].components).toEqual([]);
  });

  it('raises no alert when none is configured or the raid switch is off', async () => {
    const { owner, guild, mod, join } = await raidSetup();
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { raidProtection: { enabled: true, maxJoins: 3, windowSeconds: 60 }, safetyAlerts: { raid: false, channelId: mod.id } });
    for (let i = 0; i < 3; i++) await join(`quiet${i}`);
    expect(await alertsIn(mod.id, owner.token)).toHaveLength(0);
  });

  it('alerts every configured server a mass-DM spammer belongs to, with a kick button', async () => {
    const { owner, guild, mod, join } = await raidSetup();
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { safetyAlerts: { channelId: mod.id } });
    const { u: spammer } = await join('spam');
    await alertMassDm(env.ctx, spammer.id, { reason: 'identical_dm_with_link', recipients: 4 });
    const [alert] = await alertsIn(mod.id, owner.token);
    expect(alert.embeds[0].title).toBe('Mass-DM spam detected');
    expect(alert.components[0].components[0].customId).toBe(`${SAFETY_ALERT_PREFIX}kick:${spammer.id}`);
    expect((await press(owner, mod.id, alert.id, `${SAFETY_ALERT_PREFIX}kick:${spammer.id}`)).status).toBe(202);
    expect((await api.req('GET', `/guilds/${guild.id}`, spammer.token)).status).toBe(404);
    // switched off for mass DMs: nothing more is posted
    const { u: again } = await join('spam2');
    await api.req('PATCH', `/guilds/${guild.id}/safety`, owner.token, { safetyAlerts: { massDm: false } });
    await alertMassDm(env.ctx, again.id, { reason: 'many_strangers', recipients: 20 });
    expect(await alertsIn(mod.id, owner.token)).toHaveLength(1);
  });
});

describe('AutoMod member-profile rule', () => {
  const rule = (g: string, t: string, b: object) => api.req('POST', `/guilds/${g}/automod/rules`, t, { name: 'Profile words', trigger: 'member_profile', keywords: ['crypto giveaway'], actions: ['block'], ...b });

  it('holds a member whose username / display name / bio matches on join and on profile update, and does not touch messages', async () => {
    const { owner, guild, code, general } = await guildSetup('apo');
    expect((await rule(guild.id, owner.token, {})).status).toBe(201);
    const clean = await api.register('apc');
    await api.req('POST', `/invites/${code}`, clean.token);
    let q = (await api.req('GET', `/guilds/${guild.id}/safety/impersonation`, owner.token)).body;
    expect(q).toHaveLength(0);
    // a keyword in a normal MESSAGE is not a profile match
    expect((await say(clean, general.id, 'crypto giveaway lol')).status).toBe(201);

    // bad display name at join
    const bad = await api.register('apb');
    await api.req('PATCH', '/users/@me', bad.token, { displayName: 'Crypto Giveaway Official' });
    await api.req('POST', `/invites/${code}`, bad.token);
    q = (await api.req('GET', `/guilds/${guild.id}/safety/impersonation`, owner.token)).body;
    expect(q.map((x: any) => x.userId)).toEqual([bad.id]);
    expect(q[0]).toMatchObject({ held: true, match: { kind: 'profile', target: 'Profile words' } });
    expect((await say(bad, general.id, 'hello')).status).toBe(403); // held until a moderator clears them

    // profile update after joining (bio)
    await api.req('PATCH', '/users/@me', clean.token, { bio: 'ask me about the CRYPTO GIVEAWAY' });
    q = (await api.req('GET', `/guilds/${guild.id}/safety/impersonation`, owner.token)).body;
    expect(q.map((x: any) => x.userId).sort()).toEqual([bad.id, clean.id].sort());
    expect((await env.ctx.db.query(`SELECT 1 FROM audit_log WHERE guild_id = $1 AND action = 'AUTOMOD_BLOCK' AND actor_id = $2`, [guild.id, clean.id])).length).toBe(1);
  });

  it('supports warn / timeout / alert actions, exempt roles, the test mode and the dry-run endpoint', async () => {
    const { owner, guild, code } = await guildSetup('apw');
    const alertCh = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'profile-alerts', type: 'text' })).body;
    const r = await rule(guild.id, owner.token, { keywords: [], regexPatterns: ['^spam\\d+$'], actions: ['warn', 'timeout', 'alert'], timeoutSeconds: 60, alertChannelId: alertCh.id });
    expect(r.status).toBe(201);
    const u = await api.register('spam123'.replace(/\d+/, '')); // username is spamN... registered below
    await env.ctx.db.query(`UPDATE users SET username = 'spam42' WHERE id = $1`, [u.id]);
    await api.req('POST', `/invites/${code}`, u.token);
    const m = (await env.ctx.db.query('SELECT timeout_until FROM members WHERE guild_id = $1 AND user_id = $2', [guild.id, u.id]))[0];
    expect(m.timeout_until).toBeTruthy();
    expect((await env.ctx.db.query('SELECT 1 FROM mod_warnings WHERE guild_id = $1 AND user_id = $2', [guild.id, u.id])).length).toBe(1);
    const alerts = (await api.req('GET', `/channels/${alertCh.id}/messages`, owner.token)).body;
    expect(alerts.some((a: any) => a.embeds?.[0]?.title?.includes('AutoMod: Profile words'))).toBe(true);

    // dry run reports the profile rule against profile text
    const t = (await api.req('POST', `/guilds/${guild.id}/automod/test`, owner.token, { content: 'spam7' })).body;
    expect(t.find((x: any) => x.trigger === 'member_profile')).toMatchObject({ matched: true });
    // an exempt role skips the rule
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'trusted' })).body;
    await api.req('PATCH', `/guilds/${guild.id}/automod/rules/${r.body.id}`, owner.token, { exemptRoles: [role.id], actions: ['block'], alertChannelId: null });
    const v = await api.register('vip');
    await env.ctx.db.query(`UPDATE users SET username = 'spam99' WHERE id = $1`, [v.id]);
    await api.req('POST', `/invites/${code}`, v.token);
    await api.req('PATCH', `/guilds/${guild.id}/members/${v.id}`, owner.token, { roles: [role.id] });
    const { checkMemberProfile } = await import('../src/services/automod');
    expect(await checkMemberProfile(env.ctx, guild.id, v.id)).toBeNull();
  });
});
