import { z } from 'zod';
import { snowflakeTime } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { idSchema } from '../lib/ids';
import { messagesDTO } from './serializers';

export const HAS_VALUES = ['link', 'embed', 'file', 'image', 'video', 'sticker'] as const;
export type SearchHas = (typeof HAS_VALUES)[number];

export interface SearchParams {
  viewerId: string; channelIds: string[]; guildId?: string | null;
  q?: string; authorId?: string; has?: SearchHas[]; mentions?: string; before?: string; after?: string;
  pinned?: boolean; during?: string;
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
  has: z.union([z.string(), z.string().array()]).optional(),
  mentions: idSchema.optional(),
  before: boundaryId.optional(), after: boundaryId.optional(),
  pinned: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  during: z.string().max(40).optional(),
  sort_by: z.enum(['timestamp', 'relevance']).optional(), sortBy: z.enum(['timestamp', 'relevance']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(), sortOrder: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().optional(),
}).transform((v, ctx) => {
  const raw = ([] as string[]).concat(v.has ?? []).flatMap((h) => h.split(',')).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const bad = raw.find((h) => !(HAS_VALUES as readonly string[]).includes(h));
  if (bad) { ctx.addIssue({ code: 'custom', path: ['has'], message: `unknown has filter "${bad}"` }); return z.NEVER; }
  if (v.during && !isDay(v.during)) { ctx.addIssue({ code: 'custom', path: ['during'], message: 'during must be a YYYY-MM-DD date' }); return z.NEVER; }
  return {
    q: v.q, channelId: v.channelId, mentions: v.mentions, before: v.before, after: v.after, during: v.during, limit: v.limit,
    authorId: v.authorId ?? v.author_id, has: [...new Set(raw)] as SearchHas[],
    pinned: v.pinned === undefined ? undefined : v.pinned === true || v.pinned === 'true',
    sortBy: v.sort_by ?? v.sortBy, sortOrder: v.sort_order ?? v.sortOrder,
  };
});
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
/** True when at least one narrowing filter is present (a bare before/after range or sort alone is too broad). */
export const hasSearchCriteria = (q: Pick<SearchQueryInput, 'q' | 'authorId' | 'has' | 'mentions' | 'pinned' | 'during'>) =>
  !!(q.q || q.authorId || q.has.length || q.mentions || q.pinned !== undefined || q.during);

/** Expression the Postgres GIN index is built on (migration 003). Must stay byte-identical to it. */
// Punctuation is flattened to spaces first so "foo.com" or "a/b" index as separate words (the stock parser keeps hosts/paths whole).
export const FTS_VECTOR = `to_tsvector('simple', regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))`;

/** Words of a user query, lowercased; only letters/digits survive so the tsquery cannot be malformed. */
export const searchTerms = (q: string): string[] => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
/** Prefix-AND tsquery text ("hel:* & wor:*"), or null when the input has no searchable word. */
export const toTsQuery = (q: string): string | null => { const t = searchTerms(q); return t.length ? t.map((w) => `${w}:*`).join(' & ') : null; };

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
    if (ts) { const t = push(ts); where.push(`${FTS_VECTOR} @@ to_tsquery('simple', ${t})`); rank = `ts_rank(${FTS_VECTOR}, to_tsquery('simple', ${t}))`; }
    else where.push(`content ILIKE ${push(`%${p.q.replace(/[\\%_]/g, '\\$&')}%`)}`);
  }
  if (p.authorId) where.push(`author_id = ${push(p.authorId)}`);
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
  const order = p.sortBy === 'relevance' && rank ? `${rank} ${dir}, id DESC` : `id ${dir}`;
  return { sql: `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${push(p.limit)}`, params };
}

export async function searchMessages(ctx: Ctx, p: SearchParams) {
  if (!p.channelIds.length) return [];
  const { sql, params } = buildSearchSql(ctx.search, p);
  return messagesDTO(ctx, await ctx.db.query(sql, params), p.viewerId);
}
