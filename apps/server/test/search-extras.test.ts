import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startServer, type TestEnv } from './helpers';
import { buildSearchSql, hasSearchCriteria, searchQuerySchema } from '../src/services/search';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const mpart = (fields: Record<string, string>, filename: string, value: Buffer, type: string) => {
  const b = 'XBOUNDARYX';
  const f = Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  return { payload: Buffer.concat([Buffer.from(f), Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="files[]"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), value, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};

async function setup() {
  const owner = await api.register('so');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Srch2' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const bob = await api.register('sb'); await api.req('POST', `/invites/${code}`, bob.token);
  const ch = guild.channels.find((c: any) => c.name === 'general').id as string;
  const post = async (tok: string, content: string) => (await api.req('POST', `/channels/${ch}/messages`, tok, { content })).body;
  const search = async (qs: string, tok = owner.token) => (await api.req('GET', `/guilds/${guild.id}/messages/search?${qs}`, tok));
  const ids = async (qs: string, tok = owner.token) => (await search(qs, tok)).body.map((m: any) => m.id) as string[];
  return { owner, guild, bob, ch, post, search, ids };
}

describe('query building', () => {
  const base = { channelIds: ['c1'], limit: 25 };
  it('searches content, embed text and attachment names/alt together', () => {
    const ilike = buildSearchSql('ilike', { ...base, q: 'cat' });
    expect(ilike.sql).toContain('content ILIKE $2 OR search_extra ILIKE $2');
    const fts = buildSearchSql('fts', { ...base, q: 'cat', sortBy: 'relevance' });
    expect(fts.sql).toContain('search_extra IS NOT NULL AND to_tsvector');
    expect(fts.sql).toContain('ts_rank(');
  });
  it('link: matches urls in text and embeds, escaping wildcards', () => {
    const { sql, params } = buildSearchSql('ilike', { ...base, link: 'a_b.com' });
    expect(sql).toContain('(content ILIKE $2 OR search_extra ILIKE $2)');
    expect(params[1]).toBe('%a\\_b.com%');
  });
  it('offset pages a stable total order', () => {
    const { sql, params } = buildSearchSql('fts', { ...base, q: 'hello', sortBy: 'relevance', offset: 50 });
    expect(sql).toMatch(/ORDER BY .*DESC, id DESC LIMIT \$\d+ OFFSET \$\d+$/);
    expect(params.slice(-2)).toEqual([25, 50]);
    expect(buildSearchSql('ilike', { ...base, q: 'x' }).sql).not.toContain('OFFSET');
  });
  it('from / mentions_user / link count as criteria; offset is bounded', () => {
    expect(hasSearchCriteria(searchQuerySchema.parse({ from: 'alice' }))).toBe(true);
    expect(hasSearchCriteria(searchQuerySchema.parse({ mentions_user: 'alice' }))).toBe(true);
    expect(hasSearchCriteria(searchQuerySchema.parse({ link: 'x.com' }))).toBe(true);
    expect(searchQuerySchema.safeParse({ q: 'a', offset: 99999 }).success).toBe(false);
  });
});

describe('from: and mentions: by username, with users who left', () => {
  it('resolves ids, usernames, @name and name#0, case-insensitively', async () => {
    const { owner, bob, post, ids, search } = await setup();
    const a = await post(owner.token, 'from the owner');
    const b = await post(bob.token, `hey <@${owner.id}>`);
    expect(await ids(`from=${owner.id}`)).toEqual([a.id]);
    expect(await ids(`from=${owner.username}`)).toEqual([a.id]);
    expect(await ids(`from=${encodeURIComponent('@' + owner.username.toUpperCase())}`)).toEqual([a.id]);
    expect(await ids(`from=${owner.username}${encodeURIComponent('#0')}`)).toEqual([a.id]);
    expect(await ids(`mentions_user=${owner.username}`)).toEqual([b.id]);
    expect(await ids(`q=hey&from=${bob.username}`)).toEqual([b.id]);
    expect((await search('from=nobody-like-this')).body).toEqual([]);
  });

  it('still finds, and names, messages from someone who left the server', async () => {
    const { owner, guild, bob, post, ids, search } = await setup();
    const m = await post(bob.token, 'parting words about zebras');
    expect((await api.req('DELETE', `/users/@me/guilds/${guild.id}`, bob.token)).status).toBeLessThan(300);
    expect((await ids(`from=${bob.username}`))[0]).toBe(m.id); // newest first; the server's join notice is theirs too
    expect(await ids(`author_id=${bob.id}`)).toContain(m.id);
    expect(await ids('q=zebras')).toEqual([m.id]);
    const hit = (await search('q=zebras')).body[0];
    expect(hit.author).toMatchObject({ id: bob.id, username: bob.username });
    void owner;
  });
});

describe('embed text, attachment names and alt text are searchable', () => {
  it('finds a bot/webhook embed by title, description and url', async () => {
    const { owner, ch, ids } = await setup();
    const hook = (await api.req('POST', `/channels/${ch}/webhooks`, owner.token, { name: 'Hook' })).body;
    const r = await api.req('POST', `/webhooks/${hook.id}/${hook.token}?wait=true`, null, { embeds: [{ title: 'Quarterly flamingo report', description: 'migratory birds overview', url: 'https://birds.example.org/report' }] });
    expect(r.status).toBe(200);
    expect(await ids('q=flamingo')).toEqual([r.body.id]);
    expect(await ids('q=migratory')).toEqual([r.body.id]);
    expect(await ids('q=birds.example.org')).toEqual([r.body.id]);
    expect(await ids('link=birds.example.org')).toEqual([r.body.id]);
    expect(await ids('has=embed&q=flamingo')).toEqual([r.body.id]);
    expect(await ids('q=unrelated-term-xyz')).toEqual([]);
  });

  it('finds an attachment by filename and alt text', async () => {
    const { bob, ch, ids } = await setup();
    const mp = mpart({ content: 'look', descriptions: JSON.stringify(['A sleepy orange tabby cat']) }, 'holiday-photo.txt', Buffer.from('hello'), 'text/plain');
    const sent = await api.req('POST', `/channels/${ch}/messages`, bob.token, mp.payload as any, mp.headers);
    expect(sent.status).toBe(201);
    expect(await ids('q=holiday')).toEqual([sent.body.id]);
    expect(await ids('q=tabby')).toEqual([sent.body.id]);
    expect(await ids('has=file&q=sleepy')).toEqual([sent.body.id]);
  });

  it('keeps search_extra current when embeds change after sending', async () => {
    const { bob, ch, ids } = await setup();
    const m = (await api.req('POST', `/channels/${ch}/messages`, bob.token, { content: 'plain' })).body;
    expect(await ids('q=ostrich')).toEqual([]);
    await env.ctx.db.query('UPDATE messages SET embeds = $2::jsonb WHERE id = $1', [m.id, JSON.stringify([{ type: 'link', title: 'About the ostrich' }])]);
    expect(await ids('q=ostrich')).toEqual([m.id]);
    await env.ctx.db.query(`UPDATE messages SET embeds = '[]'::jsonb WHERE id = $1`, [m.id]);
    expect(await ids('q=ostrich')).toEqual([]);
  });
});

describe('stable pagination', () => {
  it('pages by before-cursor and by offset without gaps or repeats', async () => {
    const { owner, post, ids } = await setup();
    const all: string[] = [];
    for (let i = 0; i < 7; i++) all.unshift((await post(owner.token, `needle ${i}`)).id);
    const p1 = await ids('q=needle&limit=3');
    const p2 = await ids(`q=needle&limit=3&before=${p1[p1.length - 1]}`);
    const p3 = await ids(`q=needle&limit=3&before=${p2[p2.length - 1]}`);
    expect([...p1, ...p2, ...p3]).toEqual(all);
    const o1 = await ids('q=needle&limit=4&offset=0&sort_by=relevance');
    const o2 = await ids('q=needle&limit=4&offset=4&sort_by=relevance');
    expect(new Set([...o1, ...o2]).size).toBe(7);
  });
});
