import type { Overwrite } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import type { EventBus } from '../bus';
import { randomToken } from '../lib/crypto';

/**
 * In-process cache of everything permission computation and gateway fan-out read:
 * guild owner + roles, per-member role ids / timeout, channel topology (id, guild, type, parent), channel overwrites and DM participants.
 *
 * Correctness rules:
 *  - every mutation of those tables calls one of the invalidate* helpers AFTER the write (and before any event/visibility diff that re-reads);
 *  - invalidations are applied locally and synchronously, then published on the bus so other nodes drop the same keys;
 *  - fills are guarded by a generation counter: a fill that overlaps an invalidation is returned to its caller but never stored;
 *  - member timeouts are stored as absolute timestamps and compared at use time, so they expire without any invalidation.
 * Only message-independent, rarely-changing columns are cached (never last_message_id etc).
 */
export interface MemberEntry { timeoutMs: number | null; roleIds: string[]; /** membership screening not yet accepted: read-only like a timeout */ pending?: boolean }
interface GuildEntry { ownerId: string; rolePerms: Record<string, bigint>; rolePos: Record<string, number>; members: Map<string, MemberEntry | null> }
export interface ChannelLite { id: string; guild_id: string | null; type: string; parent_id: string | null; thread_private?: boolean }

export type Invalidation =
  | { k: 'guild'; guildId: string }                       // guild row, roles, channels, overwrites, members of the guild (delete/ownership/roles)
  | { k: 'member'; guildId: string; userId: string }       // one member's roles/timeout/existence (join, leave, ban, kick, role assign, timeout)
  | { k: 'channel'; channelId: string }                   // one channel's topology + overwrites (patch/move)
  | { k: 'overwrites'; channelId: string }                // one channel's overwrites
  | { k: 'dm'; channelId: string }                        // DM participants
  | { k: 'user'; userId: string };                        // a user everywhere (account deletion)
type Msg = Invalidation & { n: string };

const MAX_GUILDS = 5000, MAX_CHANNELS = 100_000, MAX_DMS = 100_000;

export class PermCache {
  private gen = 0;
  private guilds = new Map<string, GuildEntry>();
  private channels = new Map<string, ChannelLite>();
  private overwrites = new Map<string, Overwrite[]>();
  private dms = new Map<string, Set<string>>();
  private chByGuild = new Map<string, Set<string>>();
  private readonly node = randomToken(8);
  private bus?: EventBus; private topic = '';
  private sweep?: NodeJS.Timeout;
  stats = { hits: 0, misses: 0, invalidations: 0 };
  /** Diagnostic switch (load test baseline): false makes every read a miss and stores nothing. */
  enabled = true;

  async init(bus: EventBus, prefix: string, redis: boolean) {
    this.bus = bus; this.topic = `${prefix}:permcache`;
    await bus.subscribe(this.topic, (m) => { const msg = m as Msg; if (msg && msg.n !== this.node) this.apply(msg); });
    // Belt and braces: if a pub/sub message were ever lost, entries still self-heal within minutes.
    if (redis) { this.sweep = setInterval(() => this.clear(), 5 * 60_000); this.sweep.unref(); }
  }
  close() { if (this.sweep) clearInterval(this.sweep); }
  clear() { this.gen++; this.guilds.clear(); this.channels.clear(); this.overwrites.clear(); this.dms.clear(); this.chByGuild.clear(); }

  // ---- invalidation ----
  /** Apply locally (sync) and tell the other nodes. Await it before emitting events that depend on the new state. */
  async invalidate(i: Invalidation) {
    this.apply(i);
    if (this.bus) await this.bus.publish(this.topic, { ...i, n: this.node });
  }
  private apply(i: Invalidation) {
    this.gen++; this.stats.invalidations++;
    switch (i.k) {
      case 'guild': {
        this.guilds.delete(i.guildId);
        for (const c of this.chByGuild.get(i.guildId) ?? []) { this.channels.delete(c); this.overwrites.delete(c); }
        this.chByGuild.delete(i.guildId);
        break;
      }
      case 'member': this.guilds.get(i.guildId)?.members.delete(i.userId); break;
      case 'channel': this.dropChannel(i.channelId); break;
      case 'overwrites': this.overwrites.delete(i.channelId); break;
      case 'dm': this.dms.delete(i.channelId); this.channels.delete(i.channelId); break;
      case 'user': {
        for (const g of this.guilds.values()) g.members.delete(i.userId);
        for (const [id, s] of this.dms) if (s.has(i.userId)) this.dms.delete(id);
        break;
      }
    }
  }
  private dropChannel(id: string) {
    const c = this.channels.get(id);
    if (c?.guild_id) this.chByGuild.get(c.guild_id)?.delete(id);
    this.channels.delete(id); this.overwrites.delete(id);
    // threads under this channel point at it; drop them so their (type, parent) is re-read too
    for (const [tid, t] of this.channels) if (t.parent_id === id) { this.channels.delete(tid); this.chByGuild.get(t.guild_id ?? '')?.delete(tid); }
  }

  // ---- reads (fill on miss) ----
  private evict<K, V>(m: Map<K, V>, max: number) { while (m.size > max) m.delete(m.keys().next().value as K); }

  async channel(ctx: Ctx, id: string): Promise<ChannelLite | null> {
    if (!this.enabled) this.clear();
    const hit = this.channels.get(id);
    if (hit) { this.stats.hits++; return hit; }
    this.stats.misses++;
    const g = this.gen;
    const [r] = await ctx.db.query('SELECT id, guild_id, type, parent_id, thread_private FROM channels WHERE id = $1', [id]);
    if (!r) return null; // absent channels are never cached, so creation needs no invalidation
    const c: ChannelLite = { id: r.id, guild_id: r.guild_id ?? null, type: r.type, parent_id: r.parent_id ?? null, thread_private: !!r.thread_private };
    if (g === this.gen) this.putChannel(c);
    return c;
  }
  private putChannel(c: ChannelLite) {
    this.channels.set(c.id, c); this.evict(this.channels, MAX_CHANNELS);
    if (c.guild_id) { let s = this.chByGuild.get(c.guild_id); if (!s) this.chByGuild.set(c.guild_id, s = new Set()); s.add(c.id); }
  }

  async channelOverwrites(ctx: Ctx, channelId: string): Promise<Overwrite[]> {
    if (!this.enabled) this.clear();
    const hit = this.overwrites.get(channelId);
    if (hit) { this.stats.hits++; return hit; }
    this.stats.misses++;
    const g = this.gen;
    const rows = await ctx.db.query('SELECT * FROM overwrites WHERE channel_id = $1', [channelId]);
    const ow = rows.map((o) => ({ id: o.target_id as string, type: o.type as 'role' | 'member', allow: BigInt(o.allow), deny: BigInt(o.deny) }));
    await this.channel(ctx, channelId); // registers the channel under its guild so a guild invalidation drops these overwrites too
    if (g === this.gen && this.channels.has(channelId)) { this.overwrites.set(channelId, ow); this.evict(this.overwrites, MAX_CHANNELS); }
    return ow;
  }

  async dmParticipants(ctx: Ctx, channelId: string): Promise<Set<string>> {
    if (!this.enabled) this.clear();
    const hit = this.dms.get(channelId);
    if (hit) { this.stats.hits++; return hit; }
    this.stats.misses++;
    const g = this.gen;
    const set = new Set((await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1', [channelId])).map((r) => r.user_id as string));
    if (g === this.gen) { this.dms.set(channelId, set); this.evict(this.dms, MAX_DMS); }
    return set;
  }

  /** Guild skeleton + the requested members (null = not a member). Returns null if the guild does not exist. */
  async guildMembers(ctx: Ctx, guildId: string, userIds: string[]): Promise<{ guild: GuildEntry; members: Map<string, MemberEntry | null> } | null> {
    if (!this.enabled) this.clear();
    let guild = this.guilds.get(guildId);
    if (!guild) {
      this.stats.misses++;
      const g = this.gen;
      const [gr] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guildId]);
      if (!gr) return null;
      const roles = await ctx.db.query('SELECT id, permissions, position FROM roles WHERE guild_id = $1', [guildId]);
      const rolePerms: Record<string, bigint> = {}, rolePos: Record<string, number> = {};
      for (const r of roles) { rolePerms[r.id] = BigInt(r.permissions); rolePos[r.id] = r.position; }
      guild = { ownerId: gr.owner_id, rolePerms, rolePos, members: new Map() };
      if (g === this.gen) { this.guilds.set(guildId, guild); this.evict(this.guilds, MAX_GUILDS); }
    } else this.stats.hits++;
    const out = new Map<string, MemberEntry | null>();
    const missing: string[] = [];
    for (const u of userIds) { const m = guild.members.get(u); if (m !== undefined) out.set(u, m); else missing.push(u); }
    if (missing.length) {
      this.stats.misses++;
      const g = this.gen;
      const members = await ctx.db.query('SELECT user_id, timeout_until, pending FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])', [guildId, missing]);
      const mr = await ctx.db.query('SELECT user_id, role_id FROM member_roles WHERE guild_id = $1 AND user_id = ANY($2::text[])', [guildId, missing]);
      const roleIds = new Map<string, string[]>();
      for (const x of mr) { const l = roleIds.get(x.user_id); if (l) l.push(x.role_id); else roleIds.set(x.user_id, [x.role_id]); }
      const found = new Map<string, MemberEntry>();
      for (const m of members) found.set(m.user_id, { timeoutMs: m.timeout_until ? new Date(m.timeout_until).getTime() : null, roleIds: roleIds.get(m.user_id) ?? [], pending: !!m.pending });
      const store = g === this.gen && this.guilds.get(guildId) === guild; // skip storing if anything was invalidated while we were reading
      for (const u of missing) { const e = found.get(u) ?? null; out.set(u, e); if (store) guild.members.set(u, e); }
    }
    return { guild, members: out };
  }
}
