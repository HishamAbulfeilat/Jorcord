import type { CrosspostOrigin, ServerTag } from './parity';
import type { Component, FieldErrors, ForumTag, Poll } from './platform';
/** Wire types shared by server and clients. IDs are snowflake strings; bigints (permissions) travel as strings. */
export type Id = string;
export type Presence = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
export type ChannelType = 'text' | 'voice' | 'announcement' | 'stage' | 'forum' | 'media' | 'category' | 'dm' | 'group_dm' | 'thread';

export interface User {
  id: Id; username: string; displayName: string | null; avatar: string | null; banner: string | null;
  accentColor: string | null; bio: string | null; pronouns: string | null; bot: boolean; createdAt: string;
  customStatus?: { text: string | null; emoji: string | null; /** ISO time; the server clears the status then */ expiresAt?: string | null } | null;
  /** Two-colour profile theme (#rrggbb pair), visible to others. */
  themeColors?: [string, string] | null;
  /** Cosmetics (ids from AVATAR_DECORATIONS / PROFILE_EFFECTS / NAME_PLATES) and the server tag the user wears. */
  avatarDecoration?: string | null; profileEffect?: string | null; namePlate?: string | null; serverTag?: ServerTag | null;
  presence?: Presence;
  /** Badge bitfield (`UserFlags`); 0/absent = none. */
  publicFlags?: number;
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
export interface SelfUser extends User { privacy: Privacy; /** Confirmed 18+ (unlocks age-restricted channels). */ ageConfirmed?: boolean; email: string; mfaEnabled: boolean; verified: boolean; theme: 'dark' | 'light' | 'amoled'; settings: Record<string, unknown> }
export interface Guild {
  id: Id; name: string; icon: string | null; banner: string | null; description: string | null;
  ownerId: Id; systemChannelId: Id | null; rulesChannelId: Id | null; boostLevel: number; boostCount: number;
  features: string[]; vanityUrl: string | null; createdAt: string;
  /** 3-4 character tag members may wear beside their name, and its badge icon id (TAG_BADGES). */
  tag?: string | null; tagBadge?: string | null;
  /** Safety (see GuildSafety): enforced server-side. `invitesPausedUntil` is set while invites/joins are paused (raid protection or manual). */
  verificationLevel?: 0 | 1 | 2 | 3 | 4; explicitFilter?: 0 | 1 | 2; defaultNotifications?: 'all' | 'mentions'; invitesPausedUntil?: string | null;
  /** 'optin': members must opt in (Privacy settings) before other members can DM them through this server. */
  memberDms?: 'open' | 'optin';
  /** Community servers only (null otherwise). */
  welcomeScreen?: WelcomeScreen | null;
}
/** Welcome screen of a community server (feature COMMUNITY): shown to people who just joined. Pinned channels are always visible to @everyone. */
export interface WelcomeScreenChannel { channelId: Id; description: string; emoji: string | null }
export interface WelcomeScreen { enabled: boolean; description: string | null; channels: WelcomeScreenChannel[] }
export const WELCOME_SCREEN_MAX_CHANNELS = 5;
export interface Role { id: Id; guildId: Id; name: string; color: number; /** Second stop of a gradient name colour (needs a non-zero `color`), or null. */ colorSecondary?: number | null; hoist: boolean; position: number; permissions: string; mentionable: boolean; icon: string | null }
export interface OverwriteDTO { id: Id; type: 'role' | 'member'; allow: string; deny: string }
export interface Channel {
  id: Id; guildId: Id | null; type: ChannelType; name: string | null; topic: string | null; position: number;
  parentId: Id | null; nsfw: boolean; slowmode: number; bitrate: number | null; userLimit: number | null;
  overwrites: OverwriteDTO[]; lastMessageId: Id | null; recipients?: User[]; ownerId?: Id | null;
  archived?: boolean; createdAt: string;
  /** 1:1 DMs only: an end-to-end encrypted "secret chat". The server stores only ciphertext envelopes (docs/E2EE_DMS.md). */
  encrypted?: boolean;
  /** Additive (platform pass). Forum parents: tag catalogue; threads: tags applied + lifecycle. */
  availableTags?: ForumTag[]; requireTag?: boolean; defaultAutoArchiveDuration?: number;
  /** Forum/media defaults: post sort order, default layout, and the reaction auto-added to every new post. */
  defaultSortOrder?: 'latest_activity' | 'creation_date'; defaultForumLayout?: 'list' | 'gallery'; defaultReactionEmoji?: string | null;
  appliedTags?: Id[]; autoArchiveDuration?: number; locked?: boolean; archiveAt?: string | null;
  /** Threads: private threads are visible only to their members (and MANAGE_THREADS holders); `invitable` lets any member add others. */
  private?: boolean; invitable?: boolean;
  /** Group DMs: custom icon (asset URL). */
  icon?: string | null;
  /** A channel that hosts clips (short videos) and exposes the clips API. */
  isClipsChannel?: boolean;
}
export interface Member {
  guildId: Id; user: User; nick: string | null; roles: Id[]; joinedAt: string; timeoutUntil: string | null; avatar?: string | null;
  /** Per-server profile overrides (self-only); each falls back to the user-level field when unset. */
  banner?: string | null; bio?: string | null; pronouns?: string | null;
  /** true until the member accepts the server rules (membership screening) */ pending?: boolean; /** ISO time of their first active boost of this server */ boostingSince?: string | null;
}
export interface Attachment { id: Id; filename: string; contentType: string; size: number; url: string; width: number | null; height: number | null; spoiler: boolean }
export interface Embed { type: 'link' | 'image' | 'video' | 'rich'; url?: string; title?: string; description?: string; color?: number; thumbnail?: string; image?: string; video?: string; siteName?: string; fields?: { name: string; value: string; inline?: boolean }[]; footer?: string; author?: string }
/** `count`/`me` cover regular reactions; `burstCount`/`meBurst`/`burstColors` cover burst (super) reactions, which are metered separately. */
export interface Reaction { emoji: string; emojiId: Id | null; count: number; me: boolean; burstCount?: number; meBurst?: boolean; burstColors?: string[] }
/** Snapshot of a forwarded message. Author is deliberately not included; the origin ids let readers who can see it jump there. */
export interface ForwardSnapshot { content: string; attachments: Attachment[]; embeds: Embed[]; createdAt: string; editedAt: string | null; sourceGuildId: Id | null; sourceChannelId: Id; sourceMessageId: Id }
export interface Message {
  id: Id; channelId: Id; guildId: Id | null; author: User; content: string; createdAt: string; editedAt: string | null;
  type: 'default' | 'reply' | 'join' | 'pin' | 'boost' | 'thread_created' | 'call' | 'poll_result';
  replyTo: Id | null; referenced?: Message | null; mentions: Id[]; mentionRoles: Id[]; mentionEveryone: boolean;
  attachments: Attachment[]; embeds: Embed[]; reactions: Reaction[]; pinned: boolean; stickerIds: Id[]; threadId: Id | null; webhookId?: Id | null;
  /** Additive (platform pass). */
  components?: Component[]; poll?: Poll | null; flags?: number; applicationId?: Id | null;
  interaction?: { id: Id; type: number; name: string | null; userId: Id } | null;
  /** Set on a forwarded message: the original's content as it was when forwarded. */
  forward?: ForwardSnapshot | null;
  /** Published from an announcement channel this channel follows (flags & IS_CROSSPOST). */
  crosspost?: CrosspostOrigin | null;
  /** Controls which mentions trigger notifications. */
  allowedMentions?: AllowedMentions | null;
  /** Set when a link in the content looks like a scam or phishing attempt (server-side scoring, see trust.ts). Absent when nothing is suspicious. */
  linkWarnings?: import('./trust').LinkWarning[];
}
/** R19: a prior version of an edited message's content (`GET /channels/:id/messages/:mid/edits`). Newest first; the current content is not included. */
export interface MessageEdit { id: Id; messageId: Id; content: string; editedAt: string }
/**
 * Controls which mentions trigger notifications for a message (Discord-shape; Jorcord adds `everyone`).
 * When present it overrides default pings: only parse entries ping, and the explicit id lists ping in addition.
 */
export interface AllowedMentions {
  /** Mention types to parse: 'users' = user mentions, 'roles' = role mentions, 'everyone' = @everyone/@here, 'replied_user' = the user being replied to. */
  parse?: Array<'users' | 'roles' | 'everyone' | 'replied_user'>;
  /** Specific user IDs to allow pinging, in addition to parse. */
  users?: string[];
  /** Specific role IDs to allow pinging, in addition to parse. */
  roles?: string[];
}
/** A message reminder (private). `firedAt` is set once it is due. */
export interface Reminder { id: Id; remindAt: string; firedAt: string | null; message: Message }
export interface Invite { code: string; guildId: Id; channelId: Id; inviterId: Id; uses: number; maxUses: number | null; expiresAt: string | null; temporary: boolean; guild?: Pick<Guild, 'id' | 'name' | 'icon'>; approxMembers?: number }
export interface Relationship { user: User; type: 'friend' | 'blocked' | 'incoming' | 'outgoing' }
export interface Emoji { id: Id; guildId: Id; name: string; animated: boolean; url: string; /** When present, only members holding one of these roles (or emoji managers) may use the emoji. */ roleIds?: Id[] }
export interface Sticker { id: Id; guildId: Id; name: string; url: string; format: 'png' | 'apng' | 'lottie' | 'gif' }
export interface VoiceState { userId: Id; guildId: Id | null; channelId: Id | null; selfMute: boolean; selfDeaf: boolean; serverMute: boolean; serverDeaf: boolean; video: boolean; streaming: boolean; suppress: boolean; /** ISO time when the user asked to speak on a stage (null/absent = no request). */ requestToSpeakAt?: string | null; /** userId of the streamer this member is currently watching (null/absent = not watching). */ watching?: string | null; /** cap on how many members may watch this member's stream (null/absent = uncapped). */ streamViewerLimit?: number | null; /** true while this member holds priority speaker (server-confirmed: needs PRIORITY_SPEAKER and the right to speak); others are ducked while they talk. */ prioritySpeaker?: boolean }
/** One raised hand in a stage channel's queue. `userId` is null for an anonymous hand in the public event (moderators read identities from GET /channels/:id/stage/queue). */
export interface StageQueueEntry { userId: Id | null; anonymous: boolean; requestToSpeakAt: string; position: number }
/** A member a moderator barred from raising their hand / speaking in a stage channel. */
export interface StageBlock { userId: Id; blockedBy: Id; reason: string | null; createdAt: string }
/** A Go Live stream in a voice channel and who is watching it. `kicked` is only sent to the streamer and moderators. */
export interface StreamInfo { channelId: Id; streamerId: Id; viewerLimit: number | null; /** min(viewerLimit, the server cap) */ effectiveLimit: number; viewerCount: number; viewers: Id[]; kicked?: Id[] }
/** An active voice-channel recording session. */
export interface VoiceRecording { id: Id; channelId: Id; guildId: Id | null; startedBy: Id; startedAt: string }
export interface AuditEntry { id: Id; guildId: Id; actorId: Id; action: string; /** numeric AuditActionType (additive) */ actionType?: number; targetId: Id | null; changes: unknown; reason: string | null; createdAt: string }
export interface ReadState { channelId: Id; lastReadId: Id | null; mentionCount: number }
export interface Webhook { id: Id; guildId: Id; channelId: Id; name: string; avatar: string | null; token?: string }
export type AutoModTrigger = 'keyword' | 'keyword_preset' | 'spam' | 'mention_spam' | 'link' | 'regex' | 'invite_link' | 'caps' | 'repeated_chars' | 'suspicious_links';
export type AutoModAction = 'block' | 'timeout' | 'alert' | 'warn';
/** Trigger tuning: spamCount messages within spamSeconds; capsPercent of letters (at least capsMinLength letters); a run of repeatLimit identical characters. */
export interface AutoModOptions { spamCount?: number; spamSeconds?: number; capsPercent?: number; capsMinLength?: number; repeatLimit?: number; /** suspicious_links: lowest link risk score (0-100) that triggers the rule; default 50 */ linkMinScore?: number }
export type AutoModPreset = 'profanity' | 'sexual_content' | 'slurs';
export interface AutoModRule {
  id: Id; guildId: Id; name: string; enabled: boolean; trigger: AutoModTrigger; keywords: string[]; action: AutoModAction; exemptRoles: Id[];
  /** Additive (AutoMod depth). */
  presets?: AutoModPreset[]; allowList?: string[]; mentionLimit?: number; exemptChannels?: Id[]; timeoutSeconds?: number; customMessage?: string | null;
  /** AutoMod v3: every action runs (block/timeout/warn stop the message, alert only logs); `action` is the first one. */
  actions?: AutoModAction[]; alertChannelId?: Id | null; regexPatterns?: string[]; testMode?: boolean; options?: AutoModOptions;
}
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
export interface GuildNotificationSettings { guildId: Id; muted: boolean; mutedUntil: string | null; suppressEveryone: boolean; suppressRoles: boolean; level: NotificationLevel | null; /** batch pings into the digest instead of notifying */ digest?: boolean }
export interface ChannelNotificationSettings { channelId: Id; muted: boolean; mutedUntil: string | null; digest?: boolean }
export interface NotificationSettings { pushEnabled: boolean; guilds: GuildNotificationSettings[]; channels: ChannelNotificationSettings[] }
