import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';
import { roll } from '../src/services/sysbots/utility';
import { runSweeps } from '../src/services/sweeper';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(30); }
};
const ALL_BOT_PERMS = (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY | Perm.EMBED_LINKS | Perm.MODERATE_MEMBERS | Perm.MANAGE_MESSAGES | Perm.MANAGE_CHANNELS | Perm.SEND_POLLS);

interface World { owner: Client; guild: any; general: any; apps: Record<string, any>; cmds: Record<string, any>; members: Client[]; code: string }

async function directoryApps(token: string) {
  const r = await api.req('GET', '/directory/apps', token);
  expect(r.status).toBe(200);
  return r.body.items as any[];
}
async function installOfficial(owner: Client, guildId: string, key: string, perms = ALL_BOT_PERMS) {
  const app = (await directoryApps(owner.token)).find((a) => a.name.toLowerCase() === key);
  expect(app, `${key} is listed in the directory`).toBeTruthy();
  const r = await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: perms.toString(), guildId });
  expect(r.status).toBe(200);
  return app;
}
async function world(names: string[] = []): Promise<World> {
  const owner = await api.register('sbo');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Sys' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const members: Client[] = [];
  for (const n of names) { const u = await api.register(n); await api.req('POST', `/invites/${code}`, u.token); members.push(u); }
  const general = guild.channels.find((c: any) => c.name === 'general');
  const apps: Record<string, any> = {};
  for (const k of ['welcome', 'moderation', 'utility']) apps[k] = await installOfficial(owner, guild.id, k);
  const cat = (await api.req('GET', `/guilds/${guild.id}/application-commands`, owner.token)).body;
  const cmds: Record<string, any> = {}; for (const c of cat.commands) cmds[c.name] = c;
  return { owner, guild, general, apps, cmds, members, code };
}
async function role(w: World, name: string, perms: bigint, position?: number) {
  const r = (await api.req('POST', `/guilds/${w.guild.id}/roles`, w.owner.token, { name, permissions: perms.toString() })).body;
  if (position) await api.req('PATCH', `/guilds/${w.guild.id}/roles`, w.owner.token, [{ id: r.id, position }]);
  return r;
}
const give = (w: World, u: Client, ...roles: any[]) => api.req('PATCH', `/guilds/${w.guild.id}/members/${u.id}`, w.owner.token, { roles: roles.map((r) => r.id) });

const sockets = new Map<string, WsClient>();
async function listen(u: Client) {
  let ws = sockets.get(u.id);
  if (!ws) { ws = await WsClient.connect(env.port); await ws.identify(u.token); sockets.set(u.id, ws); }
  return ws;
}
const opts = (o: Record<string, unknown>) => Object.entries(o).map(([name, value]) => ({ name, type: typeof value === 'number' ? 4 : typeof value === 'boolean' ? 5 : 3, value }));
/** Invokes a slash command and resolves with the bot's reply text (ephemeral or public), or the HTTP status when the request was refused. */
async function run(w: World, u: Client, name: string, options: any[] = [], channelId = w.general.id): Promise<{ status: number; text: string; msg?: any }> {
  const ws = await listen(u);
  const r = await api.req('POST', '/interactions', u.token, { type: 2, channelId, data: { id: w.cmds[name].id, options } });
  if (r.status !== 202) return { status: r.status, text: '' };
  const f = await ws.waitFor((x) => x.t === 'MESSAGE_CREATE' && x.d.interaction?.id === r.body.id && x.d.content !== '', 6000);
  return { status: 202, text: f.d.content, msg: f.d };
}
const subcmd = (sub: string, o: Record<string, unknown> = {}, kinds: Record<string, number> = {}) =>
  [{ name: sub, type: 1, options: Object.entries(o).map(([name, value]) => ({ name, type: kinds[name] ?? (typeof value === 'number' ? 4 : typeof value === 'boolean' ? 5 : 3), value })) }];
const history = async (w: World, token = w.owner.token, channelId = w.general.id) => (await api.req('GET', `/channels/${channelId}/messages?limit=100`, token)).body as any[];

describe('official bots: directory and installation', () => {
  it('lists Welcome, Moderation and Utility first, flagged official, with no usable token', async () => {
    const u = await api.register('dir');
    const apps = await directoryApps(u.token);
    const official = apps.filter((a) => a.official);
    expect(official.map((a) => a.name).sort()).toEqual(['Moderation', 'Utility', 'Welcome']);
    expect(apps.slice(0, 3).every((a) => a.official)).toBe(true);
    for (const a of official) {
      expect(a.summary.length).toBeGreaterThan(10);
      // nobody can authenticate as an official bot: not with an empty, guessed or forged token
      const forged = `${Buffer.from(a.botUserId).toString('base64url')}.${'0'.repeat(43)}`;
      expect((await api.req('GET', '/users/@me', null, undefined, { authorization: `Bot ${forged}` })).status).toBe(401);
    }
    // the directory is idempotent across boots: a second ensure does not duplicate anything
    const { ensureSystemApps } = await import('../src/services/sysbots');
    await ensureSystemApps(env.ctx);
    expect((await directoryApps(u.token)).filter((a) => a.official)).toHaveLength(3);
  });

  it('"Add to server" = the normal consent flow: only MANAGE_GUILD servers, bot joins with a managed role, commands appear only where installed', async () => {
    const owner = await api.register('inst');
    const mine = (await api.req('POST', '/guilds', owner.token, { name: 'Mine' })).body;
    const other = await api.register('inst2');
    const theirs = (await api.req('POST', '/guilds', other.token, { name: 'Theirs' })).body;
    const app = (await directoryApps(owner.token)).find((a) => a.name === 'Utility');
    const q = `/oauth2/authorize?clientId=${app.id}&scope=bot%20applications.commands&permissions=${app.permissions}`;
    expect((await api.req('GET', q, owner.token)).body.guilds.map((g: any) => g.id)).toEqual([mine.id]);
    expect((await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: app.permissions, guildId: theirs.id })).status).toBe(404);
    expect((await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: app.permissions, guildId: mine.id })).status).toBe(200);
    const members = (await api.req('GET', `/guilds/${mine.id}/members`, owner.token)).body;
    const bot = members.find((m: any) => m.user.id === app.botUserId);
    expect(bot?.user.bot).toBe(true);
    expect(bot.roles).toHaveLength(1);
    const cat = await api.req('GET', `/guilds/${mine.id}/application-commands`, owner.token);
    expect(cat.body.commands.map((c: any) => c.name).sort()).toEqual(['8ball', 'poll', 'remind', 'roll']);
    const none = await api.req('GET', `/guilds/${theirs.id}/application-commands`, other.token);
    expect(none.body.commands).toEqual([]);
  });

  it('are removable by kicking: member, managed role, install and per-server settings go away; commands stop working', async () => {
    const w = await world(['k1']);
    await run(w, w.owner, 'welcome', subcmd('message', { text: 'hi {user}' }));
    expect((await env.ctx.db.query('SELECT 1 FROM system_bot_settings WHERE guild_id = $1', [w.guild.id])).length).toBe(1);
    const botId = w.apps.welcome.botUserId;
    expect((await api.req('DELETE', `/guilds/${w.guild.id}/members/${botId}`, w.owner.token)).status).toBe(204);
    expect((await api.req('GET', `/guilds/${w.guild.id}/roles`, w.owner.token)).body.find((r: any) => r.name === 'Welcome')).toBeUndefined();
    expect((await env.ctx.db.query('SELECT 1 FROM application_installs WHERE guild_id = $1 AND application_id = $2', [w.guild.id, w.apps.welcome.id])).length).toBe(0);
    expect((await env.ctx.db.query('SELECT 1 FROM system_bot_settings WHERE guild_id = $1', [w.guild.id])).length).toBe(0);
    expect((await run(w, w.owner, 'welcome', subcmd('show'))).status).toBe(403);
    // the other bots are unaffected
    expect((await run(w, w.owner, 'roll', opts({ dice: '2d6' }))).status).toBe(202);
  });
});

describe('Welcome bot', () => {
  it('greets new members with the configured message and gives the auto-role; permission checks on every subcommand', async () => {
    const w = await world(['wmgr', 'wplain']);
    const [mgr, plain] = w.members;
    const managers = await role(w, 'Managers', Perm.MANAGE_GUILD | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.USE_SLASH_COMMANDS);
    await give(w, mgr!, managers);
    // a plain member neither sees nor can run /welcome
    expect((await api.req('GET', `/guilds/${w.guild.id}/application-commands`, plain!.token)).body.commands.map((c: any) => c.name)).not.toContain('welcome');
    expect((await run(w, plain!, 'welcome', subcmd('show'))).status).toBe(403);
    expect((await run(w, plain!, 'welcome', subcmd('message', { text: 'pwned' }))).status).toBe(403);

    const starter = await role(w, 'Newcomer', Perm.VIEW_CHANNEL);
    const risky = await role(w, 'Risky', Perm.KICK_MEMBERS);
    const high = await role(w, 'AboveMgr', 0n, 50);
    // MANAGE_GUILD alone cannot choose a role (no Manage Roles) ...
    expect((await run(w, mgr!, 'welcome', subcmd('role', { role: starter.id }, { role: 8 }))).text).toMatch(/Manage Roles/);
    // ... the owner can, but never a role with moderation permissions, @everyone or an integration role
    expect((await run(w, w.owner, 'welcome', subcmd('role', { role: risky.id }, { role: 8 }))).text).toMatch(/moderation or administration/);
    expect((await run(w, w.owner, 'welcome', subcmd('role', { role: w.guild.id }, { role: 8 }))).text).toMatch(/regular role/);
    const managedRole = (await api.req('GET', `/guilds/${w.guild.id}/roles`, w.owner.token)).body.find((r: any) => r.name === 'Utility');
    expect((await run(w, w.owner, 'welcome', subcmd('role', { role: managedRole.id }, { role: 8 }))).text).toMatch(/cannot be used/);
    // a manager with Manage Roles must outrank the role
    const roleMgr = await role(w, 'RoleMgr', Perm.MANAGE_GUILD | Perm.MANAGE_ROLES | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.USE_SLASH_COMMANDS, 10);
    await give(w, mgr!, roleMgr);
    expect((await run(w, mgr!, 'welcome', subcmd('role', { role: high.id }, { role: 8 }))).text).toMatch(/hierarchy/i);
    expect((await run(w, mgr!, 'welcome', subcmd('role', { role: starter.id }, { role: 8 }))).text).toContain(`<@&${starter.id}>`);

    expect((await run(w, mgr!, 'welcome', subcmd('message', { text: 'Hello {user} to {server}! #{count}' }))).text).toMatch(/updated/);
    const channelOk = await run(w, mgr!, 'welcome', subcmd('channel', { channel: w.general.id }, { channel: 7 }));
    expect(channelOk.text).toContain(`<#${w.general.id}>`);
    const shown = (await run(w, mgr!, 'welcome', subcmd('show'))).text;
    expect(shown).toContain('Hello {user}'); expect(shown).toContain(`<@&${starter.id}>`);
    expect((await run(w, mgr!, 'welcome', subcmd('test'))).text).toMatch(/Hello <@\d+> to Sys! #\d+/);

    // a new member joins: message in the channel + role
    const joiner = await api.register('joiner');
    await api.req('POST', `/invites/${w.code}`, joiner.token);
    const hello = await until(async () => (await history(w)).find((m) => m.content.startsWith(`Hello <@${joiner.id}> to Sys!`) && m.author.id === w.apps.welcome.botUserId));
    expect(hello.mentions.map((u: any) => u.id ?? u)).toContain(joiner.id);
    const m = (await api.req('GET', `/guilds/${w.guild.id}/members/${joiner.id}`, w.owner.token)).body;
    expect(m.roles).toContain(starter.id);

    // the role is re-checked at join time: upgraded since -> not handed out
    await api.req('PATCH', `/guilds/${w.guild.id}/roles/${starter.id}`, w.owner.token, { permissions: String(Perm.BAN_MEMBERS) });
    const joiner2 = await api.register('joiner2'); await api.req('POST', `/invites/${w.code}`, joiner2.token);
    await until(async () => (await history(w)).find((m) => m.content.includes(`<@${joiner2.id}>`) && m.author.id === w.apps.welcome.botUserId));
    expect((await api.req('GET', `/guilds/${w.guild.id}/members/${joiner2.id}`, w.owner.token)).body.roles).not.toContain(starter.id);

    // toggled off: no greeting
    expect((await run(w, mgr!, 'welcome', subcmd('toggle', { enabled: false }))).text).toMatch(/off/);
    const joiner3 = await api.register('joiner3'); await api.req('POST', `/invites/${w.code}`, joiner3.token);
    await sleep(400);
    expect((await history(w)).some((m) => m.content.includes(`<@${joiner3.id}>`) && m.author.id === w.apps.welcome.botUserId)).toBe(false);
    // role removal clears the auto-role
    await run(w, mgr!, 'welcome', subcmd('toggle', { enabled: true }));
    expect((await run(w, mgr!, 'welcome', subcmd('role', {}))).text).toMatch(/turned off/);
  });
});

describe('Moderation bot', () => {
  it('/warn: needs Moderate Members, respects hierarchy, records the warning and notifies the member', async () => {
    const w = await world(['mod', 'plain', 'victim', 'boss']);
    const [mod, plain, victim, boss] = w.members as [Client, Client, Client, Client];
    const modRole = await role(w, 'Mod', Perm.MODERATE_MEMBERS | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.USE_SLASH_COMMANDS, 5);
    const bossRole = await role(w, 'Boss', Perm.VIEW_CHANNEL, 20);
    await give(w, mod, modRole); await give(w, boss, bossRole);
    const target = (u: Client) => opts({ member: u.id, reason: 'spamming' }).map((o) => ({ ...o, type: o.name === 'member' ? 6 : 3 }));

    expect((await run(w, plain, 'warn', target(victim))).status).toBe(403); // no permission: refused at the door
    const ws = await listen(victim);
    const ok = await run(w, mod, 'warn', target(victim));
    expect(ok.text).toBe(`<@${victim.id}> was warned: spamming`);
    const note = await ws.waitEvent('MOD_WARNING', (d) => d.reason === 'spamming');
    expect(note.d.guildId).toBe(w.guild.id);
    const warns = (await api.req('GET', `/guilds/${w.guild.id}/members/${victim.id}/warnings`, w.owner.token)).body;
    expect(warns).toHaveLength(1); expect(warns[0].moderatorId).toBe(mod.id);
    // hierarchy and sanity
    expect((await run(w, mod, 'warn', target(boss))).text).toMatch(/hierarchy/i);
    expect((await run(w, mod, 'warn', target(mod))).text).toMatch(/yourself/);
    expect((await run(w, mod, 'warn', target({ id: w.owner.id } as Client))).text).toMatch(/owner/i);
    expect((await run(w, mod, 'warn', [{ name: 'member', type: 6, value: w.apps.utility.botUserId }, { name: 'reason', type: 3, value: 'x' }])).text).toMatch(/Bots cannot/);
    expect((await api.req('GET', `/guilds/${w.guild.id}/members/${boss.id}/warnings`, w.owner.token)).body).toHaveLength(0);
  });

  it('/timeout: permission, hierarchy, admin protection, duration limits, lifting, and the bot role must still hold the permission', async () => {
    const w = await world(['tmod', 'tplain', 'tvictim', 'tadmin', 'tboss']);
    const [mod, plain, victim, admin, boss] = w.members as [Client, Client, Client, Client, Client];
    const modRole = await role(w, 'Mod', Perm.MODERATE_MEMBERS | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.USE_SLASH_COMMANDS, 5);
    const adminRole = await role(w, 'Admin', Perm.ADMINISTRATOR, 3);
    const bossRole = await role(w, 'Boss', Perm.VIEW_CHANNEL, 20);
    await give(w, mod, modRole); await give(w, admin, adminRole); await give(w, boss, bossRole);
    const args = (u: Client, duration: string, reason?: string) => [{ name: 'member', type: 6, value: u.id }, { name: 'duration', type: 3, value: duration }, ...(reason ? [{ name: 'reason', type: 3, value: reason }] : [])];

    expect((await run(w, plain, 'timeout', args(victim, '10m'))).status).toBe(403);
    expect((await run(w, mod, 'timeout', args(boss, '10m'))).text).toMatch(/hierarchy/i);
    expect((await run(w, mod, 'timeout', args(admin, '10m'))).text).toMatch(/hierarchy|administrator/i);
    expect((await run(w, mod, 'timeout', args(victim, '30d'))).text).toMatch(/28 days/);
    expect((await run(w, mod, 'timeout', args(victim, 'soon'))).text).toMatch(/Duration must look like/);
    const r = await run(w, mod, 'timeout', args(victim, '10m', 'cool off'));
    expect(r.text).toBe(`<@${victim.id}> was timed out for 10m: cool off.`);
    const until10 = new Date((await api.req('GET', `/guilds/${w.guild.id}/members/${victim.id}`, w.owner.token)).body.timeoutUntil).getTime();
    expect(until10 - Date.now()).toBeGreaterThan(9 * 60_000); expect(until10 - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect((await api.req('POST', `/channels/${w.general.id}/messages`, victim.token, { content: 'muted?' })).status).toBe(403); // really timed out
    const audit = (await api.req('GET', `/guilds/${w.guild.id}/audit-logs`, w.owner.token)).body;
    expect(JSON.stringify(audit)).toContain('MEMBER_TIMEOUT');
    expect((await run(w, mod, 'timeout', args(victim, 'off'))).text).toMatch(/no longer timed out/);
    expect((await api.req('GET', `/guilds/${w.guild.id}/members/${victim.id}`, w.owner.token)).body.timeoutUntil).toBeNull();

    // server managers can take the capability away from the bot in Bots & Apps
    expect((await api.req('PATCH', `/guilds/${w.guild.id}/integrations/${w.apps.moderation.id}`, w.owner.token, { permissions: String(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES) })).status).toBe(200);
    expect((await run(w, mod, 'timeout', args(victim, '10m'))).text).toMatch(/missing the Timeout Members permission/);
  });

  it('/purge: needs Manage Messages, deletes the requested messages only, keeps pinned, honours the member filter, bot permission required', async () => {
    const w = await world(['pmod', 'pplain', 'pa', 'pb']);
    const [mod, plain, a, b] = w.members as [Client, Client, Client, Client];
    const modRole = await role(w, 'Janitor', Perm.MANAGE_MESSAGES | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.USE_SLASH_COMMANDS);
    await give(w, mod, modRole);
    const send = (u: Client, content: string) => api.req('POST', `/channels/${w.general.id}/messages`, u.token, { content });
    const keep = (await send(a, 'pin me')).body;
    await api.req('PUT', `/channels/${w.general.id}/pins/${keep.id}`, w.owner.token);
    for (let i = 0; i < 4; i++) await send(a, `a${i}`);
    for (let i = 0; i < 3; i++) await send(b, `b${i}`);
    const q = (count: number, member?: Client) => [{ name: 'count', type: 4, value: count }, ...(member ? [{ name: 'member', type: 6, value: member.id }] : [])];

    expect((await run(w, plain, 'purge', q(5))).status).toBe(403);
    expect((await run(w, mod, 'purge', q(0))).status).toBe(400); // below the minimum, refused by option validation
    expect((await run(w, mod, 'purge', q(101))).status).toBe(400);
    const mineB = (await history(w)).filter((m) => m.author.id === b.id).length; // b's three messages + the "joined" system message
    expect(mineB).toBeGreaterThanOrEqual(3);
    expect((await run(w, mod, 'purge', q(100, b))).text).toBe(`Deleted ${mineB} messages.`);
    expect((await history(w)).filter((m) => m.author.id === b.id)).toEqual([]);
    expect((await history(w)).filter((m) => /^a\d$/.test(m.content))).toHaveLength(4);
    expect((await run(w, mod, 'purge', q(2))).text).toBe('Deleted 2 messages.'); // the two newest
    expect((await history(w)).map((m) => m.content)).toContain('pin me');
    expect((await history(w)).filter((m) => /^a\d$/.test(m.content)).length).toBeLessThanOrEqual(2);
    const remaining = (await history(w)).filter((m) => !m.pinned).length;
    expect((await run(w, mod, 'purge', q(100))).text).toBe(`Deleted ${remaining} messages.`);
    expect((await run(w, mod, 'purge', q(50))).text).toMatch(/nothing to delete/);
    expect((await history(w)).map((m) => m.content)).toContain('pin me');
    await api.req('PATCH', `/guilds/${w.guild.id}/integrations/${w.apps.moderation.id}`, w.owner.token, { permissions: String(Perm.VIEW_CHANNEL) });
    expect((await run(w, mod, 'purge', q(5))).text).toMatch(/missing the Manage Messages permission/);
  });

  it('/slowmode: needs Manage Channels in the target channel (overwrites count), updates the channel and audit log', async () => {
    const w = await world(['smod', 'splain']);
    const [mod, plain] = w.members as [Client, Client];
    const modRole = await role(w, 'ChanMgr', Perm.MANAGE_CHANNELS | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.USE_SLASH_COMMANDS);
    await give(w, mod, modRole);
    const extra = (await api.req('POST', `/guilds/${w.guild.id}/channels`, w.owner.token, { name: 'private-room', type: 'text', overwrites: [{ id: w.guild.id, type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }] })).body;
    const a = (s: number, ch?: string) => [{ name: 'seconds', type: 4, value: s }, ...(ch ? [{ name: 'channel', type: 7, value: ch }] : [])];
    expect((await run(w, plain, 'slowmode', a(5))).status).toBe(403);
    const ok = await run(w, mod, 'slowmode', a(30));
    expect(ok.text).toBe(`Slowmode in <#${w.general.id}> is now 30s.`);
    expect((await api.req('GET', `/channels/${w.general.id}`, w.owner.token)).body.slowmode).toBe(30);
    expect((await run(w, mod, 'slowmode', a(21601))).status).toBe(400);
    // a channel the moderator cannot even see is not theirs to change
    expect((await run(w, mod, 'slowmode', a(9, extra.id))).text).toMatch(/not found|Choose a channel/i);
    expect((await api.req('GET', `/channels/${extra.id}`, w.owner.token)).body.slowmode).toBe(0);
    expect((await run(w, mod, 'slowmode', a(0))).text).toBe(`Slowmode in <#${w.general.id}> is off.`);
    expect(JSON.stringify((await api.req('GET', `/guilds/${w.guild.id}/audit-logs`, w.owner.token)).body)).toContain('CHANNEL_UPDATE');
  });

  it('rate-limits each command per user and server', async () => {
    const w = await world(['rl1', 'rl2']);
    const [a, b] = w.members as [Client, Client];
    const modRole = await role(w, 'Janitor', Perm.MANAGE_MESSAGES | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.USE_SLASH_COMMANDS);
    await give(w, a, modRole); await give(w, b, modRole);
    const q = [{ name: 'count', type: 4, value: 1 }];
    for (let i = 0; i < 5; i++) expect((await run(w, a, 'purge', q)).text).not.toMatch(/too quickly/);
    expect((await run(w, a, 'purge', q)).text).toMatch(/using \/purge too quickly/);
    expect((await run(w, b, 'purge', q)).text).not.toMatch(/too quickly/); // another user is not affected
  });
});

describe('Utility bot', () => {
  it('/roll and /8ball: bounded, validated, public replies; the dice parser', async () => {
    const w = await world(['u1']);
    const [u] = w.members as [Client];
    const r = await run(w, u, 'roll', opts({ dice: '3d6+2' }));
    expect(r.text).toMatch(new RegExp(`^<@${u.id}> rolled 3d6\\+2: \\[\\d, \\d, \\d\\] \\+ 2 = \\*\\*\\d+\\*\\*$`));
    expect(r.msg.flags & 64).toBe(0); // public
    expect((await run(w, u, 'roll', [])).text).toMatch(/rolled d20/);
    expect((await run(w, u, 'roll', opts({ dice: '99d6' }))).text).toMatch(/between 1 and 20 dice/);
    expect((await run(w, u, 'roll', opts({ dice: '2d1' }))).text).toMatch(/2 and 1000 sides/);
    expect((await run(w, u, 'roll', opts({ dice: 'rm -rf' }))).text).toMatch(/dice notation/);
    for (let i = 0; i < 200; i++) { const x = roll('2d6-1'); expect(x.total).toBeGreaterThanOrEqual(1); expect(x.total).toBeLessThanOrEqual(11); }
    const e = await run(w, u, '8ball', opts({ question: 'Will it work?' }));
    expect(e.text).toMatch(/^<@\d+> asked: Will it work\?\n8-ball says: .+/);
  });

  it('/poll: creates a real poll message authored by the bot; answers validated; SEND_POLLS required; the bot must be allowed to talk', async () => {
    const w = await world(['po', 'pnone']);
    const [u, nopoll] = w.members as [Client, Client];
    const deny = await role(w, 'NoPolls', 0n);
    await api.req('PUT', `/channels/${w.general.id}/permissions/${deny.id}`, w.owner.token, { type: 'role', allow: '0', deny: String(Perm.SEND_POLLS) });
    await give(w, nopoll, deny);
    const q = [{ name: 'question', type: 3, value: 'Pizza?' }, { name: 'answer1', type: 3, value: 'Yes' }, { name: 'answer2', type: 3, value: 'Also yes' }, { name: 'hours', type: 4, value: 2 }];
    expect((await run(w, nopoll, 'poll', q)).status).toBe(403);
    expect((await run(w, u, 'poll', q.slice(0, 2))).status).toBe(400); // answer2 is required
    expect((await run(w, u, 'poll', q)).text).toBe('Poll created.');
    const msg = await until(async () => (await history(w)).find((m) => m.poll));
    expect(msg.author.id).toBe(w.apps.utility.botUserId);
    expect(msg.poll.question).toBe('Pizza?'); expect(msg.poll.answers.map((a: any) => a.text)).toEqual(['Yes', 'Also yes']);
    expect((await api.req('PUT', `/channels/${w.general.id}/polls/${msg.id}/votes`, u.token, { answerIds: [1] })).status).toBeLessThan(300);
    // @everyone grants Send Messages, so the server takes it away from the bot's own role with a channel overwrite
    const botRole = (await api.req('GET', `/guilds/${w.guild.id}/integrations`, w.owner.token)).body.find((i: any) => i.name === 'Utility').roleId;
    await api.req('PUT', `/channels/${w.general.id}/permissions/${botRole}`, w.owner.token, { type: 'role', allow: '0', deny: String(Perm.SEND_MESSAGES) });
    expect((await run(w, u, 'poll', q)).text).toMatch(/missing the Send Messages permission/);
  });

  it('/remind: persisted, listed, cancelled, limited; delivered by DM or in the channel; falls back to DM when the channel is no longer usable', async () => {
    const w = await world(['re1', 're2']);
    const [u, v] = w.members as [Client, Client];
    const add = (when: string, message: string, where?: string) => subcmd('remind', {}).slice(0, 0).concat([{ name: 'add', type: 1, options: [{ name: 'in', type: 3, value: when }, { name: 'message', type: 3, value: message }, ...(where ? [{ name: 'where', type: 3, value: where }] : [])] } as any]);
    expect((await run(w, u, 'remind', add('soon', 'x'))).text).toMatch(/Time must look like/);
    expect((await run(w, u, 'remind', add('5s', 'x'))).text).toMatch(/at least 10 seconds/);
    expect((await run(w, u, 'remind', add('400d', 'x'))).text).toMatch(/at most 365 days/);
    expect((await run(w, u, 'remind', add('10m', 'stretch your legs'))).text).toMatch(/by direct message/);
    expect((await run(w, u, 'remind', add('1h', 'check the oven', 'channel'))).text).toMatch(/in this channel/);
    expect((await run(w, v, 'remind', add('1h', 'not yours'))).text).toMatch(/direct message/);
    const list = (await run(w, u, 'remind', subcmd('list'))).text;
    expect(list).toMatch(/1\. .*\(DM\): stretch your legs/); expect(list).toMatch(/2\. .*\(channel\): check the oven/); expect(list).not.toContain('not yours');
    // persisted
    expect((await env.ctx.db.query('SELECT 1 FROM bot_reminders WHERE user_id = $1 AND fired_at IS NULL', [u.id])).length).toBe(2);
    // cancel only your own, by number
    expect((await run(w, u, 'remind', subcmd('cancel', { number: 9 }))).text).toMatch(/No pending reminder/);
    expect((await run(w, u, 'remind', [{ name: 'cancel', type: 1, options: [{ name: 'number', type: 4, value: 1 }] }])).text).toBe('Reminder cancelled.');
    expect((await run(w, u, 'remind', subcmd('list'))).text).not.toContain('stretch');
    expect((await run(w, v, 'remind', subcmd('list'))).text).toContain('not yours');

    // delivery: nothing happens before the time
    await runSweeps(env.ctx);
    expect((await env.ctx.db.query('SELECT 1 FROM bot_reminders WHERE fired_at IS NOT NULL')).length).toBe(0);
    await env.ctx.db.query(`UPDATE bot_reminders SET remind_at = now() - interval '1 second' WHERE user_id = ANY($1::text[])`, [[u.id, v.id]]);
    const dmWs = await listen(v);
    await runSweeps(env.ctx);
    const inChannel = await until(async () => (await history(w)).find((m) => m.content === `Reminder: check the oven` || m.content === `<@${u.id}> Reminder: check the oven`));
    expect(inChannel.author.id).toBe(w.apps.utility.botUserId); expect(inChannel.content).toContain(`<@${u.id}>`);
    const dm = await dmWs.waitEvent('MESSAGE_CREATE', (m) => m.content === 'Reminder: not yours');
    expect(dm.d.author.id).toBe(w.apps.utility.botUserId); expect(dm.d.guildId ?? null).toBeNull();
    // fired exactly once
    await runSweeps(env.ctx);
    expect((await history(w)).filter((m) => m.content.includes('check the oven'))).toHaveLength(1);

    // channel delivery falls back to a DM when the user may no longer post there
    await run(w, u, 'remind', add('1h', 'fallback please', 'channel'));
    await api.req('PUT', `/channels/${w.general.id}/permissions/${w.guild.id}`, w.owner.token, { type: 'role', allow: '0', deny: String(Perm.SEND_MESSAGES) });
    await env.ctx.db.query(`UPDATE bot_reminders SET remind_at = now() - interval '1 second' WHERE user_id = $1 AND fired_at IS NULL`, [u.id]);
    const uWs = await listen(u);
    await runSweeps(env.ctx);
    const fb = await uWs.waitEvent('MESSAGE_CREATE', (m) => m.content === 'Reminder: fallback please');
    expect(fb.d.guildId ?? null).toBeNull();

    // pending limit
    for (let i = 0; i < 25; i++) await env.ctx.db.query(`INSERT INTO bot_reminders (id, user_id, guild_id, channel_id, content, remind_at) VALUES ($1,$2,$3,$4,'x', now() + interval '1 day')`, [`9${Date.now()}${i}`, v.id, w.guild.id, w.general.id]);
    expect((await run(w, v, 'remind', add('1h', 'one too many'))).text).toMatch(/at most 25/);
  });
});

describe('Bots & Apps API (Manage Server)', () => {
  it('lists installs, edits the managed role permissions without escalation, removes apps; only for Manage Server', async () => {
    const w = await world(['bm', 'bp']);
    const [mgr, plain] = w.members as [Client, Client];
    const gm = await role(w, 'GM', Perm.MANAGE_GUILD | Perm.SEND_MESSAGES | Perm.VIEW_CHANNEL);
    await give(w, mgr, gm);
    expect((await api.req('GET', `/guilds/${w.guild.id}/integrations`, plain.token)).status).toBe(403);
    expect((await api.req('GET', `/guilds/${w.guild.id}/integrations`, null)).status).toBe(401);
    const list = (await api.req('GET', `/guilds/${w.guild.id}/integrations`, mgr.token)).body;
    expect(list.map((i: any) => i.name).sort()).toEqual(['Moderation', 'Utility', 'Welcome']);
    const mod = list.find((i: any) => i.name === 'Moderation');
    expect(mod.official).toBe(true); expect(BigInt(mod.permissions) & Perm.MODERATE_MEMBERS).toBe(Perm.MODERATE_MEMBERS); expect(mod.roleId).toBeTruthy();
    // a manager may only grant what they hold
    const esc = await api.req('PATCH', `/guilds/${w.guild.id}/integrations/${mod.applicationId}`, mgr.token, { permissions: String(Perm.ADMINISTRATOR) });
    expect(esc.status).toBe(403);
    const ok = await api.req('PATCH', `/guilds/${w.guild.id}/integrations/${mod.applicationId}`, mgr.token, { permissions: String(Perm.SEND_MESSAGES) });
    expect(ok.status).toBe(200); expect(ok.body.permissions).toBe(String(Perm.SEND_MESSAGES));
    expect((await api.req('PATCH', `/guilds/${w.guild.id}/integrations/${mod.applicationId}`, plain.token, { permissions: '0' })).status).toBe(403);
    expect((await api.req('PATCH', `/guilds/${w.guild.id}/integrations/${w.guild.id}`, mgr.token, { permissions: '0' })).status).toBe(404);
    // another server's install is invisible
    const o2 = await api.register('bo2'); const g2 = (await api.req('POST', '/guilds', o2.token, { name: 'Elsewhere' })).body;
    expect((await api.req('DELETE', `/guilds/${g2.id}/integrations/${mod.applicationId}`, o2.token)).status).toBe(404);
    expect((await api.req('DELETE', `/guilds/${w.guild.id}/integrations/${mod.applicationId}`, plain.token)).status).toBe(403);
    expect((await api.req('DELETE', `/guilds/${w.guild.id}/integrations/${mod.applicationId}`, mgr.token)).status).toBe(204);
    const after = (await api.req('GET', `/guilds/${w.guild.id}/integrations`, mgr.token)).body;
    expect(after.map((i: any) => i.name).sort()).toEqual(['Utility', 'Welcome']);
    const members = (await api.req('GET', `/guilds/${w.guild.id}/members`, w.owner.token)).body;
    expect(members.some((m: any) => m.user.id === mod.botUserId)).toBe(false);
    // third-party bots appear too, and can be removed the same way
    const dev = (await api.req('POST', '/applications', w.owner.token, { name: 'thirdparty' })).body;
    await api.req('POST', '/oauth2/authorize', w.owner.token, { clientId: dev.id, scope: 'bot', permissions: '0', guildId: w.guild.id });
    const l2 = (await api.req('GET', `/guilds/${w.guild.id}/integrations`, mgr.token)).body;
    expect(l2.find((i: any) => i.name === 'thirdparty')?.official).toBe(false);
    expect((await api.req('DELETE', `/guilds/${w.guild.id}/integrations/${dev.id}`, mgr.token)).status).toBe(204);
  });
});
