/** Context-menu builders. Pure functions over store state; navigation goes through a window event the shell listens to. */
import { Perm } from '@jorcord/shared';
import type { Channel, Id, Message } from '@jorcord/shared';
import { AtSign, BellOff, Check, Copy, Edit3, Hash, LogOut, MessageSquare, Pencil, Pin, PinOff, Reply, Settings, ShieldBan, Smile, Trash2, UserMinus, UserPlus, Link2, UserX, Clock, BookOpen, Plus, FolderPlus, Mail, Ban } from 'lucide-react';
import { api } from './api';
import { useData, selfMember, findChannel } from '@/stores/data';
import { useUI, toast, toastError, type MenuItem } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { canDeleteMessage, canEditMessage, canManageMember, canOpenGuildSettings, canPinMessage, effectivePerms, can } from './perms';
import { copyText, inviteUrl } from './format';
import { publicOrigin } from './server';
import { myChannelPerms } from './session';

export const goto = (guildId: Id | null | undefined, channelId?: Id | null) => window.dispatchEvent(new CustomEvent('jorcord:goto', { detail: { guildId, channelId } }));
const ui = () => useUI.getState();
const gperms = (gid: Id) => {
  const s = useData.getState(); const g = s.guilds[gid]; const me = selfMember(s, gid);
  return g && me ? effectivePerms({ guild: g.guild, roles: Object.values(g.roles), member: me }) : 0n;
};

export async function markGuildRead(gid: Id) {
  const s = useData.getState(); const g = s.guilds[gid]; if (!g) return;
  for (const c of Object.values(g.channels)) if (c.lastMessageId && c.type !== 'category') { s.setRead(c.id, c.lastMessageId, 0); api.channels.ack(c.id, c.lastMessageId).catch(() => {}); }
}
export function markChannelRead(c: Channel) { if (!c.lastMessageId) return; useData.getState().setRead(c.id, c.lastMessageId, 0); api.channels.ack(c.id, c.lastMessageId).catch(() => {}); }

export function guildMenu(gid: Id): MenuItem[] {
  const s = useData.getState(); const g = s.guilds[gid]?.guild; if (!g) return [];
  const p = gperms(gid); const muted = ui().prefs.mutedGuilds[gid]; const isOwner = g.ownerId === s.me?.id;
  return [
    { label: 'Mark As Read', icon: Check, onClick: () => markGuildRead(gid) },
    { separator: true },
    { label: 'Invite People', icon: UserPlus, disabled: !can(p, Perm.CREATE_INVITE), onClick: () => ui().openModal({ kind: 'invite', guildId: gid }) },
    { label: muted ? 'Unmute Server' : 'Mute Server', icon: BellOff, onClick: () => ui().setPref('mutedGuilds', { ...ui().prefs.mutedGuilds, [gid]: !muted }) },
    ...(canOpenGuildSettings(p) ? [{ label: 'Server Settings', icon: Settings, onClick: () => ui().openSettings({ kind: 'guild', guildId: gid }) }] : []),
    ...(can(p, Perm.MANAGE_CHANNELS) ? [{ label: 'Create Channel', icon: Plus, onClick: () => ui().openModal({ kind: 'createChannel', guildId: gid }) }, { label: 'Create Category', icon: FolderPlus, onClick: () => ui().openModal({ kind: 'createCategory', guildId: gid }) }] : []),
    ...(!isOwner ? [{ separator: true }, { label: 'Leave Server', icon: LogOut, danger: true, onClick: () => ui().openModal({ kind: 'leaveGuild', guildId: gid }) }] : []),
    { separator: true },
    { label: 'Copy Server ID', icon: Copy, onClick: () => copyText(gid).then(() => toast('Copied ID', 'success')) },
  ];
}

export function channelMenu(c: Channel): MenuItem[] {
  const gid = c.guildId; const p = gid ? gperms(gid) : 0n; const muted = ui().prefs.mutedChannels[c.id];
  const manage = !!gid && can(p, Perm.MANAGE_CHANNELS);
  return [
    { label: 'Mark As Read', icon: Check, onClick: () => markChannelRead(c) },
    ...(gid && c.type !== 'category' ? [{ label: 'Invite People', icon: UserPlus, disabled: !can(p, Perm.CREATE_INVITE), onClick: () => ui().openModal({ kind: 'invite', guildId: gid, channelId: c.id }) }] : []),
    { label: 'Copy Link', icon: Link2, onClick: () => copyText(`${publicOrigin()}/channels/${gid ?? '@me'}/${c.id}`).then(() => toast('Link copied', 'success')) },
    { label: muted ? 'Unmute Channel' : 'Mute Channel', icon: BellOff, onClick: () => ui().setPref('mutedChannels', { ...ui().prefs.mutedChannels, [c.id]: !muted }) },
    ...(manage ? [{ separator: true }, { label: 'Edit Channel', icon: Pencil, onClick: () => ui().openModal({ kind: 'channelSettings', channelId: c.id }) },
      { label: 'Delete Channel', icon: Trash2, danger: true, onClick: () => ui().openModal({ kind: 'confirm', title: `Delete ${c.type === 'category' ? 'Category' : 'Channel'}`, body: `Are you sure you want to delete ${c.name}? This cannot be undone.`, confirmLabel: 'Delete', danger: true, onConfirm: () => api.channels.delete(c.id).catch(toastError) }) }] : []),
    { separator: true },
    { label: 'Copy Channel ID', icon: Copy, onClick: () => copyText(c.id).then(() => toast('Copied ID', 'success')) },
  ];
}

export function dmMenu(c: Channel): MenuItem[] {
  const muted = ui().prefs.mutedChannels[c.id];
  return [
    { label: 'Mark As Read', icon: Check, onClick: () => markChannelRead(c) },
    { label: muted ? 'Unmute Conversation' : 'Mute Conversation', icon: BellOff, onClick: () => ui().setPref('mutedChannels', { ...ui().prefs.mutedChannels, [c.id]: !muted }) },
    { separator: true },
    { label: c.type === 'group_dm' ? 'Leave Group' : 'Close DM', icon: LogOut, danger: true, onClick: () => api.channels.delete(c.id).catch(toastError) },
    { label: 'Copy Channel ID', icon: Copy, onClick: () => copyText(c.id).then(() => toast('Copied ID', 'success')) },
  ];
}

export async function openDmWith(userId: Id) {
  try { const c = await api.users.openDm([userId]); useData.getState().putDm(c); goto(null, c.id); } catch (e) { toastError(e); }
}

export function userMenu(userId: Id, guildId?: Id | null): MenuItem[] {
  const s = useData.getState(); const me = s.me; const isMe = me?.id === userId;
  const rel = s.relationships[userId]?.type;
  const items: MenuItem[] = [{ label: 'Profile', icon: BookOpen, onClick: () => ui().openModal({ kind: 'profile', userId, guildId: guildId ?? undefined }) }];
  if (!isMe) items.push({ label: 'Message', icon: MessageSquare, onClick: () => openDmWith(userId) });
  if (!isMe) {
    items.push({ separator: true });
    if (rel === 'friend') items.push({ label: 'Remove Friend', icon: UserMinus, onClick: () => api.users.removeRelationship(userId).then(() => s.apply('RELATIONSHIP_REMOVE', { userId })).catch(toastError) });
    else if (rel === 'incoming') items.push({ label: 'Accept Friend Request', icon: UserPlus, onClick: () => api.users.setRelationship(userId, 'friend').catch(toastError) });
    else if (rel !== 'outgoing' && rel !== 'blocked') items.push({ label: 'Add Friend', icon: UserPlus, onClick: () => api.users.setRelationship(userId, 'friend').then(() => toast('Friend request sent', 'success')).catch(toastError) });
    items.push(rel === 'blocked' ? { label: 'Unblock', icon: UserX, onClick: () => api.users.removeRelationship(userId).catch(toastError) } : { label: 'Block', icon: UserX, danger: true, onClick: () => api.users.setRelationship(userId, 'blocked').catch(toastError) });
  }
  if (guildId) {
    const g = s.guilds[guildId]; const target = g?.members[userId]; const actor = selfMember(s, guildId);
    if (g && target && actor && !isMe) {
      const p = gperms(guildId); const roles = Object.values(g.roles);
      const mod: MenuItem[] = [];
      if (canManageMember(g.guild, roles, actor, target, p, Perm.MODERATE_MEMBERS)) mod.push({ label: 'Timeout 10 min', icon: Clock, onClick: () => api.guilds.patchMember(guildId, userId, { timeoutUntil: new Date(Date.now() + 600000).toISOString() }).then(() => toast('Member timed out', 'success')).catch(toastError) });
      if (canManageMember(g.guild, roles, actor, target, p, Perm.KICK_MEMBERS)) mod.push({ label: `Kick ${target.user.username}`, icon: UserMinus, danger: true, onClick: () => ui().openModal({ kind: 'confirm', title: 'Kick Member', body: `Kick ${target.user.username} from the server? They can rejoin with an invite.`, confirmLabel: 'Kick', danger: true, onConfirm: () => api.guilds.kick(guildId, userId).catch(toastError) }) });
      if (canManageMember(g.guild, roles, actor, target, p, Perm.BAN_MEMBERS)) mod.push({ label: `Ban ${target.user.username}`, icon: Ban, danger: true, onClick: () => ui().openModal({ kind: 'prompt', title: 'Ban Member', label: 'Reason (optional)', onSubmit: (reason) => api.guilds.ban(guildId, userId, { reason, deleteMessageSeconds: 0 }).then(() => toast('Member banned', 'success')).catch(toastError) }) });
      if (mod.length) items.push({ separator: true }, ...mod);
    }
  }
  items.push({ separator: true }, { label: 'Copy User ID', icon: Copy, onClick: () => copyText(userId).then(() => toast('Copied ID', 'success')) });
  return items;
}

export function messageMenu(m: Message, opts: { startEdit: () => void; pickEmoji: (rect: DOMRect | undefined) => void }): MenuItem[] {
  const s = useData.getState(); const me = s.me; if (!me) return [];
  const ch = findChannel(s, m.channelId); const perms = myChannelPerms(m.channelId); const isDm = !ch?.guildId;
  const items: MenuItem[] = [
    { label: 'Add Reaction', icon: Smile, disabled: !can(perms, Perm.ADD_REACTIONS) && !isDm, onClick: () => opts.pickEmoji(undefined) },
    ...(canEditMessage(m, me.id) ? [{ label: 'Edit Message', icon: Edit3, onClick: opts.startEdit }] : []),
    ...(canPinMessage(perms, isDm) ? [{ label: m.pinned ? 'Unpin Message' : 'Pin Message', icon: m.pinned ? PinOff : Pin, onClick: () => (m.pinned ? api.messages.unpin(m.channelId, m.id) : api.messages.pin(m.channelId, m.id)).then(() => useMessages.getState().update({ ...m, pinned: !m.pinned })).catch(toastError) }] : []),
    { label: 'Reply', icon: Reply, disabled: !can(perms, Perm.SEND_MESSAGES) && !isDm, onClick: () => ui().setReply(m.channelId, m.id) },
    ...(m.content ? [{ label: 'Copy Text', icon: Copy, onClick: () => copyText(m.content).then(() => toast('Copied text', 'success')) }] : []),
    ...(ch?.guildId && ch.type !== 'thread' && can(perms, Perm.CREATE_PUBLIC_THREADS) ? [{ label: 'Create Thread', icon: Hash, onClick: () => ui().openModal({ kind: 'createThread', channelId: m.channelId, messageId: m.id, suggested: m.content.slice(0, 50) }) }] : []),
    { label: 'Mark Unread', icon: Mail, onClick: () => { s.setRead(m.channelId, String(BigInt(m.id) - 1n), 0); api.channels.ack(m.channelId, String(BigInt(m.id) - 1n)).catch(() => {}); } },
    { label: 'Copy Message Link', icon: Link2, onClick: () => copyText(`${publicOrigin()}/channels/${m.guildId ?? '@me'}/${m.channelId}/${m.id}`).then(() => toast('Link copied', 'success')) },
    ...(canDeleteMessage(m, me.id, perms) ? [{ separator: true }, { label: 'Delete Message', icon: Trash2, danger: true, onClick: () => ui().openModal({ kind: 'confirm', title: 'Delete Message', body: 'Are you sure you want to delete this message?', confirmLabel: 'Delete', danger: true, onConfirm: () => api.messages.delete(m.channelId, m.id).then(() => useMessages.getState().remove(m.channelId, m.id)).catch(toastError) }) }] : []),
    { separator: true },
    { label: 'Copy Message ID', icon: Copy, onClick: () => copyText(m.id).then(() => toast('Copied ID', 'success')) },
  ];
  return items;
}
void AtSign; void ShieldBan;
