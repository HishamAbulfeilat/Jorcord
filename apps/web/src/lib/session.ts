/** Wires the gateway into the stores. Call startSession(token) after login, endSession() on logout. */
import type { Events, Message } from '@jorcord/shared';
import { Perm } from '@jorcord/shared';
import { api } from './api';
import { getGateway } from './gateway';
import { useData, findChannel, selfMember } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { useUI } from '@/stores/ui';
import { useAuth } from '@/stores/auth';
import { effectivePerms } from './perms';
import { toPlain, parseInline } from './markdown';
import { displayName } from './format';
import { playSound } from './sound';
import { useNotif } from '@/stores/notif';
import { streamerActive } from './streamer';
import { getServerUrl } from './server';
import { usePlatform } from '@/stores/platform';
import { isEphemeral } from '@/stores/messages';
import { onAutocompleteResult, onInteractionFailed, onInteractionModal, settleForMessage } from './interactions';
import { queryClient } from './queryClient';
import { onVoiceEffect } from './soundboard';
import { useSocial } from '@/stores/social';
import { useChannelActivities } from '@/stores/channelActivities';
import { setRateLimitNotifier } from './transport';
import { toast } from '@/stores/ui';
import { emitOverlayToast } from './overlay';
import { useCalls, wireCallEvents } from '@/stores/calls';

let unsubs: (() => void)[] = [];

export function startSession(token: string) {
  endSession(false);
  const gw = getGateway();
  const names: (keyof Events)[] = ['READY', 'GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'ROLE_CREATE', 'ROLE_UPDATE', 'ROLE_DELETE', 'MEMBER_ADD', 'MEMBER_UPDATE', 'MEMBER_REMOVE', 'TYPING_START', 'PRESENCE_UPDATE', 'USER_UPDATE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE', 'READ_STATE_UPDATE', 'VOICE_STATE_UPDATE', 'VOICE_RECORDING_UPDATE', 'EMOJIS_UPDATE', 'STICKERS_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'MESSAGE_REQUEST_UPDATE'];
  let readies = 0;
  unsubs.push(gw.on('READY', () => { void useSocial.getState().load(); void queryClient.invalidateQueries({ queryKey: ['inbox', 'reminders'] }); }));
  for (const n of names) unsubs.push(gw.on(n, (d: any) => { if (n === 'READY' && ++readies > 1) { useMessages.setState({ ch: {} }); usePlatform.setState({ eventsLoaded: {}, stagesLoaded: {} }); } /* missed events after a failed resume: reload open channels */ useData.getState().apply(n, d); }));
  // a bot joining or leaving changes which commands the picker may offer
  for (const n of ['MEMBER_ADD', 'MEMBER_REMOVE'] as const) unsubs.push(gw.on(n, (d: any) => { const bot = d.user?.bot ?? useData.getState().users[d.userId]?.bot; if (bot) void queryClient.invalidateQueries({ queryKey: ['commands', d.guildId] }); }));
  unsubs.push(gw.on('GUILD_MEMBERS_CHUNK', (d) => useData.getState().putMembers(d.guildId, d.members)));
  unsubs.push(gw.on('READY', (d) => useCalls.getState().setAll(d.calls ?? [])));
  unsubs.push(gw.on('CALL_RING', wireCallEvents.ring), gw.on('CALL_RING_END', wireCallEvents.end));
  unsubs.push(gw.on('MESSAGE_CREATE', onMessageCreate));
  unsubs.push(gw.on('MESSAGE_UPDATE', (m) => { useMessages.getState().update(m); settleForMessage(m); }));
  unsubs.push(gw.on('MESSAGE_DELETE', (d) => useMessages.getState().remove(d.channelId, d.id)));
  unsubs.push(gw.on('MESSAGE_REACTION_ADD', (d) => useMessages.getState().reaction(d.channelId, d.messageId, d.emoji, d.emojiId, 1, d.userId === useData.getState().me?.id, !!d.burst, d.burstColor ?? null)));
  unsubs.push(gw.on('MESSAGE_REACTION_REMOVE', (d) => useMessages.getState().reaction(d.channelId, d.messageId, d.emoji, d.emojiId, -1, d.userId === useData.getState().me?.id, !!d.burst)));
  // ---- platform pass ----
  const meId = () => useData.getState().me?.id;
  unsubs.push(gw.on('MESSAGE_POLL_VOTE_ADD', (d) => { useMessages.getState().pollVote(d.channelId, d.messageId, d.answerId, 1, d.userId === meId()); refreshPoll(d.channelId, d.messageId); }));
  unsubs.push(gw.on('MESSAGE_POLL_VOTE_REMOVE', (d) => { useMessages.getState().pollVote(d.channelId, d.messageId, d.answerId, -1, d.userId === meId()); refreshPoll(d.channelId, d.messageId); }));
  unsubs.push(gw.on('SAVED_UPDATE', (d) => { useSocial.getState().setSaved(d.messageId, d.saved); void queryClient.invalidateQueries({ queryKey: ['inbox', 'saved'] }); }));
  unsubs.push(gw.on('REMINDER_DUE', (r) => {
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'reminders'] });
    toast(`Reminder: ${(r.message.content || r.message.attachments[0]?.filename || 'a message').slice(0, 80)}`, 'info');
    window.dispatchEvent(new CustomEvent('jorcord:reminder', { detail: r }));
  }));
  unsubs.push(gw.on('SCHEDULED_MESSAGE_UPDATE', (s) => {
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'scheduled'] });
    if (s.status === 'failed') toast(`A scheduled message could not be sent: ${(s.error ?? 'unknown error').slice(0, 120)}`, 'error');
  }));
  unsubs.push(gw.on('LINKED_ROLES_UPDATE', (d) => queryClient.invalidateQueries({ queryKey: ['linked-roles', d.guildId] })));
  unsubs.push(gw.on('USER_NOTE_UPDATE', (d) => queryClient.setQueryData(['user', d.userId], (old: any) => (old ? { ...old, note: d.note } : old))));
  unsubs.push(gw.on('SOUNDBOARD_SOUNDS_UPDATE', (d) => queryClient.setQueryData(['sounds', d.guildId], d.sounds)));
  unsubs.push(gw.on('ACTIVITY_START', (a) => useChannelActivities.getState().upsert(a)));
  unsubs.push(gw.on('ACTIVITY_UPDATE', (a) => useChannelActivities.getState().upsert(a)));
  unsubs.push(gw.on('ACTIVITY_END', (d) => useChannelActivities.getState().remove(d.id, d.channelId)));
  unsubs.push(gw.on('VOICE_CHANNEL_EFFECT_SEND', (d) => onVoiceEffect(d, meId())));
  unsubs.push(gw.on('GIF_FAVORITES_UPDATE', () => { void queryClient.invalidateQueries({ queryKey: ['gif-favs'] }); }));
  unsubs.push(gw.on('INTERACTION_FAILED', onInteractionFailed));
  unsubs.push(gw.on('INTERACTION_MODAL', onInteractionModal));
  unsubs.push(gw.on('INTERACTION_AUTOCOMPLETE_RESULT', onAutocompleteResult));
  unsubs.push(gw.on('GUILD_SCHEDULED_EVENT_CREATE', (e) => usePlatform.getState().upsertEvent(e)));
  unsubs.push(gw.on('GUILD_SCHEDULED_EVENT_UPDATE', (e) => usePlatform.getState().upsertEvent(e)));
  unsubs.push(gw.on('GUILD_SCHEDULED_EVENT_DELETE', (e) => usePlatform.getState().removeEvent(e)));
  unsubs.push(gw.on('GUILD_SCHEDULED_EVENT_USER_ADD', (d) => usePlatform.getState().eventInterest(d.guildId, d.guildScheduledEventId, 1, d.userId === meId())));
  unsubs.push(gw.on('GUILD_SCHEDULED_EVENT_USER_REMOVE', (d) => usePlatform.getState().eventInterest(d.guildId, d.guildScheduledEventId, -1, d.userId === meId())));
  unsubs.push(gw.on('STAGE_INSTANCE_CREATE', (s) => usePlatform.getState().setStage(s)));
  unsubs.push(gw.on('STAGE_INSTANCE_UPDATE', (s) => usePlatform.getState().setStage(s)));
  unsubs.push(gw.on('STAGE_INSTANCE_DELETE', (s) => usePlatform.getState().removeStage(s.channelId)));
  for (const n of ['APPLICATION_COMMAND_CREATE', 'APPLICATION_COMMAND_UPDATE', 'APPLICATION_COMMAND_DELETE'] as const) unsubs.push(gw.on(n, (c) => { void queryClient.invalidateQueries({ queryKey: ['commands', c.guildId] }); }));
  // 429s: the transport already waits and retries short ones; tell the person why things are slow
  setRateLimitNotifier((ms, why) => { if (why === '429' && ms >= 1500) toast(`You are being rate limited. Retrying in ${Math.ceil(ms / 1000)}s…`, 'info'); });
  unsubs.push(gw.on('CHANNEL_PINS_UPDATE', (d) => {
    window.dispatchEvent(new CustomEvent('jorcord:pins', { detail: d.channelId }));
    // keep the "pinned" mark of already loaded messages in sync for everyone in the channel
    const loaded = useMessages.getState().ch[d.channelId]?.list; if (!loaded?.length) return;
    api.messages.pins(d.channelId).then((pins) => { const ids = new Set(pins.map((p) => p.id)); for (const m of useMessages.getState().ch[d.channelId]?.list ?? []) if (m.pinned !== ids.has(m.id)) useMessages.getState().update({ ...m, pinned: ids.has(m.id) }); }).catch(() => {});
  }));
  (gw as any).getToken = () => useAuth.getState().access;
  (gw as any).authFailed = () => {
    api.users.me().then((u) => { useData.getState().setMe(u); (gw as any).reconnect?.(useAuth.getState().access ?? token); }).catch((e) => { if (e?.status === 401) useAuth.getState().clear(); }); // only a rejected session ends it: being offline must not log anyone out
  };
  gw.connect(token);
}

const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Vote events only say "someone voted for answer N": re-read the poll shortly after to get the exact distinct-voter total (one read per burst of events). */
function refreshPoll(channelId: string, messageId: string) {
  if (!useMessages.getState().ch[channelId]?.list.some((m) => m.id === messageId)) return;
  clearTimeout(pollTimers.get(messageId));
  pollTimers.set(messageId, setTimeout(() => {
    pollTimers.delete(messageId);
    api.messages.list(channelId, { limit: 3, around: messageId }).then((l) => { const m = l.find((x) => x.id === messageId); if (m?.poll) useMessages.getState().replace(m); }).catch(() => {});
  }, 250));
}

export function endSession(reset = true) {
  unsubs.forEach((u) => u()); unsubs = [];
  getGateway().disconnect();
  if (reset) { useData.getState().reset(); usePlatform.getState().reset(); useSocial.getState().reset(); useChannelActivities.getState().reset(); useCalls.getState().setAll([]); }
}

function onMessageCreate(m: Message) {
  const data = useData.getState();
  settleForMessage(m);
  if (isEphemeral(m)) { useMessages.getState().upsert(m); return; } // "Only you can see this": no unread, no sound, never part of history
  data.apply('MESSAGE_CREATE', m);
  useMessages.getState().upsert(m);
  const me = data.me; if (!me) return;
  const mine = m.author.id === me.id;
  const viewing = currentChannelId() === m.channelId && document.visibilityState === 'visible' && document.hasFocus();
  if (mine) { data.setRead(m.channelId, m.id, 0); return; }
  if (viewing) { ackLater(m.channelId, m.id); return; }
  const gn = m.guildId ? useNotif.getState().guilds[m.guildId] : undefined;
  const prefsNow = useUI.getState().prefs;
  const everyoneOff = prefsNow.suppressEveryone || !!gn?.suppressEveryone;
  const roleMention = m.guildId ? m.mentionRoles.some((r) => selfMember(data, m.guildId!)?.roles.includes(r)) : false;
  const mentioned = m.mentions.includes(me.id) || (m.mentionEveryone && !everyoneOff) || (roleMention && !gn?.suppressRoles);
  const isDm = !m.guildId;
  if (isDm && data.messageRequests[m.channelId]) return; // message requests stay quiet: no badge, sound or notification until accepted
  const rs = data.readStates[m.channelId];
  if (mentioned || isDm) data.setRead(m.channelId, rs?.lastReadId ?? null, (rs?.mentionCount ?? 0) + 1);
  const prefs = useUI.getState().prefs;
  const muted = prefs.mutedChannels[m.channelId] || (m.guildId && prefs.mutedGuilds[m.guildId]);
  const guildDefault = m.guildId && data.guilds[m.guildId]?.guild.defaultNotifications === 'all' ? 'all' : undefined; // the server's "all messages" default applies until I choose my own
  const level = gn?.level ?? guildDefault ?? prefs.defaultNotify;
  const wants = !muted && (isDm || (level !== 'none' && (mentioned || level === 'all')) || (gn?.level == null && mentioned));
  const streaming = streamerActive();
  if (wants) {
    const ch = findChannel(data, m.channelId);
    const gm = m.guildId ? data.guilds[m.guildId]?.members[m.author.id] : undefined;
    const preview = toPlain(parseInline(m.content)).slice(0, 200);
    if (prefs.overlayEnabled && !(streaming && prefs.streamerNoNotifications)) void emitOverlayToast({ id: m.id, author: displayName(m.author, gm), channel: m.guildId ? ch?.name ?? null : null, text: preview });
    if (prefs.notificationSounds && !(streaming && prefs.streamerNoSounds)) playSound('message');
    if (prefs.desktopNotifications && !(streaming && prefs.streamerNoNotifications) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification(`${displayName(m.author, gm)}${ch?.name && m.guildId ? ` (#${ch.name})` : ''}`, { body: preview || 'Sent an attachment', tag: m.channelId, icon: getServerUrl() ? undefined : '/icon-192.png' });
        n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent('jorcord:goto', { detail: { guildId: m.guildId, channelId: m.channelId } })); };
      } catch { /* */ }
    }
  }
}

export const currentChannelId = (): string | null => (window as any).__jorcordChannel ?? null;
export const setCurrentChannel = (id: string | null) => { (window as any).__jorcordChannel = id; };

const acks = new Map<string, ReturnType<typeof setTimeout>>();
export function ackLater(channelId: string, messageId: string) {
  useData.getState().setRead(channelId, messageId, 0);
  clearTimeout(acks.get(channelId));
  acks.set(channelId, setTimeout(() => { api.channels.ack(channelId, messageId).catch(() => {}); }, 600));
}

/** perms of me in a channel (cosmetic gating). */
export function myChannelPerms(channelId: string): bigint {
  const s = useData.getState(); const ch = findChannel(s, channelId);
  if (!ch) return 0n;
  if (!ch.guildId) return ~0n & ((1n << 41n) - 1n) & ~Perm.MANAGE_MESSAGES;
  const g = s.guilds[ch.guildId]; const me = selfMember(s, ch.guildId);
  if (!g || !me) return 0n;
  return effectivePerms({ guild: g.guild, roles: Object.values(g.roles), member: me }, ch);
}
