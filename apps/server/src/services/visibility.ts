import { Perm, has, type Overwrite } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { loadGuildPerms, permsFor } from './perms';
import { channelsDTO } from './serializers';
import { disconnectMember } from './voice';

export interface VisibilityScope {
  /** Limit to these channels (and the threads under them). Default: every channel of the guild. */
  channelIds?: string[];
  /** Limit to these users. Default: every member. */
  userIds?: string[];
}
type Snapshot = Map<string, Set<string>>;

/** channelId -> users who can VIEW_CHANNEL it (threads inherit their parent's overwrites). */
async function snapshot(ctx: Ctx, guildId: string, scope: VisibilityScope): Promise<Snapshot> {
  const rows = scope.channelIds
    ? await ctx.db.query(`SELECT id, type, parent_id, archived FROM channels WHERE guild_id = $1 AND (id = ANY($2::text[]) OR parent_id = ANY($2::text[]))`, [guildId, scope.channelIds])
    : await ctx.db.query('SELECT id, type, parent_id, archived FROM channels WHERE guild_id = $1', [guildId]);
  const channels = rows.filter((c) => !(c.type === 'thread' && c.archived));
  const users = scope.userIds ?? (await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1', [guildId])).map((r) => r.user_id as string);
  const gps = await loadGuildPerms(ctx, guildId, users);
  const owIds = [...new Set(channels.map((c) => (c.type === 'thread' && c.parent_id ? c.parent_id : c.id)))];
  const owRows = owIds.length ? await ctx.db.query('SELECT * FROM overwrites WHERE channel_id = ANY($1::text[])', [owIds]) : [];
  const byCh = new Map<string, Overwrite[]>();
  for (const o of owRows) { const l = byCh.get(o.channel_id) ?? []; l.push({ id: o.target_id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }); byCh.set(o.channel_id, l); }
  const out: Snapshot = new Map();
  for (const c of channels) {
    const ow = byCh.get(c.type === 'thread' && c.parent_id ? c.parent_id : c.id) ?? [];
    const viewers = new Set<string>();
    for (const gp of gps.values()) if (has(permsFor(gp, ow), Perm.VIEW_CHANNEL)) viewers.add(gp.userId);
    out.set(c.id, viewers);
  }
  return out;
}

/**
 * Call before a permission mutation; await the returned function after it. Users who lost the ability to view a
 * channel get CHANNEL_DELETE (and are dropped from its voice call); users who gained it get CHANNEL_CREATE.
 */
export async function trackVisibility(ctx: Ctx, guildId: string, scope: VisibilityScope = {}): Promise<() => Promise<void>> {
  const before = await snapshot(ctx, guildId, scope);
  return async () => {
    const after = await snapshot(ctx, guildId, scope);
    const gainedBy = new Map<string, string[]>();
    for (const [cid, now] of after) {
      const was = before.get(cid) ?? new Set<string>();
      const lost = [...was].filter((u) => !now.has(u));
      const gained = [...now].filter((u) => !was.has(u) && before.has(cid)); // brand-new channels announce themselves
      if (lost.length) {
        await ctx.hub.toUsers(lost, 'CHANNEL_DELETE', { id: cid, guildId });
        for (const u of lost) { const st = await ctx.voice.get(u); if (st?.channelId === cid) await disconnectMember(ctx, u); }
      }
      if (gained.length) gainedBy.set(cid, gained);
    }
    if (gainedBy.size) {
      const dtos = await channelsDTO(ctx, await ctx.db.query('SELECT * FROM channels WHERE id = ANY($1::text[])', [[...gainedBy.keys()]]));
      for (const dto of dtos) await ctx.hub.toUsers(gainedBy.get(dto.id)!, dto.type === 'thread' ? 'THREAD_CREATE' : 'CHANNEL_CREATE', dto);
    }
  };
}
