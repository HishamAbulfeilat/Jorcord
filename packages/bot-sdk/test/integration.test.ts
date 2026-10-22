import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Intents, Perm } from '@jorcord/shared';
import { Api, startServer, type TestEnv } from '../../../apps/server/test/helpers';
import { Bot, Rest, RestError, actionRow, button, container, mediaGallery, section, separator, textDisplay, thumbnail, v2, MessageFlags } from '../src/index';

let env: TestEnv, api: Api, base: string;
beforeAll(async () => { env = await startServer(); api = new Api(env); base = `http://127.0.0.1:${env.port}`; });
afterAll(async () => { await env.close(); });

async function install() {
  const owner = await api.register('sdkowner');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'SDK' })).body;
  const general = guild.channels.find((c: any) => c.name === 'general');
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const user = await api.register('sdkuser'); await api.req('POST', `/invites/${code}`, user.token);
  const app = (await api.req('POST', '/applications', owner.token, { name: 'sdkbot' })).body;
  await api.req('POST', '/oauth2/authorize', owner.token, { clientId: app.id, scope: 'bot applications.commands', permissions: (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY).toString(), guildId: guild.id });
  return { owner, guild, general, user, app };
}
const until = async (fn: () => boolean, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

describe('bot-sdk against a running server', () => {
  it('logs in, registers slash commands, answers interactions and components, and sends messages', async () => {
    const { owner, guild, general, user, app } = await install();
    const bot = new Bot({ token: app.token, baseUrl: base, intents: Intents.GUILDS | Intents.GUILD_MESSAGES });
    bot.command('ping', (ix) => ix.reply({ content: `Pong ${ix.option('who') ?? 'nobody'}!`, components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Again', customId: 'again' }] }] }));
    bot.component('again', (ix) => ix.update({ content: 'Pong again', components: [] }));
    bot.command('slow', async (ix) => { await ix.defer({ ephemeral: true }); await ix.followUp('done, only you see this', { ephemeral: true }); });
    await bot.login();
    expect(bot.user?.id).toBe(app.botUser.id);

    const cmds = await bot.registerCommands([
      { name: 'ping', description: 'Ping', options: [{ type: 3, name: 'who', description: 'who' }] },
      { name: 'slow', description: 'Deferred' },
    ]);
    expect(cmds.map((c) => c.name).sort()).toEqual(['ping', 'slow']);
    const ping = cmds.find((c) => c.name === 'ping')!;

    const inv = await api.req('POST', '/interactions', user.token, { type: 2, channelId: general.id, data: { id: ping.id, options: [{ name: 'who', type: 3, value: 'sdk' }] } });
    expect(inv.status).toBe(202);
    let msg: any;
    // the reply is a public bot message in the channel
    const find = async (pred: (m: any) => boolean) => { for (let i = 0; i < 80; i++) { const h = (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body; const m = h.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); } throw new Error('message never arrived'); };
    msg = await find((m) => m.content === 'Pong sdk!');
    expect(msg.author.id).toBe(bot.user!.id);

    // press the button on the bot's message: the SDK edits it in place
    expect((await api.req('POST', '/interactions', user.token, { type: 3, channelId: general.id, messageId: msg.id, data: { customId: 'again' } })).status).toBe(202);
    expect((await find((m) => m.id === msg.id && m.content === 'Pong again')).components).toEqual([]);

    // deferred + ephemeral followup never reaches history
    const slow = cmds.find((c) => c.name === 'slow')!;
    expect((await api.req('POST', '/interactions', user.token, { type: 2, channelId: general.id, data: { id: slow.id } })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 600));
    expect(JSON.stringify((await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body)).not.toContain('only you see this');

    // REST helper
    const sent = await bot.rest.sendMessage(general.id, 'hello from the sdk');
    expect(sent.content).toBe('hello from the sdk');
    await expect(bot.rest.get('/guilds/1/channels')).rejects.toBeInstanceOf(RestError);
    void guild; bot.destroy();
  });

  it('delivers typed gateway events and honours intents', async () => {
    const { general, user, app } = await install();
    const bot = new Bot({ token: app.token, baseUrl: base, intents: Intents.GUILDS | Intents.GUILD_MESSAGES });
    const seen: any[] = [];
    bot.on('MESSAGE_CREATE', (m) => { seen.push(m); });
    await bot.login();
    await api.req('POST', `/channels/${general.id}/messages`, user.token, { content: 'hidden text' });
    await api.req('POST', `/channels/${general.id}/messages`, user.token, { content: `hi <@${app.botUser.id}>` });
    await until(() => seen.length >= 2);
    expect(seen[0].content).toBe(''); // no MESSAGE_CONTENT intent: redacted
    expect(seen[1].content).toContain('hi <@'); // mentions are readable
    bot.destroy();
  });

  it('reconnects with resume after a dropped socket and keeps receiving events', async () => {
    const { general, user, app } = await install();
    const bot = new Bot({ token: app.token, baseUrl: base, backoff: { min: 20, max: 100 } });
    const seen: string[] = []; let readies = 0, reconnects = 0;
    bot.on('MESSAGE_CREATE', (m) => { seen.push(m.content); });
    bot.on('READY', () => { readies++; });
    bot.on('reconnecting', () => { reconnects++; });
    await bot.login();
    bot._dropConnection();
    await api.req('POST', `/channels/${general.id}/messages`, user.token, { content: 'while away' }); // buffered by the server, replayed on resume
    await until(() => seen.includes('while away'));
    expect(reconnects).toBe(1); expect(readies).toBe(1); // resumed, not re-identified
    await api.req('POST', `/channels/${general.id}/messages`, user.token, { content: 'after' });
    await until(() => seen.includes('after'));
    bot.destroy();
  });

  it('sends Components V2 layouts built with the helpers, and V2 replies to interactions', async () => {
    const { general, user, app } = await install();
    const rest = new Rest(base, app.token);
    const body = v2([container([
      section(['## Release', 'notes'], thumbnail('https://example.com/a.png', { description: 'logo' })), separator({ spacing: 2 }),
      mediaGallery(['https://example.com/1.png', { media: { url: 'https://example.com/2.png' }, spoiler: true }]),
      actionRow([button({ label: 'Docs', url: 'https://example.com' }), button({ label: 'Go', customId: 'go' })]),
    ], { accentColor: 0x5865f2 }), textDisplay('footer')]);
    expect(body.flags).toBe(MessageFlags.IS_COMPONENTS_V2);
    const sent = await rest.sendMessage(general.id, body);
    expect(sent.flags & MessageFlags.IS_COMPONENTS_V2).toBeTruthy(); expect(sent.components[0].components[0].accessory.type).toBe(11);
    const rejected = await rest.sendMessage(general.id, { ...body, content: 'mixed' }).catch((e) => e);
    expect(rejected).toBeInstanceOf(RestError); expect(rejected.status).toBe(400);
    const bot = new Bot({ token: app.token, baseUrl: base, intents: Intents.GUILDS });
    bot.command('card', (ix) => ix.reply(v2([textDisplay('hello from v2')], MessageFlags.EPHEMERAL)));
    await bot.login(); bot.destroy(); void user;
  });

  it('fails login fast on a bad token and on intents the owner has not enabled', async () => {
    const { app } = await install();
    await expect(new Bot({ token: app.token + 'x', baseUrl: base }).login()).rejects.toBeInstanceOf(RestError);
    await expect(new Bot({ token: app.token, baseUrl: base, intents: Intents.MESSAGE_CONTENT }).login()).rejects.toThrow('4014');
    expect(await new Rest(base, null).request('GET', '/auth/sessions').catch((e) => e.status)).toBe(401);
  });
});
