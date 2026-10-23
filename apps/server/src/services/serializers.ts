import { UserFlags, boostLevelFor, snowflakeTime } from '@jorcord/shared';
import type { Activity, Attachment, Channel, Component, Embed, Guild, Member, Message, OverwriteDTO, Poll, Reaction, Role, SelfUser, User } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { warningsForRows } from './linkrisk';
import { normalizePrivacy } from './privacy';

export const boostLevel = boostLevelFor;

/** A custom status past its `expiresAt` reads as cleared everywhere (the sweeper also clears the row and tells peers). */
export function liveStatus(cs: any): User['customStatus'] {
  if (!cs) return null;
  if (cs.expiresAt && Date.parse(cs.expiresAt) <= Date.now()) return null;
  return cs;
}
/** Activities others may see: nothing while offline/invisible or when the owner switched "share my activity" off. */
export function publicActivities(ctx: Ctx, userId: string, row: { presence?: string; activities?: unknown; privacy?: unknown }): Activity[] {
  if (!ctx.hub.isOnline(userId) || row.presence === 'invisible') return [];
  if (!normalizePrivacy(row.privacy).showActivity) return [];
  return Array.isArray(row.activities) ? (row.activities as Activity[]) : [];
}
export function userDTO(ctx: Ctx, r: any): User {
  return {
    id: r.id, username: r.username, displayName: r.display_name ?? null, avatar: r.avatar ?? null, banner: r.banner ?? null,
    accentColor: r.accent_color ?? null, bio: r.bio ?? null, pronouns: r.pronouns ?? null, bot: !!r.bot,
    createdAt: iso(r.created_at)!, customStatus: liveStatus(r.custom_status), themeColors: r.theme_colors ?? null,
    avatarDecoration: r.avatar_decoration ?? null, profileEffect: r.profile_effect ?? null, namePlate: r.name_plate ?? null, serverTag: r.server_tag ?? null, presence: ctx.hub.publicPresence(r.id, r.presence),
    publicFlags: (r.public_flags ?? 0) | (ctx.config.superAdminId && r.id === ctx.config.superAdminId ? UserFlags.STAFF : 0),
  };
}
export function selfUserDTO(ctx: Ctx, r: any): SelfUser {
  return { ...userDTO(ctx, r), privacy: normalizePrivacy(r.privacy), ageConfirmed: !!r.age_confirmed_at, presence: r.presence, email: r.email, mfaEnabled: !!r.mfa_enabled, verified: !!r.verified, theme: r.theme, settings: r.settings ?? {} };
}
export async function usersByIds(ctx: Ctx, ids: string[]): Promise<Map<string, User>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = await ctx.db.query('SELECT * FROM users WHERE id = ANY($1::text[])', [uniq]);
  return new Map(rows.map((r) => [r.id, userDTO(ctx, r)]));
}
export async function getUser(ctx: Ctx, id: string): Promise<User | null> { return (await usersByIds(ctx, [id])).get(id) ?? null; }

export const GUILD_SELECT = 'SELECT g.*, (SELECT count(*) FROM boosts b WHERE b.guild_id = g.id)::int AS boost_count FROM guilds g';
export function guildDTO(r: any): Guild {
  return {
    id: r.id, name: r.name, icon: r.icon ?? null, banner: r.banner ?? null, description: r.description ?? null, ownerId: r.owner_id,
    systemChannelId: r.system_channel_id ?? null, rulesChannelId: r.rules_channel_id ?? null,
    boostLevel: boostLevel(r.boost_count ?? 0), boostCount: r.boost_count ?? 0, features: r.features ?? [], vanityUrl: r.vanity_url ?? null, createdAt: iso(r.created_at)!, tag: r.tag ?? null, tagBadge: r.tag_badge ?? null,
    verificationLevel: (r.verification_level ?? 0) as 0, explicitFilter: (r.explicit_filter ?? 0) as 0, defaultNotifications: r.default_notifications ?? 'mentions', welcomeScreen: r.welcome_screen ?? null,
    memberDms: r.member_dms_restricted_at ? 'optin' : 'open',
    invitesPausedUntil: r.invites_paused_until && new Date(r.invites_paused_until).getTime() > Date.now() ? iso(r.invites_paused_until) : null,
  };
}
export const roleDTO = (r: any): Role => ({ id: r.id, guildId: r.guild_id, name: r.name, color: r.color, colorSecondary: r.color_secondary ?? null, hoist: r.hoist, position: r.position, permissions: r.permissions, mentionable: r.mentionable, icon: r.icon ?? null });
export const overwriteDTO = (o: any): OverwriteDTO => ({ id: o.target_id, type: o.type, allow: o.allow, deny: o.deny });

export async function channelsDTO(ctx: Ctx, rows: any[]): Promise<Channel[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ows = await ctx.db.query('SELECT * FROM overwrites WHERE channel_id = ANY($1::text[])', [ids]);
  const dmIds = rows.filter((r) => r.type === 'dm' || r.type === 'group_dm').map((r) => r.id);
  const recips = dmIds.length ? await ctx.db.query('SELECT channel_id, user_id FROM dm_participants WHERE channel_id = ANY($1::text[])', [dmIds]) : [];
  const users = await usersByIds(ctx, recips.map((r) => r.user_id));
  return rows.map((r) => ({
    id: r.id, guildId: r.guild_id ?? null, type: r.type, name: r.name ?? null, topic: r.topic ?? null, position: r.position,
    parentId: r.parent_id ?? null, nsfw: r.nsfw, slowmode: r.slowmode, bitrate: r.bitrate ?? null, userLimit: r.user_limit ?? null,
    overwrites: ows.filter((o) => o.channel_id === r.id).map(overwriteDTO), lastMessageId: r.last_message_id ?? null,
    ...(r.type === 'group_dm' ? { icon: r.icon ?? null } : {}),
    ...(r.type === 'dm' || r.type === 'group_dm' ? { recipients: recips.filter((p) => p.channel_id === r.id).map((p) => users.get(p.user_id)!).filter(Boolean) } : {}),
    ownerId: r.owner_id ?? null, archived: r.archived, createdAt: iso(r.created_at)!, isClipsChannel: !!r.is_clips_channel,
    ...(r.type === 'forum' || r.type === 'media' ? { availableTags: r.available_tags ?? [], requireTag: !!r.require_tag, defaultAutoArchiveDuration: r.default_auto_archive ?? 1440, defaultSortOrder: (r.default_sort_order ?? 'latest_activity') as 'latest_activity' | 'creation_date', defaultForumLayout: (r.default_forum_layout ?? 'list') as 'list' | 'gallery', defaultReactionEmoji: r.default_reaction_emoji ?? null } : {}),
    ...(r.type === 'thread' ? {
      appliedTags: r.applied_tags ?? [], autoArchiveDuration: r.auto_archive_minutes ?? 1440, locked: !!r.locked,
      ...(r.thread_private ? { private: true, invitable: r.thread_invitable !== false } : {}),
      archiveAt: r.archived ? null : new Date(new Date(r.activity_at ?? r.created_at).getTime() + (r.auto_archive_minutes ?? 1440) * 60_000).toISOString(),
    } : {}),
  }));
}
export async function channelDTO(ctx: Ctx, row: any): Promise<Channel> { return (await channelsDTO(ctx, [row]))[0]!; }

export async function membersDTO(ctx: Ctx, rows: any[]): Promise<Member[]> {
  if (!rows.length) return [];
  const users = await usersByIds(ctx, rows.map((r) => r.user_id));
  const guildIds = [...new Set(rows.map((r) => r.guild_id))];
  const roles = await ctx.db.query('SELECT guild_id, user_id, role_id FROM member_roles WHERE guild_id = ANY($1::text[]) AND user_id = ANY($2::text[])', [guildIds, rows.map((r) => r.user_id)]);
  const boosts = await ctx.db.query('SELECT guild_id, user_id, min(created_at) AS since FROM boosts WHERE guild_id = ANY($1::text[]) AND user_id = ANY($2::text[]) GROUP BY guild_id, user_id', [guildIds, rows.map((r) => r.user_id)]);
  return rows.filter((r) => users.has(r.user_id)).map((r) => ({
    guildId: r.guild_id, user: users.get(r.user_id)!, nick: r.nick ?? null,
    roles: roles.filter((x) => x.guild_id === r.guild_id && x.user_id === r.user_id).map((x) => x.role_id),
    joinedAt: iso(r.joined_at)!, timeoutUntil: iso(r.timeout_until), avatar: r.avatar ?? null,
    banner: r.banner ?? null, bio: r.bio ?? null, pronouns: r.pronouns ?? null, pending: !!r.pending,
    boostingSince: iso(boosts.find((x) => x.guild_id === r.guild_id && x.user_id === r.user_id)?.since),
  }));
}
export async function memberDTO(ctx: Ctx, guildId: string, userId: string): Promise<Member | null> {
  const rows = await ctx.db.query('SELECT * FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return (await membersDTO(ctx, rows))[0] ?? null;
}

/** Webhook executions may carry their own display name / avatar for that one message. */
function withWebhookIdentity(u: User | undefined, r: any): User | undefined {
  if (!u || !r.webhook_id || (!r.webhook_username && !r.webhook_avatar)) return u;
  return { ...u, username: r.webhook_username ?? u.username, displayName: r.webhook_username ?? u.displayName, avatar: r.webhook_avatar ?? u.avatar };
}

export async function messagesDTO(ctx: Ctx, rows: any[], viewerId: string | null, withRef = true): Promise<Message[]> {
  if (!rows.length) return [];
  const users = await usersByIds(ctx, rows.map((r) => r.author_id));
  const ids = rows.map((r) => r.id);
  const reacts = await ctx.db.query(
    `SELECT message_id, emoji, emoji_id,
            count(*) FILTER (WHERE NOT burst)::int AS count, bool_or(user_id = $2 AND NOT burst) AS me,
            count(*) FILTER (WHERE burst)::int AS burst_count, bool_or(user_id = $2 AND burst) AS me_burst,
            array_agg(DISTINCT burst_color) FILTER (WHERE burst AND burst_color IS NOT NULL) AS burst_colors,
            min(created_at) AS first
       FROM reactions WHERE message_id = ANY($1::text[]) GROUP BY message_id, emoji, emoji_id ORDER BY first`, [ids, viewerId ?? '']);
  const refIds = withRef ? [...new Set(rows.map((r) => r.reply_to).filter(Boolean))] : [];
  const refRows = refIds.length ? await ctx.db.query('SELECT * FROM messages WHERE id = ANY($1::text[])', [refIds]) : [];
  const refs = new Map((await messagesDTO(ctx, refRows, viewerId, false)).map((m) => [m.id, m]));
  const pollIds = rows.filter((r) => r.poll).map((r) => r.id);
  const votes = pollIds.length ? await ctx.db.query(
    'SELECT message_id, answer_id, count(*)::int AS n, bool_or(user_id = $2) AS me FROM poll_votes WHERE message_id = ANY($1::text[]) GROUP BY message_id, answer_id', [pollIds, viewerId ?? '']) : [];
  const voters = pollIds.length ? await ctx.db.query('SELECT message_id, count(DISTINCT user_id)::int AS n FROM poll_votes WHERE message_id = ANY($1::text[]) GROUP BY message_id', [pollIds]) : [];
  const linkWarn = await warningsForRows(ctx, rows);
  return rows.map((r) => ({
    id: r.id, channelId: r.channel_id, guildId: r.guild_id ?? null,
    author: withWebhookIdentity(users.get(r.author_id), r) ?? { id: r.author_id, username: 'deleted', displayName: null, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: iso(r.created_at ?? new Date())! },
    content: r.content, createdAt: new Date(snowflakeTime(r.id)).toISOString(), editedAt: iso(r.edited_at),
    type: r.type, replyTo: r.reply_to ?? null, referenced: r.reply_to && withRef ? refs.get(r.reply_to) ?? null : undefined,
    mentions: r.mentions, mentionRoles: r.mention_roles, mentionEveryone: r.mention_everyone,
    attachments: r.attachments as Attachment[], embeds: r.embeds as Embed[],
    reactions: reacts.filter((x) => x.message_id === r.id).map((x): Reaction => ({
      emoji: x.emoji, emojiId: x.emoji_id ?? null, count: x.count, me: !!x.me,
      // Burst fields only travel when a burst actually exists: a regular reaction keeps its original shape.
      ...(x.burst_count ? { burstCount: x.burst_count, meBurst: !!x.me_burst, burstColors: (x.burst_colors ?? []) as string[] } : {}),
    })),
    pinned: r.pinned, stickerIds: r.sticker_ids, threadId: r.thread_id ?? null, webhookId: r.webhook_id ?? null,
    components: (r.components ?? []) as Component[], flags: r.flags ?? 0, applicationId: r.application_id ?? null, interaction: r.interaction ?? null,
    poll: r.poll ? pollDTO(r, votes, voters) : null,
    forward: r.forward ?? null, crosspost: r.crosspost ?? null,
    allowedMentions: r.allowed_mentions ?? null,
    ...(linkWarn.has(r.id) ? { linkWarnings: linkWarn.get(r.id) } : {}),
  }));
}
export async function messageDTO(ctx: Ctx, row: any, viewerId: string | null): Promise<Message> { return (await messagesDTO(ctx, [row], viewerId))[0]!; }

/** Poll as clients see it: counts and `meVoted` are computed from poll_votes; `isFinalized` flips at expiry even before the sweeper posts the result. */
export function pollDTO(r: any, votes: any[], voters: any[]): Poll {
  const p = r.poll as { question: string; answers: { id: number; text: string; emoji: string | null }[]; allowMultiselect: boolean };
  const mine = votes.filter((v) => v.message_id === r.id);
  const answers = p.answers.map((a) => { const v = mine.find((x) => x.answer_id === a.id); return { id: a.id, text: a.text, emoji: a.emoji ?? null, count: v?.n ?? 0, meVoted: !!v?.me }; });
  const expiry = r.poll_expiry ? new Date(r.poll_expiry) : new Date(0);
  return { question: p.question, answers, allowMultiselect: p.allowMultiselect, layoutType: 1, expiry: expiry.toISOString(), isFinalized: !!r.poll_finalized || expiry.getTime() <= Date.now(), totalVotes: voters.find((x) => x.message_id === r.id)?.n ?? 0 };
}
