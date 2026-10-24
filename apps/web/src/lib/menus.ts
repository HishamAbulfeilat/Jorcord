/** Context-menu builders. Pure functions over store state; navigation goes through a window event the shell listens to. */
import { MessageFlags, Perm } from '@jorcord/shared';
import type { Channel, Id, Message } from '@jorcord/shared';
import { Eye, Languages, Lock, ShieldAlert, Rocket, Star, Megaphone, EyeOff, ListChecks, AlarmClock, Bookmark, Forward, ArrowDown, ArrowUp, Bell, FolderMinus, FolderPlus as FolderAdd, Folder as FolderI, MonitorUp, Unlink, Bot, AtSign, BellOff, Check, Copy, Edit3, Hash, LogOut, MessageSquare, Pencil, Pin, PinOff, Reply, Settings, ShieldBan, Smile, Trash2, UserMinus, UserPlus, Link2, UserX, Clock, BookOpen, Plus, FolderPlus, Mail, Ban } from 'lucide-react';
import { api } from './api';
import { api3c } from './api3c';
import { MESSAGE_TTL_OPTIONS, messageTtlLabel } from '@jorcord/shared';
import { queryClient } from './queryClient';
import { useSocial } from '@/stores/social';
import { useData, selfMember, findChannel } from '@/stores/data';
import { useUI, toast, toastError, type MenuItem } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { canDeleteMessage, canEditMessage, canManageMember, canOpenGuildSettings, canPinMessage, effectivePerms, can } from './perms';
import { copyText, inviteUrl } from './format';
import { publicOrigin } from './server';
import { myChannelPerms } from './session';
import { t } from '@/i18n';
import { useLayout } from '@/stores/layout';
import { setMuted } from '@/stores/notif';
import { goLive } from '@/voice/controller';
import { isFolderKey, folderOf, FOLDER_PREFIX } from './railLayout';

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

import { favoriteCandidate } from './gifFavorites';
import { targetLanguage, translateMessage, translateSupport, translateSupportCached, useTranslations } from './translate';
import { addAppPath } from './directory';
import { navigateTo } from './navigate';
import { ensureLocalDevice } from './e2ee/service';
export function guildMenu(gid: Id): MenuItem[] {
  const s = useData.getState(); const g = s.guilds[gid]?.guild; if (!g) return [];
  const p = gperms(gid); const muted = ui().prefs.mutedGuilds[gid]; const isOwner = g.ownerId === s.me?.id;
  const lay = useLayout.getState(); const items = lay.items();
  const parent = folderOf(items, gid); const folders = items.filter((i) => i.kind === 'folder');
  const keys = items.map((i) => (i.kind === 'guild' ? i.id : FOLDER_PREFIX + i.id)); const idx = keys.indexOf(gid);
  return [
    { label: t('Mark As Read'), icon: Check, onClick: () => markGuildRead(gid) },
    { separator: true },
    { label: t('Invite People'), icon: UserPlus, disabled: !can(p, Perm.CREATE_INVITE), onClick: () => ui().openModal({ kind: 'invite', guildId: gid }) },
    { label: muted ? t('Unmute Server') : t('Mute Server'), icon: BellOff, onClick: () => setMuted('guild', gid, !muted) },
    { label: t('Notification Settings'), icon: Bell, onClick: () => ui().openModal({ kind: 'notifSettings', scope: 'guild', id: gid }) },
    { label: t('Hide Muted Channels'), icon: EyeOff, checked: !!ui().prefs.hideMutedChannels[gid], onClick: () => ui().setPref('hideMutedChannels', { ...ui().prefs.hideMutedChannels, [gid]: !ui().prefs.hideMutedChannels[gid] }) },
    ...(g.features.includes('ONBOARDING') ? [{ label: t('Channels & Roles'), icon: ListChecks, onClick: () => ui().openModal({ kind: 'customize', guildId: gid }) }] : []),
    ...(g.rulesChannelId || g.description || g.welcomeScreen?.enabled ? [{ label: t('View Server Welcome'), icon: BookOpen, onClick: () => ui().openModal({ kind: 'onboarding', guildId: gid }) }] : []),
    ...(can(p, Perm.MANAGE_GUILD) ? [{ label: t('Add App'), icon: Bot, onClick: () => navigateTo(addAppPath(gid)) }] : []),
    { label: t('Edit Server Profile'), icon: Pencil, onClick: () => ui().openSettings({ kind: 'guild', guildId: gid, tab: 'profile' }) },
    { label: t('Linked Roles'), icon: Link2, onClick: () => ui().openSettings({ kind: 'guild', guildId: gid, tab: 'linkedroles' }) },
    { label: t('Server Boost'), icon: Rocket, onClick: () => ui().openSettings({ kind: 'guild', guildId: gid, tab: 'boosts' }) },
    ...(canOpenGuildSettings(p) ? [{ label: t('Server Settings'), icon: Settings, onClick: () => ui().openSettings({ kind: 'guild', guildId: gid }) }] : []),
    ...(can(p, Perm.MANAGE_CHANNELS) ? [{ label: t('Create Channel'), icon: Plus, onClick: () => ui().openModal({ kind: 'createChannel', guildId: gid }) }, { label: t('Create Category'), icon: FolderPlus, onClick: () => ui().openModal({ kind: 'createCategory', guildId: gid }) }] : []),
    { separator: true },
    ...(parent ? [{ label: t('Remove From Folder'), icon: FolderMinus, onClick: () => lay.removeFromFolder(gid) }] : []),
    ...(folders.length ? [{ label: t('Move To Folder'), icon: FolderI, children: folders.map((f) => ({ label: (f.kind === 'folder' && f.folder.name) || t('Folder'), checked: parent?.id === f.id, onClick: () => lay.moveToFolder(gid, f.kind === 'folder' ? f.id : '') })) }] : []),
    ...(!parent && items.filter((i) => i.kind === 'guild').length > 1 ? [{ label: t('Create Folder'), icon: FolderAdd, onClick: () => { const other = items.find((i) => i.kind === 'guild' && i.id !== gid); if (other) lay.mergeGuilds(gid, other.id); } }] : []),
    ...(!parent && idx > 0 ? [{ label: t('Move Up'), icon: ArrowUp, onClick: () => lay.reorder(gid, keys[idx - 1]!) }] : []),
    ...(!parent && idx >= 0 && idx < keys.length - 1 ? [{ label: t('Move Down'), icon: ArrowDown, onClick: () => lay.reorder(gid, keys[idx + 1]!) }] : []),
    ...(!isOwner ? [{ separator: true }, { label: t('Leave Server'), icon: LogOut, danger: true, onClick: () => ui().openModal({ kind: 'leaveGuild', guildId: gid }) }] : []),
    { separator: true },
    ...(p & (Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_GUILD) || (p & Perm.ADMINISTRATOR) ? [{ label: t('Reports'), icon: ShieldBan, onClick: () => ui().openReports(gid) }] : []),
    { separator: true },
    { label: t('Copy Server ID'), icon: Copy, onClick: () => copyText(gid).then(() => toast(t('Copied ID'), 'success')) },
  ];
}

export function folderMenu(folderId: string): MenuItem[] {
  const lay = useLayout.getState(); const f = lay.items().find((i) => i.kind === 'folder' && i.id === folderId);
  if (!f || f.kind !== 'folder') return [];
  return [
    { label: t('Mark Folder As Read'), icon: Check, onClick: () => f.guildIds.forEach((g) => void markGuildRead(g)) },
    { label: t('Folder Settings'), icon: Pencil, onClick: () => ui().openModal({ kind: 'folder', folderId }) },
    { separator: true },
    { label: t('Ungroup Servers'), icon: Unlink, danger: true, onClick: () => lay.ungroup(folderId) },
  ];
}

export function channelMenu(c: Channel): MenuItem[] {
  const gid = c.guildId; const p = gid ? gperms(gid) : 0n; const muted = ui().prefs.mutedChannels[c.id];
  const manage = !!gid && can(p, Perm.MANAGE_CHANNELS);
  const isVoice = c.type === 'voice' || c.type === 'stage';
  return [
    { label: t('Mark As Read'), icon: Check, onClick: () => markChannelRead(c) },
    ...(isVoice && gid && can(p, Perm.STREAM) && canShareScreen() ? [{ label: t('Go Live'), icon: MonitorUp, onClick: () => void goLive(c.id) }] : []),
    ...(gid && c.type !== 'category' ? [{ label: t('Invite People'), icon: UserPlus, disabled: !can(p, Perm.CREATE_INVITE), onClick: () => ui().openModal({ kind: 'invite', guildId: gid, channelId: c.id }) }] : []),
    { label: t('Copy Link'), icon: Link2, onClick: () => copyText(`${publicOrigin()}/channels/${gid ?? '@me'}/${c.id}`).then(() => toast(t('Link copied'), 'success')) },
    ...(c.type === 'announcement' ? [{ label: t('Follow Channel'), icon: Megaphone, onClick: () => ui().openModal({ kind: 'followChannel', channelId: c.id }) }] : []),
    ...(c.type !== 'category' ? [{ label: muted ? t('Unmute Channel') : t('Mute Channel'), icon: BellOff, onClick: () => setMuted('channel', c.id, !muted) }, { label: t('Notification Settings'), icon: Bell, onClick: () => ui().openModal({ kind: 'notifSettings', scope: 'channel' as const, id: c.id }) }] : []),
    ...(manage ? [{ separator: true }, { label: t('Edit Channel'), icon: Pencil, onClick: () => ui().openModal({ kind: 'channelSettings', channelId: c.id }) },
      { label: t('Delete Channel'), icon: Trash2, danger: true, onClick: () => ui().openModal({ kind: 'confirm', title: c.type === 'category' ? t('Delete Category') : t('Delete Channel'), body: t('Are you sure you want to delete {name}? This cannot be undone.', { name: c.name ?? '' }), confirmLabel: t('Delete'), danger: true, onConfirm: () => api.channels.delete(c.id).catch(toastError) }) }] : []),
    { separator: true },
    { label: t('Copy Channel ID'), icon: Copy, onClick: () => copyText(c.id).then(() => toast(t('Copied ID'), 'success')) },
  ];
}

/** Screen capture is impossible on mobile webviews and WebKitGTK; hide Go Live there. */
export const canShareScreen = () => !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !(window as any).Capacitor?.isNativePlatform?.();

export function dmMenu(c: Channel): MenuItem[] {
  const muted = ui().prefs.mutedChannels[c.id];
  return [
    { label: t('Mark As Read'), icon: Check, onClick: () => markChannelRead(c) },
    { label: muted ? t('Unmute Conversation') : t('Mute Conversation'), icon: BellOff, onClick: () => setMuted('channel', c.id, !muted) },
    { label: t('Disappearing Messages'), icon: Clock, children: MESSAGE_TTL_OPTIONS.map((sec) => ({ label: `${(c.messageTtlSeconds ?? 0) === sec ? '✓ ' : ''}${t(messageTtlLabel(sec))}`, onClick: () => { api3c.setDisappearing(c.id, sec).catch(toastError); } })) },
    { separator: true },
    { label: c.type === 'group_dm' ? t('Leave Group') : t('Close DM'), icon: LogOut, danger: true, onClick: () => api.channels.delete(c.id).catch(toastError) },
    { label: t('Copy Channel ID'), icon: Copy, onClick: () => copyText(c.id).then(() => toast(t('Copied ID'), 'success')) },
  ];
}

export async function openDmWith(userId: Id) {
  try { const c = await api.users.openDm([userId]); useData.getState().putDm(c); goto(null, c.id); } catch (e) { toastError(e); }
}

/** Opens (creating if needed) the end-to-end encrypted 1:1 chat with someone. This device's key is created and published first. */
export async function openSecretChatWith(userId: Id) {
  try {
    const meId = useData.getState().me?.id; if (!meId) return;
    await ensureLocalDevice(meId);
    const c = await api.users.openDm([userId], { encrypted: true }); useData.getState().putDm(c); goto(null, c.id);
  } catch (e) { toastError(e); }
}

export function userMenu(userId: Id, guildId?: Id | null): MenuItem[] {
  const s = useData.getState(); const me = s.me; const isMe = me?.id === userId;
  const rel = s.relationships[userId]?.type;
  const items: MenuItem[] = [{ label: t('Profile'), icon: BookOpen, onClick: () => ui().openModal({ kind: 'profile', userId, guildId: guildId ?? undefined }) }];
  if (!isMe) items.push({ label: t('Message'), icon: MessageSquare, onClick: () => openDmWith(userId) });
  if (!isMe && typeof globalThis.crypto?.subtle !== 'undefined') items.push({ label: t('Start Secret Chat'), icon: Lock, onClick: () => openSecretChatWith(userId) });
  if (!isMe) {
    items.push({ separator: true });
    if (rel === 'friend') items.push({ label: t('Remove Friend'), icon: UserMinus, onClick: () => api.users.removeRelationship(userId).then(() => s.apply('RELATIONSHIP_REMOVE', { userId })).catch(toastError) });
    else if (rel === 'incoming') items.push({ label: t('Accept Friend Request'), icon: UserPlus, onClick: () => api.users.setRelationship(userId, 'friend').catch(toastError) });
    else if (rel !== 'outgoing' && rel !== 'blocked') items.push({ label: t('Add Friend'), icon: UserPlus, onClick: () => api.users.setRelationship(userId, 'friend').then(() => toast(t('Friend request sent'), 'success')).catch(toastError) });
    if (rel === 'friend') items.push({ label: t('Change Friend Nickname'), icon: BookOpen, onClick: () => ui().openModal({ kind: 'prompt', title: t('Friend Nickname'), label: t('Only you see this. Leave empty to remove it.'), initial: s.relationships[userId]?.nickname ?? '', onSubmit: (v) => api3c.setFriendNickname(userId, v.trim() || null).catch(toastError) }) });
    { const ign = !!useSocial.getState().ignored[userId]; items.push({ label: ign ? t('Unignore') : t('Ignore'), icon: EyeOff, onClick: () => (ign ? api3c.unignore(userId) : api3c.ignore(userId)).then(() => { useSocial.getState().setIgnored(userId, !ign); toast(ign ? t('No longer ignoring this user') : t('Ignored. Their messages are hidden and they cannot ping you.'), 'success'); }).catch(toastError) }); }
    items.push(rel === 'blocked' ? { label: t('Unblock'), icon: UserX, onClick: () => api.users.removeRelationship(userId).catch(toastError) } : { label: t('Block'), icon: UserX, danger: true, onClick: () => api.users.setRelationship(userId, 'blocked').catch(toastError) });
  }
  if (guildId) {
    const g = s.guilds[guildId]; const target = g?.members[userId]; const actor = selfMember(s, guildId);
    if (g && target && actor && !isMe) {
      const p = gperms(guildId); const roles = Object.values(g.roles);
      const mod: MenuItem[] = [];
      if (canManageMember(g.guild, roles, actor, target, p, Perm.MODERATE_MEMBERS)) mod.push({ label: t('Timeout 10 min'), icon: Clock, onClick: () => api.guilds.patchMember(guildId, userId, { timeoutUntil: new Date(Date.now() + 600000).toISOString() }).then(() => toast(t('Member timed out'), 'success')).catch(toastError) });
      if (canManageMember(g.guild, roles, actor, target, p, Perm.KICK_MEMBERS)) mod.push({ label: `Kick ${target.user.username}`, icon: UserMinus, danger: true, onClick: () => ui().openModal({ kind: 'confirm', title: t('Kick Member'), body: `Kick ${target.user.username} from the server? They can rejoin with an invite.`, confirmLabel: 'Kick', danger: true, onConfirm: () => api.guilds.kick(guildId, userId).catch(toastError) }) });
      if (canManageMember(g.guild, roles, actor, target, p, Perm.BAN_MEMBERS)) mod.push({ label: `Ban ${target.user.username}`, icon: Ban, danger: true, onClick: () => ui().openModal({ kind: 'prompt', title: 'Ban Member', label: t('Reason (optional)'), onSubmit: (reason) => api.guilds.ban(guildId, userId, { reason, deleteMessageSeconds: 0 }).then(() => toast(t('Member banned'), 'success')).catch(toastError) }) });
      if (p & (Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_GUILD) || (p & Perm.ADMINISTRATOR)) mod.unshift({ label: t('Mod View'), icon: ShieldAlert, onClick: () => ui().openModal({ kind: 'modView', guildId, userId }) });
      if (mod.length) items.push({ separator: true }, ...mod);
    }
  }
  items.push({ separator: true }, { label: t('Copy User ID'), icon: Copy, onClick: () => copyText(userId).then(() => toast(t('Copied ID'), 'success')) });
  return items;
}

/** "Remove Embeds" / "Restore Embeds": the author, or someone with MANAGE_MESSAGES, toggles SUPPRESS_EMBEDS. Only offered when there is something to hide. */
export function embedsToggle(m: Message, meId: string, perms: bigint): MenuItem | null {
  if (!['default', 'reply'].includes(m.type) || m.forward || m.webhookId) return null;
  const suppressed = ((m.flags ?? 0) & MessageFlags.SUPPRESS_EMBEDS) !== 0;
  if (m.author.id !== meId && !can(perms, Perm.MANAGE_MESSAGES)) return null;
  if (!suppressed && !m.embeds.length && !/https?:\/\//i.test(m.content)) return null;
  return { label: suppressed ? t('Restore Embeds') : t('Remove Embeds'), icon: suppressed ? Eye : EyeOff,
    onClick: () => api.messages.setFlags(m.channelId, m.id, suppressed ? 0 : MessageFlags.SUPPRESS_EMBEDS)
      .then((u) => useMessages.getState().update({ ...m, flags: u.flags, embeds: u.embeds })).catch(toastError) };
}

/** "Translate": on-device Translator API when the browser has one, else the server's TRANSLATE_URL; shown disabled when neither exists. */
function translateItem(m: Message): MenuItem {
  void translateSupport(); // probe once so the next menu knows
  const cached = translateSupportCached();
  const shown = !!useTranslations.getState().by[m.id];
  if (shown) return { label: t('Hide Translation'), icon: Languages, onClick: () => useTranslations.getState().set(m.id, null) };
  return { label: cached === 'none' ? t('Translate (not available)') : t('Translate'), icon: Languages, disabled: cached === 'none',
    onClick: () => {
      const st = useTranslations.getState(); st.set(m.id, 'loading');
      translateMessage(m.channelId, m.id, m.content, targetLanguage(useUI.getState().prefs.language))
        .then((r) => st.set(m.id, r)).catch((e) => { st.set(m.id, null); toastError(e); });
    } };
}

export function messageMenu(m: Message, opts: { startEdit: () => void; pickEmoji: (rect: DOMRect | undefined) => void }): MenuItem[] {
  const s = useData.getState(); const me = s.me; if (!me) return [];
  const ch = findChannel(s, m.channelId); const perms = myChannelPerms(m.channelId); const isDm = !ch?.guildId;
  const items: MenuItem[] = [
    { label: t('Add Reaction'), icon: Smile, disabled: !can(perms, Perm.ADD_REACTIONS) && !isDm, onClick: () => opts.pickEmoji(undefined) },
    ...(canEditMessage(m, me.id) ? [{ label: t('Edit Message'), icon: Edit3, onClick: opts.startEdit }] : []),
    ...(canPinMessage(perms, isDm) ? [{ label: m.pinned ? 'Unpin Message' : 'Pin Message', icon: m.pinned ? PinOff : Pin, onClick: () => (m.pinned ? api.messages.unpin(m.channelId, m.id) : api.messages.pin(m.channelId, m.id)).then(() => useMessages.getState().update({ ...m, pinned: !m.pinned })).catch(toastError) }] : []),
    ...(embedsToggle(m, me.id, perms) ? [embedsToggle(m, me.id, perms)!] : []),
    ...(m.content.trim() && ['default', 'reply'].includes(m.type) && !ch?.encrypted ? [translateItem(m)] : []),
    { label: t('Reply'), icon: Reply, disabled: !can(perms, Perm.SEND_MESSAGES) && !isDm, onClick: () => ui().setReply(m.channelId, m.id) },
    ...(m.content ? [{ label: t('Copy Text'), icon: Copy, onClick: () => copyText(m.content).then(() => toast(t('Copied text'), 'success')) }] : []),
    ...(ch?.guildId && ch.type !== 'thread' && can(perms, Perm.CREATE_PUBLIC_THREADS) ? [{ label: t('Create Thread'), icon: Hash, onClick: () => ui().openModal({ kind: 'createThread', channelId: m.channelId, messageId: m.id, suggested: m.content.slice(0, 50) }) }] : []),
    ...(['default', 'reply'].includes(m.type) && (m.content || m.attachments.length || m.embeds.length || m.forward) ? [{ label: t('Forward'), icon: Forward, onClick: () => ui().openModal({ kind: 'forward', message: m }) }] : []),
    { label: useSocial.getState().saved[m.id] ? t('Remove from Saved') : t('Save for Later'), icon: Bookmark, onClick: () => { const on = !useSocial.getState().saved[m.id]; (on ? api.users.save(m.channelId, m.id) : api.users.unsave(m.channelId, m.id)).then(() => { useSocial.getState().setSaved(m.id, on); toast(on ? t('Saved for later') : t('Removed from saved'), 'success'); }).catch(toastError); } },
    { label: t('Remind Me'), icon: AlarmClock, children: [[t('in 5 minutes'), 300], [t('in 1 hour'), 3600], [t('in 3 hours'), 10800], [t('in 24 hours'), 86400], [t('in 1 week'), 604800]].map(([label, secs]) => ({ label: label as string, onClick: () => { api.users.remind(m.channelId, m.id, { inSeconds: secs as number }).then(() => { toast(t('We will remind you {when}', { when: label as string }), 'success'); void queryClient.invalidateQueries({ queryKey: ['inbox', 'reminders'] }); }).catch(toastError); } })) },
    ...(favoriteCandidate(m) ? [{ label: t('Add to GIF Favorites'), icon: Star, onClick: () => api.users.addGifFavorite(favoriteCandidate(m)!).then(() => { void queryClient.invalidateQueries({ queryKey: ['gif-favs'] }); toast(t('Saved to your favorites'), 'success'); }).catch(toastError) }] : []),
    ...(ch?.guildId && ch.type !== 'thread' && can(perms, Perm.MODERATE_MEMBERS) ? [{ label: t('Report Message'), icon: ShieldBan, onClick: () => ui().openModal({ kind: 'report', messageId: m.id, guildId: ch.guildId!, channelId: m.channelId }) }] : []),
    { label: t('Mark Unread'), icon: Mail, onClick: () => { s.setRead(m.channelId, String(BigInt(m.id) - 1n), 0); api.channels.ack(m.channelId, m.id, true).catch(() => {}); } },
    { label: t('Copy Message Link'), icon: Link2, onClick: () => copyText(`${publicOrigin()}/channels/${m.guildId ?? '@me'}/${m.channelId}/${m.id}`).then(() => toast(t('Link copied'), 'success')) },
    ...(canDeleteMessage(m, me.id, perms) ? [{ separator: true }, { label: t('Delete Message'), icon: Trash2, danger: true, onClick: () => ui().openModal({ kind: 'confirm', title: t('Delete Message'), body: 'Are you sure you want to delete this message?', confirmLabel: 'Delete', danger: true, onConfirm: () => api.messages.delete(m.channelId, m.id).then(() => useMessages.getState().remove(m.channelId, m.id)).catch(toastError) }) }] : []),
    { separator: true },
    { label: t('Copy Message ID'), icon: Copy, onClick: () => copyText(m.id).then(() => toast(t('Copied ID'), 'success')) },
  ];
  return items;
}
void AtSign; void ShieldBan;
