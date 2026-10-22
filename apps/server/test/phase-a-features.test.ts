import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMS, DEFAULT_EVERYONE, DISCORD_PERMISSION_BITS, Perm, snowflake } from '@jorcord/shared';
import { Api, WsClient, eraseNow, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const PW = 'correct horse battery';
const STICKER_URL = '/api/v1/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.png';

async function guildWith(...names: string[]) {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Phase A', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: Client[] = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  const ch = (type: string, name?: string) => guild.channels.find((c: any) => c.type === type && (!name || c.name === name));
  return { owner, guild, members, general: ch('text', 'general'), rules: ch('text', 'rules') };
}
async function role(owner: Client, guildId: string, perms: bigint, name = 'r') {
  return (await api.req('POST', `/guilds/${guildId}/roles`, owner.token, { name, permissions: String(perms) })).body;
}
const give = (owner: Client, guildId: string, user: Client, roleId: string) => api.req('PATCH', `/guilds/${guildId}/members/${user.id}`, owner.token, { roles: [roleId] });

describe('permission bits PIN_MESSAGES, BYPASS_SLOWMODE, USE_EXTERNAL_STICKERS', () => {
  it('have their own bits, a Discord mapping and sane defaults', () => {
    expect(Perm.PIN_MESSAGES).toBe(1n << 44n); expect(Perm.BYPASS_SLOWMODE).toBe(1n << 45n); expect(Perm.USE_EXTERNAL_STICKERS).toBe(1n << 46n);
    expect(DISCORD_PERMISSION_BITS).toMatchObject({ PIN_MESSAGES: 51, BYPASS_SLOWMODE: 52, USE_EXTERNAL_STICKERS: 37 });
    expect(DEFAULT_EVERYONE & Perm.USE_EXTERNAL_STICKERS).toBe(Perm.USE_EXTERNAL_STICKERS);
    expect(DEFAULT_EVERYONE & (Perm.PIN_MESSAGES | Perm.BYPASS_SLOWMODE)).toBe(0n);
    expect(ALL_PERMS & Perm.PIN_MESSAGES).toBe(Perm.PIN_MESSAGES);
  });

  it('pinning needs PIN_MESSAGES (MANAGE_MESSAGES alone is not enough); DMs stay open to participants', async () => {
    const { owner, guild, members: [mod, pinner, plain], general } = await guildWith('mod', 'pinner', 'plain');
    const msg = (await api.req('POST', `/channels/${general.id}/messages`, plain!.token, { content: 'pin me' })).body;
    await give(owner, guild.id, mod!, (await role(owner, guild.id, Perm.MANAGE_MESSAGES, 'mm')).id);
    await give(owner, guild.id, pinner!, (await role(owner, guild.id, Perm.PIN_MESSAGES, 'pin')).id);
    const pin = (u: Client) => api.req('PUT', `/channels/${general.id}/pins/${msg.id}`, u.token);
    expect((await pin(plain!)).status).toBe(403);
    expect((await pin(mod!)).status).toBe(403);
    expect((await pin(pinner!)).status).toBe(204);
    expect((await api.req('GET', `/channels/${general.id}/pins`, plain!.token)).body.map((m: any) => m.id)).toEqual([msg.id]);
    expect((await api.req('DELETE', `/channels/${general.id}/pins/${msg.id}`, mod!.token)).status).toBe(403);
    expect((await api.req('DELETE', `/channels/${general.id}/pins/${msg.id}`, pinner!.token)).status).toBe(204);
    // a channel overwrite grants it too
    await api.req('PUT', `/channels/${general.id}/permissions/${plain!.id}`, owner.token, { type: 'member', allow: String(Perm.PIN_MESSAGES), deny: '0' });
    expect((await pin(plain!)).status).toBe(204);
    // DMs: both participants may pin
    const dm = (await api.req('POST', '/users/@me/channels', plain!.token, { recipientIds: [pinner!.id] })).body;
    const dmMsg = (await api.req('POST', `/channels/${dm.id}/messages`, plain!.token, { content: 'hi' })).body;
    expect((await api.req('PUT', `/channels/${dm.id}/pins/${dmMsg.id}`, pinner!.token)).status).toBe(204);
  });

  it('slowmode applies to everyone without BYPASS_SLOWMODE, including holders of MANAGE_MESSAGES', async () => {
    const { owner, guild, members: [mod, bypass, plain], general } = await guildWith('mod', 'bypass', 'plain');
    await give(owner, guild.id, mod!, (await role(owner, guild.id, Perm.MANAGE_MESSAGES, 'mm')).id);
    await give(owner, guild.id, bypass!, (await role(owner, guild.id, Perm.BYPASS_SLOWMODE, 'bp')).id);
    expect((await api.req('PATCH', `/channels/${general.id}`, owner.token, { slowmode: 60 })).status).toBe(200);
    const send = (u: Client) => api.req('POST', `/channels/${general.id}/messages`, u.token, { content: 'x' });
    expect((await send(plain!)).status).toBe(201);
    const slow = await send(plain!);
    expect(slow.status).toBe(429); expect(slow.body.code).toBe('SLOWMODE');
    expect((await send(mod!)).status).toBe(201);
    expect((await send(mod!)).status).toBe(429);
    expect((await send(bypass!)).status).toBe(201);
    expect((await send(bypass!)).status).toBe(201);
    expect((await send(owner)).status).toBe(201); expect((await send(owner)).status).toBe(201); // owner has every bit
  });

  it('stickers of another server need USE_EXTERNAL_STICKERS and membership of that server', async () => {
    const a = await guildWith('shared'), b = await guildWith();
    const sticker = (await api.req('POST', `/guilds/${a.guild.id}/stickers`, a.owner.token, { name: 'wave', url: STICKER_URL })).body;
    const shared = a.members[0]!;
    const code = (await api.req('POST', `/guilds/${b.guild.id}/invites`, b.owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, shared.token);
    const outsider = await api.register('out');
    await api.req('POST', `/invites/${code}`, outsider.token);
    const post = async (u: Client) => (await api.req('POST', `/channels/${b.general.id}/messages`, u.token, { content: 'hey', stickerIds: [sticker.id] })).body.stickerIds as string[];
    // @everyone has the bit by default: members of both servers may use it, people who are not in A may not
    expect(await post(shared)).toEqual([sticker.id]);
    expect(await post(outsider)).toEqual([]);
    // take the bit away from @everyone in B
    await api.req('PATCH', `/guilds/${b.guild.id}/roles/${b.guild.id}`, b.owner.token, { permissions: String(DEFAULT_EVERYONE & ~Perm.USE_EXTERNAL_STICKERS) });
    expect(await post(shared)).toEqual([]);
    // the channel's own stickers always work
    const own = (await api.req('POST', `/guilds/${b.guild.id}/stickers`, b.owner.token, { name: 'own', url: STICKER_URL })).body;
    expect((await api.req('POST', `/channels/${b.general.id}/messages`, shared.token, { content: 'own', stickerIds: [own.id] })).body.stickerIds).toEqual([own.id]);
  });

  it('migration 052 ORs the bits into roles and overwrites that held MANAGE_MESSAGES / MANAGE_CHANNELS and into @everyone', async () => {
    const { owner, guild, members: [m], general } = await guildWith('m');
    const mm = await role(owner, guild.id, Perm.MANAGE_MESSAGES | Perm.SEND_MESSAGES, 'old-mm');
    const mc = await role(owner, guild.id, Perm.MANAGE_CHANNELS, 'old-mc');
    const none = await role(owner, guild.id, Perm.SEND_MESSAGES, 'old-none');
    const ev = (BigInt(DEFAULT_EVERYONE) & ~Perm.USE_EXTERNAL_STICKERS).toString();
    await env.ctx.db.query('UPDATE roles SET permissions = $2 WHERE id = $1', [guild.id, ev]);
    await env.ctx.db.query('INSERT INTO overwrites (channel_id, target_id, type, allow, deny) VALUES ($1,$2,\'member\',$3,$4)', [general.id, m!.id, Perm.MANAGE_MESSAGES.toString(), '0']);
    const sql = readFileSync(join(__dirname, '..', 'migrations', '052_permission_bits.sql'), 'utf8');
    await env.ctx.db.exec(sql);
    const perm = async (id: string) => BigInt((await env.ctx.db.query('SELECT permissions FROM roles WHERE id = $1', [id]))[0].permissions);
    expect(await perm(mm.id)).toBe(Perm.MANAGE_MESSAGES | Perm.SEND_MESSAGES | Perm.PIN_MESSAGES | Perm.BYPASS_SLOWMODE);
    expect(await perm(mc.id)).toBe(Perm.MANAGE_CHANNELS | Perm.BYPASS_SLOWMODE);
    expect(await perm(none.id)).toBe(Perm.SEND_MESSAGES);
    expect((await perm(guild.id)) & Perm.USE_EXTERNAL_STICKERS).toBe(Perm.USE_EXTERNAL_STICKERS);
    const [ow] = await env.ctx.db.query('SELECT allow FROM overwrites WHERE channel_id = $1 AND target_id = $2', [general.id, m!.id]);
    expect(BigInt(ow.allow)).toBe(Perm.MANAGE_MESSAGES | Perm.PIN_MESSAGES | Perm.BYPASS_SLOWMODE);
    // idempotent
    await env.ctx.db.exec(sql);
    expect(await perm(mm.id)).toBe(Perm.MANAGE_MESSAGES | Perm.SEND_MESSAGES | Perm.PIN_MESSAGES | Perm.BYPASS_SLOWMODE);
  });
});

describe('gradient role colours', () => {
  it('stores a secondary colour only together with a primary one and broadcasts it', async () => {
    const { owner, guild, members: [m] } = await guildWith('m');
    const w = await WsClient.connect(env.port); await w.identify(owner.token);
    expect((await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'bad', colorSecondary: 0x00ff00 })).status).toBe(400);
    const r = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'grad', color: 0xff0000, colorSecondary: 0x0000ff })).body;
    expect(r).toMatchObject({ color: 0xff0000, colorSecondary: 0x0000ff });
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles/${r.id}`, owner.token, { colorSecondary: 0x1000000 })).status).toBe(400);
    const p = await api.req('PATCH', `/guilds/${guild.id}/roles/${r.id}`, owner.token, { colorSecondary: 0x00ff00 });
    expect(p.body.colorSecondary).toBe(0x00ff00);
    await w.waitEvent('ROLE_UPDATE', (d) => d.id === r.id && d.colorSecondary === 0x00ff00);
    // listing and permissions: members cannot edit
    expect((await api.req('GET', `/guilds/${guild.id}/roles`, m!.token)).body.find((x: any) => x.id === r.id).colorSecondary).toBe(0x00ff00);
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles/${r.id}`, m!.token, { colorSecondary: 1 })).status).toBe(403);
    // clearing the primary clears the secondary; explicit null clears just the secondary
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles/${r.id}`, owner.token, { colorSecondary: null })).body).toMatchObject({ color: 0xff0000, colorSecondary: null });
    await api.req('PATCH', `/guilds/${guild.id}/roles/${r.id}`, owner.token, { colorSecondary: 0x00ff00 });
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles/${r.id}`, owner.token, { color: 0 })).body).toMatchObject({ color: 0, colorSecondary: null });
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles/${r.id}`, owner.token, { colorSecondary: 5 })).status).toBe(400);
    // @everyone has no colour at all
    expect((await api.req('PATCH', `/guilds/${guild.id}/roles/${guild.id}`, owner.token, { colorSecondary: 5 })).status).toBe(400);
    w.close();
  });
});

describe('welcome screen', () => {
  it('community servers only; channels must be visible to @everyone; managers write, members read; leaving community switches it off', async () => {
    const { owner, guild, members: [m], general, rules } = await guildWith('m');
    const secret = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'staff', type: 'text', overwrites: [{ id: guild.id, type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }] })).body;
    const url = `/guilds/${guild.id}/welcome-screen`;
    const body = { enabled: true, description: 'Hello there', channels: [{ channelId: rules.id, description: 'Read the rules', emoji: '📜' }, { channelId: general.id, description: 'Chat with us' }] };
    // not a community yet
    expect((await api.req('PATCH', url, owner.token, body)).status).toBe(400);
    // community needs a rules channel
    expect((await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { community: true })).status).toBe(400);
    expect((await api.req('PATCH', `/guilds/${guild.id}`, m!.token, { community: true, rulesChannelId: rules.id })).status).toBe(403);
    const up = await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { community: true, rulesChannelId: rules.id });
    expect(up.body.features).toContain('COMMUNITY');
    const wm = await WsClient.connect(env.port); await wm.identify(m!.token);
    expect((await api.req('PATCH', url, m!.token, body)).status).toBe(403);
    expect((await api.req('PATCH', url, owner.token, { ...body, channels: [{ channelId: secret.id, description: 'secret' }] })).status).toBe(400);
    expect((await api.req('PATCH', url, owner.token, { ...body, channels: [{ channelId: snowflake(), description: 'nope' }] })).status).toBe(400);
    expect((await api.req('PATCH', url, owner.token, { ...body, channels: [{ channelId: rules.id, description: 'a' }, { channelId: rules.id, description: 'b' }] })).status).toBe(400);
    expect((await api.req('PATCH', url, owner.token, { ...body, channels: [] })).status).toBe(400); // enabled with nothing to show
    const ok = await api.req('PATCH', url, owner.token, body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, description: 'Hello there' });
    expect(ok.body.channels).toEqual([{ channelId: rules.id, description: 'Read the rules', emoji: '📜' }, { channelId: general.id, description: 'Chat with us', emoji: null }]);
    const ev = await wm.waitEvent('GUILD_UPDATE', (d) => d.id === guild.id && d.welcomeScreen?.enabled === true);
    expect(ev.d.welcomeScreen.channels).toHaveLength(2);
    expect((await api.req('GET', url, m!.token)).body.description).toBe('Hello there');
    expect((await api.req('GET', url, (await api.register('stranger')).token)).status).toBe(404);
    // a newcomer receives it with the guild on join
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const late = await api.register('late');
    const wl = await WsClient.connect(env.port); await wl.identify(late.token);
    await api.req('POST', `/invites/${code}`, late.token);
    expect((await wl.waitEvent('GUILD_CREATE', (d) => d.guild?.id === guild.id || d.id === guild.id)).d).toBeTruthy();
    expect((await api.req("GET", `/guilds/${guild.id}`, late.token)).body.welcomeScreen).toMatchObject({ enabled: true });
    // at most 5 channels
    const many = [] as any[]; for (let i = 0; i < 6; i++) many.push((await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: `c${i}`, type: 'text' })).body);
    expect((await api.req('PATCH', url, owner.token, { channels: many.map((c) => ({ channelId: c.id, description: 'x' })) })).status).toBe(400);
    // leaving community disables it but keeps the content
    const off = await api.req('PATCH', `/guilds/${guild.id}`, owner.token, { community: false });
    expect(off.body.features).not.toContain('COMMUNITY'); expect(off.body.welcomeScreen).toMatchObject({ enabled: false });
    expect((await api.req('GET', url, m!.token)).body).toMatchObject({ enabled: false, channels: [] });
    wm.close(); wl.close();
  });
});

describe('account deletion grace period', () => {
  it('schedules, signs everyone out, is cancelled by logging in, and is carried out by the sweeper', async () => {
    const u = await api.register('grace');
    const wait = await api.req('DELETE', '/users/@me', u.token, { password: 'wrong wrong wrong' });
    expect(wait.status).toBe(401);
    const r = await api.req('DELETE', '/users/@me', u.token, { password: PW });
    expect(r.status).toBe(202);
    expect(r.body.graceDays).toBe(14);
    expect(Date.parse(r.body.deletionDueAt) - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
    expect(Date.parse(r.body.deletionDueAt) - Date.now()).toBeLessThan(14.1 * 86_400_000);
    // nothing erased yet; every session is gone
    expect((await api.req('GET', '/users/@me', u.token)).status).toBe(401);
    const [row] = await env.ctx.db.query('SELECT email, deleted_at, deletion_due_at FROM users WHERE id = $1', [u.id]);
    expect(row.email).toBe(`${u.username}@example.com`); expect(row.deleted_at).toBeNull(); expect(row.deletion_due_at).not.toBeNull();
    expect(env.ctx.mailer.outbox.some((m) => m.to === row.email && /scheduled for deletion/.test(m.subject))).toBe(true);
    // the sweeper leaves it alone before the due date
    const { sweepAccountDeletions } = await import('../src/services/accountDeletion');
    await sweepAccountDeletions(env.ctx);
    expect((await env.ctx.db.query('SELECT deleted_at FROM users WHERE id = $1', [u.id]))[0].deleted_at).toBeNull();
    // logging in cancels it
    const login = await api.req('POST', '/auth/login', null, { email: row.email, password: PW });
    expect(login.status).toBe(200); expect(login.body.deletionCancelled).toBe(true);
    expect((await env.ctx.db.query('SELECT deletion_due_at FROM users WHERE id = $1', [u.id]))[0].deletion_due_at).toBeNull();
    expect((await api.req('POST', '/auth/login', null, { email: row.email, password: PW })).body.deletionCancelled).toBeUndefined();
    const t2 = login.body.accessToken as string;
    expect((await api.req('GET', '/users/@me', t2)).status).toBe(200);
  });

  it('erases at the due date: account anonymised, login impossible', async () => {
    const u = await api.register('gone');
    expect((await api.req('DELETE', '/users/@me', u.token, { password: PW })).status).toBe(202);
    await eraseNow(env, u.id);
    const [row] = await env.ctx.db.query('SELECT email, display_name, deleted_at, deletion_due_at FROM users WHERE id = $1', [u.id]);
    expect(row).toMatchObject({ email: null, display_name: 'Deleted User', deletion_due_at: null }); expect(row.deleted_at).not.toBeNull();
    expect((await api.req('POST', '/auth/login', null, { email: `${u.username}@example.com`, password: PW })).status).toBe(401);
  });

  it('owners must hand over or delete their servers; the sweeper hands leftovers to the most senior member or deletes empty ones', async () => {
    const { owner, guild, members: [admin, plain] } = await guildWith('admin', 'plain');
    const blocked = await api.req('DELETE', '/users/@me', owner.token, { password: PW });
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('OWNS_GUILDS');
    // explicit transfer: owner only, re-authenticated, to a member
    const url = `/guilds/${guild.id}/transfer-ownership`;
    expect((await api.req('POST', url, plain!.token, { userId: plain!.id, password: PW })).status).toBe(403);
    expect((await api.req('POST', url, owner.token, { userId: plain!.id, password: 'wrong wrong wrong' })).status).toBe(401);
    expect((await api.req('POST', url, owner.token, { userId: (await api.register("nm")).id, password: PW })).status).toBe(400);
    expect((await api.req('POST', url, owner.token, { userId: owner.id, password: PW })).status).toBe(400);
    const bot = (await env.ctx.db.query(`INSERT INTO users (id, username, display_name, bot) VALUES ($1,$2,'b',true) RETURNING id`, [snowflake(), 'tbot' + Date.now()]))[0];
    await env.ctx.db.query('INSERT INTO members (guild_id, user_id) VALUES ($1,$2)', [guild.id, bot.id]);
    expect((await api.req('POST', url, owner.token, { userId: bot.id, password: PW })).status).toBe(400);
    // pretend `owner` created the server during the grace period: it is still theirs when the sweep runs; the admin role outranks the plain member
    const adminRole = await role(owner, guild.id, Perm.ADMINISTRATOR, 'adm'); await give(owner, guild.id, admin!, adminRole.id);
    await env.ctx.db.query('UPDATE users SET deletion_due_at = now() - interval \'1 minute\' WHERE id = $1', [owner.id]);
    const { sweepAccountDeletions } = await import('../src/services/accountDeletion');
    await sweepAccountDeletions(env.ctx);
    expect((await env.ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guild.id]))[0].owner_id).toBe(admin!.id);
    expect((await env.ctx.db.query('SELECT deleted_at FROM users WHERE id = $1', [owner.id]))[0].deleted_at).not.toBeNull();
    // the new owner can now transfer on to someone else with the explicit endpoint
    expect((await api.req('POST', url, admin!.token, { userId: plain!.id, password: PW })).status).toBe(204);
    expect((await env.ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guild.id]))[0].owner_id).toBe(plain!.id);
    // a server nobody else is in disappears with its owner
    const solo = await api.register('solo');
    const lone = (await api.req('POST', '/guilds', solo.token, { name: 'Lonely' })).body;
    await env.ctx.db.query('UPDATE users SET deletion_due_at = now() - interval \'1 minute\' WHERE id = $1', [solo.id]);
    await sweepAccountDeletions(env.ctx);
    expect((await env.ctx.db.query('SELECT 1 FROM guilds WHERE id = $1', [lone.id])).length).toBe(0);
  });
});
