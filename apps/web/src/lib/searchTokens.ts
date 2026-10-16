import type { Id, Member } from '@jorcord/shared';

export const SEARCH_HAS = ['link', 'embed', 'file', 'image', 'video', 'sticker'] as const;
export type SearchHasValue = (typeof SEARCH_HAS)[number];

export interface ParsedSearch {
  /** Free text left after tokens are removed. */
  text: string;
  /** Raw `from:` values (usernames, `<@id>` or ids), resolved later with `resolveUser`. */
  from: string[];
  mentions: string[];
  has: SearchHasValue[];
  /** Snowflake or ISO date string, exactly as the server accepts it. */
  before?: string;
  after?: string;
  sortBy?: 'timestamp' | 'relevance';
  sortOrder?: 'asc' | 'desc';
}

const ID = /^\d{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** `<@123>` / `<@!123>` / `@name` -> bare value. */
const stripMention = (v: string) => v.replace(/^<@!?(\d+)>$/, '$1').replace(/^@/, '');
const validBound = (v: string) => ID.test(v) || (DATE.test(v) && Number.isFinite(Date.parse(v.replace(' ', 'T'))));

/** Splits on whitespace, keeping `key:"quoted value"` and `"quoted phrase"` together. */
function tokenize(input: string): string[] {
  return input.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) ?? [];
}

/**
 * Pulls Discord-style filter tokens (`from:`, `mentions:`, `has:`, `before:`, `after:`, `sort:`, `order:`) out of a search
 * box string. Unknown keys and invalid values (`has:banana`, `before:soon`) are kept as plain search text.
 */
export function parseSearchTokens(input: string): ParsedSearch {
  const out: ParsedSearch = { text: '', from: [], mentions: [], has: [] };
  const rest: string[] = [];
  for (const tok of tokenize(input)) {
    const m = /^(from|mentions|has|before|after|sort|order):(.*)$/i.exec(tok);
    const value = m ? m[2]!.replace(/^"(.*)"$/, '$1').trim() : '';
    if (!m || !value) { rest.push(tok); continue; }
    const key = m[1]!.toLowerCase();
    if (key === 'from') out.from.push(stripMention(value));
    else if (key === 'mentions') out.mentions.push(stripMention(value));
    else if (key === 'has') {
      const h = value.toLowerCase();
      if ((SEARCH_HAS as readonly string[]).includes(h)) { if (!out.has.includes(h as SearchHasValue)) out.has.push(h as SearchHasValue); } else rest.push(tok);
    } else if (key === 'before' || key === 'after') {
      if (validBound(value)) out[key] = value; else rest.push(tok);
    } else if (key === 'sort') {
      const v = value.toLowerCase();
      if (v === 'timestamp' || v === 'relevance') out.sortBy = v; else rest.push(tok);
    } else {
      const v = value.toLowerCase();
      if (v === 'asc' || v === 'desc') out.sortOrder = v; else rest.push(tok);
    }
  }
  out.text = rest.join(' ').replace(/\s+/g, ' ').trim();
  return out;
}

/** Resolves a `from:`/`mentions:` value to a user id: ids pass through, names match username / display name / nickname. */
export function resolveUser(value: string, members: Iterable<Pick<Member, 'user' | 'nick'>>): Id | null {
  if (ID.test(value)) return value;
  const v = value.toLowerCase();
  for (const m of members) {
    const u = m.user;
    if ([u.username, u.displayName, m.nick].some((n) => n && n.toLowerCase() === v)) return u.id;
  }
  return null;
}

export interface SearchRequest { q?: string; authorId?: Id; mentions?: Id; has?: string; before?: string; after?: string; sort_by?: string; sort_order?: string }

/**
 * Turns parsed tokens into API query params. A `from:`/`mentions:` name that matches nobody sets `unresolved` so the UI can
 * say so instead of silently searching everyone. Only the first value of each user filter is sent (the API takes one).
 */
export function toSearchRequest(p: ParsedSearch, members: Iterable<Pick<Member, 'user' | 'nick'>>): { req: SearchRequest; unresolved: string[] } {
  const list = [...members]; const unresolved: string[] = [];
  const one = (vals: string[]) => { for (const v of vals) { const id = resolveUser(v, list); if (id) return id; unresolved.push(v); } return undefined; };
  const req: SearchRequest = {
    q: p.text || undefined, authorId: one(p.from), mentions: one(p.mentions), has: p.has.length ? p.has.join(',') : undefined,
    before: p.before, after: p.after, sort_by: p.sortBy, sort_order: p.sortOrder,
  };
  return { req, unresolved };
}
