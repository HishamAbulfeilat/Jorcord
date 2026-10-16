/** Typed REST client written against docs/CONTRACT.md. All calls go through the swappable transport. */
import type {
  Activity, Attachment, AuditEntry, AutoModRule, Channel, Emoji, Guild, GuildFull, Invite, Member, Message, MessageEdit, Relationship, ReadState, Role, SelfUser, Sticker, User, VoiceToken, Id, Presence, OverwriteDTO,
  AllowedMentions,
  Reminder, ModView, ModWarning, ModNote, BulkModerationFilter, BulkModerationResult, PruneResult, BoostSummary, LinkedRoleView, LinkedCriterion, RoleMetadataApp, DirectoryApp, DirectoryCategory, SoundboardSound, Connection, PublicConnection, GifFavorite, GuildTemplate, GuildWidgetSettings, GuildInsights, ChannelFollow, Onboarding, OnboardingResponse, GuildSafety, SafetyPreset, Application, ApplicationCommand, CommandPermissionOverwrite, CommandOptionChoice, CreatePoll, ForumTag, InteractionOptionValue, ModalSubmitRow, OAuthAuthorizePreview, OAuthAuthorizeResult, ScheduledEvent, StageInstance, Report,
} from '@jorcord/shared';
import { send } from './transport';

export interface AuthResult { user: SelfUser; accessToken: string; refreshToken: string }
export interface UserProfile extends User { activities?: Activity[]; connections?: PublicConnection[]; note?: string | null; mutualGuilds?: { id: Id; name: string; icon: string | null; nick?: string | null }[]; mutualFriends?: User[] }
export interface MessageQuery { limit?: number; before?: Id; after?: Id; around?: Id }
export interface SearchQuery { q?: string; authorId?: Id; mentions?: Id; channelId?: Id; /** comma-separated: link,embed,file,image,video,sticker */ has?: string; before?: string; after?: string; during?: string; pinned?: string; sort_by?: string; sort_order?: string }
export interface SendMessageInput { content: string; replyTo?: Id | null; files?: File[]; nonce?: string; stickerIds?: Id[]; poll?: CreatePoll; allowedMentions?: AllowedMentions | null }
export interface CreateEventInput { name: string; description?: string | null; entityType: number; channelId?: Id | null; scheduledStartTime: string; scheduledEndTime?: string | null; location?: string | null; privacyLevel?: 2 }
export interface CommandPermissionSet { commandId: Id; applicationId: Id; guildId: Id; permissions: CommandPermissionOverwrite[] }
export interface CommandCatalog { commands: ApplicationCommand[]; applications: { id: Id; name: string; icon: string | null; botUserId: Id }[] }
export interface ScreeningInfo { enabled: boolean; rulesChannelId: Id | null; description: string | null; pending: boolean }
export type InteractionInput =
  | { type: 2; channelId: Id; data: { id: Id; options?: InteractionOptionValue[]; targetId?: Id } }
  | { type: 4; channelId: Id; data: { id: Id; options: InteractionOptionValue[] } }
  | { type: 3; channelId: Id; messageId: Id; data: { customId: string; values?: string[] } }
  | { type: 5; channelId: Id; interactionId: Id; data: { customId: string; components: ModalSubmitRow[] } };
export interface PushDevice { id: Id; platform: 'web' | 'android' | 'ios' | 'desktop'; createdAt: string | null; lastUsedAt: string | null; current?: boolean }
export type PushRegistration = { platform: 'web' | 'desktop'; subscription: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } } } | { platform: 'android' | 'ios'; token: string };
export interface GuildNotify { muted: boolean; mutedUntil: string | null; suppressEveryone: boolean; suppressRoles: boolean; level: 'all' | 'mentions' | 'none' | null }
export interface ChannelNotify { muted: boolean; mutedUntil: string | null }
export interface NotificationSettings { pushEnabled: boolean; guilds: (GuildNotify & { guildId: Id })[]; channels: (ChannelNotify & { channelId: Id })[] }
export interface AutoModTestResult { ruleId: Id; name: string; trigger: string; enabled: boolean; testMode: boolean; actions: string[]; matched: boolean; evaluated: boolean }
export interface GifResult { id: string; url: string; preview: string; title?: string }

const arr = <T>(x: any): T[] => (Array.isArray(x) ? x : Array.isArray(x?.items) ? x.items : []);
const enc = encodeURIComponent;
export const emojiKey = (emoji: string, emojiId?: Id | null) => enc(emojiId ? `${emoji}:${emojiId}` : emoji);

export interface DirectoryQuery { q?: string; category?: DirectoryCategory | ''; sort?: 'popular' | 'new'; limit?: number; offset?: number }
export const api = {
  directory: {
    apps: (q: DirectoryQuery = {}) => { const p = new URLSearchParams(); if (q.q) p.set('q', q.q); if (q.category) p.set('category', q.category); if (q.sort) p.set('sort', q.sort); if (q.limit) p.set('limit', String(q.limit)); if (q.offset) p.set('offset', String(q.offset)); return send<{ items: DirectoryApp[]; total: number }>({ method: 'GET', path: `/directory/apps${p.size ? `?${p}` : ''}` }); },
    categories: () => send<{ id: DirectoryCategory; name: string; count: number }[]>({ method: 'GET', path: '/directory/categories' }).then((x) => arr<{ id: DirectoryCategory; name: string; count: number }>(x)),
  },
  auth: {
    register: (b: { email: string; username: string; password: string; displayName?: string }) => send<AuthResult>({ method: 'POST', path: '/auth/register', body: b, auth: false }),
    login: (b: { email: string; password: string; totp?: string }) => send<AuthResult>({ method: 'POST', path: '/auth/login', body: b, auth: false }),
    logout: () => send({ method: 'POST', path: '/auth/logout' }),
    sessions: () => send<any[]>({ method: 'GET', path: '/auth/sessions' }).then((x) => arr<any>(x)),
    revokeSession: (id: string) => send({ method: 'POST', path: '/auth/sessions', body: { id } }),
    mfaSetup: () => send<{ secret: string; uri?: string; otpauthUrl?: string; qr?: string }>({ method: 'POST', path: '/auth/mfa/setup' }),
    mfaEnable: (code: string) => send<{ recoveryCodes?: string[] }>({ method: 'POST', path: '/auth/mfa/enable', body: { code, totp: code } }),
    mfaDisable: (code: string, password?: string) => send({ method: 'POST', path: '/auth/mfa/disable', body: { code, totp: code, password } }),
    verifyEmail: (token: string) => send({ method: 'POST', path: '/auth/verify-email', body: { token }, auth: false }),
    sendVerifyEmail: () => send({ method: 'POST', path: '/auth/verify-email/send' }),
    forgotPassword: (email: string) => send({ method: 'POST', path: '/auth/password/forgot', body: { email }, auth: false }),
    resetPassword: (token: string, newPassword: string) => send({ method: 'POST', path: '/auth/password/reset', body: { token, newPassword }, auth: false }),
    password: (b: { currentPassword: string; newPassword: string }) => send({ method: 'POST', path: '/auth/password', body: b }),
  },
  users: {
    me: () => send<SelfUser>({ method: 'GET', path: '/users/@me' }),
    patchMe: (b: Partial<{ displayName: string | null; bio: string | null; pronouns: string | null; avatar: string | null; banner: string | null; accentColor: string | null; themeColors: [string, string] | null; avatarDecoration: string | null; profileEffect: string | null; namePlate: string | null; serverTagGuildId: Id | null; customStatus: User['customStatus']; theme: SelfUser['theme']; settings: Record<string, unknown>; privacy: { allowDmsFromServerMembers?: boolean; messageRequests?: boolean; showActivity?: boolean; friendRequests?: Partial<SelfUser['privacy']['friendRequests']> } }>) => send<SelfUser>({ method: 'PATCH', path: '/users/@me', body: b }),
    get: (id: Id) => send<UserProfile>({ method: 'GET', path: `/users/${id}` }),
    /** Rich presence: replace my activities (<= 5). */
    setActivities: (activities: Omit<Activity, 'startedAt'>[] & Partial<Pick<Activity, 'startedAt'>>[]) => send<{ activities: Activity[] }>({ method: 'PUT', path: '/users/@me/activities', body: { activities } }),
    clearActivities: () => send({ method: 'DELETE', path: '/users/@me/activities' }),
    setPresence: (presence: Presence) => send({ method: 'PUT', path: '/users/@me/presence', body: { presence } }),
    guilds: () => send<Guild[]>({ method: 'GET', path: '/users/@me/guilds' }).then((x) => arr<Guild>(x)),
    leaveGuild: (id: Id) => send({ method: 'DELETE', path: `/users/@me/guilds/${id}` }),
    openDm: (recipientIds: Id[]) => send<Channel>({ method: 'POST', path: '/users/@me/channels', body: { recipientIds } }),
    /** Message requests: move a DM from non-friends to the regular list, or delete it and bar the sender. */
    acceptRequest: (channelId: Id) => send({ method: 'POST', path: `/channels/${channelId}/accept-request` }),
    ignoreRequest: (channelId: Id) => send({ method: 'POST', path: `/channels/${channelId}/ignore-request` }),
    channels: () => send<Channel[]>({ method: 'GET', path: '/users/@me/channels' }).then((x) => arr<Channel>(x)),
    relationships: () => send<Relationship[]>({ method: 'GET', path: '/users/@me/relationships' }).then((x) => arr<Relationship>(x)),
    setRelationship: (userId: Id, type: 'friend' | 'blocked') => send({ method: 'PUT', path: `/users/@me/relationships/${userId}`, body: { type } }),
    removeRelationship: (userId: Id) => send({ method: 'DELETE', path: `/users/@me/relationships/${userId}` }),
    readStates: () => send<ReadState[]>({ method: 'GET', path: '/users/@me/read-states' }).then((x) => arr<ReadState>(x)),
    /** Friend request by username: the contract addresses relationships by user id, so resolve through a username lookup. */
    /** Self-attest 18+ (unlocks age-restricted channels); `unconfirmAge` locks them again. */
    confirmAge: () => send({ method: 'POST', path: '/users/@me/age-confirm', body: { confirm: true } }),
    unconfirmAge: () => send({ method: 'DELETE', path: '/users/@me/age-confirm' }),
    /** Saved for later. */
    savedIds: () => send<Id[]>({ method: 'GET', path: '/users/@me/saved/ids' }).then((x) => arr<Id>(x)),
    saved: (q: { limit?: number; offset?: number } = {}) => send<Message[]>({ method: 'GET', path: '/users/@me/saved', query: q }).then((x) => arr<Message>(x)),
    save: (channelId: Id, messageId: Id) => send({ method: 'PUT', path: `/users/@me/saved/${channelId}/${messageId}` }),
    unsave: (channelId: Id, messageId: Id) => send({ method: 'DELETE', path: `/users/@me/saved/${channelId}/${messageId}` }),
    /** Reminders: pass `inSeconds` or an absolute `remindAt`. */
    reminders: () => send<Reminder[]>({ method: 'GET', path: '/users/@me/reminders' }).then((x) => arr<Reminder>(x)),
    remind: (channelId: Id, messageId: Id, when: { inSeconds: number } | { remindAt: string }) => send<Reminder>({ method: 'POST', path: '/users/@me/reminders', body: { channelId, messageId, ...when } }),
    deleteReminder: (id: Id) => send({ method: 'DELETE', path: `/users/@me/reminders/${id}` }),
    /** Private note about another user (author-only). */
    setNote: (userId: Id, note: string) => send({ method: 'PUT', path: `/users/@me/notes/${userId}`, body: { note } }),
    /** Inbox: recent @mentions (user, my roles, @everyone) in channels I can read. */
    mentions: (q: { before?: Id; limit?: number; guildId?: Id; roles?: boolean; everyone?: boolean } = {}) => send<Message[]>({ method: 'GET', path: '/users/@me/mentions', query: { ...q, roles: q.roles === undefined ? undefined : String(q.roles), everyone: q.everyone === undefined ? undefined : String(q.everyone) } as any }).then((x) => arr<Message>(x)),
    /** GIF favorites / saved media. */
    gifFavorites: () => send<GifFavorite[]>({ method: 'GET', path: '/users/@me/gif-favorites' }).then((x) => arr<GifFavorite>(x)),
    addGifFavorite: (b: { url: string; preview?: string | null; title?: string | null; width?: number | null; height?: number | null }) => send<GifFavorite>({ method: 'POST', path: '/users/@me/gif-favorites', body: b }),
    removeGifFavorite: (id: Id) => send({ method: 'DELETE', path: `/users/@me/gif-favorites/${id}` }),
    /** Profile connections: self-declared links, verified by placing a code on the linked page. */
    connections: () => send<Connection[]>({ method: 'GET', path: '/users/@me/connections' }).then((x) => arr<Connection>(x)),
    addConnection: (b: { type: string; handle: string; visible?: boolean }) => send<Connection>({ method: 'POST', path: '/users/@me/connections', body: b }),
    patchConnection: (id: Id, b: { visible: boolean }) => send<Connection>({ method: 'PATCH', path: `/users/@me/connections/${id}`, body: b }),
    deleteConnection: (id: Id) => send({ method: 'DELETE', path: `/users/@me/connections/${id}` }),
    verifyConnection: (id: Id) => send<Connection>({ method: 'POST', path: `/users/@me/connections/${id}/verify` }),
    findByUsername: (username: string) => send<User[] | User>({ method: 'GET', path: '/users', query: { username } }).then((x) => (Array.isArray(x) ? x : x ? [x] : [])),
  },
  guilds: {
    create: (b: { name: string; icon?: string | null; template?: string }) => send<GuildFull>({ method: 'POST', path: '/guilds', body: b }),
    get: (id: Id) => send<GuildFull>({ method: 'GET', path: `/guilds/${id}` }),
    preview: (id: Id) => send<Guild & { approxMembers?: number }>({ method: 'GET', path: `/guilds/${id}/preview` }),
    patch: (id: Id, b: Partial<Guild> & { discoverable?: boolean; memberScreening?: boolean }) => send<Guild>({ method: 'PATCH', path: `/guilds/${id}`, body: b }),
    delete: (id: Id) => send({ method: 'DELETE', path: `/guilds/${id}` }),
    channels: (id: Id) => send<Channel[]>({ method: 'GET', path: `/guilds/${id}/channels` }).then((x) => arr<Channel>(x)),
    createChannel: (id: Id, b: Partial<Channel> & { name: string; type: Channel['type'] }) => send<Channel>({ method: 'POST', path: `/guilds/${id}/channels`, body: b }),
    reorderChannels: (id: Id, b: { id: Id; position: number; parentId?: Id | null }[]) => send({ method: 'PATCH', path: `/guilds/${id}/channels`, body: b }),
    roles: (id: Id) => send<Role[]>({ method: 'GET', path: `/guilds/${id}/roles` }).then((x) => arr<Role>(x)),
    createRole: (id: Id, b: Partial<Role>) => send<Role>({ method: 'POST', path: `/guilds/${id}/roles`, body: b }),
    patchRole: (id: Id, roleId: Id, b: Partial<Role>) => send<Role>({ method: 'PATCH', path: `/guilds/${id}/roles/${roleId}`, body: b }),
    deleteRole: (id: Id, roleId: Id) => send({ method: 'DELETE', path: `/guilds/${id}/roles/${roleId}` }),
    reorderRoles: (id: Id, b: { id: Id; position: number }[]) => send({ method: 'PATCH', path: `/guilds/${id}/roles`, body: b }),
    members: (id: Id, q: { limit?: number; after?: Id } = {}) => send<Member[]>({ method: 'GET', path: `/guilds/${id}/members`, query: q }).then((x) => arr<Member>(x)),
    searchMembers: (id: Id, q: string) => send<Member[]>({ method: 'GET', path: `/guilds/${id}/members/search`, query: { q } }).then((x) => arr<Member>(x)),
    patchMember: (id: Id, userId: Id, b: Partial<{ nick: string | null; roles: Id[]; timeoutUntil: string | null }>) => send<Member>({ method: 'PATCH', path: `/guilds/${id}/members/${userId}`, body: b }),
    kick: (id: Id, userId: Id) => send({ method: 'DELETE', path: `/guilds/${id}/members/${userId}` }),
    ban: (id: Id, userId: Id, b: { reason?: string; deleteMessageSeconds?: number } = {}) => send({ method: 'PUT', path: `/guilds/${id}/bans/${userId}`, body: b }),
    unban: (id: Id, userId: Id) => send({ method: 'DELETE', path: `/guilds/${id}/bans/${userId}` }),
    bans: (id: Id) => send<{ user: User; reason: string | null }[]>({ method: 'GET', path: `/guilds/${id}/bans` }).then((x) => arr<{ user: User; reason: string | null }>(x)),
    invites: (id: Id) => send<Invite[]>({ method: 'GET', path: `/guilds/${id}/invites` }).then((x) => arr<Invite>(x)),
    createInvite: (id: Id, b: { channelId?: Id; maxUses?: number | null; maxAgeSeconds?: number | null; temporary?: boolean } = {}) => send<Invite>({ method: 'POST', path: `/guilds/${id}/invites`, body: b }),
    auditLogs: (id: Id, q: { limit?: number; before?: Id; action?: string; actionType?: number } = {}) => send<AuditEntry[]>({ method: 'GET', path: `/guilds/${id}/audit-logs`, query: q }).then((x) => arr<AuditEntry>(x)),
    emojis: (id: Id) => send<Emoji[]>({ method: 'GET', path: `/guilds/${id}/emojis` }).then((x) => arr<Emoji>(x)),
    createEmoji: (id: Id, b: { name: string; url: string; animated?: boolean }) => send<Emoji>({ method: 'POST', path: `/guilds/${id}/emojis`, body: b }),
    patchEmoji: (id: Id, eid: Id, b: { name: string }) => send<Emoji>({ method: 'PATCH', path: `/guilds/${id}/emojis/${eid}`, body: b }),
    deleteEmoji: (id: Id, eid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/emojis/${eid}` }),
    stickers: (id: Id) => send<Sticker[]>({ method: 'GET', path: `/guilds/${id}/stickers` }).then((x) => arr<Sticker>(x)),
    createSticker: (id: Id, b: { name: string; url: string; format?: Sticker['format'] }) => send<Sticker>({ method: 'POST', path: `/guilds/${id}/stickers`, body: b }),
    patchSticker: (id: Id, sid: Id, b: { name: string }) => send<Sticker>({ method: 'PATCH', path: `/guilds/${id}/stickers/${sid}`, body: b }),
    deleteSticker: (id: Id, sid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/stickers/${sid}` }),
    automod: (id: Id) => send<AutoModRule[]>({ method: 'GET', path: `/guilds/${id}/automod/rules` }).then((x) => arr<AutoModRule>(x)),
    createAutomod: (id: Id, b: Partial<AutoModRule>) => send<AutoModRule>({ method: 'POST', path: `/guilds/${id}/automod/rules`, body: b }),
    patchAutomod: (id: Id, rid: Id, b: Partial<AutoModRule>) => send<AutoModRule>({ method: 'PATCH', path: `/guilds/${id}/automod/rules/${rid}`, body: b }),
    testAutomod: (id: Id, b: { content: string; mentionCount?: number }) => send<AutoModTestResult[]>({ method: 'POST', path: `/guilds/${id}/automod/test`, body: b }).then((x) => arr<AutoModTestResult>(x)),
    deleteAutomod: (id: Id, rid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/automod/rules/${rid}` }),
    modView: (id: Id, uid: Id) => send<ModView>({ method: 'GET', path: `/guilds/${id}/members/${uid}/mod-view` }),
    warn: (id: Id, uid: Id, reason: string) => send<ModWarning>({ method: 'POST', path: `/guilds/${id}/members/${uid}/warnings`, body: { reason } }),
    deleteWarning: (id: Id, wid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/warnings/${wid}` }),
    addModNote: (id: Id, uid: Id, note: string) => send<ModNote>({ method: 'POST', path: `/guilds/${id}/members/${uid}/notes`, body: { note } }),
    deleteModNote: (id: Id, nid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/notes/${nid}` }),
    bulkModeration: (id: Id, b: { action: 'ban' | 'kick'; userIds?: Id[]; filter?: BulkModerationFilter; reason?: string | null; dryRun: boolean }) => send<BulkModerationResult>({ method: 'POST', path: `/guilds/${id}/moderation/bulk`, body: b }),
    prune: (id: Id, b: { days: number; includeRoles: Id[]; dryRun: boolean }) => send<PruneResult>({ method: 'POST', path: `/guilds/${id}/prune`, body: b }),
    modLogCsv: (id: Id, all = false) => send<string>({ method: 'GET', path: `/guilds/${id}/mod-log.csv${all ? '?all=true' : ''}` }),
    linkedRoles: (id: Id) => send<LinkedRoleView[]>({ method: 'GET', path: `/guilds/${id}/linked-roles` }).then((x) => arr<LinkedRoleView>(x)),
    createLinkedRole: (id: Id, b: { roleId: Id; description?: string | null; criteria: LinkedCriterion[] }) => send<LinkedRoleView>({ method: 'POST', path: `/guilds/${id}/linked-roles`, body: b }),
    patchLinkedRole: (id: Id, lid: Id, b: { description?: string | null; criteria?: LinkedCriterion[] }) => send<LinkedRoleView>({ method: 'PATCH', path: `/guilds/${id}/linked-roles/${lid}`, body: b }),
    deleteLinkedRole: (id: Id, lid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/linked-roles/${lid}` }),
    refreshLinkedRoles: (id: Id) => send<LinkedRoleView[]>({ method: 'POST', path: `/guilds/${id}/linked-roles/refresh` }).then((x) => arr<LinkedRoleView>(x)),
    syncLinkedRoles: (id: Id) => send<{ checked: number; changed: number }>({ method: 'POST', path: `/guilds/${id}/linked-roles/sync` }),
    linkedRoleApps: (id: Id) => send<RoleMetadataApp[]>({ method: 'GET', path: `/guilds/${id}/linked-roles/apps` }).then((x) => arr<RoleMetadataApp>(x)),
    boost: (id: Id, count?: number) => send<Guild>({ method: 'POST', path: `/guilds/${id}/boosts`, body: count ? { count } : {} }),
    unboost: (id: Id) => send<BoostSummary>({ method: 'DELETE', path: `/guilds/${id}/boosts` }),
    boosts: (id: Id) => send<BoostSummary>({ method: 'GET', path: `/guilds/${id}/boosts` }),
    boostSettings: (id: Id, b: { announce?: boolean; boosterRole?: boolean }) => send<BoostSummary>({ method: 'PATCH', path: `/guilds/${id}/boosts/settings`, body: b }),
    search: (id: Id, q: SearchQuery) => send<any>({ method: 'GET', path: `/guilds/${id}/messages/search`, query: q as any }).then((x) => arr<Message>(x)),
    discover: (q?: string) => send<Guild[]>({ method: 'GET', path: '/discover/guilds', query: q ? { q } : undefined }).then((x) => arr<Guild>(x)),
    /** Join a DISCOVERABLE guild without an invite (404 for guilds that are not discoverable). */
    joinDiscoverable: (id: Id) => send<GuildFull>({ method: 'POST', path: `/discover/guilds/${id}/join` }),
    screening: (id: Id) => send<ScreeningInfo>({ method: 'GET', path: `/guilds/${id}/screening` }),
    /** Accept the server rules: lifts the read-only `pending` state of a new member. */
    acceptScreening: (id: Id) => send<Member>({ method: 'PUT', path: `/guilds/${id}/members/@me/screening`, body: { acceptRules: true } }),
    /** What the composer's slash-command picker offers in a channel. */
    commands: (id: Id, channelId?: Id) => send<CommandCatalog>({ method: 'GET', path: `/guilds/${id}/application-commands`, query: channelId ? { channelId } : undefined }),
    events: (id: Id) => send<ScheduledEvent[]>({ method: 'GET', path: `/guilds/${id}/scheduled-events` }).then((x) => arr<ScheduledEvent>(x)),
    createEvent: (id: Id, b: CreateEventInput) => send<ScheduledEvent>({ method: 'POST', path: `/guilds/${id}/scheduled-events`, body: b }),
    patchEvent: (id: Id, eid: Id, b: Partial<CreateEventInput> & { status?: number }) => send<ScheduledEvent>({ method: 'PATCH', path: `/guilds/${id}/scheduled-events/${eid}`, body: b }),
    deleteEvent: (id: Id, eid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/scheduled-events/${eid}` }),
    eventInterest: (id: Id, eid: Id, on: boolean) => send({ method: on ? 'PUT' : 'DELETE', path: `/guilds/${id}/scheduled-events/${eid}/users/@me` }),
    eventUsers: (id: Id, eid: Id) => send<{ user: User }[]>({ method: 'GET', path: `/guilds/${id}/scheduled-events/${eid}/users`, query: { limit: 100 } }).then((x) => arr<{ user: User }>(x)),
    safety: (id: Id) => send<GuildSafety>({ method: 'GET', path: `/guilds/${id}/safety` }),
    patchSafety: (id: Id, b: Partial<{ verificationLevel: number; explicitFilter: number; defaultNotifications: 'all' | 'mentions'; raidProtection: Partial<GuildSafety['raidProtection']>; pauseInvites: boolean }>) => send<GuildSafety>({ method: 'PATCH', path: `/guilds/${id}/safety`, body: b }),
    safetyPreset: (id: Id, preset: SafetyPreset) => send<GuildSafety>({ method: 'POST', path: `/guilds/${id}/safety/preset`, body: { preset } }),
    onboarding: (id: Id) => send<Onboarding>({ method: 'GET', path: `/guilds/${id}/onboarding` }),
    putOnboarding: (id: Id, b: Partial<Pick<Onboarding, 'enabled' | 'defaultChannelIds'>> & { prompts?: any[] }) => send<Onboarding>({ method: 'PUT', path: `/guilds/${id}/onboarding`, body: b }),
    answerOnboarding: (id: Id, optionIds: Id[]) => send<OnboardingResponse>({ method: 'PUT', path: `/guilds/${id}/onboarding/responses`, body: { optionIds } }),
    templates: (id: Id) => send<GuildTemplate[]>({ method: 'GET', path: `/guilds/${id}/templates` }).then((x) => arr<GuildTemplate>(x)),
    createTemplate: (id: Id, b: { name: string; description?: string | null }) => send<GuildTemplate>({ method: 'POST', path: `/guilds/${id}/templates`, body: b }),
    syncTemplate: (id: Id, code: string) => send<GuildTemplate>({ method: 'PUT', path: `/guilds/${id}/templates/${code}` }),
    patchTemplate: (id: Id, code: string, b: { name?: string; description?: string | null }) => send<GuildTemplate>({ method: 'PATCH', path: `/guilds/${id}/templates/${code}`, body: b }),
    deleteTemplate: (id: Id, code: string) => send({ method: 'DELETE', path: `/guilds/${id}/templates/${code}` }),
    template: (code: string) => send<GuildTemplate>({ method: 'GET', path: `/guilds/templates/${code}` }),
    createFromTemplate: (code: string, b: { name: string; icon?: string | null }) => send<GuildFull>({ method: 'POST', path: `/guilds/templates/${code}`, body: b }),
    widget: (id: Id) => send<GuildWidgetSettings>({ method: 'GET', path: `/guilds/${id}/widget` }),
    patchWidget: (id: Id, b: Partial<{ enabled: boolean; channelId: Id | null }>) => send<GuildWidgetSettings>({ method: 'PATCH', path: `/guilds/${id}/widget`, body: b }),
    insights: (id: Id, days: 7 | 14 | 30) => send<GuildInsights>({ method: 'GET', path: `/guilds/${id}/insights`, query: { days } }),
    sounds: (id: Id) => send<SoundboardSound[]>({ method: 'GET', path: `/guilds/${id}/soundboard-sounds` }).then((x) => arr<SoundboardSound>(x)),
    createSound: (id: Id, b: { name: string; url: string; emoji?: string | null; volume?: number }) => send<SoundboardSound>({ method: 'POST', path: `/guilds/${id}/soundboard-sounds`, body: b }),
    patchSound: (id: Id, sid: Id, b: Partial<{ name: string; emoji: string | null; volume: number }>) => send<SoundboardSound>({ method: 'PATCH', path: `/guilds/${id}/soundboard-sounds/${sid}`, body: b }),
    deleteSound: (id: Id, sid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/soundboard-sounds/${sid}` }),
    /** Play a clip into the voice channel I am connected to. */
    playSound: (channelId: Id, soundId: Id) => send({ method: 'POST', path: `/channels/${channelId}/send-soundboard-sound`, body: { soundId } }),
    stageInstances: (id: Id) => send<StageInstance[]>({ method: 'GET', path: `/guilds/${id}/stage-instances` }).then((x) => arr<StageInstance>(x)),
    /** Moderation report queue (Mod View gate): list reports, resolve or dismiss one. */
    reports: (id: Id, q: { status?: 'open' | 'resolved' | 'dismissed' | 'all'; limit?: number; before?: Id } = {}) => send<Report[]>({ method: 'GET', path: `/guilds/${id}/reports`, query: { status: q.status ?? 'open', limit: q.limit ?? 50, ...(q.before ? { before: q.before } : {}) } }).then((x) => arr<Report>(x)),
    resolveReport: (id: Id, rid: Id) => send<Report>({ method: 'PATCH', path: `/guilds/${id}/reports/${rid}`, body: { status: 'resolved' } }),
    dismissReport: (id: Id, rid: Id) => send<Report>({ method: 'PATCH', path: `/guilds/${id}/reports/${rid}`, body: { status: 'dismissed' } }),
  },
  stages: {
    start: (channelId: Id, topic: string) => send<StageInstance>({ method: 'POST', path: '/stage-instances', body: { channelId, topic } }),
    get: (channelId: Id) => send<StageInstance>({ method: 'GET', path: `/stage-instances/${channelId}` }),
    setTopic: (channelId: Id, topic: string) => send<StageInstance>({ method: 'PATCH', path: `/stage-instances/${channelId}`, body: { topic } }),
    end: (channelId: Id) => send({ method: 'DELETE', path: `/stage-instances/${channelId}` }),
  },
  applications: {
    list: () => send<Application[]>({ method: 'GET', path: '/applications' }).then((x) => arr<Application>(x)),
    get: (id: Id) => send<Application>({ method: 'GET', path: `/applications/${id}` }),
    /** The response carries the bot token and client secret exactly once. */
    create: (b: { name: string; description?: string; botPublic?: boolean; redirectUris?: string[] }) => send<Application>({ method: 'POST', path: '/applications', body: b }),
    patch: (id: Id, b: Partial<Pick<Application, 'name' | 'description' | 'icon' | 'botPublic' | 'redirectUris' | 'interactionsEndpointUrl'>> & { directoryListed?: boolean; directoryCategory?: DirectoryCategory; directorySummary?: string; directoryTags?: string[]; directoryPermissions?: string }) => send<Application>({ method: 'PATCH', path: `/applications/${id}`, body: b }),
    delete: (id: Id) => send({ method: 'DELETE', path: `/applications/${id}` }),
    resetToken: (id: Id) => send<{ token: string }>({ method: 'POST', path: `/applications/${id}/bot/reset-token` }),
    resetSecret: (id: Id) => send<{ clientSecret: string }>({ method: 'POST', path: `/applications/${id}/reset-secret` }),
    installs: (id: Id) => send<{ guildId: Id; scopes: string[]; installedAt: string }[]>({ method: 'GET', path: `/applications/${id}/installs` }).then((x) => arr<{ guildId: Id; scopes: string[]; installedAt: string }>(x)),
    commands: (id: Id, guildId?: Id) => send<ApplicationCommand[]>({ method: 'GET', path: guildId ? `/applications/${id}/guilds/${guildId}/commands` : `/applications/${id}/commands` }).then((x) => arr<ApplicationCommand>(x)),
    /** Per-command role/user/channel overrides in a guild (`cid` = application id edits the app-wide default). User sessions with MANAGE_GUILD + MANAGE_ROLES only. */
    commandPermissions: (id: Id, guildId: Id) => send<CommandPermissionSet[]>({ method: 'GET', path: `/applications/${id}/guilds/${guildId}/commands/permissions` }).then((x) => arr<CommandPermissionSet>(x)),
    getCommandPermissions: (id: Id, guildId: Id, cid: Id) => send<CommandPermissionSet>({ method: 'GET', path: `/applications/${id}/guilds/${guildId}/commands/${cid}/permissions` }),
    putCommandPermissions: (id: Id, guildId: Id, cid: Id, permissions: CommandPermissionOverwrite[]) => send<CommandPermissionSet>({ method: 'PUT', path: `/applications/${id}/guilds/${guildId}/commands/${cid}/permissions`, body: { permissions } }),
    deleteCommand: (id: Id, cid: Id, guildId?: Id) => send({ method: 'DELETE', path: guildId ? `/applications/${id}/guilds/${guildId}/commands/${cid}` : `/applications/${id}/commands/${cid}` }),
  },
  oauth: {
    preview: (q: { clientId: Id; scope: string; permissions?: string }) => send<OAuthAuthorizePreview>({ method: 'GET', path: '/oauth2/authorize', query: q }),
    authorize: (b: { clientId: Id; scope: string; permissions?: string; guildId?: Id; redirectUri?: string; state?: string }) => send<OAuthAuthorizeResult>({ method: 'POST', path: '/oauth2/authorize', body: b }),
  },
  interactions: {
    /** 202 `{id}`: the answer arrives over the gateway (MESSAGE_CREATE, INTERACTION_MODAL, INTERACTION_AUTOCOMPLETE_RESULT, INTERACTION_FAILED). */
    send: (b: InteractionInput) => send<{ id: Id }>({ method: 'POST', path: '/interactions', body: b }),
  },
  channels: {
    /** Announcement channels: follow into a channel of mine, publish a message, list/stop follows. */
    follow: (sourceId: Id, targetChannelId: Id) => send<ChannelFollow>({ method: 'POST', path: `/channels/${sourceId}/followers`, body: { webhookChannelId: targetChannelId } }),
    followers: (id: Id) => send<ChannelFollow[]>({ method: 'GET', path: `/channels/${id}/followers` }).then((x) => arr<ChannelFollow>(x)),
    follows: (id: Id) => send<ChannelFollow[]>({ method: 'GET', path: `/channels/${id}/follows` }).then((x) => arr<ChannelFollow>(x)),
    unfollow: (followId: Id) => send({ method: 'DELETE', path: `/follows/${followId}` }),
    crosspost: (channelId: Id, messageId: Id) => send<Message>({ method: 'POST', path: `/channels/${channelId}/messages/${messageId}/crosspost` }),
    patch: (id: Id, b: Partial<Channel>) => send<Channel>({ method: 'PATCH', path: `/channels/${id}`, body: b }),
    delete: (id: Id) => send({ method: 'DELETE', path: `/channels/${id}` }),
    putOverwrite: (id: Id, ow: OverwriteDTO) => send({ method: 'PUT', path: `/channels/${id}/permissions/${ow.id}`, body: { type: ow.type, allow: ow.allow, deny: ow.deny } }),
    deleteOverwrite: (id: Id, owId: Id) => send({ method: 'DELETE', path: `/channels/${id}/permissions/${owId}` }),
    ack: (id: Id, messageId: Id) => send({ method: 'POST', path: `/channels/${id}/ack`, body: { messageId } }),
    typing: (id: Id) => send({ method: 'POST', path: `/channels/${id}/typing` }),
    webhooks: (id: Id) => send<any[]>({ method: 'GET', path: `/channels/${id}/webhooks` }).then((x) => arr<any>(x)),
    createWebhook: (id: Id, name: string, avatar?: string | null) => send<any>({ method: 'POST', path: `/channels/${id}/webhooks`, body: { name, ...(avatar ? { avatar } : {}) } }),
    deleteWebhook: (id: Id, wid: Id) => send({ method: 'DELETE', path: `/channels/${id}/webhooks/${wid}` }),
    forumPost: (id: Id, b: { name: string; content: string; appliedTags?: Id[]; autoArchiveDuration?: number }) => send<{ channel: Channel; message?: Message }>({ method: 'POST', path: `/channels/${id}/forum/posts`, body: b }),
    /** Active or archived threads of a channel: `{threads,members,hasMore}`. */
    threads: (id: Id, archived = false) => send<any>({ method: 'GET', path: `/channels/${id}/threads/${archived ? 'archived' : 'active'}` }).then((x) => (Array.isArray(x) ? x : (x?.threads ?? [])) as Channel[]),
    addRecipient: (channelId: Id, userId: Id) => send({ method: 'PUT', path: `/channels/${channelId}/recipients/${userId}` }),
    removeRecipient: (channelId: Id, userId: Id | '@me') => send({ method: 'DELETE', path: `/channels/${channelId}/recipients/${userId}` }),
  },
  messages: {
    list: (channelId: Id, q: MessageQuery = {}) => send<Message[]>({ method: 'GET', path: `/channels/${channelId}/messages`, query: { limit: 50, ...q } }).then((x) => arr<Message>(x)),
    send: (channelId: Id, m: SendMessageInput) => {
      if (m.files?.length) {
        const f = new FormData();
        f.set('content', m.content); if (m.replyTo) f.set('replyTo', m.replyTo);
        m.files.forEach((file) => f.append('files[]', file, file.name));
        return send<Message>({ method: 'POST', path: `/channels/${channelId}/messages`, form: f });
      }
      return send<Message>({ method: 'POST', path: `/channels/${channelId}/messages`, body: { content: m.content, replyTo: m.replyTo ?? null, ...(m.stickerIds?.length ? { stickerIds: m.stickerIds } : {}), ...(m.poll ? { poll: m.poll } : {}), ...(m.allowedMentions ? { allowedMentions: m.allowedMentions } : {}) } });
    },
    /** Forward a message I can read into `channelId` (snapshot copy, no pings). */
    forward: (channelId: Id, src: { channelId: Id; messageId: Id }) => send<Message>({ method: 'POST', path: `/channels/${channelId}/messages`, body: { forward: src } }),
    edit: (channelId: Id, id: Id, content: string) => send<Message>({ method: 'PATCH', path: `/channels/${channelId}/messages/${id}`, body: { content } }),
    /** R19: prior versions of an edited message's content, newest first (the current content is not included). */
    editHistory: (channelId: Id, id: Id) => send<MessageEdit[]>({ method: 'GET', path: `/channels/${channelId}/messages/${id}/edits` }).then((x) => arr<MessageEdit>(x)),
    delete: (channelId: Id, id: Id) => send({ method: 'DELETE', path: `/channels/${channelId}/messages/${id}` }),
    bulkDelete: (channelId: Id, ids: Id[]) => send({ method: 'POST', path: `/channels/${channelId}/messages/bulk-delete`, body: { messageIds: ids } }),
    react: (channelId: Id, id: Id, emoji: string, emojiId?: Id | null) => send({ method: 'PUT', path: `/channels/${channelId}/messages/${id}/reactions/${emojiKey(emoji, emojiId)}/@me` }),
    unreact: (channelId: Id, id: Id, emoji: string, emojiId?: Id | null) => send({ method: 'DELETE', path: `/channels/${channelId}/messages/${id}/reactions/${emojiKey(emoji, emojiId)}/@me` }),
    reactors: (channelId: Id, id: Id, emoji: string, emojiId?: Id | null) => send<User[]>({ method: 'GET', path: `/channels/${channelId}/messages/${id}/reactions/${emojiKey(emoji, emojiId)}` }).then((x) => arr<User>(x)),
    pins: (channelId: Id) => send<Message[]>({ method: 'GET', path: `/channels/${channelId}/pins` }).then((x) => arr<Message>(x)),
    pin: (channelId: Id, id: Id) => send({ method: 'PUT', path: `/channels/${channelId}/pins/${id}` }),
    unpin: (channelId: Id, id: Id) => send({ method: 'DELETE', path: `/channels/${channelId}/pins/${id}` }),
    createThread: (channelId: Id, id: Id, name: string, autoArchiveDuration?: number) => send<Channel>({ method: 'POST', path: `/channels/${channelId}/messages/${id}/threads`, body: { name, ...(autoArchiveDuration ? { autoArchiveDuration } : {}) } }),
    /** Replaces my votes with `answerIds` ([] clears them). Returns the poll message as I see it. */
    vote: (channelId: Id, id: Id, answerIds: number[]) => send<Message>({ method: 'PUT', path: `/channels/${channelId}/polls/${id}/votes`, body: { answerIds } }),
    removeVote: (channelId: Id, id: Id) => send<Message>({ method: 'DELETE', path: `/channels/${channelId}/polls/${id}/votes/@me` }),
    voters: (channelId: Id, id: Id, answerId: number) => send<{ users: User[] }>({ method: 'GET', path: `/channels/${channelId}/polls/${id}/answers/${answerId}`, query: { limit: 100 } }).then((x) => x?.users ?? []),
    endPoll: (channelId: Id, id: Id) => send<Message>({ method: 'POST', path: `/channels/${channelId}/polls/${id}/expire` }),
    /** Report a message in a guild channel (the reporter must be able to read the channel). Returns the new report id. */
    report: (channelId: Id, messageId: Id, body: { reason: string; description?: string }) => send<{ id: Id }>({ method: 'POST', path: `/channels/${channelId}/messages/${messageId}/report`, body }),
  },
  invites: {
    get: (code: string) => send<Invite>({ method: 'GET', path: `/invites/${code}`, auth: false }),
    join: (code: string) => send<{ guild?: GuildFull; guildId?: Id } & Partial<GuildFull>>({ method: 'POST', path: `/invites/${code}` }),
    delete: (code: string) => send({ method: 'DELETE', path: `/invites/${code}` }),
  },
  files: {
    upload: (file: File) => { const f = new FormData(); f.append('file', file, file.name); return send<Attachment>({ method: 'POST', path: '/uploads', form: f }); },
    /** Upload an image and return the URL to store in avatar/icon/banner fields (the server rejects data: URIs). */
    uploadImage: (file: File) => { const f = new FormData(); f.append('file', file, file.name); return send<Attachment>({ method: 'POST', path: '/uploads', form: f }).then((a) => a.url); },
  },
  voice: {
    token: (channelId: Id) => send<VoiceToken>({ method: 'POST', path: '/voice/token', body: { channelId } }),
    /** Server mute/deafen another member (MUTE_MEMBERS / DEAFEN_MEMBERS). */
    moderate: (guildId: Id, userId: Id, b: { mute?: boolean; deaf?: boolean }) => send({ method: 'PATCH', path: `/guilds/${guildId}/voice-states/${userId}`, body: b }),
    move: (guildId: Id, userId: Id, channelId: Id) => send({ method: 'POST', path: `/guilds/${guildId}/voice-states/${userId}/move`, body: { channelId } }),
    disconnect: (guildId: Id, userId: Id) => send({ method: 'DELETE', path: `/guilds/${guildId}/voice-states/${userId}` }),
    /** Stage: ask (or stop asking) to speak. */
    stageRequest: (channelId: Id, on: boolean) => send({ method: on ? 'PUT' : 'DELETE', path: `/channels/${channelId}/stage/request` }),
    /** Stage: invite a member to speak (on) or move them back to the audience (off). `@me` for self. */
    stageSpeaker: (channelId: Id, userId: Id | '@me', on: boolean) => send({ method: on ? 'PUT' : 'DELETE', path: `/channels/${channelId}/stage/speakers/${userId}` }),
    /** Priority speaker: others are ducked while you talk (requires PRIORITY_SPEAKER). The client sets the LiveKit attribute after this succeeds. */
    prioritySpeaker: (channelId: Id, on: boolean) => send<{ channelId: Id; prioritySpeaker: boolean }>({ method: on ? 'PUT' : 'DELETE', path: `/channels/${channelId}/voice/priority-speaker` }),
  },
  push: {
    vapidKey: () => send<{ publicKey: string | null }>({ method: 'GET', path: '/push/vapid-public-key', auth: false }),
    register: (b: PushRegistration) => send<PushDevice>({ method: 'POST', path: '/users/@me/push-devices', body: b }),
    devices: () => send<PushDevice[]>({ method: 'GET', path: '/users/@me/push-devices' }).then((x) => arr<PushDevice>(x)),
    /** Forget this device by token (native) or endpoint (web push). Idempotent. */
    unregister: (b: { token?: string; endpoint?: string; platform?: PushDevice['platform'] }) => send({ method: 'DELETE', path: '/users/@me/push-devices', body: b }),
    removeDevice: (id: Id) => send({ method: 'DELETE', path: `/users/@me/push-devices/${id}` }),
  },
  notifications: {
    get: () => send<NotificationSettings>({ method: 'GET', path: '/users/@me/notification-settings' }),
    setPushEnabled: (pushEnabled: boolean) => send<NotificationSettings>({ method: 'PATCH', path: '/users/@me/notification-settings', body: { pushEnabled } }),
    putGuild: (guildId: Id, b: Partial<GuildNotify>) => send<GuildNotify & { guildId: Id }>({ method: 'PUT', path: `/users/@me/notification-settings/guilds/${guildId}`, body: b }),
    putChannel: (channelId: Id, b: Partial<ChannelNotify>) => send<ChannelNotify & { channelId: Id }>({ method: 'PUT', path: `/users/@me/notification-settings/channels/${channelId}`, body: b }),
    reset: (scope: 'guilds' | 'channels', targetId: Id) => send({ method: 'DELETE', path: `/users/@me/notification-settings/${scope}/${targetId}` }),
  },
  /** Instance super admin (404 for everyone else). */
  admin: {
    me: () => send<{ admin: true; userId: string; mfaEnabled: boolean }>({ method: 'GET', path: '/admin/me' }),
    stats: () => send<Record<string, number>>({ method: 'GET', path: '/admin/stats' }),
    users: (q = '', offset = 0) => send<any[]>({ method: 'GET', path: '/admin/users', query: { ...(q ? { q } : {}), offset: String(offset) } }),
    user: (id: string) => send<any>({ method: 'GET', path: `/admin/users/${id}` }),
    disable: (id: string) => send({ method: 'POST', path: `/admin/users/${id}/disable` }),
    enable: (id: string) => send({ method: 'POST', path: `/admin/users/${id}/enable` }),
    guilds: (q = '', offset = 0) => send<any[]>({ method: 'GET', path: '/admin/guilds', query: { ...(q ? { q } : {}), offset: String(offset) } }),
    guild: (id: string) => send<any>({ method: 'GET', path: `/admin/guilds/${id}` }),
    messages: (channelId: string, before?: string) => send<any[]>({ method: 'GET', path: `/admin/channels/${channelId}/messages`, query: before ? { before } : undefined }),
    reports: () => send<any[]>({ method: 'GET', path: '/admin/reports' }),
  },
  misc: {
    gifs: (q?: string) => send<any>({ method: 'GET', path: q ? '/gifs/search' : '/gifs/trending', query: q ? { q } : undefined }).then((x) => arr<GifResult>(x)),
    unfurl: (url: string) => send<any>({ method: 'GET', path: '/unfurl', query: { url } }),
  },
};
