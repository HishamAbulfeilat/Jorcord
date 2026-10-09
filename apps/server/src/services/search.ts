import type { Ctx } from '../ctx';
import { messagesDTO } from './serializers';

export interface SearchParams {
  viewerId: string; channelIds: string[]; guildId?: string | null;
  q?: string; authorId?: string; has?: 'link' | 'image' | 'file' | 'embed' | 'sticker'; before?: string; limit: number;
}

/** Expression the Postgres GIN index is built on (migration 003). Must stay byte-identical to it. */
// Punctuation is flattened to spaces first so "foo.com" or "a/b" index as separate words (the stock parser keeps hosts/paths whole).
export const FTS_VECTOR = `to_tsvector('simple', regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))`;

/** Words of a user query, lowercased; only letters/digits survive so the tsquery cannot be malformed. */
export const searchTerms = (q: string): string[] => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
/** Prefix-AND tsquery text ("hel:* & wor:*"), or null when the input has no searchable word. */
export const toTsQuery = (q: string): string | null => { const t = searchTerms(q); return t.length ? t.map((w) => `${w}:*`).join(' & ') : null; };

const HAS: Record<NonNullable<SearchParams['has']>, string> = { link: 'has_link', image: 'has_image', file: 'has_file', embed: "embeds <> '[]'::jsonb", sticker: "sticker_ids <> '[]'::jsonb" };

/**
 * Message search. Postgres uses full-text search (GIN, word-prefix matching); embedded PGlite and queries with no
 * searchable word fall back to a case-insensitive substring match.
 */
export function buildSearchSql(mode: Ctx['search'], p: Omit<SearchParams, 'viewerId'>): { sql: string; params: unknown[] } {
  const params: unknown[] = [p.channelIds];
  const where: string[] = ['channel_id = ANY($1::text[])'];
  const push = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (p.guildId) where.push(`guild_id = ${push(p.guildId)}`);
  if (p.q) {
    const ts = mode === 'fts' ? toTsQuery(p.q) : null;
    if (ts) where.push(`${FTS_VECTOR} @@ to_tsquery('simple', ${push(ts)})`);
    else where.push(`content ILIKE ${push(`%${p.q.replace(/[\\%_]/g, '\\$&')}%`)}`);
  }
  if (p.authorId) where.push(`author_id = ${push(p.authorId)}`);
  if (p.before) where.push(`id < ${push(p.before)}`);
  if (p.has) where.push(HAS[p.has]);
  return { sql: `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${push(p.limit)}`, params };
}

export async function searchMessages(ctx: Ctx, p: SearchParams) {
  if (!p.channelIds.length) return [];
  const { sql, params } = buildSearchSql(ctx.search, p);
  return messagesDTO(ctx, await ctx.db.query(sql, params), p.viewerId);
}
