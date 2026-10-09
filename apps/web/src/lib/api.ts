/** Typed REST client written against docs/CONTRACT.md. All calls go through the swappable transport. */
import type {
  Attachment, AuditEntry, AutoModRule, Channel, Emoji, Guild, GuildFull, Invite, Member, Message, Relationship, ReadState, Role, SelfUser, Sticker, User, VoiceToken, Id, Presence, OverwriteDTO,
} from '@jorcord/shared';
import { send } from './transport';

export interface AuthResult { user: SelfUser; accessToken: string; refreshToken: string }
export interface UserProfile extends User { mutualGuilds?: { id: Id; name: string; icon: string | null; nick?: string | null }[]; mutualFriends?: User[] }
export interface MessageQuery { limit?: number; before?: Id; after?: Id; around?: Id }
export interface SearchQuery { q?: string; authorId?: Id; channelId?: Id; has?: string; before?: string }
export interface SendMessageInput { content: string; replyTo?: Id | null; files?: File[]; nonce?: string; stickerIds?: Id[] }
export interface PushDevice { id: Id; platform: 'web' | 'android' | 'ios' | 'desktop'; createdAt: string | null; lastUsedAt: string | null; current?: boolean }
export type PushRegistration = { platform: 'web' | 'desktop'; subscription: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } } } | { platform: 'android' | 'ios'; token: string };
export interface GuildNotify { muted: boolean; mutedUntil: string | null; suppressEveryone: boolean; suppressRoles: boolean; level: 'all' | 'mentions' | 'none' | null }
export interface ChannelNotify { muted: boolean; mutedUntil: string | null }
export interface NotificationSettings { pushEnabled: boolean; guilds: (GuildNotify & { guildId: Id })[]; channels: (ChannelNotify & { channelId: Id })[] }
export interface GifResult { id: string; url: string; preview: string; title?: string }

const arr = <T>(x: any): T[] => (Array.isArray(x) ? x : Array.isArray(x?.items) ? x.items : []);
const enc = encodeURIComponent;
export const emojiKey = (emoji: string, emojiId?: Id | null) => enc(emojiId ? `${emoji}:${emojiId}` : emoji);

export const api = {
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
    patchMe: (b: Partial<{ displayName: string | null; bio: string | null; pronouns: string | null; avatar: string | null; banner: string | null; accentColor: string | null; customStatus: User['customStatus']; theme: SelfUser['theme']; settings: Record<string, unknown> }>) => send<SelfUser>({ method: 'PATCH', path: '/users/@me', body: b }),
    get: (id: Id) => send<UserProfile>({ method: 'GET', path: `/users/${id}` }),
    setPresence: (presence: Presence) => send({ method: 'PUT', path: '/users/@me/presence', body: { presence } }),
    guilds: () => send<Guild[]>({ method: 'GET', path: '/users/@me/guilds' }).then((x) => arr<Guild>(x)),
    leaveGuild: (id: Id) => send({ method: 'DELETE', path: `/users/@me/guilds/${id}` }),
    openDm: (recipientIds: Id[]) => send<Channel>({ method: 'POST', path: '/users/@me/channels', body: { recipientIds } }),
    channels: () => send<Channel[]>({ method: 'GET', path: '/users/@me/channels' }).then((x) => arr<Channel>(x)),
    relationships: () => send<Relationship[]>({ method: 'GET', path: '/users/@me/relationships' }).then((x) => arr<Relationship>(x)),
    setRelationship: (userId: Id, type: 'friend' | 'blocked') => send({ method: 'PUT', path: `/users/@me/relationships/${userId}`, body: { type } }),
    removeRelationship: (userId: Id) => send({ method: 'DELETE', path: `/users/@me/relationships/${userId}` }),
    readStates: () => send<ReadState[]>({ method: 'GET', path: '/users/@me/read-states' }).then((x) => arr<ReadState>(x)),
    /** Friend request by username: the contract addresses relationships by user id, so resolve through a username lookup. */
    findByUsername: (username: string) => send<User[] | User>({ method: 'GET', path: '/users', query: { username } }).then((x) => (Array.isArray(x) ? x : x ? [x] : [])),
  },
  guilds: {
    create: (b: { name: string; icon?: string | null; template?: string }) => send<GuildFull>({ method: 'POST', path: '/guilds', body: b }),
    get: (id: Id) => send<GuildFull>({ method: 'GET', path: `/guilds/${id}` }),
    preview: (id: Id) => send<Guild & { approxMembers?: number }>({ method: 'GET', path: `/guilds/${id}/preview` }),
    patch: (id: Id, b: Partial<Guild>) => send<Guild>({ method: 'PATCH', path: `/guilds/${id}`, body: b }),
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
    auditLogs: (id: Id, q: { limit?: number; before?: Id; action?: string } = {}) => send<AuditEntry[]>({ method: 'GET', path: `/guilds/${id}/audit-logs`, query: q }).then((x) => arr<AuditEntry>(x)),
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
    deleteAutomod: (id: Id, rid: Id) => send({ method: 'DELETE', path: `/guilds/${id}/automod/rules/${rid}` }),
    boost: (id: Id) => send<Guild>({ method: 'POST', path: `/guilds/${id}/boosts` }),
    search: (id: Id, q: SearchQuery) => send<any>({ method: 'GET', path: `/guilds/${id}/messages/search`, query: q as any }).then((x) => arr<Message>(x)),
    discover: () => send<Guild[]>({ method: 'GET', path: '/discover/guilds' }).then((x) => arr<Guild>(x)),
  },
  channels: {
    patch: (id: Id, b: Partial<Channel>) => send<Channel>({ method: 'PATCH', path: `/channels/${id}`, body: b }),
    delete: (id: Id) => send({ method: 'DELETE', path: `/channels/${id}` }),
    putOverwrite: (id: Id, ow: OverwriteDTO) => send({ method: 'PUT', path: `/channels/${id}/permissions/${ow.id}`, body: { type: ow.type, allow: ow.allow, deny: ow.deny } }),
    deleteOverwrite: (id: Id, owId: Id) => send({ method: 'DELETE', path: `/channels/${id}/permissions/${owId}` }),
    ack: (id: Id, messageId: Id) => send({ method: 'POST', path: `/channels/${id}/ack`, body: { messageId } }),
    typing: (id: Id) => send({ method: 'POST', path: `/channels/${id}/typing` }),
    webhooks: (id: Id) => send<any[]>({ method: 'GET', path: `/channels/${id}/webhooks` }).then((x) => arr<any>(x)),
    createWebhook: (id: Id, name: string, avatar?: string | null) => send<any>({ method: 'POST', path: `/channels/${id}/webhooks`, body: { name, ...(avatar ? { avatar } : {}) } }),
    deleteWebhook: (id: Id, wid: Id) => send({ method: 'DELETE', path: `/channels/${id}/webhooks/${wid}` }),
    forumPost: (id: Id, b: { name: string; content: string }) => send<{ channel: Channel; message?: Message }>({ method: 'POST', path: `/channels/${id}/forum/posts`, body: b }),
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
      return send<Message>({ method: 'POST', path: `/channels/${channelId}/messages`, body: { content: m.content, replyTo: m.replyTo ?? null, ...(m.stickerIds?.length ? { stickerIds: m.stickerIds } : {}) } });
    },
    edit: (channelId: Id, id: Id, content: string) => send<Message>({ method: 'PATCH', path: `/channels/${channelId}/messages/${id}`, body: { content } }),
    delete: (channelId: Id, id: Id) => send({ method: 'DELETE', path: `/channels/${channelId}/messages/${id}` }),
    bulkDelete: (channelId: Id, ids: Id[]) => send({ method: 'POST', path: `/channels/${channelId}/messages/bulk-delete`, body: { messageIds: ids } }),
    react: (channelId: Id, id: Id, emoji: string, emojiId?: Id | null) => send({ method: 'PUT', path: `/channels/${channelId}/messages/${id}/reactions/${emojiKey(emoji, emojiId)}/@me` }),
    unreact: (channelId: Id, id: Id, emoji: string, emojiId?: Id | null) => send({ method: 'DELETE', path: `/channels/${channelId}/messages/${id}/reactions/${emojiKey(emoji, emojiId)}/@me` }),
    reactors: (channelId: Id, id: Id, emoji: string, emojiId?: Id | null) => send<User[]>({ method: 'GET', path: `/channels/${channelId}/messages/${id}/reactions/${emojiKey(emoji, emojiId)}` }).then((x) => arr<User>(x)),
    pins: (channelId: Id) => send<Message[]>({ method: 'GET', path: `/channels/${channelId}/pins` }).then((x) => arr<Message>(x)),
    pin: (channelId: Id, id: Id) => send({ method: 'PUT', path: `/channels/${channelId}/pins/${id}` }),
    unpin: (channelId: Id, id: Id) => send({ method: 'DELETE', path: `/channels/${channelId}/pins/${id}` }),
    createThread: (channelId: Id, id: Id, name: string) => send<Channel>({ method: 'POST', path: `/channels/${channelId}/messages/${id}/threads`, body: { name } }),
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
  misc: {
    gifs: (q?: string) => send<any>({ method: 'GET', path: q ? '/gifs/search' : '/gifs/trending', query: q ? { q } : undefined }).then((x) => arr<GifResult>(x)),
    unfurl: (url: string) => send<any>({ method: 'GET', path: '/unfurl', query: { url } }),
  },
};
