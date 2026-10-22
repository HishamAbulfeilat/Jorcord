import { Intents as I, type GuildFull, type Message } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import type { GwSession } from './hub';
import { getChannelLite } from '../services/perms';

/** Event -> [guild intent, DM intent]. 0 = not available in that scope. Events missing from this table are always delivered. */
const MAP: Record<string, [number, number]> = {
  GUILD_CREATE: [I.GUILDS, 0], GUILD_UPDATE: [I.GUILDS, 0], GUILD_DELETE: [I.GUILDS, 0],
  CHANNEL_CREATE: [I.GUILDS, 0], CHANNEL_UPDATE: [I.GUILDS, 0], CHANNEL_DELETE: [I.GUILDS, 0],
  ROLE_CREATE: [I.GUILDS, 0], ROLE_UPDATE: [I.GUILDS, 0], ROLE_DELETE: [I.GUILDS, 0],
  THREAD_CREATE: [I.GUILDS, 0], THREAD_UPDATE: [I.GUILDS, 0], THREAD_DELETE: [I.GUILDS, 0], THREAD_MEMBERS_UPDATE: [I.GUILDS, 0], THREAD_LIST_SYNC: [I.GUILDS, 0],
  STAGE_INSTANCE_CREATE: [I.GUILDS, 0], STAGE_INSTANCE_UPDATE: [I.GUILDS, 0], STAGE_INSTANCE_DELETE: [I.GUILDS, 0],
  MEMBER_ADD: [I.GUILD_MEMBERS, 0], MEMBER_UPDATE: [I.GUILD_MEMBERS, 0], MEMBER_REMOVE: [I.GUILD_MEMBERS, 0],
  EMOJIS_UPDATE: [I.GUILD_EMOJIS_AND_STICKERS, 0], STICKERS_UPDATE: [I.GUILD_EMOJIS_AND_STICKERS, 0],
  VOICE_STATE_UPDATE: [I.GUILD_VOICE_STATES, I.GUILD_VOICE_STATES],
  STAGE_QUEUE_UPDATE: [I.GUILD_VOICE_STATES, 0], STAGE_HAND_UPDATE: [I.GUILD_VOICE_STATES, 0], STREAM_VIEWER_KICKED: [I.GUILD_VOICE_STATES, 0],
  PRESENCE_UPDATE: [I.GUILD_PRESENCES, I.GUILD_PRESENCES],
  MESSAGE_CREATE: [I.GUILD_MESSAGES, I.DIRECT_MESSAGES], MESSAGE_UPDATE: [I.GUILD_MESSAGES, I.DIRECT_MESSAGES], MESSAGE_DELETE: [I.GUILD_MESSAGES, I.DIRECT_MESSAGES],
  CHANNEL_PINS_UPDATE: [I.GUILD_MESSAGES, I.DIRECT_MESSAGES],
  MESSAGE_REACTION_ADD: [I.GUILD_MESSAGE_REACTIONS, I.DIRECT_MESSAGE_REACTIONS], MESSAGE_REACTION_REMOVE: [I.GUILD_MESSAGE_REACTIONS, I.DIRECT_MESSAGE_REACTIONS],
  TYPING_START: [I.GUILD_MESSAGE_TYPING, I.DIRECT_MESSAGE_TYPING],
  MESSAGE_POLL_VOTE_ADD: [I.GUILD_MESSAGE_POLLS, I.DIRECT_MESSAGE_POLLS], MESSAGE_POLL_VOTE_REMOVE: [I.GUILD_MESSAGE_POLLS, I.DIRECT_MESSAGE_POLLS],
  GUILD_SCHEDULED_EVENT_CREATE: [I.GUILD_SCHEDULED_EVENTS, 0], GUILD_SCHEDULED_EVENT_UPDATE: [I.GUILD_SCHEDULED_EVENTS, 0], GUILD_SCHEDULED_EVENT_DELETE: [I.GUILD_SCHEDULED_EVENTS, 0],
  GUILD_SCHEDULED_EVENT_USER_ADD: [I.GUILD_SCHEDULED_EVENTS, 0], GUILD_SCHEDULED_EVENT_USER_REMOVE: [I.GUILD_SCHEDULED_EVENTS, 0],
};

/** Is this event guild- or DM-scoped? null = unknown channel (drop for filtered sessions). Only called when an intent-filtered session is a target. */
export async function eventScope(ctx: Ctx, t: string, d: any): Promise<'guild' | 'dm' | null> {
  const rule = MAP[t];
  if (!rule || rule[1] === 0 || !d || typeof d !== 'object') return 'guild';
  if (d.guildId) return 'guild';
  if ('guildId' in d && d.guildId === null) return 'dm';
  if (typeof d.channelId === 'string') { const ch = await getChannelLite(ctx, d.channelId); return ch ? (ch.guild_id ? 'guild' : 'dm') : null; }
  return 'guild';
}

/** Applies a session's intents to one event. Returns the payload to send (possibly redacted) or null to drop it. */
export function shapeForIntents(s: GwSession, t: string, d: any, scope: 'guild' | 'dm' | null): { d: unknown } | null {
  const intents = s.intents;
  if (intents == null) return { d };
  const rule = MAP[t];
  if (!rule) return { d }; // READY, INTERACTION_*, APPLICATION_*, USER_UPDATE, GUILD_MEMBERS_CHUNK, ERROR ... always flow
  if (!scope) return null;
  // the bot always hears about itself, even without GUILD_MEMBERS
  if ((t === 'MEMBER_ADD' || t === 'MEMBER_UPDATE') && (d as { user?: { id: string } }).user?.id === s.userId) return { d };
  if (t === 'MEMBER_REMOVE' && (d as { userId: string }).userId === s.userId) return { d };
  const need = scope === 'guild' ? rule[0] : rule[1];
  if (!need || !(intents & need)) return null;
  if (t === 'GUILD_CREATE') return { d: trimGuild(d as GuildFull, s, intents) };
  if ((t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') && !(intents & I.MESSAGE_CONTENT)) return { d: redactMessage(d as Message, s.userId, scope) };
  return { d };
}

/** Without MESSAGE_CONTENT a bot sees text only for DMs, its own messages and messages that mention it (Discord's rule). */
export function redactMessage(m: Message, botId: string, scope: 'guild' | 'dm'): Message {
  if (scope === 'dm' || m.author.id === botId || m.mentions.includes(botId)) return m;
  return { ...m, content: '', embeds: [], attachments: [], ...(m.referenced ? { referenced: null } : {}) };
}

function trimGuild(g: GuildFull, s: GwSession, intents: number): GuildFull {
  if (intents & I.GUILD_MEMBERS) return g;
  return { ...g, members: g.members.filter((m) => m.user.id === s.userId) }; // memberCount stays accurate
}

/** READY for an intent-filtered bot: same trimming as GUILD_CREATE, no presences without GUILD_PRESENCES, no guild payload without GUILDS. */
export function shapeReady(s: GwSession, ready: any) {
  const intents = s.intents;
  if (intents == null) return ready;
  return { ...ready, guilds: ready.guilds.map((g: GuildFull) => trimGuild(g, s, intents)), presences: intents & I.GUILD_PRESENCES ? ready.presences : [], voiceStates: intents & I.GUILD_VOICE_STATES ? ready.voiceStates : [] };
}
