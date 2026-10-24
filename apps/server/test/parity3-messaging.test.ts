import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessageFlags, Perm } from '@jorcord/shared';
import { Api, startServer, type TestEnv } from './helpers';
import { buildSearchSql, hasSearchCriteria, searchQuerySchema } from '../src/services/search';
import { _clearTranslateCache } from '../src/services/translate';

let env: TestEnv, api: Api, fake: http.Server, hits = 0, lastBody: any = null;
beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      hits++; lastBody = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ translatedText: `[${lastBody.target}] ${lastBody.q}`, detectedLanguage: { language: 'en', confidence: 90 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  env = await startServer({ translateUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, translateApiKey: 'k' });
  api = new Api(env);
});
afterAll(async () => { await env.close(); fake.close(); });

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Msgs' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const m = await api.register('m'); await api.req('POST', `/invites/${code}`, m.token);
  const general = guild.channels.find((c: any) => c.name === 'general');
  return { owner, guild, m, general };
}
const mpart = (fields: Record<string, string>, filename: string, value: Buffer, type: string) => {
  const b = 'XBOUNDARYX';
  const f = Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  return { payload: Buffer.concat([Buffer.from(f), Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="files[]"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), value, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};

describe('message flags: silent, suppress embeds, TTS', () => {
  it('exposes the TTS flag at bit 4', () => expect(MessageFlags.TTS).toBe(16));

  it('TTS needs SEND_TTS; the owner can send one, a plain member cannot', async () => {
    const { owner, m, general } = await setup();
    const ok = await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'hello there', flags: MessageFlags.TTS });
    expect(ok.status).toBe(201); expect(ok.body.flags & MessageFlags.TTS).toBe(MessageFlags.TTS);
    expect((await api.req('POST', `/channels/${general.id}/messages`, m.token, { content: 'hi', flags: MessageFlags.TTS })).status).toBe(403);
    // unknown flags are still refused
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'x', flags: 8 })).status).toBe(400);
    expect(Perm.SEND_TTS).toBe(1n << 12n);
  });

  it('the author (or MANAGE_MESSAGES) toggles SUPPRESS_EMBEDS via PATCH; others cannot; no edit marker', async () => {
    const { owner, m, general } = await setup();
    const msg = (await api.req('POST', `/channels/${general.id}/messages`, m.token, { content: 'see https://example.com' })).body;
    const on = await api.req('PATCH', `/channels/${general.id}/messages/${msg.id}`, m.token, { flags: MessageFlags.SUPPRESS_EMBEDS });
    expect(on.status).toBe(200); expect(on.body.flags & MessageFlags.SUPPRESS_EMBEDS).toBe(MessageFlags.SUPPRESS_EMBEDS); expect(on.body.editedAt ?? null).toBeNull();
    const off = await api.req('PATCH', `/channels/${general.id}/messages/${msg.id}`, m.token, { flags: 0 });
    expect(off.body.flags & MessageFlags.SUPPRESS_EMBEDS).toBe(0);
    // flags other than SUPPRESS_EMBEDS cannot be edited in
    expect((await api.req('PATCH', `/channels/${general.id}/messages/${msg.id}`, m.token, { flags: MessageFlags.TTS })).status).toBe(400);
    // a moderator may remove embeds on someone else's message, but still cannot edit its text
    const mod = await api.req('PATCH', `/channels/${general.id}/messages/${msg.id}`, owner.token, { flags: MessageFlags.SUPPRESS_EMBEDS });
    expect(mod.status).toBe(200);
    expect((await api.req('PATCH', `/channels/${general.id}/messages/${msg.id}`, owner.token, { content: 'hijack' })).status).toBe(403);
    // a plain member cannot touch someone else's message
    const other = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'https://example.org' })).body;
    expect((await api.req('PATCH', `/channels/${general.id}/messages/${other.id}`, m.token, { flags: MessageFlags.SUPPRESS_EMBEDS })).status).toBe(403);
  });

  it('@silent: flag 1<<12 is accepted and stored', async () => {
    const { m, general } = await setup();
    const r = await api.req('POST', `/channels/${general.id}/messages`, m.token, { content: 'quiet', flags: MessageFlags.SUPPRESS_NOTIFICATIONS });
    expect(r.status).toBe(201); expect(r.body.flags).toBe(1 << 12);
  });
});

describe('attachment alt text', () => {
  it('multipart descriptions are stored on the attachment and returned', async () => {
    const { m, general } = await setup();
    const mp = mpart({ content: 'pic', descriptions: JSON.stringify(['  A red square  ']) }, 'a.txt', Buffer.from('hello'), 'text/plain');
    const r = await api.req('POST', `/channels/${general.id}/messages`, m.token, mp.payload as any, mp.headers);
    expect(r.status).toBe(201); expect(r.body.attachments[0].description).toBe('A red square');
    const list = (await api.req('GET', `/channels/${general.id}/messages?limit=5`, m.token)).body;
    expect(list.find((x: any) => x.id === r.body.id).attachments[0].description).toBe('A red square');
  });

  it('PATCH /uploads/:id sets alt text before sending, caps at 1024, and only for the owner', async () => {
    const { owner, m, general } = await setup();
    const mp = mpart({}, 'b.txt', Buffer.from('hello'), 'text/plain');
    const up = await api.req('POST', '/uploads', m.token, mp.payload as any, mp.headers);
    expect(up.status).toBe(201); expect(up.body.description).toBeNull();
    expect((await api.req('PATCH', `/uploads/${up.body.id}`, owner.token, { description: 'steal' })).status).toBe(404);
    expect((await api.req('PATCH', `/uploads/${up.body.id}`, m.token, { description: 'x'.repeat(1025) })).status).toBe(400);
    expect((await api.req('PATCH', `/uploads/${up.body.id}`, m.token, { description: 'Alt text' })).body.description).toBe('Alt text');
    const sent = await api.req('POST', `/channels/${general.id}/messages`, m.token, { attachments: [up.body.id] });
    expect(sent.body.attachments[0].description).toBe('Alt text');
    // once sent, the row is attached and no longer editable through the upload route
    expect((await api.req('PATCH', `/uploads/${up.body.id}`, m.token, { description: 'late' })).status).toBe(404);
  });
});

describe('search: author_type and in:', () => {
  it('author_type is validated, counts as a criterion and narrows SQL', () => {
    expect(searchQuerySchema.parse({ author_type: 'bot' }).authorType).toBe('bot');
    expect(searchQuerySchema.safeParse({ author_type: 'robot' }).success).toBe(false);
    expect(hasSearchCriteria(searchQuerySchema.parse({ authorType: 'user' }))).toBe(true);
    const bot = buildSearchSql('ilike', { channelIds: ['c1'], authorType: 'bot', limit: 5 }).sql;
    const usr = buildSearchSql('ilike', { channelIds: ['c1'], authorType: 'user', limit: 5 }).sql;
    expect(bot).toContain('author_id IN (SELECT id FROM users WHERE bot = true)');
    expect(usr).toContain('author_id NOT IN (SELECT id FROM users WHERE bot = true)');
  });

  it('filters real messages by author type and by channel', async () => {
    const { owner, guild, m, general } = await setup();
    const other = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'other', type: 'text' })).body;
    await api.req('POST', `/channels/${general.id}/messages`, m.token, { content: 'findme human' });
    await api.req('POST', `/channels/${other.id}/messages`, owner.token, { content: 'findme elsewhere' });
    const users = await api.req('GET', `/guilds/${guild.id}/messages/search?q=findme&author_type=user`, owner.token);
    expect(users.body.length).toBe(2);
    const bots = await api.req('GET', `/guilds/${guild.id}/messages/search?q=findme&author_type=bot`, owner.token);
    expect(bots.body.length).toBe(0);
    const inCh = await api.req('GET', `/guilds/${guild.id}/messages/search?q=findme&channelId=${other.id}`, owner.token);
    expect(inCh.body.map((x: any) => x.content)).toEqual(['findme elsewhere']);
  });
});

describe('message translation', () => {
  it('translates through the configured LibreTranslate endpoint and caches per (message, language)', async () => {
    _clearTranslateCache(); hits = 0;
    const { m, general } = await setup();
    const msg = (await api.req('POST', `/channels/${general.id}/messages`, m.token, { content: 'good morning' })).body;
    expect((await api.req('GET', '/translate/config', m.token)).body.available).toBe(true);
    const r = await api.req('POST', `/channels/${general.id}/messages/${msg.id}/translate`, m.token, { to: 'de' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ text: '[de] good morning', detectedLanguage: 'en', cached: false });
    expect(lastBody).toMatchObject({ source: 'auto', target: 'de', q: 'good morning', api_key: 'k' });
    const again = await api.req('POST', `/channels/${general.id}/messages/${msg.id}/translate`, m.token, { to: 'de' });
    expect(again.body.cached).toBe(true); expect(hits).toBe(1);
    await api.req('POST', `/channels/${general.id}/messages/${msg.id}/translate`, m.token, { to: 'fr' });
    expect(hits).toBe(2);
    expect((await api.req('POST', `/channels/${general.id}/messages/${msg.id}/translate`, m.token, { to: 'not a lang!' })).status).toBe(400);
  });

  it('is a clear 501 NOT_CONFIGURED when no TRANSLATE_URL is set', async () => {
    const e2 = await startServer(); const a2 = new Api(e2);
    try {
      const u = await a2.register('t');
      const g = (await a2.req('POST', '/guilds', u.token, { name: 'Tr' })).body; if (!g?.channels) throw new Error(JSON.stringify(g));
      const ch = g.channels.find((c: any) => c.name === 'general');
      const msg = (await a2.req('POST', `/channels/${ch.id}/messages`, u.token, { content: 'hi' })).body;
      expect((await a2.req('GET', '/translate/config', u.token)).body.available).toBe(false);
      const r = await a2.req('POST', `/channels/${ch.id}/messages/${msg.id}/translate`, u.token, { to: 'de' });
      expect(r.status).toBe(501); expect(r.body.code).toBe('NOT_CONFIGURED');
    } finally { await e2.close(); }
  });
});
