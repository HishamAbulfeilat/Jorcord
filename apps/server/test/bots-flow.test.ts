import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Intents, Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });
const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); }
};

const botReq = (method: string, url: string, token: string, body?: unknown) => api.req(method, url, null, body, { authorization: `Bot ${token}` });
/** What bot-sdk's Bot.login() does: identify over the gateway with a Bot token and react to INTERACTION_CREATE. */
async function connectBot(token: string, intents: number, handlers: Record<string, (ix: any) => string> = {}) {
  const ws = await WsClient.connect(env.port);
  const ready = await ws.identify(`Bot ${token}`);
  const interactions: any[] = [];
  const pump = setInterval(() => {
    for (const f of ws.frames) if (f.t === 'INTERACTION_CREATE' && !interactions.includes(f.d)) {
      interactions.push(f.d);
      const text = handlers[f.d.data?.name]?.(f.d);
      if (text) void botReq('POST', `/interactions/${f.d.id}/${f.d.token}/callback`, token, { type: 4, data: { content: text } });
    }
  }, 20);
  return { ws, ready, interactions, close: () => { clearInterval(pump); ws.close(); } };
}

describe('adding a bot end to end', () => {
  it('portal -> invite link -> pick a managed server -> approve -> managed role -> sdk bot receives messages and slash commands -> kick removes it', async () => {
    const owner = await api.register('own');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Home' })).body;
    const other = (await api.req('POST', '/guilds', owner.token, { name: 'Second' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    // a plain member and a MANAGE_GUILD member (no admin)
    const plain = await api.register('plain'); await api.req('POST', `/invites/${code}`, plain.token);
    const mgr = await api.register('mgr'); await api.req('POST', `/invites/${code}`, mgr.token);
    const mgrRole = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Managers', permissions: String(Perm.MANAGE_GUILD | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES) })).body;
    expect((await api.req('PATCH', `/guilds/${guild.id}/members/${mgr.id}`, owner.token, { roles: [mgrRole.id] })).status).toBe(200);

    // 1. developer portal: create the application + bot
    const created = await api.req('POST', '/applications', owner.token, { name: 'flowbot', description: 'A bot used for testing the install flow', botPublic: true });
    expect(created.status).toBe(201);
    const appRow = created.body;
    expect(appRow.token).toBeTruthy();
    await api.req('PATCH', `/applications/${appRow.id}`, owner.token, { privilegedIntents: 1 << 15 });

    // 2. the invite link opens a preview: only servers the user manages are offered
    const perms = (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY | Perm.MANAGE_MESSAGES).toString();
    const qs = `/oauth2/authorize?clientId=${appRow.id}&scope=bot%20applications.commands&permissions=${perms}`;
    const prev = await api.req('GET', qs, owner.token);
    expect(prev.status).toBe(200);
    expect(prev.body.application.name).toBe('flowbot');
    expect(prev.body.guilds.map((g: any) => g.id).sort()).toEqual([guild.id, other.id].sort());
    expect((await api.req('GET', qs, plain.token)).body.guilds).toEqual([]);
    const mgrPrev = (await api.req('GET', qs, mgr.token)).body.guilds;
    expect(mgrPrev.map((g: any) => g.id)).toEqual([guild.id]);
    expect(BigInt(mgrPrev[0].grantable) & Perm.MANAGE_MESSAGES).toBe(0n); // the page can lock what this approver may not hand out
    expect(BigInt(mgrPrev[0].grantable) & Perm.SEND_MESSAGES).toBe(Perm.SEND_MESSAGES);
    expect(BigInt(prev.body.guilds[0].grantable) & Perm.MANAGE_MESSAGES).toBe(Perm.MANAGE_MESSAGES);

    // 3. approving: not for a server the user cannot manage, not by a plain member, not beyond the approver's own permissions
    const body = { clientId: appRow.id, scope: 'bot applications.commands', permissions: perms, guildId: guild.id };
    expect((await api.req('POST', '/oauth2/authorize', plain.token, body)).status).toBe(403);
    expect((await api.req('POST', '/oauth2/authorize', mgr.token, body)).status).toBe(403); // asks for MANAGE_MESSAGES / READ_MESSAGE_HISTORY the manager lacks
    const ok = await api.req('POST', '/oauth2/authorize', owner.token, body);
    expect(ok.status).toBe(200); expect(ok.body.guildId).toBe(guild.id);

    // 4. the bot is a member with its managed role
    const members = (await api.req('GET', `/guilds/${guild.id}/members`, owner.token)).body;
    const botMember = members.find((m: any) => m.user.id === appRow.botUser.id);
    expect(botMember).toBeTruthy();
    const roles = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body;
    const managed = roles.find((r: any) => r.name === 'flowbot');
    expect(botMember.roles).toContain(managed.id);
    expect(managed.permissions).toBe(perms);
    expect((await api.req('GET', `/applications/${appRow.id}/installs`, owner.token)).body.map((i: any) => i.guildId)).toEqual([guild.id]);

    // 5. the SDK bot connects, gets GUILD_CREATE, message content, and answers a slash command
    const bot = await connectBot(appRow.token, Intents.GUILDS | Intents.GUILD_MESSAGES | Intents.MESSAGE_CONTENT, { hello: (ix) => `hi ${ix.data.options?.[0]?.value ?? 'you'}` });
    expect(bot.ready.d.user.id).toBe(appRow.botUser.id);
    expect(bot.ready.d.guilds.map((g: any) => g.id)).toContain(guild.id);
    const cmds = (await botReq('PUT', `/applications/${appRow.id}/commands`, appRow.token, [{ name: 'hello', description: 'Say hello', options: [{ type: 3, name: 'name', description: 'who' }] }])).body;
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'ping from a human' });
    await bot.ws.waitEvent('MESSAGE_CREATE', (m) => m.content === 'ping from a human');
    const user = plain;
    const cmdList = await api.req('GET', `/guilds/${guild.id}/application-commands`, user.token);
    expect(JSON.stringify(cmdList.body)).toContain('hello');
    expect((await api.req('POST', '/interactions', user.token, { type: 2, channelId: general.id, data: { id: cmds[0]!.id, options: [{ name: 'name', type: 3, value: 'Jor' }] } })).status).toBe(202);
    await until(async () => (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body.find((m: any) => m.content === 'hi Jor' && m.author.id === appRow.botUser.id));
    // not installed in the second guild: the bot cannot be used there
    const otherGeneral = other.channels.find((c: any) => c.name === 'general');
    expect((await api.req('POST', '/interactions', owner.token, { type: 2, channelId: otherGeneral.id, data: { id: cmds[0]!.id } })).status).toBe(403);

    // 6. kicking the bot removes member, managed role and install
    expect((await api.req('DELETE', `/guilds/${guild.id}/members/${appRow.botUser.id}`, owner.token)).status).toBe(204);
    expect((await api.req('GET', `/applications/${appRow.id}/installs`, owner.token)).body).toEqual([]);
    expect((await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === 'flowbot')).toBeUndefined();
    bot.close();
  });
});

describe('a bot that is already online when it is invited', () => {
  it('gets GUILD_CREATE, then messages and interactions; after the kick it receives nothing more', async () => {
    const owner = await api.register('own2');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Late' })).body;
    const general = guild.channels.find((c: any) => c.name === 'general');
    const app = (await api.req('POST', '/applications', owner.token, { name: 'latebot' })).body;
    const bot = await connectBot(app.token, Intents.GUILDS | Intents.GUILD_MESSAGES, { yo: () => 'yo!' });
    expect(bot.ready.d.guilds).toHaveLength(0);
    const cmds = (await botReq('PUT', `/applications/${app.id}/commands`, app.token, [{ name: 'yo', description: 'yo' }])).body;
    expect(cmds).toHaveLength(1);
    const perms = (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY).toString();
    expect((await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: perms, guildId: guild.id })).status).toBe(200);
    await bot.ws.waitEvent('GUILD_CREATE', (g) => g.id === guild.id);
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'after invite' });
    await bot.ws.waitEvent('MESSAGE_CREATE', (m) => m.content === 'after invite' || m.channelId === general.id);
    const list = (await api.req('GET', `/guilds/${guild.id}/application-commands`, owner.token)).body;
    const yo = list.commands.find((c: any) => c.name === 'yo');
    expect(yo).toBeTruthy();
    expect((await api.req('POST', '/interactions', owner.token, { type: 2, channelId: general.id, data: { id: yo.id } })).status).toBe(202);
    await until(async () => (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body.find((m: any) => m.content === 'yo!'));
    expect((await api.req('DELETE', `/guilds/${guild.id}/members/${app.botUser.id}`, owner.token)).status).toBe(204);
    await bot.ws.waitEvent('GUILD_DELETE', (g) => g.id === guild.id);
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'after kick' });
    await bot.ws.expectNone((f) => f.t === 'MESSAGE_CREATE' && f.d.content === 'after kick', 400);
    // the command disappears with the install
    expect((await api.req('POST', '/interactions', owner.token, { type: 2, channelId: general.id, data: { id: yo.id } })).status).toBe(403);
    bot.close();
  });
});
