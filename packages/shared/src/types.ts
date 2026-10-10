import type { Component, FieldErrors, ForumTag, Poll } from './platform';
/** Wire types shared by server and clients. IDs are snowflake strings; bigints (permissions) travel as strings. */
export type Id = string;
export type Presence = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
export type ChannelType = 'text' | 'voice' | 'announcement' | 'stage' | 'forum' | 'category' | 'dm' | 'group_dm' | 'thread';

export interface User {
  id: Id; username: string; displayName: string | null; avatar: string | null; banner: string | null;
  accentColor: string | null; bio: string | null; pronouns: string | null; bot: boolean; createdAt: string;
  customStatus?: { text: string | null; emoji: string | null; /** ISO time; the server clears the status then */ expiresAt?: string | null } | null;
  /** Two-colour profile theme (#rrggbb pair), visible to others. */
  themeColors?: [string, string] | null;
  presence?: Presence;
}
/** Private to the owner; enforced server-side. */
export interface Privacy {
  /** Let people who only share a server with me start a DM. Friends can always DM. */
  allowDmsFromServerMembers: boolean;
  /** DMs from non-friends land in Message Requests instead of the main DM list. */
  messageRequests: boolean;
  /** Share my activity (what I am playing/listening to) with others. */
  showActivity: boolean;
  /** Who may send me a friend request (any ticked group; none ticked = nobody). */
  friendRequests: { everyone: boolean; friendsOfFriends: boolean; serverMembers: boolean };
}
export const DEFAULT_PRIVACY: Privacy = { allowDmsFromServerMembers: true, messageRequests: true, showActivity: true, friendRequests: { everyone: true, friendsOfFriends: true, serverMembers: true } };
export interface SelfUser extends User { privacy: Privacy; email: string; mfaEnabled: boolean; verified: boolean; theme: 'dark' | 'light' | 'amoled'; settings: Record<string, unknown> }
export interface Guild {
  id: Id; name: string; icon: string | null; banner: string | null; description: string | null;
  ownerId: Id; systemChannelId: Id | null; rulesChannelId: Id | null; boostLevel: number; boostCount: number;
  features: string[]; vanityUrl: string | null; createdAt: string;
}
export interface Role { id: Id; guildId: Id; name: string; color: number; hoist: boolean; position: number; permissions: string; mentionable: boolean; icon: string | null }
export interface OverwriteDTO { id: Id; type: 'role' | 'member'; allow: string; deny: string }
export interface Channel {
  id: Id; guildId: Id | null; type: ChannelType; name: string | null; topic: string | null; position: number;
  parentId: Id | null; nsfw: boolean; slowmode: number; bitrate: number | null; userLimit: number | null;
  overwrites: OverwriteDTO[]; lastMessageId: Id | null; recipients?: User[]; ownerId?: Id | null;
  archived?: boolean; createdAt: string;
  /** Additive (platform pass). Forum parents: tag catalogue; threads: tags applied + lifecycle. */
  availableTags?: ForumTag[]; requireTag?: boolean; defaultAutoArchiveDuration?: number;
  appliedTags?: Id[]; autoArchiveDuration?: number; locked?: boolean; archiveAt?: string | null;
}
export interface Member { guildId: Id; user: User; nick: string | null; roles: Id[]; joinedAt: string; timeoutUntil: string | null; avatar?: string | null; /** true until the member accepts the server rules (membership screening) */ pending?: boolean }
export interface Attachment { id: Id; filename: string; contentType: string; size: number; url: string; width: number | null; height: number | null; spoiler: boolean }
export interface Embed { type: 'link' | 'image' | 'video' | 'rich'; url?: string; title?: string; description?: string; color?: number; thumbnail?: string; image?: string; video?: string; siteName?: string; fields?: { name: string; value: string; inline?: boolean }[]; footer?: string; author?: string }
export interface Reaction { emoji: string; emojiId: Id | null; count: number; me: boolean }
export interface Message {
  id: Id; channelId: Id; guildId: Id | null; author: User; content: string; createdAt: string; editedAt: string | null;
  type: 'default' | 'reply' | 'join' | 'pin' | 'boost' | 'thread_created' | 'call' | 'poll_result';
  replyTo: Id | null; referenced?: Message | null; mentions: Id[]; mentionRoles: Id[]; mentionEveryone: boolean;
  attachments: Attachment[]; embeds: Embed[]; reactions: Reaction[]; pinned: boolean; stickerIds: Id[]; threadId: Id | null; webhookId?: Id | null;
  /** Additive (platform pass). */
  components?: Component[]; poll?: Poll | null; flags?: number; applicationId?: Id | null;
  interaction?: { id: Id; type: number; name: string | null; userId: Id } | null;
}
export interface Invite { code: string; guildId: Id; channelId: Id; inviterId: Id; uses: number; maxUses: number | null; expiresAt: string | null; temporary: boolean; guild?: Pick<Guild, 'id' | 'name' | 'icon'>; approxMembers?: number }
export interface Relationship { user: User; type: 'friend' | 'blocked' | 'incoming' | 'outgoing' }
export interface Emoji { id: Id; guildId: Id; name: string; animated: boolean; url: string }
export interface Sticker { id: Id; guildId: Id; name: string; url: string; format: 'png' | 'apng' | 'lottie' | 'gif' }
export interface VoiceState { userId: Id; guildId: Id | null; channelId: Id | null; selfMute: boolean; selfDeaf: boolean; serverMute: boolean; serverDeaf: boolean; video: boolean; streaming: boolean; suppress: boolean; /** ISO time when the user asked to speak on a stage (null/absent = no request). */ requestToSpeakAt?: string | null }
export interface AuditEntry { id: Id; guildId: Id; actorId: Id; action: string; /** numeric AuditActionType (additive) */ actionType?: number; targetId: Id | null; changes: unknown; reason: string | null; createdAt: string }
export interface ReadState { channelId: Id; lastReadId: Id | null; mentionCount: number }
export interface Webhook { id: Id; guildId: Id; channelId: Id; name: string; avatar: string | null; token?: string }
export interface AutoModRule { id: Id; guildId: Id; name: string; enabled: boolean; trigger: 'keyword' | 'spam' | 'mention_spam' | 'link'; keywords: string[]; action: 'block' | 'timeout' | 'alert'; exemptRoles: Id[] }
export interface VoiceToken { token: string; url: string; room: string }
export interface Page<T> { items: T[]; nextCursor: Id | null }
export interface ApiError { code: string; message: string; details?: unknown; /** Discord-style numeric code (additive; see ErrorCode). */ errorCode?: number; /** Field-level validation errors (additive). */ errors?: FieldErrors; retry_after?: number; global?: boolean }

// ---- Push notifications (server: POST/DELETE /users/@me/push-devices, GET /push/vapid-public-key, /users/@me/notification-settings) ----
export type PushPlatform = 'web' | 'android' | 'ios' | 'desktop';
export interface WebPushSubscriptionJSON { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }
/** web/desktop send `subscription`; android/ios send the FCM/APNs `token`. */
export interface RegisterPushDevice { platform: PushPlatform; token?: string; subscription?: WebPushSubscriptionJSON }
export interface PushDevice { id: Id; platform: PushPlatform; createdAt: string; lastUsedAt: string; current: boolean }
export type NotificationLevel = 'all' | 'mentions' | 'none';
export interface GuildNotificationSettings { guildId: Id; muted: boolean; mutedUntil: string | null; suppressEveryone: boolean; suppressRoles: boolean; level: NotificationLevel | null }
export interface ChannelNotificationSettings { channelId: Id; muted: boolean; mutedUntil: string | null }
export interface NotificationSettings { pushEnabled: boolean; guilds: GuildNotificationSettings[]; channels: ChannelNotificationSettings[] }
