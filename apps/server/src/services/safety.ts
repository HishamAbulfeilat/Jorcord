import { DEFAULT_RAID_PROTECTION, DEFAULT_SAFETY_ALERTS, type SafetyAlerts, Perm, has, normalizeLinkList, type Attachment, type GuildSafety, type RaidProtection, type SafetyPreset } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { audit } from './guilds';
import { normalizeGuard } from './impersonation';
import { guildDTO, GUILD_SELECT } from './serializers';

export const normalizeRaid = (raw: unknown): RaidProtection => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RaidProtection>;
  const n = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return { enabled: r.enabled === true, maxJoins: n(r.maxJoins, DEFAULT_RAID_PROTECTION.maxJoins, 3, 100), windowSeconds: n(r.windowSeconds, DEFAULT_RAID_PROTECTION.windowSeconds, 10, 600), lockMinutes: n(r.lockMinutes, DEFAULT_RAID_PROTECTION.lockMinutes, 5, 1440) };
};

export function normalizeAlerts(row: { safety_alerts?: unknown; safety_alerts_channel_id?: string | null }): SafetyAlerts {
  const r = (row.safety_alerts && typeof row.safety_alerts === 'object' ? row.safety_alerts : {}) as Partial<SafetyAlerts>;
  return { channelId: row.safety_alerts_channel_id ?? null, raid: r.raid ?? DEFAULT_SAFETY_ALERTS.raid, massDm: r.massDm ?? DEFAULT_SAFETY_ALERTS.massDm };
}

const MESSAGES: Record<number, string> = {
  1: 'This server requires a verified email address before you can chat.',
  2: 'This server requires your account to be at least 5 minutes old before you can chat.',
  3: 'This server requires you to have been a member for more than 10 minutes before you can chat.',
  4: 'This server requires a verified email and an account older than 7 days before you can chat.',
};
const MIN = 60_000;

/**
 * Verification level gate for speaking in a server (messages, reactions, threads). The owner, bots, people with a role and managers are exempt.
 * Throws 403 VERIFICATION_REQUIRED.
 */
export async function checkVerification(ctx: Ctx, guildId: string, userId: string, perms?: bigint) {
  const [g] = await ctx.db.query('SELECT verification_level, owner_id FROM guilds WHERE id = $1', [guildId]);
  const level = (g?.verification_level ?? 0) as number;
  if (!g || level === 0 || g.owner_id === userId) return;
  if (perms !== undefined && (has(perms, Perm.MANAGE_GUILD) || has(perms, Perm.MANAGE_MESSAGES) || has(perms, Perm.MODERATE_MEMBERS))) return;
  const [u] = await ctx.db.query('SELECT verified, created_at, bot FROM users WHERE id = $1', [userId]);
  if (!u || u.bot) return;
  const [m] = await ctx.db.query('SELECT joined_at, (SELECT count(*)::int FROM member_roles r WHERE r.guild_id = $1 AND r.user_id = $2) AS roles FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  if (!m || m.roles > 0) return;
  const now = Date.now(); const age = now - new Date(u.created_at).getTime(); const tenure = now - new Date(m.joined_at).getTime();
  const ok = (level >= 1 ? u.verified : true) && (level >= 2 ? age >= 5 * MIN : true) && (level >= 3 ? tenure >= 10 * MIN : true) && (level >= 4 ? age >= 7 * 86_400_000 : true);
  if (!ok) throw new ApiError(403, 'VERIFICATION_REQUIRED', MESSAGES[level]!);
}

/** Explicit-media filter: image/video attachments of covered authors arrive blurred (spoiler) in channels that are not age-restricted. */
export async function applyMediaFilter(ctx: Ctx, channel: any, authorId: string, attachments: Attachment[]): Promise<Attachment[]> {
  if (!channel.guild_id || channel.nsfw || !attachments.some((a) => /^(image|video)\//.test(a.contentType) && !a.spoiler)) return attachments;
  const [g] = await ctx.db.query('SELECT explicit_filter, owner_id FROM guilds WHERE id = $1', [channel.guild_id]);
  const level = (g?.explicit_filter ?? 0) as number;
  if (!level || g.owner_id === authorId) return attachments; // the owner is never filtered
  const [u] = await ctx.db.query('SELECT bot FROM users WHERE id = $1', [authorId]);
  if (u?.bot) return attachments;
  if (level === 1) {
    const [r] = await ctx.db.query('SELECT count(*)::int AS n FROM member_roles WHERE guild_id = $1 AND user_id = $2', [channel.guild_id, authorId]);
    if (r.n > 0) return attachments;
  }
  return attachments.map((a) => (/^(image|video)\//.test(a.contentType) ? { ...a, spoiler: true } : a));
}

/** Joins are refused while invites are paused (raid protection or a manual pause). */
export async function assertInvitesOpen(ctx: Ctx, guildId: string) {
  const [g] = await ctx.db.query('SELECT invites_paused_until FROM guilds WHERE id = $1', [guildId]);
  if (g?.invites_paused_until && new Date(g.invites_paused_until).getTime() > Date.now()) throw new ApiError(403, 'INVITES_PAUSED', 'Invites to this server are paused right now. Try again later.');
}

/** After a join: a burst of joins inside the window pauses invites (atomic, so concurrent joiners trigger it once). */
export async function detectRaid(ctx: Ctx, guildId: string) {
  const [g] = await ctx.db.query('SELECT owner_id, raid_protection FROM guilds WHERE id = $1', [guildId]);
  const cfg = normalizeRaid(g?.raid_protection);
  if (!g || !cfg.enabled) return;
  const [c] = await ctx.db.query(`SELECT count(*)::int AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id <> $3 AND NOT u.bot AND m.joined_at > now() - ($2::int * interval '1 second')`, [guildId, cfg.windowSeconds, g.owner_id]);
  if (c.n < cfg.maxJoins) return;
  const rows = await ctx.db.query(`UPDATE guilds SET invites_paused_until = now() + ($2::int * interval '1 minute') WHERE id = $1 AND (invites_paused_until IS NULL OR invites_paused_until < now()) RETURNING *`, [guildId, cfg.lockMinutes]);
  if (!rows.length) return;
  await ctx.db.query(`UPDATE members SET raid_flagged = true WHERE guild_id = $1 AND user_id <> $3 AND joined_at > now() - ($2::int * interval '1 second')`, [guildId, cfg.windowSeconds, g.owner_id]); // moderators see "raid joined" on these members
  await audit(ctx, guildId, g.owner_id, 'RAID_DETECTED', null, { joins: c.n, windowSeconds: cfg.windowSeconds, lockMinutes: cfg.lockMinutes });
  const [fresh] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [guildId]);
  await ctx.hub.toGuild(guildId, 'GUILD_UPDATE', guildDTO(fresh));
  const { alertRaid } = await import('./safetyAlerts'); // moderator alert channel (Safety Setup > Safety alerts)
  await alertRaid(ctx, guildId, { joins: c.n, windowSeconds: cfg.windowSeconds, lockMinutes: cfg.lockMinutes });
}

export function safetyDTO(g: any): GuildSafety {
  const raid = normalizeRaid(g.raid_protection);
  const paused = g.invites_paused_until && new Date(g.invites_paused_until).getTime() > Date.now() ? new Date(g.invites_paused_until).toISOString() : null;
  const checklist = [
    { id: 'verification', done: (g.verification_level ?? 0) >= 2 },
    { id: 'explicit_filter', done: (g.explicit_filter ?? 0) >= 1 },
    { id: 'raid_protection', done: raid.enabled },
    { id: 'default_notifications', done: g.default_notifications === 'mentions' },
    { id: 'screening', done: Array.isArray(g.features) && g.features.includes('MEMBER_SCREENING') },
  ];
  const guard = normalizeGuard(g.impersonation_guard);
  return { memberDms: g.member_dms_restricted_at ? 'optin' : 'open', linkAllow: normalizeLinkList(g.link_allow), linkDeny: normalizeLinkList(g.link_deny), impersonationGuard: guard, safetyAlerts: normalizeAlerts(g),
    verificationLevel: (g.verification_level ?? 0) as 0, explicitFilter: (g.explicit_filter ?? 0) as 0, defaultNotifications: g.default_notifications ?? 'mentions', raidProtection: raid, invitesPausedUntil: paused, checklist, score: Math.round((checklist.filter((c) => c.done).length / checklist.length) * 100) };
}

export const SAFETY_PRESETS: Record<SafetyPreset, { verificationLevel: number; explicitFilter: number; defaultNotifications: 'all' | 'mentions'; raidProtection: RaidProtection }> = {
  basic: { verificationLevel: 1, explicitFilter: 0, defaultNotifications: 'mentions', raidProtection: { ...DEFAULT_RAID_PROTECTION, enabled: false } },
  recommended: { verificationLevel: 2, explicitFilter: 1, defaultNotifications: 'mentions', raidProtection: { ...DEFAULT_RAID_PROTECTION, enabled: true } },
  strict: { verificationLevel: 4, explicitFilter: 2, defaultNotifications: 'mentions', raidProtection: { enabled: true, maxJoins: 5, windowSeconds: 60, lockMinutes: 120 } },
};
