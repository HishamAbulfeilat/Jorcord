import { ButtonStyle, ComponentType, Perm, SAFETY_ALERT_PREFIX, has, type Component, type Embed } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, forbidden, notFound } from '../errors';
import { automodUserId } from './automod';
import { audit } from './guilds';
import { createMessage } from './messages';
import { guildAccess, guildPerms, loadGuildPerm, needOutrankMember } from './perms';
import { normalizeAlerts } from './safety';
import { GUILD_SELECT, guildDTO, messageDTO } from './serializers';

const button = (customId: string, label: string, style: number): Component => ({ type: ComponentType.BUTTON, style, label, customId });
const row = (...c: Component[]): Component => ({ type: ComponentType.ACTION_ROW, components: c });

/** The configured alert channel when it still exists and is a text channel, else null. */
async function alertChannel(ctx: Ctx, guildId: string, kind: 'raid' | 'massDm') {
  const [g] = await ctx.db.query('SELECT safety_alerts, safety_alerts_channel_id FROM guilds WHERE id = $1', [guildId]);
  if (!g) return null;
  const cfg = normalizeAlerts(g);
  if (!cfg.channelId || !cfg[kind]) return null;
  const [ch] = await ctx.db.query(`SELECT * FROM channels WHERE id = $1 AND guild_id = $2 AND type IN ('text','announcement')`, [cfg.channelId, guildId]);
  return ch ?? null;
}

async function post(ctx: Ctx, guildId: string, kind: 'raid' | 'massDm', embed: Embed, components: Component[]) {
  try {
    if (ctx.rl.hit(`safety-alert:${guildId}:${kind}`, 6, 3600_000)) return null; // a flood of alerts is itself a nuisance
    const ch = await alertChannel(ctx, guildId, kind);
    if (!ch) return null;
    return await createMessage(ctx, { channel: ch, authorId: await automodUserId(ctx), content: '', senderPerms: 0n, skipChecks: true, allowEmpty: true, embeds: [embed], components });
  } catch (e) { ctx.log.warn({ err: e, guildId }, 'safety alert failed'); return null; }
}

/** Raid protection tripped: tell the moderators, with one-click follow-ups. */
export async function alertRaid(ctx: Ctx, guildId: string, info: { joins: number; windowSeconds: number; lockMinutes: number }) {
  return post(ctx, guildId, 'raid', {
    type: 'rich', title: 'Possible raid detected', color: 0xed4245, footer: 'Safety alert',
    description: `${info.joins} accounts joined within ${info.windowSeconds} seconds. Invites are paused for ${info.lockMinutes} minutes and the new members are flagged.`,
    fields: [{ name: 'Joins', value: String(info.joins), inline: true }, { name: 'Window', value: `${info.windowSeconds}s`, inline: true }],
  }, [row(button(`${SAFETY_ALERT_PREFIX}lock`, 'Lock invites (24h)', ButtonStyle.PRIMARY), button(`${SAFETY_ALERT_PREFIX}kick`, 'Kick new members', ButtonStyle.DANGER), button(`${SAFETY_ALERT_PREFIX}dismiss`, 'Dismiss', ButtonStyle.SECONDARY))]);
}

const REASONS: Record<string, string> = { identical_dm: 'sent the same message to many people who never replied', identical_dm_with_link: 'sent the same link to many people who never replied', many_strangers: 'messaged a great many people who never replied' };

/** The mass-DM brake limited a member: alert every server (with alerts on) the sender belongs to. */
export async function alertMassDm(ctx: Ctx, senderId: string, info: { reason: string; recipients: number }) {
  try {
    const gs = await ctx.db.query(
      `SELECT m.guild_id FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = $1 AND g.safety_alerts_channel_id IS NOT NULL AND g.owner_id <> $1 LIMIT 50`, [senderId]);
    if (!gs.length) return;
    const [u] = await ctx.db.query('SELECT username, display_name FROM users WHERE id = $1', [senderId]);
    for (const g of gs) {
      await post(ctx, g.guild_id, 'massDm', {
        type: 'rich', title: 'Mass-DM spam detected', color: 0xfaa61a, footer: 'Safety alert',
        description: `${u?.display_name || u?.username || senderId} ${REASONS[info.reason] ?? 'is sending direct messages in bulk'}. Their new conversations are paused automatically.`,
        fields: [{ name: 'Member', value: `${u?.username ?? 'unknown'} (${senderId})`, inline: true }, { name: 'People reached', value: String(info.recipients), inline: true }],
      }, [row(button(`${SAFETY_ALERT_PREFIX}kick:${senderId}`, 'Kick member', ButtonStyle.DANGER), button(`${SAFETY_ALERT_PREFIX}dismiss`, 'Dismiss', ButtonStyle.SECONDARY))]);
    }
  } catch (e) { ctx.log.warn({ err: e }, 'mass-DM alert failed'); }
}

const MOD_BITS = Perm.MANAGE_GUILD | Perm.KICK_MEMBERS | Perm.MODERATE_MEMBERS | Perm.BAN_MEMBERS;

/** Marks an alert as handled: buttons disappear and the embed says who did what. */
async function close(ctx: Ctx, msg: any, note: string) {
  const embeds = (msg.embeds ?? []) as Embed[];
  const next = embeds.map((e, i) => (i === 0 ? { ...e, footer: `${e.footer ?? 'Safety alert'} · ${note}` } : e));
  await ctx.db.query(`UPDATE messages SET components = '[]'::jsonb, embeds = $2::jsonb, edited_at = now() WHERE id = $1`, [msg.id, JSON.stringify(next)]);
  const [fresh] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [msg.id]);
  await ctx.hub.toChannel(msg.channel_id, 'MESSAGE_UPDATE', await messageDTO(ctx, fresh, null));
}

/**
 * A moderator pressed a button on an alert. The press is authorised by the guild permissions of the person pressing (never by the message):
 * lock needs MANAGE_GUILD, kicking needs KICK_MEMBERS and outranking each target, dismiss needs any moderation permission.
 */
export async function handleSafetyAlertPress(ctx: Ctx, userId: string, channelId: string, messageId: string, customId: string): Promise<void> {
  const [msg] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channelId]);
  if (!msg || !msg.guild_id || msg.author_id !== (await automodUserId(ctx))) throw notFound('Message');
  const live = ((msg.components ?? []) as Component[]).flatMap((r) => r.components ?? []).some((c) => c.customId === customId);
  if (!live) throw badRequest('This alert was already handled');
  const guildId = msg.guild_id as string;
  const actor = await guildAccess(ctx, userId, guildId);
  const perms = guildPerms(actor);
  if (!(perms & MOD_BITS)) throw forbidden('Missing permissions');
  const [name] = await ctx.db.query('SELECT username FROM users WHERE id = $1', [userId]);
  const who = name?.username ?? userId;
  const [, , action, arg] = customId.split(':');
  if (action === 'dismiss') { await close(ctx, msg, `dismissed by ${who}`); return; }
  if (action === 'lock') {
    if (!has(perms, Perm.MANAGE_GUILD)) throw forbidden('Missing permissions');
    await ctx.db.query(`UPDATE guilds SET invites_paused_until = greatest(coalesce(invites_paused_until, now()), now() + interval '24 hours') WHERE id = $1`, [guildId]);
    await audit(ctx, guildId, userId, 'SAFETY_UPDATE', guildId, { pauseInvites: true, via: 'safety alert' });
    const [fresh] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [guildId]);
    await ctx.hub.toGuild(guildId, 'GUILD_UPDATE', guildDTO(fresh));
    await close(ctx, msg, `invites locked for 24 hours by ${who}`);
    return;
  }
  if (action === 'kick') {
    if (!has(perms, Perm.KICK_MEMBERS) && !has(perms, Perm.MANAGE_GUILD)) throw forbidden('Missing permissions');
    const ids = arg
      ? [arg]
      : (await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1 AND raid_flagged AND user_id <> $2 LIMIT 200', [guildId, userId])).map((r) => r.user_id as string);
    const { removeMemberFromGuild } = await import('../routes/members');
    let kicked = 0;
    for (const id of ids) {
      const target = await loadGuildPerm(ctx, guildId, id);
      if (!target) continue;
      try { needOutrankMember(actor, target); } catch { continue; } // never above one's own rank
      await removeMemberFromGuild(ctx, guildId, id);
      await audit(ctx, guildId, userId, 'MEMBER_KICK', id, { via: 'safety alert' });
      kicked++;
    }
    await close(ctx, msg, `${kicked} member${kicked === 1 ? '' : 's'} kicked by ${who}`);
    return;
  }
  throw badRequest('Unknown action');
}
