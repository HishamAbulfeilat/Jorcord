/** Audit-log presentation: numeric `actionType` filters and human labels for every action the server records (docs/CONTRACT.md "Audit log"). */
import { AuditActionType } from '@jorcord/shared';
import type { AuditEntry } from '@jorcord/shared';

const LABELS: Record<string, string> = {
  GUILD_UPDATE: 'updated the server', CHANNEL_CREATE: 'created a channel', CHANNEL_UPDATE: 'updated a channel', CHANNEL_DELETE: 'deleted a channel', OVERWRITE_UPDATE: 'updated channel permissions', OVERWRITE_DELETE: 'removed channel permissions', CHANNEL_REORDER: 'reordered channels',
  MEMBER_KICK: 'kicked a member', MEMBER_PRUNE: 'pruned members', MEMBER_BAN_ADD: 'banned a member', MEMBER_BAN_REMOVE: 'unbanned a member', MEMBER_UPDATE: 'changed a member\'s nickname', MEMBER_ROLE_UPDATE: 'updated a member\'s roles', MEMBER_MOVE: 'moved a member', MEMBER_DISCONNECT: 'disconnected a member', BOT_ADD: 'added a bot', MEMBER_TIMEOUT: 'timed out a member',
  ROLE_CREATE: 'created a role', ROLE_UPDATE: 'updated a role', ROLE_DELETE: 'deleted a role', ROLE_REORDER: 'reordered roles', INVITE_CREATE: 'created an invite', INVITE_DELETE: 'deleted an invite',
  WEBHOOK_CREATE: 'created a webhook', WEBHOOK_UPDATE: 'updated a webhook', WEBHOOK_DELETE: 'deleted a webhook', EMOJI_CREATE: 'created an emoji', EMOJI_UPDATE: 'updated an emoji', EMOJI_DELETE: 'deleted an emoji',
  MESSAGE_DELETE: 'deleted a message', MESSAGE_BULK_DELETE: 'bulk deleted messages', MESSAGE_PIN: 'pinned a message', MESSAGE_UNPIN: 'unpinned a message',
  STAGE_INSTANCE_CREATE: 'started a stage', STAGE_INSTANCE_UPDATE: 'updated a stage topic', STAGE_INSTANCE_DELETE: 'ended a stage', STICKER_CREATE: 'created a sticker', STICKER_UPDATE: 'updated a sticker', STICKER_DELETE: 'deleted a sticker',
  GUILD_SCHEDULED_EVENT_CREATE: 'created an event', GUILD_SCHEDULED_EVENT_UPDATE: 'updated an event', GUILD_SCHEDULED_EVENT_DELETE: 'deleted an event',
  THREAD_CREATE: 'created a thread', THREAD_UPDATE: 'updated a thread', THREAD_DELETE: 'deleted a thread', APPLICATION_COMMAND_PERMISSION_UPDATE: 'updated command permissions',
  AUTOMOD_RULE_CREATE: 'created an AutoMod rule', AUTOMOD_RULE_UPDATE: 'updated an AutoMod rule', AUTOMOD_RULE_DELETE: 'deleted an AutoMod rule', AUTOMOD_BLOCK: 'AutoMod blocked a message', AUTOMOD_ALERT: 'AutoMod sent an alert',
  STAGE_INVITE_SPEAKER: 'invited a speaker', STAGE_SUPPRESS_SPEAKER: 'moved a speaker to the audience', VOICE_MOVE: 'moved a member', VOICE_DISCONNECT: 'disconnected a member', VOICE_MODERATE: 'moderated a member in voice',
  AUTOMOD_TEST: 'AutoMod test hit', MEMBER_WARN: 'warned a member', BAN_APPEAL_CREATE: 'received a ban appeal', BAN_APPEAL_APPROVE: 'approved a ban appeal', BAN_APPEAL_DENY: 'denied a ban appeal', MEMBER_WARN_DELETE: 'removed a warning', MEMBER_BULK_BAN: 'bulk banned members', MEMBER_BULK_KICK: 'bulk kicked members', MOD_NOTE_UPDATE: 'edited a mod note',
  LINKED_ROLE_CREATE: 'created a linked role', LINKED_ROLE_UPDATE: 'updated a linked role', LINKED_ROLE_DELETE: 'removed a linked role', BOOST_UPDATE: 'updated boost settings',
  POLL_END: 'ended a poll', APPLICATION_UPDATE: 'updated an application', APPLICATION_TOKEN_RESET: 'reset a bot token', FORUM_TAG_UPDATE: 'updated forum tags',
  STAGE_BLOCK_SPEAKER: 'blocked a member from speaking on a stage', STAGE_UNBLOCK_SPEAKER: 'allowed a member to speak on a stage again', STREAM_VIEWER_KICK: 'removed a viewer from a stream',
  GUILD_IMPORT: 'imported a server structure', GUILD_EXPORT: 'exported the server structure',
  STREAM_FEED_CREATE: 'added a stream or video feed', STREAM_FEED_UPDATE: 'updated a stream or video feed', STREAM_FEED_DELETE: 'removed a stream or video feed',
};
export const humanize = (a: string) => a.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const actionLabel = (action: string) => LABELS[action] ?? humanize(action).toLowerCase();

export interface AuditFilter { value: string; label: string; type?: number }
const GROUPS: { title: string; actions: string[] }[] = [
  { title: 'Server', actions: ['GUILD_UPDATE', 'BOT_ADD', 'INVITE_CREATE', 'INVITE_DELETE', 'WEBHOOK_CREATE', 'WEBHOOK_UPDATE', 'WEBHOOK_DELETE', 'STREAM_FEED_CREATE', 'STREAM_FEED_UPDATE', 'STREAM_FEED_DELETE', 'APPLICATION_COMMAND_PERMISSION_UPDATE'] },
  { title: 'Channels', actions: ['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'OVERWRITE_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'FORUM_TAG_UPDATE'] },
  { title: 'Members', actions: ['MEMBER_KICK', 'MEMBER_BAN_ADD', 'MEMBER_BAN_REMOVE', 'MEMBER_UPDATE', 'MEMBER_ROLE_UPDATE', 'MEMBER_TIMEOUT', 'MEMBER_PRUNE', 'MEMBER_WARN', 'MEMBER_WARN_DELETE', 'MEMBER_BULK_BAN', 'MEMBER_BULK_KICK', 'BAN_APPEAL_CREATE', 'BAN_APPEAL_APPROVE', 'BAN_APPEAL_DENY'] },
  { title: 'AutoMod', actions: ['AUTOMOD_RULE_CREATE', 'AUTOMOD_RULE_UPDATE', 'AUTOMOD_RULE_DELETE', 'AUTOMOD_BLOCK', 'AUTOMOD_ALERT', 'AUTOMOD_TEST'] },
  { title: 'Roles', actions: ['ROLE_CREATE', 'ROLE_UPDATE', 'ROLE_DELETE'] },
  { title: 'Messages', actions: ['MESSAGE_DELETE', 'MESSAGE_BULK_DELETE', 'MESSAGE_PIN', 'MESSAGE_UNPIN', 'POLL_END'] },
  { title: 'Expressions', actions: ['EMOJI_CREATE', 'EMOJI_UPDATE', 'EMOJI_DELETE', 'STICKER_CREATE', 'STICKER_UPDATE', 'STICKER_DELETE'] },
  { title: 'Events & stages', actions: ['GUILD_SCHEDULED_EVENT_CREATE', 'GUILD_SCHEDULED_EVENT_UPDATE', 'GUILD_SCHEDULED_EVENT_DELETE', 'STAGE_INSTANCE_CREATE', 'STAGE_INSTANCE_UPDATE', 'STAGE_INSTANCE_DELETE'] },
];
/** Filter dropdown options, grouped; each carries the numeric `actionType` the server accepts as `?actionType=`. */
export const AUDIT_FILTER_GROUPS: { title: string; items: AuditFilter[] }[] = GROUPS.map((g) => ({
  title: g.title, items: g.actions.filter((a) => a in AuditActionType).map((a) => ({ value: a, label: humanize(a), type: AuditActionType[a as keyof typeof AuditActionType] })),
}));

/** Numeric action type of an entry: the server's `actionType`, else derived from the string action. */
export const entryType = (e: Pick<AuditEntry, 'action' | 'actionType'>): number | undefined => e.actionType ?? (AuditActionType as Record<string, number>)[e.action];

/** A short detail line from `changes` ("name: general"), best effort. */
export function entryDetail(e: Pick<AuditEntry, 'changes'>): string | null {
  const c = e.changes;
  if (!c || typeof c !== 'object') return null;
  const pairs: string[] = [];
  const rec = c as Record<string, unknown>;
  for (const k of ['name', 'topic', 'nick', 'question', 'reason']) { const v = rec[k]; if (typeof v === 'string' && v) pairs.push(`${k}: ${v.slice(0, 60)}`); }
  return pairs.length ? pairs.join(' • ') : null;
}
