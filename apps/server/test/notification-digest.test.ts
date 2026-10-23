import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import { runSweeps } from '../src/services/sweeper';
import { applyLargeServerDefault } from '../src/services/digest';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer({ sweepIntervalMs: 0 }); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('do');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Busy' })).body;
  const general = guild.channels.find((c: any) => c.name === 'general');
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const join = async (name: string) => { const u = await api.register(name); await api.req('POST', `/invites/${code}`, u.token); return u; };
  return { owner, guild, general, alice: await join('da'), bob: await join('db') };
}
const mentionCount = async (u: Client, channelId: string) => ((await api.req('GET', '/users/@me/read-states', u.token)).body as any[]).find((r) => r.channelId === channelId)?.mentionCount ?? 0;
const age = (userId: string, hours: number) => env.ctx.db.query(`UPDATE digest_pending SET created_at = now() - ($2 || ' hours')::interval WHERE user_id = $1`, [userId, String(hours)]);

describe('notification digest', () => {
  it('holds pings for digest servers, keeps them for everyone else, and delivers one Inbox entry when the period is over', async () => {
    const { owner, guild, general, alice, bob } = await setup();
    const set = await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, alice.token, { digest: true });
    expect(set.status).toBe(200); expect(set.body.digest).toBe(true);
    expect((await api.req('GET', '/users/@me/notification-settings', alice.token)).body.guilds[0].digest).toBe(true);
    const ws = await WsClient.connect(env.port); await ws.identify(alice.token);

    for (let i = 0; i < 2; i++) await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: `hey <@${alice.id}> <@${bob.id}> ${i}` });
    expect(await mentionCount(alice, general.id)).toBe(0); // no badge: held for the digest
    expect(await mentionCount(bob, general.id)).toBe(2); // others are untouched
    expect((await env.ctx.db.query('SELECT 1 FROM digest_pending WHERE user_id = $1', [alice.id])).length).toBe(2);

    await runSweeps(env.ctx); // not due yet (daily by default)
    expect((await api.req('GET', '/users/@me/digests', alice.token)).body).toEqual([]);
    await age(alice.id, 25); await runSweeps(env.ctx);
    const entries = (await api.req('GET', '/users/@me/digests', alice.token)).body;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ total: 2, readAt: null, items: [{ guildId: guild.id, channelId: general.id, count: 2, mentions: 2 }] });
    expect((await ws.waitEvent('DIGEST_CREATE')).d.id).toBe(entries[0].id);
    expect((await env.ctx.db.query('SELECT 1 FROM digest_pending WHERE user_id = $1', [alice.id])).length).toBe(0); // consumed once
    await runSweeps(env.ctx);
    expect((await api.req('GET', '/users/@me/digests', alice.token)).body.length).toBe(1);

    expect((await api.req('GET', '/users/@me/notification-digest', alice.token)).body.unread).toBe(1);
    expect((await api.req('POST', `/users/@me/digests/${entries[0].id}/read`, bob.token)).status).toBe(404); // not bob's
    expect((await api.req('POST', `/users/@me/digests/${entries[0].id}/read`, alice.token)).status).toBe(204);
    expect((await api.req('GET', '/users/@me/notification-digest', alice.token)).body.unread).toBe(0);
    expect((await api.req('DELETE', `/users/@me/digests/${entries[0].id}`, alice.token)).status).toBe(204);
    ws.close();
  });

  it('honours the hourly setting, validates preferences, and works per channel and for DMs', async () => {
    const { owner, general, alice, bob } = await setup();
    expect((await api.req('PATCH', '/users/@me/notification-digest', alice.token, { frequency: 'weekly' })).status).toBe(400);
    expect((await api.req('GET', '/users/@me/notification-digest', alice.token)).body).toMatchObject({ frequency: 'daily', largeServerMentionsOnly: true, largeServerThreshold: 250 });
    expect((await api.req('PATCH', '/users/@me/notification-digest', alice.token, { frequency: 'hourly' })).body.frequency).toBe('hourly');
    await api.req('PUT', `/users/@me/notification-settings/channels/${general.id}`, alice.token, { digest: true });
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: `ping <@${alice.id}>` });
    await age(alice.id, 0.5); await runSweeps(env.ctx);
    expect((await api.req('GET', '/users/@me/digests', alice.token)).body.length).toBe(0); // 30 minutes < 1 hour
    await age(alice.id, 2); await runSweeps(env.ctx);
    expect((await api.req('GET', '/users/@me/digests', alice.token)).body.length).toBe(1);

    // a DM channel can be digested too
    await api.req('PUT', `/users/@me/relationships/${alice.id}`, bob.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${bob.id}`, alice.token, { type: 'friend' });
    const dm = (await api.req('POST', '/users/@me/channels', bob.token, { recipientIds: [alice.id] })).body;
    await api.req('PUT', `/users/@me/notification-settings/channels/${dm.id}`, alice.token, { digest: true });
    await api.req('POST', `/channels/${dm.id}/messages`, bob.token, { content: 'psst' });
    expect(await mentionCount(alice, dm.id)).toBe(0);
    await age(alice.id, 2); await runSweeps(env.ctx);
    const items = (await api.req('GET', '/users/@me/digests', alice.token)).body[0].items;
    expect(items).toEqual([{ guildId: null, channelId: dm.id, count: 1, mentions: 1, lastMessageId: expect.any(String) }]);

    // switching digest off restores normal badges
    await api.req('PUT', `/users/@me/notification-settings/channels/${general.id}`, alice.token, { digest: false });
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: `again <@${alice.id}>` });
    expect(await mentionCount(alice, general.id)).toBe(1);
  });

  it('drops held items for servers the user has since left', async () => {
    const { owner, guild, general, alice } = await setup();
    await api.req('PUT', `/users/@me/notification-settings/guilds/${guild.id}`, alice.token, { digest: true });
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: `bye <@${alice.id}>` });
    await api.req('DELETE', `/users/@me/guilds/${guild.id}`, alice.token);
    await age(alice.id, 25); await runSweeps(env.ctx);
    expect((await api.req('GET', '/users/@me/digests', alice.token)).body).toEqual([]);
  });
});

describe('mentions-only default for large servers', () => {
  it('sets mentions-only on join when the server would otherwise ping for everything, never overrides a choice, and can be turned off', async () => {
    const owner = await api.register('lo');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Huge' })).body;
    const quiet = await api.register('lq'); const loud = await api.register('ll'); const optout = await api.register('lx'); const chosen = await api.register('lc');
    const rows = (u: Client) => env.ctx.db.query(`SELECT level FROM notification_settings WHERE user_id = $1 AND scope = 'guild' AND target_id = $2`, [u.id, guild.id]);
    const join = async (u: Client) => { await env.ctx.db.query('INSERT INTO members (guild_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [guild.id, u.id]); return applyLargeServerDefault(env.ctx, u.id, guild.id, 1); };

    expect(await join(quiet)).toBe(false); // server default is already mentions-only
    await env.ctx.db.query("UPDATE guilds SET default_notifications = 'all' WHERE id = $1", [guild.id]); // the owner chose "all messages"
    expect(await join(loud)).toBe(true);
    expect((await rows(loud))[0].level).toBe('mentions');
    await api.req('PATCH', '/users/@me/notification-digest', optout.token, { largeServerMentionsOnly: false });
    expect(await join(optout)).toBe(false); expect(await rows(optout)).toEqual([]);
    await env.ctx.db.query('INSERT INTO members (guild_id, user_id) VALUES ($1,$2)', [guild.id, chosen.id]);
    await env.ctx.db.query(`INSERT INTO notification_settings (user_id, scope, target_id, level) VALUES ($1,'guild',$2,'all')`, [chosen.id, guild.id]);
    expect(await applyLargeServerDefault(env.ctx, chosen.id, guild.id, 1)).toBe(false);
    expect((await rows(chosen))[0].level).toBe('all'); // an explicit choice wins
    // small servers are left alone
    expect(await applyLargeServerDefault(env.ctx, owner.id, guild.id, 1000)).toBe(false);
  });

  it('applies automatically on a real join once the server is over the threshold', async () => {
    const owner = await api.register('jo');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Crowd' })).body;
    await env.ctx.db.query("UPDATE guilds SET default_notifications = 'all' WHERE id = $1", [guild.id]);
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    // the owner + 249 filler members = 250 (not over the threshold); the next join makes it 251
    const tag = Date.now().toString(36);
    await env.ctx.db.query(`INSERT INTO users (id, email, username, password_hash) SELECT 'fill${tag}' || g, 'fill${tag}' || g || '@x.test', 'fill${tag}' || g, 'x' FROM generate_series(1, 249) g`);
    await env.ctx.db.query(`INSERT INTO members (guild_id, user_id) SELECT $1, id FROM users WHERE id LIKE 'fill${tag}%'`, [guild.id]);
    const early = await api.register('je');
    const settingsOf = async (u: Client) => (await api.req('GET', '/users/@me/notification-settings', u.token)).body.guilds.find((g: any) => g.guildId === guild.id);
    await api.req('POST', `/invites/${code}`, early.token); // 251st member: over the threshold
    expect((await settingsOf(early))?.level).toBe('mentions');
  });
});
