import { MOD_LIMITS, Perm, snowflake } from '@jorcord/shared';
import { badRequest, forbidden, notFound } from '../../errors';
import { iso } from '../../lib/ids';
import { audit } from '../guilds';
import { settleLastMessage } from '../messages';
import { guildPerms, loadGuildPerm, needOutrankMember } from '../perms';
import { channelDTO, memberDTO } from '../serializers';
import { channelOpt, int, parseDuration, permsIn, requireBotPerm, requirePerm, str, user, type CmdCtx, type SysBot } from './kit';

const MAX_TIMEOUT_MS = 28 * 86_400_000;

/**
 * The caller's rights decide. They need the permission and must strictly outrank the target (the owner always does); nobody can act on
 * themselves, the owner, an administrator or a bot. The bot's own role must also still hold the permission, so a server can switch a
 * capability off under Bots & Apps. (The bot's role sits at the bottom of the hierarchy by design, so its position is not compared.)
 */
async function targetMember(c: CmdCtx, userId: string | undefined) {
  if (!userId) throw badRequest('Choose a member');
  if (userId === c.userId) throw badRequest('You cannot do that to yourself');
  if (userId === c.app.bot_user_id) throw badRequest('Nice try');
  const t = await loadGuildPerm(c.ctx, c.guildId, userId);
  if (!t) throw badRequest('That user is not a member of this server');
  needOutrankMember(c.caller, t);
  const [u] = await c.ctx.db.query('SELECT bot FROM users WHERE id = $1', [userId]);
  if (u?.bot) throw badRequest('Bots cannot be moderated with this command');
  return t;
}

export const moderationBot: SysBot = {
  key: 'moderation', name: 'Moderation', category: 'moderation', tags: ['moderation', 'warn', 'timeout', 'purge', 'official'],
  summary: 'Warn and time out members, purge messages and set slowmode.',
  description: 'The official Jorcord moderation bot: /warn, /timeout, /purge and /slowmode. Every command checks your own permissions and role hierarchy, and is written to the audit log.',
  permissions: Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.MODERATE_MEMBERS | Perm.MANAGE_MESSAGES | Perm.MANAGE_CHANNELS | Perm.READ_MESSAGE_HISTORY,
  commands: [
    {
      name: 'warn', description: 'Warn a member (recorded in their moderation history)', requires: Perm.MODERATE_MEMBERS, limit: { max: 10, windowMs: 60_000 },
      options: [user('member', 'Who to warn', { required: true }), str('reason', 'Why', { required: true, maxLength: MOD_LIMITS.warningLength })],
      async run(c) {
        requirePerm(guildPerms(c.caller), Perm.MODERATE_MEMBERS, 'Timeout Members');
        const userId = c.opt('member');
        await targetMember(c, userId);
        const reason = (c.opt('reason') ?? '').trim();
        if (!reason) throw badRequest('Give a reason');
        const id = snowflake();
        await c.ctx.db.query(`INSERT INTO mod_warnings (id, guild_id, user_id, moderator_id, reason, source) VALUES ($1,$2,$3,$4,$5,'manual')`, [id, c.guildId, userId, c.userId, reason]);
        const [row] = await c.ctx.db.query('SELECT * FROM mod_warnings WHERE id = $1', [id]);
        await audit(c.ctx, c.guildId, c.userId, 'MEMBER_WARN', userId!, null, reason);
        const [g] = await c.ctx.db.query('SELECT name FROM guilds WHERE id = $1', [c.guildId]);
        await c.ctx.hub.toUser(userId!, 'MOD_WARNING', { guildId: c.guildId, guildName: g.name, reason, createdAt: iso(row.created_at)! });
        await c.reply(`<@${userId}> was warned: ${reason}`, { ephemeral: false });
      },
    },
    {
      name: 'timeout', description: 'Time a member out (mute them) for a while, or lift a timeout', requires: Perm.MODERATE_MEMBERS, limit: { max: 10, windowMs: 60_000 },
      options: [
        user('member', 'Who to time out', { required: true }),
        str('duration', 'For how long: 10m, 2h, 1d (max 28d), or "off" to lift it', { required: true, maxLength: 12 }),
        str('reason', 'Why', { maxLength: 300 }),
      ],
      async run(c) {
        requirePerm(guildPerms(c.caller), Perm.MODERATE_MEMBERS, 'Timeout Members');
        await requireBotPerm(c, Perm.MODERATE_MEMBERS, 'Timeout Members');
        const userId = c.opt('member');
        const t = await targetMember(c, userId);
        if ((guildPerms(t) & Perm.ADMINISTRATOR) !== 0n) throw forbidden('Cannot time out an administrator');
        const raw = (c.opt('duration') ?? '').trim().toLowerCase();
        const lift = ['off', 'none', 'clear', '0'].includes(raw);
        const ms = lift ? 0 : parseDuration(raw);
        if (ms === null) throw badRequest('Duration must look like 30s, 10m, 2h, 1d or 1w');
        if (!lift && ms < 1000) throw badRequest('The duration is too short');
        if (ms > MAX_TIMEOUT_MS) throw badRequest('Timeout may not exceed 28 days');
        const until = lift ? null : new Date(Date.now() + ms).toISOString();
        const reason = (c.opt('reason') ?? '').trim() || null;
        await c.ctx.db.query('UPDATE members SET timeout_until = $3 WHERE guild_id = $1 AND user_id = $2', [c.guildId, userId, until]);
        await c.ctx.pcache.invalidate({ k: 'member', guildId: c.guildId, userId: userId! });
        await audit(c.ctx, c.guildId, c.userId, 'MEMBER_TIMEOUT', userId!, { until }, reason);
        const m = await memberDTO(c.ctx, c.guildId, userId!);
        if (m) await c.ctx.hub.toGuild(c.guildId, 'MEMBER_UPDATE', m);
        await c.reply(lift ? `<@${userId}> is no longer timed out.` : `<@${userId}> was timed out for ${raw}${reason ? `: ${reason}` : ''}.`, { ephemeral: false });
      },
    },
    {
      name: 'purge', description: 'Delete the latest messages in this channel', requires: Perm.MANAGE_MESSAGES, limit: { max: 5, windowMs: 60_000 },
      options: [int('count', 'How many messages to look at (1-100)', { required: true, minValue: 1, maxValue: 100 }), user('member', 'Only delete messages from this member')],
      async run(c) {
        requirePerm(c.callerPerms, Perm.MANAGE_MESSAGES, 'Manage Messages');
        await requireBotPerm(c, Perm.MANAGE_MESSAGES, 'Manage Messages');
        const count = Math.trunc(Number(c.opt<number>('count')));
        if (!Number.isFinite(count) || count < 1 || count > 100) throw badRequest('Count must be between 1 and 100');
        const only = c.opt('member') ?? null;
        const rows = await c.ctx.db.query(
          'SELECT id FROM messages WHERE channel_id = $1 AND NOT pinned AND ($3::text IS NULL OR author_id = $3) ORDER BY id DESC LIMIT $2', [c.channel.id, count, only]);
        const gone = rows.length ? await c.ctx.db.query('DELETE FROM messages WHERE channel_id = $1 AND id = ANY($2::text[]) RETURNING id', [c.channel.id, rows.map((r) => r.id)]) : [];
        await settleLastMessage(c.ctx, [c.channel.id]);
        for (const r of gone) await c.ctx.hub.toChannel(c.channel.id, 'MESSAGE_DELETE', { id: r.id, channelId: c.channel.id, guildId: c.guildId });
        await audit(c.ctx, c.guildId, c.userId, 'MESSAGE_BULK_DELETE', c.channel.id, { count: gone.length, authorId: only });
        await c.reply(gone.length ? `Deleted ${gone.length} message${gone.length === 1 ? '' : 's'}.` : 'There was nothing to delete (pinned messages are kept).');
      },
    },
    {
      name: 'slowmode', description: 'Set how often members may post in a channel', requires: Perm.MANAGE_CHANNELS, limit: { max: 10, windowMs: 60_000 },
      options: [int('seconds', 'Seconds between messages (0 turns it off, max 21600)', { required: true, minValue: 0, maxValue: 21600 }), channelOpt('channel', 'Channel (default: this one)')],
      async run(c) {
        const id = c.opt('channel') ?? c.channel.id;
        const [target] = await c.ctx.db.query('SELECT * FROM channels WHERE id = $1 AND guild_id = $2', [id, c.guildId]);
        if (!target || target.type === 'category') throw badRequest('Choose a channel of this server');
        const mine = id === c.channel.id ? c.callerPerms : await permsIn(c.ctx, c.caller, target);
        if ((mine & Perm.VIEW_CHANNEL) === 0n) throw notFound('Channel');
        requirePerm(mine, Perm.MANAGE_CHANNELS, 'Manage Channels');
        await requireBotPerm(c, Perm.MANAGE_CHANNELS, 'Manage Channels', target);
        const seconds = Math.trunc(Number(c.opt<number>('seconds')));
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 21600) throw badRequest('Seconds must be between 0 and 21600');
        await c.ctx.db.query('UPDATE channels SET slowmode = $2 WHERE id = $1', [id, seconds]);
        await c.ctx.pcache.invalidate({ k: 'channel', channelId: id });
        const [row] = await c.ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
        await audit(c.ctx, c.guildId, c.userId, 'CHANNEL_UPDATE', id, { slowmode: seconds });
        await c.ctx.hub.toChannel(id, 'CHANNEL_UPDATE', await channelDTO(c.ctx, row));
        await c.reply(seconds ? `Slowmode in <#${id}> is now ${seconds}s.` : `Slowmode in <#${id}> is off.`, { ephemeral: false });
      },
    },
  ],
};
