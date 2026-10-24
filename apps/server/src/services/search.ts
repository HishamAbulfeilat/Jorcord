import { z } from 'zod';
import { snowflakeTime } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { idSchema } from '../lib/ids';
import { messagesDTO } from './serializers';

export const HAS_VALUES = ['link', 'embed', 'file', 'image', 'video', 'sticker'] as const;
export type SearchHas = (typeof HAS_VALUES)[number];

export interface SearchParams {
  viewerId: string; channelIds: string[]; guildId?: string | null;
  q?: string; authorId?: string; authorType?: 'bot' | 'user'; has?: SearchHas[]; mentions?: string; before?: string; after?: string;
  pinned?: boolean; during?: string;
  /** Raw `from:` / `mentions:` values (id, `name`, `@name`, `name#0`): resolved to user ids by `searchMessages`, including accounts that left the server. */
  from?: string; mentionsUser?: string;
  /** Substring of a link (`link:example.com`) in the text, embed urls or attachment names. */
  link?: string; offset?: number;
  sortBy?: 'timestamp' | 'relevance'; sortOrder?: 'asc' | 'desc'; limit: number;
}

/** Snowflake id or ISO date/datetime -> smallest snowflake of that instant; `null` when neither parses. */
const boundId = (v: string): string | null => {
  if (/^\d{1,20}$/.test(v)) return v;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const rel = BigInt(ms) - BigInt(snowflakeTime('0'));
  return (rel > 0n ? rel << 22n : 0n).toString();
};

/** Discord-style bound: a snowflake id or an ISO date/datetime. Dates become the smallest snowflake of that instant. */
export const boundaryId = z.string().max(40).transform((v, ctx) => {
  const id = boundId(v);
  if (id === null) { ctx.addIssue({ code: 'custom', message: 'must be a snowflake or ISO date' }); return z.NEVER; }
  return id;
});

/** `during:` takes a single UTC calendar day. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string) => DAY.test(v) && Number.isFinite(Date.parse(v));

/** Query-string schema shared by the three search routes. `has` may repeat or be comma-separated; snake_case aliases accepted. */
export const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  authorId: idSchema.optional(), author_id: idSchema.optional(),
  channelId: idSchema.optional(),
  authorType: z.enum(['bot', 'user']).optional(), author_type: z.enum(['bot', 'user']).optional(),
  has: z.union([z.string(), z.string().array()]).optional(),
  mentions: idSchema.optional(),
  before: boundaryId.optional(), after: boundaryId.optional(),
  pinned: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  during: z.string().max(40).optional(),
  from: z.string().trim().min(1).max(64).optional(), mentionsUser: z.string().trim().min(1).max(64).optional(), mentions_user: z.string().trim().min(1).max(64).optional(),
  link: z.string().trim().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(5000).optional(),
  sort_by: z.enum(['timestamp', 'relevance']).optional(), sortBy: z.enum(['timestamp', 'relevance']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(), sortOrder: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().optional(),
}).transform((v, ctx) => {
  const raw = ([] as string[]).concat(v.has ?? []).flatMap((h) => h.split(',')).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const bad = raw.find((h) => !(HAS_VALUES as readonly string[]).includes(h));
  if (bad) { ctx.addIssue({ code: 'custom', path: ['has'], message: `unknown has filter "${bad}"` }); return z.NEVER; }
  if (v.during && !isDay(v.during)) { ctx.addIssue({ code: 'custom', path: ['during'], message: 'during must be a YYYY-MM-DD date' }); return z.NEVER; }
  return {
    q: v.q, channelId: v.channelId, mentions: v.mentions, from: v.from, mentionsUser: v.mentionsUser ?? v.mentions_user, link: v.link, offset: v.offset, before: v.before, after: v.after, during: v.during, limit: v.limit,
    authorId: v.authorId ?? v.author_id, authorType: v.authorType ?? v.author_type, has: [...new Set(raw)] as SearchHas[],
    pinned: v.pinned === undefined ? undefined : v.pinned === true || v.pinned === 'true',
    sortBy: v.sort_by ?? v.sortBy, sortOrder: v.sort_order ?? v.sortOrder,
  };
});
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
/** True when at least one narrowing filter is present (a bare before/after range or sort alone is too broad). */
export const hasSearchCriteria = (q: Pick<SearchQueryInput, 'q' | 'authorId' | 'authorType' | 'has' | 'mentions' | 'pinned' | 'during'> & Partial<Pick<SearchQueryInput, 'from' | 'mentionsUser' | 'link'>>) =>
  !!(q.q || q.authorId || q.authorType || q.has.length || q.mentions || q.pinned !== undefined || q.during || q.from || q.mentionsUser || q.link);

/** Expression the Postgres GIN index is built on (migration 003). Must stay byte-identical to it. */
// Punctuation is flattened to spaces first so "foo.com" or "a/b" index as separate words (the stock parser keeps hosts/paths whole).
export const FTS_VECTOR = `to_tsvector('simple', regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))`;
/** Same for embed text + attachment names/alt (`search_extra`, migrations 140/141; partial index `WHERE search_extra IS NOT NULL`). */
export const FTS_EXTRA_VECTOR = `to_tsvector('simple', regexp_replace(search_extra, '[^[:alnum:]]+', ' ', 'g'))`;

/** Words of a user query, lowercased; only letters/digits survive so the tsquery cannot be malformed. */
export const searchTerms = (q: string): string[] => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
/** Prefix-AND tsquery text ("hel:* & wor:*"), or null when the input has no searchable word. */
export const toTsQuery = (q: string): string | null => { const t = searchTerms(q); return t.length ? t.map((w) => `${w}:*`).join(' & ') : null; };

const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

const HAS: Record<SearchHas, string> = {
  link: 'has_link', image: 'has_image', file: 'has_file', embed: "embeds <> '[]'::jsonb", sticker: "sticker_ids <> '[]'::jsonb",
  video: "(EXISTS (SELECT 1 FROM jsonb_array_elements(attachments) a WHERE a->>'contentType' LIKE 'video/%') OR EXISTS (SELECT 1 FROM jsonb_array_elements(embeds) e WHERE e->>'type' = 'video'))",
};

/**
 * Message search. Postgres uses full-text search (GIN, word-prefix matching); embedded PGlite and queries with no
 * searchable word fall back to a case-insensitive substring match.
 */
export function buildSearchSql(mode: Ctx['search'], p: Omit<SearchParams, 'viewerId'>): { sql: string; params: unknown[] } {
  const params: unknown[] = [p.channelIds];
  const where: string[] = ['channel_id = ANY($1::text[])'];
  const push = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (p.guildId) where.push(`guild_id = ${push(p.guildId)}`);
  let rank = '';
  if (p.q) {
    const ts = mode === 'fts' ? toTsQuery(p.q) : null;
    // text, embed title/description/url and attachment filename/alt text are all searchable
    if (ts) {
      const t = push(ts);
      where.push(`(${FTS_VECTOR} @@ to_tsquery('simple', ${t}) OR (search_extra IS NOT NULL AND ${FTS_EXTRA_VECTOR} @@ to_tsquery('simple', ${t})))`);
      rank = `ts_rank(${FTS_VECTOR}, to_tsquery('simple', ${t})) + 0.5 * coalesce(ts_rank(${FTS_EXTRA_VECTOR}, to_tsquery('simple', ${t})), 0)`;
    } else { const l = push(`%${escapeLike(p.q)}%`); where.push(`(content ILIKE ${l} OR search_extra ILIKE ${l})`); }
  }
  if (p.link) { const l = push(`%${escapeLike(p.link)}%`); where.push(`(content ILIKE ${l} OR search_extra ILIKE ${l})`); }
  if (p.authorId) where.push(`author_id = ${push(p.authorId)}`);
  if (p.authorType) where.push(`author_id ${p.authorType === 'bot' ? 'IN' : 'NOT IN'} (SELECT id FROM users WHERE bot = true)`);
  if (p.mentions) where.push(`mentions @> ${push(JSON.stringify([p.mentions]))}::jsonb`);
  if (p.before) where.push(`id < ${push(p.before)}`);
  if (p.after) where.push(`id > ${push(p.after)}`);
  if (p.during) { // one UTC day: `[day start, next day start)`
    const start = Date.parse(`${p.during}T00:00:00Z`);
    where.push(`id >= ${push(boundId(new Date(start).toISOString())!)}`);
    where.push(`id < ${push(boundId(new Date(start + 86_400_000).toISOString())!)}`);
  }
  if (p.pinned !== undefined) where.push(p.pinned ? 'pinned' : 'NOT pinned');
  for (const h of p.has ?? []) where.push(HAS[h]);
  const dir = p.sortOrder === 'asc' ? 'ASC' : 'DESC';
  // Relevance only exists for full-text queries; otherwise (and as tie-break) order by id, which is time order.
  // `id` is unique, so every order is total: pages never overlap or skip when rows tie on rank.
  const order = p.sortBy === 'relevance' && rank ? `${rank} ${dir}, id DESC` : `id ${dir}`;
  const limit = push(p.limit);
  return { sql: `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}${p.offset ? ` OFFSET ${push(p.offset)}` : ''}`, params };
}

/**
 * Resolves a `from:` / `mentions:` value to a user id. Ids pass through; `name`, `@name` and `name#0` match the account
 * username (case-insensitive), then display name / server nickname among the server's members. Accounts that left the
 * server still resolve (their messages stay searchable); a deleted account does not. `null` = nobody matches.
 */
export async function resolveSearchUser(ctx: Ctx, value: string, guildId?: string | null): Promise<string | null> {
  const v = value.replace(/^<@!?(\d+)>$/, '$1').replace(/^@/, '').replace(/#0*$/, '').trim().toLowerCase();
  if (!v) return null;
  if (/^\d{1,20}$/.test(v)) return v;
  const [u] = await ctx.db.query('SELECT id FROM users WHERE lower(username) = $1 AND deleted_at IS NULL LIMIT 1', [v]);
  if (u) return u.id as string;
  if (guildId) {
    const [m] = await ctx.db.query('SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND (lower(m.nick) = $2 OR lower(u.display_name) = $2) LIMIT 1', [guildId, v]);
    if (m) return m.user_id as string;
  }
  return null;
}

export async function searchMessages(ctx: Ctx, p: SearchParams) {
  if (!p.channelIds.length) return [];
  if (p.from) { const id = await resolveSearchUser(ctx, p.from, p.guildId); if (!id) return []; p = { ...p, authorId: id, from: undefined }; }
  if (p.mentionsUser) { const id = await resolveSearchUser(ctx, p.mentionsUser, p.guildId); if (!id) return []; p = { ...p, mentions: id, mentionsUser: undefined }; }
  // secret chats are never searchable: the server holds only ciphertext (docs/E2EE_DMS.md)
  const secret = new Set((await ctx.db.query('SELECT id FROM channels WHERE id = ANY($1::text[]) AND encrypted', [p.channelIds])).map((r) => r.id as string));
  if (secret.size) { p = { ...p, channelIds: p.channelIds.filter((c) => !secret.has(c)) }; if (!p.channelIds.length) return []; }
  const { sql, params } = buildSearchSql(ctx.search, p);
  return messagesDTO(ctx, await ctx.db.query(sql, params), p.viewerId);
}
