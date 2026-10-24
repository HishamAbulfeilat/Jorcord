import { create } from 'zustand';
import type { Activity, Channel, Emoji, Events, Guild, GuildFull, Id, Member, Presence, ReadState, Relationship, Role, SelfUser, Sticker, User, VoiceRecording, VoiceState } from '@jorcord/shared';
import { compareId } from '@/lib/format';

export interface GuildState {
  guild: Guild; channels: Record<Id, Channel>; roles: Record<Id, Role>; members: Record<Id, Member>;
  emojis: Emoji[]; stickers: Sticker[]; memberCount: number; membersLoaded?: boolean;
}
export interface DataState {
  ready: boolean; me: SelfUser | null;
  guilds: Record<Id, GuildState>; guildOrder: Id[];
  dms: Record<Id, Channel>;
  /** DM channels that are message requests (non-friends, not accepted yet). */
  messageRequests: Record<Id, true>;
  relationships: Record<Id, Relationship>;
  readStates: Record<Id, ReadState>;
  presences: Record<Id, Presence>;
  /** Rich presence per user (empty/absent = nothing shown). */
  activities: Record<Id, Activity[]>;
  users: Record<Id, User>;
  typing: Record<Id, Record<Id, number>>;
  voiceStates: Record<Id, VoiceState>;
  /** Active voice-channel recordings, keyed by channel (VOICE_RECORDING_UPDATE; absent = not recording). */
  voiceRecordings: Record<Id, VoiceRecording>;
  reset(): void;
  applyReady(p: Events['READY']): void;
  apply<K extends keyof Events>(name: K, d: Events[K]): void;
  setMe(u: SelfUser): void;
  putGuild(g: GuildFull): void;
  putMembers(guildId: Id, ms: Member[]): void;
  putUsers(us: User[]): void;
  putDm(c: Channel): void;
  setRead(channelId: Id, lastReadId: Id | null, mentionCount?: number): void;
  setTyping(channelId: Id, userId: Id): void;
}

const empty = { ready: false, me: null, guilds: {}, guildOrder: [], dms: {}, messageRequests: {}, relationships: {}, readStates: {}, presences: {}, activities: {}, users: {}, typing: {}, voiceStates: {}, voiceRecordings: {} };
const rec = <T extends { id: Id }>(xs: T[]): Record<Id, T> => Object.fromEntries(xs.map((x) => [x.id, x]));
const toGuildState = (g: GuildFull): GuildState => {
  const { channels, roles, members, emojis, stickers, memberCount, ...guild } = g;
  return { guild, channels: rec(channels ?? []), roles: rec(roles ?? []), members: Object.fromEntries((members ?? []).map((m) => [m.user.id, m])), emojis: emojis ?? [], stickers: stickers ?? [], memberCount: memberCount ?? members?.length ?? 0 };
};

const stickerFetches = new Map<Id, number>();
/** Stickers have no gateway event: pull a guild's list when a message references one we do not know. Throttled per guild. */
export async function refreshStickers(guildId: Id) {
  if (Date.now() - (stickerFetches.get(guildId) ?? 0) < 15_000) return;
  stickerFetches.set(guildId, Date.now());
  try {
    const { api } = await import('@/lib/api');
    const list = await api.guilds.stickers(guildId);
    useData.setState((st) => (st.guilds[guildId] ? { guilds: { ...st.guilds, [guildId]: { ...st.guilds[guildId]!, stickers: list } } } : st));
  } catch { /* no permission / offline */ }
}

export const useData = create<DataState>((set, get) => ({
  ...empty,
  reset: () => set({ ...empty }),
  setMe: (me) => set((s) => ({ me, users: { ...s.users, [me.id]: me } })),
  applyReady(p) {
    const users: Record<Id, User> = { [p.user.id]: p.user };
    const guilds: Record<Id, GuildState> = {};
    for (const g of p.guilds) { guilds[g.id] = toGuildState(g); for (const m of g.members ?? []) users[m.user.id] = m.user; }
    for (const c of p.privateChannels) for (const r of c.recipients ?? []) users[r.id] = r;
    for (const r of p.relationships) users[r.user.id] = r.user;
    const presences: Record<Id, Presence> = {};
    const activities: Record<Id, Activity[]> = {};
    for (const x of p.presences ?? []) { presences[x.userId] = x.presence; if (x.activities?.length) activities[x.userId] = x.activities; }
    // The server's READY lists peers only; we are obviously online ourselves (own status honoured unless invisible).
    if (!presences[p.user.id]) presences[p.user.id] = p.user.presence && p.user.presence !== 'invisible' ? p.user.presence : p.user.presence === 'invisible' ? 'invisible' : 'online';
    const vs: Record<Id, VoiceState> = {};
    for (const v of p.voiceStates ?? []) if (v.channelId) vs[v.userId] = v;
    set({
      ready: true, me: p.user, guilds, guildOrder: p.guilds.map((g) => g.id), users,
      dms: rec(p.privateChannels), messageRequests: Object.fromEntries((p.messageRequests ?? []).map((id) => [id, true as const])), relationships: Object.fromEntries(p.relationships.map((r) => [r.user.id, r])),
      readStates: Object.fromEntries((p.readStates ?? []).map((r) => [r.channelId, r])), presences, activities, voiceStates: vs, typing: {},
    });
  },
  putGuild: (g) => set((s) => ({ guilds: { ...s.guilds, [g.id]: toGuildState(g) }, guildOrder: s.guildOrder.includes(g.id) ? s.guildOrder : [...s.guildOrder, g.id] })),
  putMembers: (guildId, ms) => set((s) => {
    const gs = s.guilds[guildId]; if (!gs) return s;
    const members = { ...gs.members }; const users = { ...s.users };
    for (const m of ms) { members[m.user.id] = m; users[m.user.id] = m.user; }
    return { guilds: { ...s.guilds, [guildId]: { ...gs, members, membersLoaded: true } }, users };
  }),
  putUsers: (us) => set((s) => { const users = { ...s.users }; for (const u of us) users[u.id] = { ...users[u.id], ...u }; return { users }; }),
  putDm: (c) => set((s) => ({ dms: { ...s.dms, [c.id]: c }, users: { ...s.users, ...Object.fromEntries((c.recipients ?? []).map((r) => [r.id, r])) } })),
  setRead: (channelId, lastReadId, mentionCount = 0) => set((s) => ({ readStates: { ...s.readStates, [channelId]: { channelId, lastReadId, mentionCount } } })),
  setTyping: (channelId, userId) => set((s) => ({ typing: { ...s.typing, [channelId]: { ...s.typing[channelId], [userId]: Date.now() } } })),
  apply(name, d: any) {
    const s = get();
    const patchGuild = (id: Id | null | undefined, fn: (g: GuildState) => GuildState) => {
      if (!id || !s.guilds[id]) return;
      set((st) => ({ guilds: { ...st.guilds, [id]: fn(st.guilds[id]) } }));
    };
    switch (name) {
      case 'READY': return get().applyReady(d);
      case 'GUILD_CREATE': return get().putGuild(d);
      case 'GUILD_UPDATE': return patchGuild(d.id, (g) => ({ ...g, guild: { ...g.guild, ...d } }));
      case 'GUILD_DELETE': return set((st) => { const { [d.id]: _, ...rest } = st.guilds; return { guilds: rest, guildOrder: st.guildOrder.filter((x) => x !== d.id) }; });
      case 'CHANNEL_CREATE': case 'CHANNEL_UPDATE': case 'THREAD_CREATE': case 'THREAD_UPDATE': {
        const c = d as Channel;
        if (!c.guildId) return get().putDm(c);
        return patchGuild(c.guildId, (g) => ({ ...g, channels: { ...g.channels, [c.id]: { ...g.channels[c.id], ...c } } }));
      }
      case 'CHANNEL_VOICE_STATUS_UPDATE': return patchGuild(d.guildId, (g) => (g.channels[d.channelId] ? { ...g, channels: { ...g.channels, [d.channelId]: { ...g.channels[d.channelId], voiceStatus: d.status } } } : g));
      case 'CHANNEL_DELETE': {
        if (!d.guildId) return set((st) => { const { [d.id]: _, ...rest } = st.dms; return { dms: rest, messageRequests: omit(st.messageRequests, d.id) }; });
        return patchGuild(d.guildId, (g) => { const { [d.id]: _, ...rest } = g.channels; return { ...g, channels: rest }; });
      }
      case 'ROLE_CREATE': case 'ROLE_UPDATE': return patchGuild(d.guildId, (g) => ({ ...g, roles: { ...g.roles, [d.id]: d } }));
      case 'ROLE_DELETE': return patchGuild(d.guildId, (g) => { const { [d.id]: _, ...rest } = g.roles; return { ...g, roles: rest }; });
      case 'MEMBER_ADD': case 'MEMBER_UPDATE': {
        set((st) => ({ users: { ...st.users, [d.user.id]: d.user } }));
        return patchGuild(d.guildId, (g) => ({ ...g, members: { ...g.members, [d.user.id]: d }, memberCount: name === 'MEMBER_ADD' && !g.members[d.user.id] ? g.memberCount + 1 : g.memberCount }));
      }
      case 'MEMBER_REMOVE': return patchGuild(d.guildId, (g) => { const { [d.userId]: _, ...rest } = g.members; return { ...g, members: rest, memberCount: Math.max(0, g.memberCount - 1) }; });
      case 'MESSAGE_CREATE': {
        const m = d as Events['MESSAGE_CREATE'];
        set((st) => {
          const users = { ...st.users, [m.author.id]: { ...st.users[m.author.id], ...m.author } };
          const typing = st.typing[m.channelId] ? { ...st.typing, [m.channelId]: omit(st.typing[m.channelId], m.author.id) } : st.typing;
          let guilds = st.guilds; let dms = st.dms;
          if (m.guildId && guilds[m.guildId]?.channels[m.channelId]) {
            const g = guilds[m.guildId];
            guilds = { ...guilds, [m.guildId]: { ...g, channels: { ...g.channels, [m.channelId]: { ...g.channels[m.channelId], lastMessageId: m.id } } } };
          } else if (dms[m.channelId]) dms = { ...dms, [m.channelId]: { ...dms[m.channelId], lastMessageId: m.id } };
          return { users, typing, guilds, dms };
        });
        return;
      }
      case 'MESSAGE_REQUEST_UPDATE': return set((st) => ({ messageRequests: d.request ? { ...st.messageRequests, [d.channelId]: true } : omit(st.messageRequests, d.channelId) }));
      case 'MESSAGE_DELETE': return;
      case 'TYPING_START': { if (d.userId !== s.me?.id) get().setTyping(d.channelId, d.userId); return; }
      case 'PRESENCE_UPDATE': return set((st) => ({
        presences: { ...st.presences, [d.userId]: d.presence },
        activities: d.activities === undefined ? st.activities : d.activities.length ? { ...st.activities, [d.userId]: d.activities } : omit(st.activities, d.userId),
        users: st.users[d.userId] && d.customStatus !== undefined ? { ...st.users, [d.userId]: { ...st.users[d.userId], customStatus: d.customStatus } } : st.users,
        // the server clears an expired status and broadcasts it: keep my own copy in sync too
        me: st.me && st.me.id === d.userId && d.customStatus !== undefined ? { ...st.me, customStatus: d.customStatus } : st.me,
      }));
      case 'USER_UPDATE': return set((st) => ({
        users: { ...st.users, [d.id]: { ...st.users[d.id], ...d } },
        me: st.me && st.me.id === d.id ? { ...st.me, ...d } : st.me,
        guilds: Object.fromEntries(Object.entries(st.guilds).map(([id, g]) => [id, g.members[d.id] ? { ...g, members: { ...g.members, [d.id]: { ...g.members[d.id], user: { ...g.members[d.id].user, ...d } } } } : g])),
      }));
      case 'RELATIONSHIP_ADD': return set((st) => ({ relationships: { ...st.relationships, [d.user.id]: d }, users: { ...st.users, [d.user.id]: d.user } }));
      case 'RELATIONSHIP_REMOVE': return set((st) => ({ relationships: omit(st.relationships, d.userId) }));
      case 'READ_STATE_UPDATE': return set((st) => ({ readStates: { ...st.readStates, [d.channelId]: d } }));
      case 'VOICE_STATE_UPDATE': return set((st) => d.channelId ? { voiceStates: { ...st.voiceStates, [d.userId]: d } } : { voiceStates: omit(st.voiceStates, d.userId) });
      case 'VOICE_RECORDING_UPDATE': return set((st) => d.recording ? { voiceRecordings: { ...st.voiceRecordings, [d.channelId]: d.recording } } : { voiceRecordings: omit(st.voiceRecordings, d.channelId) });
      case 'EMOJIS_UPDATE': return patchGuild(d.guildId, (g) => ({ ...g, emojis: d.emojis }));
      case 'STICKERS_UPDATE': return patchGuild(d.guildId, (g) => ({ ...g, stickers: d.stickers }));
      case 'THREAD_LIST_SYNC': {
        // authoritative list of active threads (for the whole guild, or just under d.channelIds): drop the ones we no longer see
        const keep = new Set((d.threads as Channel[]).map((t) => t.id));
        return patchGuild(d.guildId, (g) => {
          const channels = { ...g.channels };
          for (const c of Object.values(channels)) if (c.type === 'thread' && !c.archived && !keep.has(c.id) && (!d.channelIds || d.channelIds.includes(c.parentId))) delete channels[c.id];
          for (const t of d.threads as Channel[]) channels[t.id] = { ...channels[t.id], ...t };
          return { ...g, channels };
        });
      }
      case 'THREAD_DELETE': return patchGuild(d.guildId, (g) => { const { [d.id]: _, ...rest } = g.channels; return { ...g, channels: rest }; });
      default: return;
    }
  },
}));

function omit<T>(o: Record<string, T>, k: string) { const { [k]: _, ...rest } = o; return rest; }

// ---- selectors / helpers (non-hook) ----
export const findChannel = (s: DataState, id: Id | undefined | null): Channel | undefined => {
  if (!id) return undefined;
  if (s.dms[id]) return s.dms[id];
  for (const g of Object.values(s.guilds)) if (g.channels[id]) return g.channels[id];
  return undefined;
};
export const channelUnread = (s: DataState, c: Channel): { unread: boolean; mentions: number } => {
  const rs = s.readStates[c.id];
  const mentions = rs?.mentionCount ?? 0;
  if (!c.lastMessageId) return { unread: false, mentions };
  return { unread: compareId(c.lastMessageId, rs?.lastReadId ?? null) > 0, mentions };
};
export const guildUnread = (s: DataState, gid: Id, mutedChannels: Record<Id, boolean> = {}): { unread: boolean; mentions: number } => {
  const g = s.guilds[gid]; if (!g) return { unread: false, mentions: 0 };
  let unread = false, mentions = 0;
  for (const c of Object.values(g.channels)) {
    if (c.type === 'category' || c.type === 'voice' || c.type === 'stage') continue;
    const u = channelUnread(s, c); mentions += u.mentions;
    if (u.unread && !mutedChannels[c.id]) unread = true;
  }
  return { unread, mentions };
};
export function userOf(s: DataState, id: Id): User | undefined { return s.users[id]; }
export function selfMember(s: DataState, guildId: Id): Member | undefined { return s.me ? s.guilds[guildId]?.members[s.me.id] : undefined; }
