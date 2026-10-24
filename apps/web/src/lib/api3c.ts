/** Package C REST calls (accounts, social, safety). Kept apart from api.ts so the shared client only needs additive edits. */
import type { Channel, DisplayNameStyle, GuildSafety, Id, InboxThread, InboxUnreadChannel, Message, SelfUser, ThreadNotifyLevel, User, UsernameChangeResult } from '@jorcord/shared';
import { send } from './transport';

const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

export interface PendingEmail { pendingEmail: string | null; expiresAt: string | null }

export const api3c = {
  /** Username (needs the password, and the 2FA code when two-factor is on). */
  usernameStatus: () => send<{ changesLeft: number; nextChangeAt: string | null }>({ method: 'GET', path: '/users/@me/username' }),
  changeUsername: (b: { username: string; password: string; totp?: string }) => send<UsernameChangeResult>({ method: 'POST', path: '/users/@me/username', body: b }),
  /** Email: the new address gets a confirm link; nothing changes until it is used. */
  pendingEmail: () => send<PendingEmail>({ method: 'GET', path: '/users/@me/email-change' }),
  changeEmail: (b: { newEmail: string; password: string; totp?: string }) => send<{ pendingEmail: string; expiresAt: string }>({ method: 'POST', path: '/users/@me/email', body: b }),
  cancelEmailChange: () => send({ method: 'DELETE', path: '/users/@me/email-change' }),
  confirmEmailChange: (token: string) => send({ method: 'POST', path: '/auth/email-change/confirm', body: { token }, auth: false }),
  /** Reversible: signs out everywhere; signing in again reactivates. */
  disableAccount: (b: { password: string; totp?: string }) => send({ method: 'POST', path: '/users/@me/disable', body: b }),
  /** Ignore (hide their messages locally, no pings) is separate from block. */
  ignored: () => send<{ users: User[] }>({ method: 'GET', path: '/users/@me/ignored' }).then((x) => arr<User>(x?.users)),
  ignore: (userId: Id) => send({ method: 'PUT', path: `/users/@me/ignored/${userId}` }),
  unignore: (userId: Id) => send({ method: 'DELETE', path: `/users/@me/ignored/${userId}` }),
  setFriendNickname: (userId: Id, nickname: string | null) => send({ method: 'PUT', path: `/users/@me/relationships/${userId}/nickname`, body: { nickname } }),
  /** Disappearing messages (0 = off). */
  setDisappearing: (channelId: Id, seconds: number) => send<Channel>({ method: 'PUT', path: `/channels/${channelId}/disappearing`, body: { seconds } }),
  wave: (channelId: Id, messageId: Id) => send<Message>({ method: 'POST', path: `/channels/${channelId}/messages/${messageId}/wave` }),
  setDisplayNameStyle: (style: DisplayNameStyle | null) => send<SelfUser>({ method: 'PATCH', path: '/users/@me', body: { displayNameStyle: style } }),
  /** Inbox tabs. */
  inboxUnreads: () => send<InboxUnreadChannel[]>({ method: 'GET', path: '/users/@me/inbox/unreads' }).then((x) => arr<InboxUnreadChannel>(x)),
  inboxThreads: () => send<InboxThread[]>({ method: 'GET', path: '/users/@me/inbox/threads' }).then((x) => arr<InboxThread>(x)),
  setThreadLevel: (threadId: Id, level: ThreadNotifyLevel) => send<{ threadId: Id; level: ThreadNotifyLevel }>({ method: 'PUT', path: `/users/@me/notification-settings/threads/${threadId}`, body: { level } }),
  /** Safety Setup > Safety alerts. */
  patchSafetyAlerts: (guildId: Id, b: Partial<NonNullable<GuildSafety['safetyAlerts']>>) => send<GuildSafety>({ method: 'PATCH', path: `/guilds/${guildId}/safety`, body: { safetyAlerts: b } }),
};
