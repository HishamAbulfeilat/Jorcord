/** Gateway protocol: JSON over WebSocket at /gateway. Opcode model mirrors Discord's. */
import type { Application, ApplicationCommand, Interaction, Modal, ScheduledEvent, StageInstance, CommandOptionChoice } from './platform';
import type { Activity, GifFavorite, SoundboardSound } from './parity';
import type { Channel, Guild, Id, Invite, Member, Message, Presence, ReadState, Relationship, Reminder, Role, SelfUser, User, VoiceState, Emoji, Sticker } from './types';

export const Op = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE_UPDATE: 3, VOICE_STATE_UPDATE: 4, RESUME: 6, RECONNECT: 7, REQUEST_MEMBERS: 8, TYPING: 9, HELLO: 10, HEARTBEAT_ACK: 11 } as const;

export interface GatewayFrame<T = unknown> { op: number; t?: string; s?: number; d?: T }

export interface ReadyPayload {
  sessionId: string; user: SelfUser; guilds: GuildFull[]; privateChannels: Channel[];
  relationships: Relationship[]; readStates: ReadState[]; presences: { userId: Id; presence: Presence; activities?: Activity[] }[];
  voiceStates: VoiceState[];
  /** DM channel ids that are message requests for me (from non-friends, not yet accepted). */
  messageRequests?: Id[];
}
export interface GuildFull extends Guild { channels: Channel[]; roles: Role[]; members: Member[]; emojis: Emoji[]; stickers: Sticker[]; memberCount: number }

/** Dispatch event name -> payload. Clients must handle unknown events gracefully. */
export interface Events {
  READY: ReadyPayload;
  GUILD_CREATE: GuildFull; GUILD_UPDATE: Guild; GUILD_DELETE: { id: Id };
  CHANNEL_CREATE: Channel; CHANNEL_UPDATE: Channel; CHANNEL_DELETE: { id: Id; guildId: Id | null };
  ROLE_CREATE: Role; ROLE_UPDATE: Role; ROLE_DELETE: { id: Id; guildId: Id };
  INVITE_CREATE: Invite; INVITE_DELETE: Invite;
  MEMBER_ADD: Member; MEMBER_UPDATE: Member; MEMBER_REMOVE: { guildId: Id; userId: Id };
  MESSAGE_CREATE: Message; MESSAGE_UPDATE: Message; MESSAGE_DELETE: { id: Id; channelId: Id; guildId: Id | null };
  MESSAGE_REACTION_ADD: { messageId: Id; channelId: Id; userId: Id; emoji: string; emojiId: Id | null; /** burst (super) reaction; `burstColor` is set when `burst` is true. */ burst?: boolean; burstColor?: string | null };
  MESSAGE_REACTION_REMOVE: { messageId: Id; channelId: Id; userId: Id; emoji: string; emojiId: Id | null; burst?: boolean; burstColor?: string | null };
  CHANNEL_PINS_UPDATE: { channelId: Id };
  TYPING_START: { channelId: Id; userId: Id; timestamp: number };
  PRESENCE_UPDATE: { userId: Id; presence: Presence; customStatus?: User['customStatus']; /** what they are doing (empty when offline or sharing is off) */ activities?: Activity[] };
  USER_UPDATE: User;
  RELATIONSHIP_ADD: Relationship; RELATIONSHIP_REMOVE: { userId: Id };
  READ_STATE_UPDATE: ReadState;
  VOICE_STATE_UPDATE: VoiceState;
  EMOJIS_UPDATE: { guildId: Id; emojis: Emoji[] };
  STICKERS_UPDATE: { guildId: Id; stickers: Sticker[] };
  THREAD_CREATE: Channel; THREAD_UPDATE: Channel;
  THREAD_MEMBERS_UPDATE: { id: Id; guildId: Id; addedUserIds: Id[]; removedUserIds: Id[] };
  /** Reply to gateway op REQUEST_MEMBERS (sent only to the requesting session). */
  /** Platform pass (additive). Bots receive INTERACTION_CREATE on their gateway session (or via the signed HTTP endpoint). */
  INTERACTION_CREATE: Interaction;
  /** To the invoking user: the app did not acknowledge within 3s. */
  INTERACTION_FAILED: { id: Id; applicationId: Id; channelId: Id | null };
  /** To the invoking user: the app answered an autocomplete interaction (callback type 8). */
  INTERACTION_AUTOCOMPLETE_RESULT: { interactionId: Id; applicationId: Id; choices: CommandOptionChoice[] };
  /** To the invoking user: the app opened a modal (callback type 9). Submit with POST /interactions {type:5}. */
  INTERACTION_MODAL: { interactionId: Id; applicationId: Id; modal: Modal };
  APPLICATION_COMMAND_CREATE: ApplicationCommand; APPLICATION_COMMAND_UPDATE: ApplicationCommand; APPLICATION_COMMAND_DELETE: ApplicationCommand;
  APPLICATION_UPDATE: Omit<Application, 'token' | 'clientSecret'>;
  /** `count` = the answer's new vote total, `totalVotes` = distinct voters after this change (the percent base). Both optional for older servers. */
  MESSAGE_POLL_VOTE_ADD: { userId: Id; channelId: Id; messageId: Id; answerId: number; count?: number; totalVotes?: number };
  MESSAGE_POLL_VOTE_REMOVE: { userId: Id; channelId: Id; messageId: Id; answerId: number; count?: number; totalVotes?: number };
  GUILD_SCHEDULED_EVENT_CREATE: ScheduledEvent; GUILD_SCHEDULED_EVENT_UPDATE: ScheduledEvent; GUILD_SCHEDULED_EVENT_DELETE: ScheduledEvent;
  GUILD_SCHEDULED_EVENT_USER_ADD: { guildScheduledEventId: Id; userId: Id; guildId: Id };
  GUILD_SCHEDULED_EVENT_USER_REMOVE: { guildScheduledEventId: Id; userId: Id; guildId: Id };
  STAGE_INSTANCE_CREATE: StageInstance; STAGE_INSTANCE_UPDATE: StageInstance; STAGE_INSTANCE_DELETE: StageInstance;
  THREAD_DELETE: { id: Id; guildId: Id; parentId: Id | null };
  /** A server's linked roles (criteria) changed: refetch GET /guilds/:id/linked-roles. Role grants themselves arrive as MEMBER_UPDATE. */
  LINKED_ROLES_UPDATE: { guildId: Id };
  /** To the warned member only: a moderator (or AutoMod) warned them in this server. */
  MOD_WARNING: { guildId: Id; guildName: string; reason: string; createdAt: string };
  /** To the caller's own sessions: a private note about another user changed (`note: null` = removed). */
  /** To me: a DM became (or stopped being) a message request. */
  MESSAGE_REQUEST_UPDATE: { channelId: Id; request: boolean };
  /** To me: a reminder came due (the message is the one I asked to be reminded about). */
  REMINDER_DUE: Reminder;
  /** To me: my saved-for-later list changed on another session. */
  SAVED_UPDATE: { channelId: Id; messageId: Id; saved: boolean };
  USER_NOTE_UPDATE: { userId: Id; note: string | null };
  /** Soundboard: a guild's sound list changed / someone played a sound in a voice channel (sent to the people in that channel). */
  SOUNDBOARD_SOUNDS_UPDATE: { guildId: Id; sounds: SoundboardSound[] };
  VOICE_CHANNEL_EFFECT_SEND: { guildId: Id | null; channelId: Id; userId: Id; sound: SoundboardSound };
  /** To my own sessions: a GIF favorite was added or removed. */
  GIF_FAVORITES_UPDATE: { item?: GifFavorite; removedId?: Id };
  /** Reports (mod queue): a report was created or triaged; clients with moderation perms re-read the queue. */
  GUILD_REPORTS_UPDATE: { guildId: Id };
  /** A guild's webhook was created, updated or deleted: clients re-read that channel's webhook list. */
  WEBHOOKS_UPDATE: { guildId: Id; channelId: Id };
  GUILD_MEMBERS_CHUNK: { guildId: Id; members: Member[]; notFound: Id[]; chunkIndex: number; chunkCount: number; nonce?: string };
}
export type EventName = keyof Events;

/** `token` is a user access token, or `Bot <token>` for an application's bot. */
export interface IdentifyPayload { token: string; sessionId?: string; seq?: number; properties?: { os?: string; client?: string }; /** Bots only: bitfield of {@link Intents}. Omitted = legacy unfiltered stream. Ignored for user sessions. */ intents?: number }

/**
 * Gateway intents (bots): opt-in event filtering. Bit positions follow Discord's public table where an equivalent exists.
 * GUILD_MEMBERS, GUILD_PRESENCES and MESSAGE_CONTENT are privileged: the application owner must enable them (PATCH /applications/:id `privilegedIntents`).
 */
export const Intents = {
  GUILDS: 1 << 0, GUILD_MEMBERS: 1 << 1, GUILD_EMOJIS_AND_STICKERS: 1 << 3, GUILD_VOICE_STATES: 1 << 7, GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9, GUILD_MESSAGE_REACTIONS: 1 << 10, GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12, DIRECT_MESSAGE_REACTIONS: 1 << 13, DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15, GUILD_SCHEDULED_EVENTS: 1 << 16, GUILD_MESSAGE_POLLS: 1 << 24, DIRECT_MESSAGE_POLLS: 1 << 25,
} as const;
export const PRIVILEGED_INTENTS: number = Intents.GUILD_MEMBERS | Intents.GUILD_PRESENCES | Intents.MESSAGE_CONTENT;
export const ALL_INTENTS: number = Object.values(Intents).reduce((a, b) => a | b, 0);
/** Gateway close codes for IDENTIFY problems. */
export const GatewayClose = { INVALID_INTENTS: 4013, DISALLOWED_INTENTS: 4014 } as const;
export interface VoiceStateUpdatePayload { guildId: Id | null; channelId: Id | null; selfMute?: boolean; selfDeaf?: boolean; video?: boolean; streaming?: boolean }
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Gateway op REQUEST_MEMBERS: `query` is a username/display-name/nick prefix; `userIds` fetches specific members; neither lists members by id after `after`. */
export interface RequestMembersPayload { guildId: Id; query?: string; userIds?: Id[]; limit?: number; after?: Id; nonce?: string }
