/** Server-side notification settings (push on/off, per-guild level/mute/suppress, per-channel mute), mirrored into local prefs. */
import { create } from 'zustand';
import type { Id } from '@jorcord/shared';
import { api, type ChannelNotify, type GuildNotify, type NotificationSettings } from '@/lib/api';
import { useUI, toastError } from '@/stores/ui';

export const DEFAULT_GUILD_NOTIFY: GuildNotify = { muted: false, mutedUntil: null, suppressEveryone: false, suppressRoles: false, level: null };
export const mutedNow = (s?: { muted: boolean; mutedUntil: string | null } | null, now = Date.now()) => !!s && s.muted && (!s.mutedUntil || new Date(s.mutedUntil).getTime() > now);

interface NotifState {
  loaded: boolean; pushEnabled: boolean;
  guilds: Record<Id, GuildNotify>; channels: Record<Id, ChannelNotify>;
  load(): Promise<void>;
  hydrate(s: NotificationSettings): void;
  reset(): void;
  setPushEnabled(v: boolean): Promise<void>;
  setGuild(gid: Id, patch: Partial<GuildNotify>): Promise<void>;
  setChannel(cid: Id, patch: Partial<ChannelNotify>): Promise<void>;
  /** Re-derive local mute prefs from the server rows (expired timed mutes drop out). */
  syncPrefs(): void;
}

export const useNotif = create<NotifState>((set, get) => ({
  loaded: false, pushEnabled: true, guilds: {}, channels: {},
  reset: () => set({ loaded: false, pushEnabled: true, guilds: {}, channels: {} }),
  hydrate(s) {
    set({ loaded: true, pushEnabled: s.pushEnabled, guilds: Object.fromEntries(s.guilds.map(({ guildId, ...r }) => [guildId, r])), channels: Object.fromEntries(s.channels.map(({ channelId, ...r }) => [channelId, r])) });
    get().syncPrefs();
  },
  async load() { try { get().hydrate(await api.notifications.get()); } catch { /* server without push: local prefs only */ } },
  async setPushEnabled(v) {
    const prev = get().pushEnabled; set({ pushEnabled: v });
    try { await api.notifications.setPushEnabled(v); } catch (e) { set({ pushEnabled: prev }); toastError(e); }
  },
  async setGuild(gid, patch) {
    const cur = get().guilds[gid] ?? DEFAULT_GUILD_NOTIFY; const next = { ...cur, ...patch };
    set((s) => ({ guilds: { ...s.guilds, [gid]: next } })); get().syncPrefs();
    try { const r = await api.notifications.putGuild(gid, patch); const { guildId: _g, ...row } = r; set((s) => ({ guilds: { ...s.guilds, [gid]: row } })); get().syncPrefs(); }
    catch (e) { set((s) => ({ guilds: { ...s.guilds, [gid]: cur } })); get().syncPrefs(); toastError(e); }
  },
  async setChannel(cid, patch) {
    const cur = get().channels[cid] ?? { muted: false, mutedUntil: null }; const next = { ...cur, ...patch };
    set((s) => ({ channels: { ...s.channels, [cid]: next } })); get().syncPrefs();
    try { const r = await api.notifications.putChannel(cid, patch); const { channelId: _c, ...row } = r; set((s) => ({ channels: { ...s.channels, [cid]: row } })); get().syncPrefs(); }
    catch (e) { set((s) => ({ channels: { ...s.channels, [cid]: cur } })); get().syncPrefs(); toastError(e); }
  },
  syncPrefs() {
    const { guilds, channels } = get(); const ui = useUI.getState();
    const mg = { ...ui.prefs.mutedGuilds }; const mc = { ...ui.prefs.mutedChannels };
    for (const [id, r] of Object.entries(guilds)) mg[id] = mutedNow(r);
    for (const [id, r] of Object.entries(channels)) mc[id] = mutedNow(r);
    if (JSON.stringify(mg) !== JSON.stringify(ui.prefs.mutedGuilds)) ui.setPref('mutedGuilds', mg);
    if (JSON.stringify(mc) !== JSON.stringify(ui.prefs.mutedChannels)) ui.setPref('mutedChannels', mc);
  },
}));

/** Mute / unmute helpers used by menus: always update the instant local pref and the server row. */
export function setMuted(scope: 'guild' | 'channel', id: Id, muted: boolean, until: Date | null = null) {
  const ui = useUI.getState();
  const key = scope === 'guild' ? 'mutedGuilds' : 'mutedChannels';
  ui.setPref(key, { ...ui.prefs[key], [id]: muted });
  const patch = { muted, mutedUntil: muted && until ? until.toISOString() : null };
  void (scope === 'guild' ? useNotif.getState().setGuild(id, patch) : useNotif.getState().setChannel(id, patch));
}

setInterval(() => { if (useNotif.getState().loaded) useNotif.getState().syncPrefs(); }, 60_000);
