import { randomInt } from 'node:crypto';
import { Perm, has, snowflake } from '@jorcord/shared';
import type { Ctx } from '../../ctx';
import { badRequest } from '../../errors';
import { createMessage } from '../messages';
import { DM_PERMS, channelPermsLite } from '../perms';
import { buildPoll } from '../polls';
import { channelDTO } from '../serializers';
import { bool, int, parseDuration, requireBotPerm, str, sub, type CmdCtx, type SysBot } from './kit';

const MAX_PENDING_REMINDERS = 25;
const MAX_REMIND_MS = 365 * 86_400_000;
const MIN_REMIND_MS = 10_000;

const EIGHT_BALL = [
  'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes, definitely.', 'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.',
  'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
  'Do not count on it.', 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.',
];

/** "2d6", "d20", "3d8+2", "1d10-1" -> a roll. Bounded so a single command can never be expensive. */
export function roll(expr: string): { text: string; total: number } {
  const m = /^\s*(\d{1,2})?d(\d{1,4})\s*(?:([+-])\s*(\d{1,4}))?\s*$/i.exec(expr);
  if (!m) throw badRequest('Use dice notation such as d20, 2d6 or 3d8+2');
  const n = m[1] ? Number(m[1]) : 1, sides = Number(m[2]), mod = m[4] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
  if (n < 1 || n > 20) throw badRequest('Roll between 1 and 20 dice');
  if (sides < 2 || sides > 1000) throw badRequest('Dice have between 2 and 1000 sides');
  const dice = Array.from({ length: n }, () => randomInt(1, sides + 1));
  const total = dice.reduce((a, b) => a + b, 0) + mod;
  return { total, text: `[${dice.join(', ')}]${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : ''} = **${total}**` };
}

const interactionMeta = (c: CmdCtx, name: string) => ({ id: c.interaction.id, type: c.interaction.type, name, userId: c.userId });
const optionNames = Array.from({ length: 10 }, (_, i) => `answer${i + 1}`);

// ------------------------------------------------------------------ reminders
const fmtWhen = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:R>`;
async function pendingReminders(c: CmdCtx) {
  return c.ctx.db.query('SELECT * FROM bot_reminders WHERE user_id = $1 AND fired_at IS NULL ORDER BY remind_at, id', [c.userId]);
}

export const utilityBot: SysBot = {
  key: 'utility', name: 'Utility', category: 'utility', tags: ['poll', 'remind', 'dice', 'official'],
  summary: 'Polls, reminders, dice and a magic 8-ball.',
  description: 'The official Jorcord utility bot: /poll for quick votes, /remind for reminders delivered by DM or in the channel, /roll for dice and /8ball for fun.',
  permissions: Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.SEND_POLLS,
  commands: [
    {
      name: 'poll', description: 'Start a poll in this channel', requires: Perm.SEND_POLLS, limit: { max: 5, windowMs: 60_000 },
      options: [
        str('question', 'What to ask', { required: true, maxLength: 300 }),
        str('answer1', 'First answer', { required: true, maxLength: 55 }), str('answer2', 'Second answer', { required: true, maxLength: 55 }),
        ...optionNames.slice(2).map((n, i) => str(n, `Answer ${i + 3}`, { maxLength: 55 })),
        int('hours', 'How long the poll runs (default 24)', { minValue: 1, maxValue: 168 }), bool('multiselect', 'Allow choosing more than one answer'),
      ],
      async run(c) {
        if (!has(c.callerPerms, Perm.SEND_POLLS)) throw badRequest('You cannot create polls here');
        await requireBotPerm(c, Perm.SEND_MESSAGES, 'Send Messages');
        const answers = optionNames.map((n) => (c.opt(n) ?? '').trim()).filter(Boolean);
        const built = buildPoll({ question: (c.opt('question') ?? '').trim(), answers: answers.map((text) => ({ text })), durationHours: c.opt<number>('hours') ?? 24, allowMultiselect: c.opt<boolean>('multiselect') ?? false });
        await createMessage(c.ctx, { channel: c.channel, authorId: c.app.bot_user_id, content: '', poll: built.poll, pollExpiry: built.expiry, applicationId: c.app.id, interaction: interactionMeta(c, 'poll'), senderPerms: 0n, skipChecks: true });
        await c.reply('Poll created.');
      },
    },
    {
      name: 'roll', description: 'Roll dice, e.g. d20, 2d6 or 3d8+2', limit: { max: 20, windowMs: 60_000 },
      options: [str('dice', 'Dice notation (default d20)', { maxLength: 16 })],
      async run(c) {
        await requireBotPerm(c, Perm.SEND_MESSAGES, 'Send Messages');
        const expr = (c.opt('dice') ?? 'd20').trim() || 'd20';
        const r = roll(expr);
        await c.reply(`<@${c.userId}> rolled ${expr.toLowerCase()}: ${r.text}`, { ephemeral: false });
      },
    },
    {
      name: '8ball', description: 'Ask the magic 8-ball a yes/no question', limit: { max: 10, windowMs: 60_000 },
      options: [str('question', 'Your question', { required: true, maxLength: 200 })],
      async run(c) {
        await requireBotPerm(c, Perm.SEND_MESSAGES, 'Send Messages');
        const q = (c.opt('question') ?? '').trim();
        if (!q) throw badRequest('Ask a question');
        await c.reply(`<@${c.userId}> asked: ${q}\n8-ball says: ${EIGHT_BALL[randomInt(EIGHT_BALL.length)]}`, { ephemeral: false });
      },
    },
    {
      name: 'remind', description: 'Set, list or cancel reminders', limit: { max: 10, windowMs: 60_000 },
      options: [
        sub('add', 'Remind me later', [
          str('in', 'When: 10m, 2h, 1d, 1w (10 seconds to 365 days)', { required: true, maxLength: 12 }),
          str('message', 'What to remind you of', { required: true, maxLength: 500 }),
          str('where', 'Where to remind you (default: direct message)', { choices: [{ name: 'Direct message', value: 'dm' }, { name: 'This channel', value: 'channel' }] }),
        ]),
        sub('list', 'Show my pending reminders'),
        sub('cancel', 'Cancel a pending reminder', [int('number', 'The number shown by /remind list', { required: true, minValue: 1, maxValue: MAX_PENDING_REMINDERS })]),
      ],
      async run(c) {
        if (c.sub === 'list') {
          const rows = await pendingReminders(c);
          if (!rows.length) return c.reply('You have no pending reminders.');
          return c.reply(rows.map((r, i) => `${i + 1}. ${fmtWhen(new Date(r.remind_at))} (${r.via_dm ? 'DM' : 'channel'}): ${r.content}`).join('\n'));
        }
        if (c.sub === 'cancel') {
          const rows = await pendingReminders(c);
          const target = rows[Math.trunc(Number(c.opt<number>('number'))) - 1];
          if (!target) throw badRequest('No pending reminder with that number. Use /remind list.');
          await c.ctx.db.query('DELETE FROM bot_reminders WHERE id = $1 AND user_id = $2 AND fired_at IS NULL', [target.id, c.userId]);
          return c.reply('Reminder cancelled.');
        }
        const ms = parseDuration((c.opt('in') ?? '').trim());
        if (ms === null) throw badRequest('Time must look like 10m, 2h, 1d or 1w');
        if (ms < MIN_REMIND_MS) throw badRequest('Reminders must be at least 10 seconds away');
        if (ms > MAX_REMIND_MS) throw badRequest('Reminders can be at most 365 days away');
        const content = (c.opt('message') ?? '').trim();
        if (!content) throw badRequest('Say what to remind you of');
        const viaDm = (c.opt('where') ?? 'dm') !== 'channel';
        const [n] = await c.ctx.db.query('SELECT count(*)::int AS n FROM bot_reminders WHERE user_id = $1 AND fired_at IS NULL', [c.userId]);
        if (n.n >= MAX_PENDING_REMINDERS) throw badRequest(`You can have at most ${MAX_PENDING_REMINDERS} pending reminders`);
        const at = new Date(Date.now() + ms);
        await c.ctx.db.query('INSERT INTO bot_reminders (id, user_id, guild_id, channel_id, via_dm, content, remind_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [snowflake(), c.userId, c.guildId, c.channel.id, viaDm, content, at]);
        await c.reply(`I will remind you ${fmtWhen(at)} ${viaDm ? 'by direct message' : 'in this channel'}.`);
      },
    },
  ],
};

// ------------------------------------------------------------------ delivery
/** Opens (or reuses) the DM between a bot and a user. */
async function openBotDm(ctx: Ctx, botId: string, userId: string) {
  const dmKey = [botId, userId].sort().join(':');
  const [ex] = await ctx.db.query('SELECT * FROM channels WHERE dm_key = $1', [dmKey]);
  if (ex) return ex;
  const id = snowflake();
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO channels (id, guild_id, type, dm_key, owner_id, name) VALUES ($1,NULL,'dm',$2,NULL,NULL)`, [id, dmKey]);
    for (const u of [botId, userId]) await q.query('INSERT INTO dm_participants (channel_id, user_id, request) VALUES ($1,$2,false)', [id, u]);
  });
  await ctx.pcache.invalidate({ k: 'dm', channelId: id });
  const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
  await ctx.hub.toUser(userId, 'CHANNEL_CREATE', await channelDTO(ctx, row));
  return row;
}

async function deliverReminder(ctx: Ctx, app: any, r: any) {
  const text = `Reminder: ${r.content}`;
  if (!r.via_dm && r.channel_id && r.guild_id) {
    const [member] = await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [r.guild_id, r.user_id]);
    const [installed] = await ctx.db.query('SELECT 1 AS x FROM application_installs WHERE application_id = $1 AND guild_id = $2', [app.id, r.guild_id]);
    const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [r.channel_id]);
    const mine = member && installed && channel ? await channelPermsLite(ctx, r.user_id, r.channel_id) : null;
    const bot = member && installed && channel ? await channelPermsLite(ctx, app.bot_user_id, r.channel_id) : null;
    if (channel && mine && bot && has(mine.perms, Perm.SEND_MESSAGES) && has(bot.perms, Perm.SEND_MESSAGES)) { // still allowed to talk there: say it in public
      await createMessage(ctx, { channel, authorId: app.bot_user_id, content: `<@${r.user_id}> ${text}`.slice(0, 2000), applicationId: app.id, senderPerms: 0n, skipChecks: true, allowedMentions: { parse: [], users: [r.user_id] } });
      return;
    }
  }
  const dm = await openBotDm(ctx, app.bot_user_id, r.user_id);
  await createMessage(ctx, { channel: dm, authorId: app.bot_user_id, content: text.slice(0, 2000), applicationId: app.id, senderPerms: DM_PERMS, skipChecks: true });
}

/** Sweeper step: delivers due /remind reminders. The claim is atomic, so with several nodes each reminder is delivered once. */
export async function fireDueBotReminders(ctx: Ctx, limit = 100): Promise<number> {
  const rows = await ctx.db.query(
    'UPDATE bot_reminders SET fired_at = now() WHERE id IN (SELECT id FROM bot_reminders WHERE fired_at IS NULL AND remind_at <= now() ORDER BY remind_at LIMIT $1) AND fired_at IS NULL RETURNING *', [limit]);
  if (!rows.length) return 0;
  const [app] = await ctx.db.query(`SELECT * FROM applications WHERE system_key = 'utility'`);
  if (!app) return 0;
  for (const r of rows) await deliverReminder(ctx, app, r).catch((e) => ctx.log.warn({ err: e, reminder: r.id }, 'bot reminder delivery failed'));
  return rows.length;
}
