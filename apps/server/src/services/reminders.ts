import { Perm, has, type Reminder } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { channelPermsLite } from './perms';
import { messagesDTO } from './serializers';

/** Can `userId` still read this message? (channel visible + READ_MESSAGE_HISTORY). */
export async function canReadChannel(ctx: Ctx, userId: string, channelId: string): Promise<boolean> {
  const a = await channelPermsLite(ctx, userId, channelId);
  return !!a && has(a.perms, Perm.READ_MESSAGE_HISTORY);
}

/** Reminder rows -> DTOs, dropping rows whose message is gone or no longer readable by the owner. */
export async function reminderDTOs(ctx: Ctx, userId: string, rows: any[]): Promise<Reminder[]> {
  if (!rows.length) return [];
  const msgs = await ctx.db.query('SELECT * FROM messages WHERE id = ANY($1::text[])', [rows.map((r) => r.message_id)]);
  const dtos = new Map((await messagesDTO(ctx, msgs, userId)).map((m) => [m.id, m]));
  const ok = new Map<string, boolean>();
  const out: Reminder[] = [];
  for (const r of rows) {
    const m = dtos.get(r.message_id); if (!m) continue;
    let can = ok.get(r.channel_id); if (can === undefined) { can = await canReadChannel(ctx, userId, r.channel_id); ok.set(r.channel_id, can); }
    if (can) out.push({ id: r.id, remindAt: iso(r.remind_at)!, firedAt: iso(r.fired_at), message: m });
  }
  return out;
}

/** Sweeper step: marks due reminders fired (atomic, multi-node safe), tells the owner live and by push when offline. */
export async function fireDueReminders(ctx: Ctx) {
  const rows = await ctx.db.query('UPDATE reminders SET fired_at = now() WHERE fired_at IS NULL AND remind_at <= now() RETURNING *');
  for (const r of rows) {
    const [dto] = await reminderDTOs(ctx, r.user_id, [r]);
    if (!dto) continue;
    await ctx.hub.toUser(r.user_id, 'REMINDER_DUE', dto);
    if (!ctx.hub.isOnline(r.user_id)) {
      const preview = (dto.message.content || dto.message.attachments[0]?.filename || 'Message').slice(0, 140);
      ctx.push.deliver([r.user_id], { kind: 'reminder', title: 'Reminder', body: preview, tag: `reminder-${r.id}`, channelId: r.channel_id, guildId: r.guild_id, messageId: r.message_id }).catch(() => {});
    }
  }
  return rows.length;
}
