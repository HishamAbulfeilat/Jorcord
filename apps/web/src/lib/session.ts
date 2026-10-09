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

let unsubs: (() => void)[] = [];

export function startSession(token: string) {
  endSession(false);
  const gw = getGateway();
  const names: (keyof Events)[] = ['READY', 'GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'ROLE_CREATE', 'ROLE_UPDATE', 'ROLE_DELETE', 'MEMBER_ADD', 'MEMBER_UPDATE', 'MEMBER_REMOVE', 'TYPING_START', 'PRESENCE_UPDATE', 'USER_UPDATE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE', 'READ_STATE_UPDATE', 'VOICE_STATE_UPDATE', 'EMOJIS_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE'];
  let readies = 0;
  for (const n of names) unsubs.push(gw.on(n, (d: any) => { if (n === 'READY' && ++readies > 1) useMessages.setState({ ch: {} }); /* missed events after a failed resume: reload open channels */ useData.getState().apply(n, d); }));
  unsubs.push(gw.on('GUILD_MEMBERS_CHUNK', (d) => useData.getState().putMembers(d.guildId, d.members)));
  unsubs.push(gw.on('MESSAGE_CREATE', onMessageCreate));
  unsubs.push(gw.on('MESSAGE_UPDATE', (m) => { useMessages.getState().update(m); }));
  unsubs.push(gw.on('MESSAGE_DELETE', (d) => useMessages.getState().remove(d.channelId, d.id)));
  unsubs.push(gw.on('MESSAGE_REACTION_ADD', (d) => useMessages.getState().reaction(d.channelId, d.messageId, d.emoji, d.emojiId, 1, d.userId === useData.getState().me?.id)));
  unsubs.push(gw.on('MESSAGE_REACTION_REMOVE', (d) => useMessages.getState().reaction(d.channelId, d.messageId, d.emoji, d.emojiId, -1, d.userId === useData.getState().me?.id)));
  unsubs.push(gw.on('CHANNEL_PINS_UPDATE', (d) => window.dispatchEvent(new CustomEvent('jorcord:pins', { detail: d.channelId }))));
  (gw as any).getToken = () => useAuth.getState().access;
  (gw as any).authFailed = () => {
    api.users.me().then((u) => { useData.getState().setMe(u); (gw as any).reconnect?.(useAuth.getState().access ?? token); }).catch(() => useAuth.getState().clear());
  };
  gw.connect(token);
}

export function endSession(reset = true) {
  unsubs.forEach((u) => u()); unsubs = [];
  getGateway().disconnect();
  if (reset) { useData.getState().reset(); }
}

function onMessageCreate(m: Message) {
  const data = useData.getState();
  data.apply('MESSAGE_CREATE', m);
  useMessages.getState().upsert(m);
  const me = data.me; if (!me) return;
  const mine = m.author.id === me.id;
  const viewing = currentChannelId() === m.channelId && document.visibilityState === 'visible' && document.hasFocus();
  if (mine) { data.setRead(m.channelId, m.id, 0); return; }
  if (viewing) { ackLater(m.channelId, m.id); return; }
  const mentioned = m.mentions.includes(me.id) || (m.mentionEveryone && !useUI.getState().prefs.suppressEveryone) || (m.guildId ? m.mentionRoles.some((r) => selfMember(data, m.guildId!)?.roles.includes(r)) : false);
  const isDm = !m.guildId;
  const rs = data.readStates[m.channelId];
  if (mentioned || isDm) data.setRead(m.channelId, rs?.lastReadId ?? null, (rs?.mentionCount ?? 0) + 1);
  const prefs = useUI.getState().prefs;
  const muted = prefs.mutedChannels[m.channelId] || (m.guildId && prefs.mutedGuilds[m.guildId]);
  const wants = !muted && (isDm || mentioned || prefs.defaultNotify === 'all');
  if (wants) {
    if (prefs.notificationSounds) playSound('message');
    if (prefs.desktopNotifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const ch = findChannel(data, m.channelId);
        const gm = m.guildId ? data.guilds[m.guildId]?.members[m.author.id] : undefined;
        const n = new Notification(`${displayName(m.author, gm)}${ch?.name && m.guildId ? ` (#${ch.name})` : ''}`, { body: toPlain(parseInline(m.content)).slice(0, 200) || 'Sent an attachment', tag: m.channelId, icon: '/icon-192.png' });
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
