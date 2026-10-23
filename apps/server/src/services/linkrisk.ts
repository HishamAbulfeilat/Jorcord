import { linkWarnings, normalizeLinkList, type LinkLists, type LinkWarning } from '@jorcord/shared';
import type { Ctx } from '../ctx';

/** Cheap pre-check so ordinary chat never pays for link scoring: only text with something domain-shaped is looked at. */
const MAYBE_LINK = /[\p{L}\p{N}-]\.[\p{L}\p{N}-]{2,}|https?:\/\//u;

/** A server's allow/deny lists (hostnames). */
export async function guildLinkLists(ctx: Ctx, guildId: string): Promise<LinkLists> {
  const [g] = await ctx.db.query('SELECT link_allow, link_deny FROM guilds WHERE id = $1', [guildId]);
  return { allow: normalizeLinkList(g?.link_allow), deny: normalizeLinkList(g?.link_deny) };
}

/** Link warnings for a batch of message rows (one query for all distinct servers). Rows without suspicious links are absent from the map. */
export async function warningsForRows(ctx: Ctx, rows: any[]): Promise<Map<string, LinkWarning[]>> {
  const out = new Map<string, LinkWarning[]>();
  const cands = rows.filter((r) => typeof r.content === 'string' && r.content.length >= 4 && (r.type === 'default' || r.type === 'reply') && MAYBE_LINK.test(r.content));
  if (!cands.length) return out;
  const gids = [...new Set(cands.map((r) => r.guild_id).filter(Boolean))] as string[];
  const lists = new Map<string, LinkLists>();
  if (gids.length) for (const g of await ctx.db.query('SELECT id, link_allow, link_deny FROM guilds WHERE id = ANY($1::text[])', [gids])) lists.set(g.id, { allow: normalizeLinkList(g.link_allow), deny: normalizeLinkList(g.link_deny) });
  for (const r of cands) {
    const w = linkWarnings(r.content, r.guild_id ? lists.get(r.guild_id) : undefined);
    if (w.length) out.set(r.id, w);
  }
  return out;
}
