/** Gateway protocol: JSON over WebSocket at /gateway. Opcode model mirrors Discord's. */
import type { Channel, Guild, Id, Member, Message, Presence, ReadState, Relationship, Role, SelfUser, User, VoiceState, Emoji, Sticker } from './types';

export const Op = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE_UPDATE: 3, VOICE_STATE_UPDATE: 4, RESUME: 6, RECONNECT: 7, REQUEST_MEMBERS: 8, TYPING: 9, HELLO: 10, HEARTBEAT_ACK: 11 } as const;

export interface GatewayFrame<T = unknown> { op: number; t?: string; s?: number; d?: T }

export interface ReadyPayload {
  sessionId: string; user: SelfUser; guilds: GuildFull[]; privateChannels: Channel[];
  relationships: Relationship[]; readStates: ReadState[]; presences: { userId: Id; presence: Presence }[];
  voiceStates: VoiceState[];
}
export interface GuildFull extends Guild { channels: Channel[]; roles: Role[]; members: Member[]; emojis: Emoji[]; stickers: Sticker[]; memberCount: number }

/** Dispatch event name -> payload. Clients must handle unknown events gracefully. */
export interface Events {
  READY: ReadyPayload;
  GUILD_CREATE: GuildFull; GUILD_UPDATE: Guild; GUILD_DELETE: { id: Id };
  CHANNEL_CREATE: Channel; CHANNEL_UPDATE: Channel; CHANNEL_DELETE: { id: Id; guildId: Id | null };
  ROLE_CREATE: Role; ROLE_UPDATE: Role; ROLE_DELETE: { id: Id; guildId: Id };
  MEMBER_ADD: Member; MEMBER_UPDATE: Member; MEMBER_REMOVE: { guildId: Id; userId: Id };
  MESSAGE_CREATE: Message; MESSAGE_UPDATE: Message; MESSAGE_DELETE: { id: Id; channelId: Id; guildId: Id | null };
  MESSAGE_REACTION_ADD: { messageId: Id; channelId: Id; userId: Id; emoji: string; emojiId: Id | null };
  MESSAGE_REACTION_REMOVE: { messageId: Id; channelId: Id; userId: Id; emoji: string; emojiId: Id | null };
  CHANNEL_PINS_UPDATE: { channelId: Id };
  TYPING_START: { channelId: Id; userId: Id; timestamp: number };
  PRESENCE_UPDATE: { userId: Id; presence: Presence; customStatus?: User['customStatus'] };
  USER_UPDATE: User;
  RELATIONSHIP_ADD: Relationship; RELATIONSHIP_REMOVE: { userId: Id };
  READ_STATE_UPDATE: ReadState;
  VOICE_STATE_UPDATE: VoiceState;
  EMOJIS_UPDATE: { guildId: Id; emojis: Emoji[] };
  THREAD_CREATE: Channel; THREAD_UPDATE: Channel;
  THREAD_MEMBERS_UPDATE: { id: Id; guildId: Id; addedUserIds: Id[]; removedUserIds: Id[] };
  /** Reply to gateway op REQUEST_MEMBERS (sent only to the requesting session). */
  GUILD_MEMBERS_CHUNK: { guildId: Id; members: Member[]; notFound: Id[]; chunkIndex: number; chunkCount: number; nonce?: string };
}
export type EventName = keyof Events;

export interface IdentifyPayload { token: string; sessionId?: string; seq?: number; properties?: { os?: string; client?: string } }
export interface VoiceStateUpdatePayload { guildId: Id | null; channelId: Id | null; selfMute?: boolean; selfDeaf?: boolean; video?: boolean; streaming?: boolean }
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Gateway op REQUEST_MEMBERS: `query` is a username/display-name/nick prefix; `userIds` fetches specific members; neither lists members by id after `after`. */
export interface RequestMembersPayload { guildId: Id; query?: string; userIds?: Id[]; limit?: number; after?: Id; nonce?: string }
