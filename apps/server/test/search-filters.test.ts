import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snowflake, snowflakeTime } from '@jorcord/shared';
import { Api, startServer, type TestEnv } from './helpers';
import { boundaryId, buildSearchSql, hasSearchCriteria, searchQuerySchema } from '../src/services/search';

const base = { channelIds: ['c1'], limit: 25 };
const parseQ = (o: Record<string, unknown>) => searchQuerySchema.safeParse(o);

describe('search query parsing', () => {
  it('accepts snake_case and camelCase aliases', () => {
    const r = searchQuerySchema.parse({ author_id: '12', sort_by: 'relevance', sort_order: 'asc', has: 'image,video' });
    expect(r).toMatchObject({ authorId: '12', sortBy: 'relevance', sortOrder: 'asc', has: ['image', 'video'] });
    expect(searchQuerySchema.parse({ authorId: '9' }).authorId).toBe('9');
  });
  it('merges repeated and comma-separated has values, de-duplicated', () => {
    expect(searchQuerySchema.parse({ has: ['link', 'embed,link'] }).has).toEqual(['link', 'embed']);
  });
  it('rejects unknown has/sort/bound values', () => {
    expect(parseQ({ has: 'bogus' }).success).toBe(false);
    expect(parseQ({ sort_by: 'size' }).success).toBe(false);
    expect(parseQ({ before: 'yesterday' }).success).toBe(false);
    expect(parseQ({ mentions: 'abc' }).success).toBe(false);
  });
  it('parses pinned and during', () => {
    expect(searchQuerySchema.parse({ pinned: 'true', during: '2026-03-01' })).toMatchObject({ pinned: true, during: '2026-03-01' });
    expect(searchQuerySchema.parse({ pinned: 'false' }).pinned).toBe(false);
    expect(searchQuerySchema.parse({ pinned: true }).pinned).toBe(true);
    expect(searchQuerySchema.parse({ pinned: false }).pinned).toBe(false);
    expect(parseQ({ pinned: 'maybe' }).success).toBe(false);
    expect(parseQ({ during: 'soon' }).success).toBe(false);
    expect(parseQ({ during: '2026-13-45' }).success).toBe(false);
    expect(parseQ({ during: '2026-03-01T00:00:00Z' }).success).toBe(false);
  });
  it('requires a narrowing filter', () => {
    expect(hasSearchCriteria(searchQuerySchema.parse({ sort_by: 'timestamp' }))).toBe(false);
    expect(hasSearchCriteria(searchQuerySchema.parse({ mentions: '5' }))).toBe(true);
    expect(hasSearchCriteria(searchQuerySchema.parse({ has: 'file' }))).toBe(true);
    expect(hasSearchCriteria(searchQuerySchema.parse({ pinned: 'true' }))).toBe(true);
    expect(hasSearchCriteria(searchQuerySchema.parse({ pinned: 'false' }))).toBe(true);
    expect(hasSearchCriteria(searchQuerySchema.parse({ during: '2026-03-01' }))).toBe(true);
  });
});

describe('before/after bounds', () => {
  it('passes snowflakes through', () => expect(boundaryId.parse('123456')).toBe('123456'));
  it('converts ISO dates to the smallest snowflake of that instant', () => {
    const id = boundaryId.parse('2026-03-01T00:00:00Z');
    expect(snowflakeTime(id)).toBe(Date.parse('2026-03-01T00:00:00Z'));
    expect(BigInt(id) & 0x3fffffn).toBe(0n);
    expect(BigInt(snowflake(Date.parse('2026-03-01T00:00:01Z')))).toBeGreaterThan(BigInt(id));
  });
  it('clamps dates before the epoch to 0', () => expect(boundaryId.parse('2020-01-01')).toBe('0'));
});

describe('buildSearchSql', () => {
  it('defaults to newest first', () => {
    const { sql } = buildSearchSql('ilike', { ...base, q: 'hi' });
    expect(sql).toContain('ORDER BY id DESC');
    expect(sql).toContain('content ILIKE');
  });
  it('builds author, mentions, before/after predicates with bound params', () => {
    const { sql, params } = buildSearchSql('ilike', { ...base, authorId: '7', mentions: '8', before: '900', after: '100' });
    expect(sql).toContain('author_id = $2');
    expect(sql).toContain('mentions @> $3::jsonb');
    expect(sql).toContain('id < $4');
    expect(sql).toContain('id > $5');
    expect(params.slice(1, 5)).toEqual(['7', '["8"]', '900', '100']);
    expect(sql).not.toContain('900');
  });
  it('ANDs every has filter', () => {
    const { sql } = buildSearchSql('ilike', { ...base, has: ['link', 'image', 'video', 'embed', 'file', 'sticker'] });
    for (const frag of ['has_link', 'has_image', 'has_file', "embeds <> '[]'", "sticker_ids <> '[]'", "LIKE 'video/%'"]) expect(sql).toContain(frag);
    expect(sql.match(/ AND /g)!.length).toBeGreaterThanOrEqual(6);
  });
  it('honours sort_order asc', () => {
    expect(buildSearchSql('ilike', { ...base, authorId: '1', sortOrder: 'asc' }).sql).toContain('ORDER BY id ASC');
  });
  it('relevance uses ts_rank under FTS and falls back to time order otherwise', () => {
    const fts = buildSearchSql('fts', { ...base, q: 'hello world', sortBy: 'relevance' }).sql;
    expect(fts).toContain('ORDER BY ts_rank(');
    expect(fts).toContain('DESC, id DESC');
    expect(buildSearchSql('ilike', { ...base, q: 'hello', sortBy: 'relevance' }).sql).toContain('ORDER BY id DESC');
    expect(buildSearchSql('fts', { ...base, authorId: '1', sortBy: 'relevance' }).sql).toContain('ORDER BY id DESC');
  });
  it('escapes LIKE wildcards in the fallback', () => {
    expect(buildSearchSql('ilike', { ...base, q: '50%_' }).params[1]).toBe('%50' + String.fromCharCode(92) + '%' + String.fromCharCode(92) + '_%');
  });
  it('narrows by pinned and by the UTC day named in during', () => {
    const { sql, params } = buildSearchSql('ilike', { ...base, pinned: true, during: '2026-03-01' });
    expect(sql).toContain(' AND pinned');
    expect(sql).toContain('id >= $2');
    expect(sql).toContain('id < $3');
    expect(params.slice(1, 3)).toEqual([boundaryId.parse('2026-03-01T00:00:00Z'), boundaryId.parse('2026-03-02T00:00:00Z')]);
    expect(sql).not.toContain('2026-03-01');
    expect(buildSearchSql('ilike', { ...base, pinned: false }).sql).toContain('NOT pinned');
    expect(buildSearchSql('ilike', base).sql).not.toContain('pinned');
    expect(buildSearchSql('ilike', base).sql).not.toContain('id >=');
  });
});

describe('search filters end to end', () => {
  let env: TestEnv, api: Api;
  beforeAll(async () => { env = await startServer(); api = new Api(env); });
  afterAll(async () => { await env.close(); });

  it('filters by has, mentions, author, before/after and sort order', async () => {
    const owner = await api.register('so');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Srch' })).body;
    const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    const bob = await api.register('sb'); await api.req('POST', `/invites/${code}`, bob.token);
    const ch = guild.channels.find((c: any) => c.name === 'general').id;
    const post = async (tok: string, content: string) => (await api.req('POST', `/channels/${ch}/messages`, tok, { content })).body;
    const a = await post(owner.token, 'alpha https://example.com/a');
    const b = await post(bob.token, `beta <@${owner.id}>`);
    const c = await post(owner.token, 'gamma plain');
    const ids = async (qs: string) => (await api.req('GET', `/guilds/${guild.id}/messages/search?${qs}`, bob.token)).body.map((m: any) => m.id);

    expect(await ids('has=link')).toEqual([a.id]);
    expect(await ids(`mentions=${owner.id}`)).toEqual([b.id]);
    expect(await ids(`author_id=${owner.id}`)).toEqual([c.id, a.id]);
    expect(await ids(`author_id=${owner.id}&sort_order=asc`)).toEqual([a.id, c.id]);
    expect(await ids(`author_id=${owner.id}&after=${a.id}`)).toEqual([c.id]);
    expect(await ids(`author_id=${owner.id}&before=${c.id}`)).toEqual([a.id]);
    expect(await ids(`author_id=${owner.id}&before=${new Date(Date.now() + 60_000).toISOString()}&after=${new Date(Date.now() - 3_600_000).toISOString()}`)).toEqual([c.id, a.id]);
    expect(await ids(`author_id=${owner.id}&after=${new Date(Date.now() + 60_000).toISOString()}`)).toEqual([]);
    expect(await ids('q=a&sort_by=relevance')).toBeInstanceOf(Array);
    expect((await api.req('GET', `/guilds/${guild.id}/messages/search?has=bogus`, bob.token)).status).toBe(400);
    expect((await api.req('GET', `/guilds/${guild.id}/messages/search?sort_order=asc`, bob.token)).status).toBe(400);
  });

  it('filters by pinned and during', async () => {
    const owner = await api.register('sp');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Pins' })).body;
    const ch = guild.channels.find((c: any) => c.name === 'general').id;
    const post = async (content: string) => (await api.req('POST', `/channels/${ch}/messages`, owner.token, { content })).body;
    const a = await post('pinned alpha');
    const b = await post('plain beta');
    expect((await api.req('PUT', `/channels/${ch}/pins/${a.id}`, owner.token)).status).toBe(204);
    const ids = async (qs: string) => (await api.req('GET', `/guilds/${guild.id}/messages/search?${qs}`, owner.token)).body.map((m: any) => m.id);

    expect(await ids('pinned=true')).toEqual([a.id]);
    expect(await ids('pinned=false')).toEqual([b.id]);
    const day = new Date(snowflakeTime(a.id)).toISOString().slice(0, 10);
    const onDay = await ids(`during=${day}`);
    expect(onDay).toContain(a.id);
    expect(onDay).toContain(b.id);
    expect(await ids('during=2000-01-01')).toEqual([]);
    expect((await api.req('GET', `/guilds/${guild.id}/messages/search?pinned=maybe`, owner.token)).status).toBe(400);
    expect((await api.req('GET', `/guilds/${guild.id}/messages/search?during=nope`, owner.token)).status).toBe(400);
  });
});
