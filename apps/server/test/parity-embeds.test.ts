import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, startServer, type Client, type TestEnv } from './helpers';

// Sender-sent rich embeds (CONTRACT.md): bots only (403 USER_FORBIDDEN / 20002 for users),
// webhook executes can send embeds too. Discord's public numbers: 10 embeds, 25 fields,
// 6000 chars total; content accepted together with embeds or without.
let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Embeds' })).body;
  const general = guild.channels.find((c: any) => c.name === 'general');
  const created = await api.req('POST', '/applications', owner.token, { name: 'EmbedBot', redirectUris: ['https://app.example/cb'] });
  const perms = (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_MESSAGE_HISTORY | Perm.EMBED_LINKS).toString();
  const authz = await api.req('POST', '/oauth2/authorize', owner.token, { clientId: created.body.id, scope: 'bot applications.commands', permissions: perms, guildId: guild.id });
  expect(authz.status).toBe(200);
  const bot: Client = { id: created.body.botUser.id, token: created.body.token, refresh: '', username: 'EmbedBot', user: created.body.botUser };
  const hook = (await api.req('POST', `/channels/${general.id}/webhooks`, owner.token, { name: 'Hook' })).body;
  return { owner, bot, guild, general, hook };
}

const botReq = (method: string, url: string, bot: Client, body?: unknown) => api.req(method, url, null, body, { authorization: `Bot ${bot.token}` });
const rich = { title: 'Deploy report', description: 'All green', color: 0x34eb3a, fields: [{ name: 'build', value: 'ok', inline: true }], footer: 'ci', author: 'Jorcord CI', url: 'https://ci.example/run/8', image: 'https://ci.example/shot.png', thumbnail: 'https://ci.example/icon.png' };

describe('sender-sent embeds', () => {
  it('users cannot send embeds (20002), bots can and the message echoes them', async () => {
    const { owner, bot, general } = await setup();
    const u = await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'x', embeds: [rich] });
    expect(u.status).toBe(403);
    expect(u.body.errorCode).toBe(20002);
    const b = await botReq('POST', `/channels/${general.id}/messages`, bot, { content: 'with embed', embeds: [rich] });
    expect(b.status).toBe(201);
    expect(b.body.embeds[0]).toMatchObject({ type: 'rich', title: 'Deploy report', color: 0x34eb3a, footer: 'ci', author: 'Jorcord CI' });
    expect(b.body.embeds[0].url).toBe('https://ci.example/run/8');
    expect(b.body.embeds[0].fields).toEqual([{ name: 'build', value: 'ok', inline: true }]);
    const hist = (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body;
    expect(hist.find((m: any) => m.content === 'with embed').embeds).toHaveLength(1);
  });

  it('validates structure: counts, sizes, urls, empty embeds, totals', async () => {
    const { bot, general } = await setup();
    const post = (embeds: unknown, content = 'x') => botReq('POST', `/channels/${general.id}/messages`, bot, { content, embeds });
    expect((await post([])).status).toBe(400);
    expect((await post({ title: 'not an array' })).status).toBe(400);
    expect((await post([{ description: 'no schema keys'.repeat(100), extra: 1 }])).status).toBe(400); // strict: unknown key
    expect((await post([{}])).status).toBe(400); // nothing to show
    expect((await post([{ title: 'a', url: 'javascript:alert(1)' }])).status).toBe(400);
    expect((await post([{ title: 'big color', color: 1234567890 }])).status).toBe(400);
    expect((await post([{ title: 't', fields: [{ name: 'f', value: 'v' }], footer: 'x'.repeat(2049) }])).status).toBe(400);
    expect((await post([{ title: 't', fields: Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: 'v' })) }])).status).toBe(400);
    expect((await post(Array.from({ length: 11 }, () => ({ description: 'd' })))).status).toBe(400);
    expect((await post(Array.from({ length: 10 }, () => ({ description: 'd' })))).status).toBe(201);
    // 6000 total char budget
    const fat = { description: 'd'.repeat(700) }; // 10 x 700 = 7000 > 6000
    expect((await post(Array.from({ length: 10 }, () => fat))).status).toBe(400);
    const ok = { description: 'd'.repeat(599) };
    expect((await post(Array.from({ length: 10 }, () => ok))).status).toBe(201);
  });

  it('an embeds-only message can be empty of content', async () => {
    const { bot, general } = await setup();
    const b = await botReq('POST', `/channels/${general.id}/messages`, bot, { embeds: [{ title: 'Only embed' }] });
    expect(b.status).toBe(201);
    expect(b.body.content).toBe('');
    expect(b.body.embeds[0].title).toBe('Only embed');
  });

  it('webhook executes accept embeds, with or without content', async () => {
    const { owner, hook, general } = await setup();
    const path = `/webhooks/${hook.id}/${hook.token}?wait=true`;
    const withContent = (await api.req('POST', path, null, { content: 'ci', embeds: [rich] })).body;
    expect(withContent.embeds).toHaveLength(1);
    expect(withContent.embeds[0].title).toBe('Deploy report');
    const embedsOnly = (await api.req('POST', path, null, { embeds: [{ description: 'summary' }] })).body;
    expect(embedsOnly.content).toBe('');
    expect(embedsOnly.embeds[0].description).toBe('summary');
    expect((await api.req('POST', path, null, { embeds: [{}] })).status).toBe(400);
    expect((await api.req('POST', path, null, {})).status).toBe(400); // neither content nor embeds
    const hist = (await api.req('GET', `/channels/${general.id}/messages`, owner.token)).body;
    expect(hist.find((m: any) => m.content === 'ci').embeds).toHaveLength(1);
  });
});
