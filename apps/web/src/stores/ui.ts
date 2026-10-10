import { create } from 'zustand';
import type { Id, Message, Modal } from '@jorcord/shared';

export type Theme = 'dark' | 'light' | 'amoled';
export interface Prefs {
  theme: Theme; density: 'cozy' | 'compact'; fontScale: number; reducedMotion: boolean; saturation: number;
  showEmbeds: boolean; autoplayGifs: boolean; twentyFourHour: boolean; language: string; highContrast: boolean;
  desktopNotifications: boolean; notificationSounds: boolean; defaultNotify: 'all' | 'mentions' | 'none'; suppressEveryone: boolean;
  inputDevice: string; outputDevice: string; videoDevice: string; inputVolume: number; outputVolume: number;
  noiseSuppression: boolean; echoCancellation: boolean; autoGain: boolean; pushToTalk: boolean;
  noiseEngine: 'browser' | 'rnnoise' | 'off'; voiceBitrate: number; musicMode: boolean; pttCode: string; vadMode: boolean; vadThreshold: number;
  screenPreset: '720p30' | '1080p60' | '1440p60' | '4k60' | 'source'; cameraPreset: '720p30' | '1080p60' | '1440p60' | '4k60' | 'source'; screenHint: 'motion' | 'detail'; screenAudio: boolean; showVoiceStats: boolean;
  keybinds: Record<string, string>;
  streamerMode: boolean; streamerAuto: boolean; streamerHidePersonal: boolean; streamerHideInvites: boolean; streamerNoSounds: boolean; streamerNoNotifications: boolean;
  mutedChannels: Record<Id, boolean>; mutedGuilds: Record<Id, boolean>; collapsedCategories: Record<Id, boolean>;
}
/** First-run language: the browser's, when we ship that translation. */
export function detectLanguage(): string {
  try {
    const l = (navigator.languages?.[0] ?? navigator.language ?? 'en-US');
    const base = l.toLowerCase().split('-')[0];
    return ({ es: 'es-ES', fr: 'fr-FR', de: 'de-DE', tr: 'tr-TR', ar: 'ar' } as Record<string, string>)[base!] ?? 'en-US';
  } catch { return 'en-US'; }
}
export const defaultKeybinds: Record<string, string> = {
  quickSwitcher: 'Ctrl+K', markRead: 'Escape', prevChannel: 'Alt+ArrowUp', nextChannel: 'Alt+ArrowDown',
  prevServer: 'Ctrl+Alt+ArrowUp', nextServer: 'Ctrl+Alt+ArrowDown', toggleMembers: 'Ctrl+U', search: 'Ctrl+F', shortcuts: 'Ctrl+/', pushToTalk: 'Ctrl+`', toggleMute: 'Ctrl+Shift+M', toggleDeafen: 'Ctrl+Shift+D',
};
export const defaultPrefs: Prefs = {
  theme: 'dark', density: 'cozy', fontScale: 1, reducedMotion: false, saturation: 1, showEmbeds: true, autoplayGifs: true, twentyFourHour: false, language: detectLanguage(), highContrast: false,
  desktopNotifications: false, notificationSounds: true, defaultNotify: 'mentions', suppressEveryone: false,
  inputDevice: 'default', outputDevice: 'default', videoDevice: 'default', inputVolume: 100, outputVolume: 100, noiseSuppression: true, echoCancellation: true, autoGain: true, pushToTalk: false,
  noiseEngine: 'browser', voiceBitrate: 64, musicMode: false, pttCode: 'Backquote', vadMode: false, vadThreshold: 0.03,
  screenPreset: '1080p60', cameraPreset: '720p30', screenHint: 'motion', screenAudio: true, showVoiceStats: false,
  keybinds: defaultKeybinds,
  streamerMode: false, streamerAuto: true, streamerHidePersonal: true, streamerHideInvites: true, streamerNoSounds: true, streamerNoNotifications: true,
  mutedChannels: {}, mutedGuilds: {}, collapsedCategories: {},
};

export type RightPanel = 'members' | 'search' | 'pins' | 'threads' | null;
export type ModalSpec =
  | { kind: 'createServer' } | { kind: 'joinServer'; code?: string }
  | { kind: 'createChannel'; guildId: Id; parentId?: Id | null; type?: string } | { kind: 'createCategory'; guildId: Id }
  | { kind: 'invite'; guildId: Id; channelId?: Id } | { kind: 'profile'; userId: Id; guildId?: Id }
  | { kind: 'confirm'; title: string; body: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'image'; url: string; name?: string } | { kind: 'createThread'; channelId: Id; messageId: Id; suggested?: string }
  | { kind: 'newDm'; addTo?: Id } | { kind: 'voiceSettings' } | { kind: 'createForumPost'; channelId: Id } | { kind: 'shortcuts' }
  | { kind: 'channelSettings'; channelId: Id } | { kind: 'reactors'; channelId: Id; messageId: Id; emoji: string; emojiId: Id | null }
  | { kind: 'prompt'; title: string; label: string; initial?: string; onSubmit: (v: string) => void | Promise<void> }
  | { kind: 'leaveGuild'; guildId: Id }
  | { kind: 'customStatus' } | { kind: 'folder'; folderId: string } | { kind: 'notifSettings'; scope: 'guild' | 'channel'; id: Id }
  | { kind: 'onboarding'; guildId: Id; step?: 'welcome' | 'rules' } | { kind: 'streamerStart' }
  | { kind: 'interactionModal'; interactionId: Id; channelId: Id; modal: Modal }
  | { kind: 'createPoll'; channelId: Id } | { kind: 'pollVoters'; channelId: Id; messageId: Id; answerId?: number }
  | { kind: 'events'; guildId: Id } | { kind: 'eventEditor'; guildId: Id; eventId?: Id; channelId?: Id }
  | { kind: 'forward'; message: Message } | { kind: 'inbox'; tab?: 'mentions' | 'saved' | 'reminders' } | { kind: 'screening'; guildId: Id } | { kind: 'threadSettings'; channelId: Id } | { kind: 'stage'; channelId: Id; mode: 'start' | 'edit' };
export type SettingsSpec = { kind: 'user'; tab?: string } | { kind: 'guild'; guildId: Id; tab?: string } | null;
export interface MenuItem { label?: string; icon?: any; onClick?: () => void; danger?: boolean; separator?: boolean; checked?: boolean; disabled?: boolean; hint?: string; children?: MenuItem[] }
export interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }
export type Popout = { kind: 'user'; userId: Id; guildId?: Id; rect: DOMRect } | { kind: 'emoji'; rect: DOMRect; onPick: (e: { char?: string; name: string; id?: Id; animated?: boolean; gif?: string; sticker?: Id }) => void; guildId?: Id; stickers?: boolean } | null;

interface UIState {
  prefs: Prefs; setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void;
  leftDrawer: boolean; rightDrawer: boolean; setLeftDrawer(v: boolean): void; setRightDrawer(v: boolean): void;
  panel: RightPanel; setPanel(p: RightPanel): void; togglePanel(p: Exclude<RightPanel, null>): void;
  modal: ModalSpec | null; openModal(m: ModalSpec): void; closeModal(): void;
  settings: SettingsSpec; openSettings(s: SettingsSpec): void;
  menu: { x: number; y: number; items: MenuItem[]; t: number } | null; openMenu(x: number, y: number, items: MenuItem[]): void; closeMenu(): void;
  popout: Popout; openPopout(p: Popout): void; closePopout(): void;
  toasts: Toast[]; toast(text: string, kind?: Toast['kind']): void; dismissToast(id: number): void;
  switcher: boolean; setSwitcher(v: boolean): void;
  replyTo: Record<Id, Id | null>; setReply(channelId: Id, mid: Id | null): void;
  editing: Id | null; setEditing(id: Id | null): void;
  lastChannel: Record<Id, Id>; setLastChannel(guildId: Id, channelId: Id): void;
  drafts: Record<Id, string>; setDraft(channelId: Id, v: string): void;
  searchQuery: string; setSearchQuery(q: string): void;
  threadOpen: Id | null; openThread(id: Id | null): void;
  mobileTab: 'servers' | 'dms' | 'friends' | 'you'; setMobileTab(t: UIState['mobileTab']): void;
}

const KEY = 'jorcord.prefs.v1';
const loadPrefs = (): Prefs => { try { return { ...defaultPrefs, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return defaultPrefs; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } };
let tid = 1;

export const useUI = create<UIState>((set, get) => ({
  prefs: loadPrefs(),
  setPref: (k, v) => set((s) => { const prefs = { ...s.prefs, [k]: v }; savePrefs(prefs); return { prefs }; }),
  leftDrawer: false, rightDrawer: false, setLeftDrawer: (leftDrawer) => set({ leftDrawer }), setRightDrawer: (rightDrawer) => set({ rightDrawer }),
  panel: 'members', setPanel: (panel) => set({ panel }), togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  modal: null, openModal: (modal) => set({ modal, menu: null, popout: null }), closeModal: () => set({ modal: null }),
  settings: null, openSettings: (settings) => set({ settings, menu: null, popout: null, leftDrawer: false }),
  menu: null, openMenu: (x, y, items) => set({ menu: { x, y, items, t: Date.now() }, popout: null }), closeMenu: () => set({ menu: null }),
  popout: null, openPopout: (popout) => set({ popout, menu: null }), closePopout: () => set({ popout: null }),
  toasts: [],
  toast: (text, kind = 'info') => { const id = tid++; set((s) => ({ toasts: [...s.toasts, { id, kind, text }] })); setTimeout(() => get().dismissToast(id), 4500); },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  switcher: false, setSwitcher: (switcher) => set({ switcher }),
  replyTo: {}, setReply: (c, m) => set((s) => ({ replyTo: { ...s.replyTo, [c]: m } })),
  editing: null, setEditing: (editing) => set({ editing }),
  lastChannel: (() => { try { return JSON.parse(localStorage.getItem('jorcord.last') ?? '{}'); } catch { return {}; } })(),
  setLastChannel: (g, c) => set((s) => { const lastChannel = { ...s.lastChannel, [g]: c }; try { localStorage.setItem('jorcord.last', JSON.stringify(lastChannel)); } catch { /* */ } return { lastChannel }; }),
  drafts: {}, setDraft: (c, v) => set((s) => ({ drafts: { ...s.drafts, [c]: v } })),
  searchQuery: '', setSearchQuery: (searchQuery) => set({ searchQuery }),
  threadOpen: null, openThread: (threadOpen) => set({ threadOpen }),
  mobileTab: 'servers', setMobileTab: (mobileTab) => set({ mobileTab }),
}));

export const toast = (text: string, kind: Toast['kind'] = 'info') => useUI.getState().toast(text, kind);
export const errorText = (e: unknown): string => {
  const x = e as { message?: string; errors?: Record<string, { _errors?: { message?: string }[] }> } | undefined;
  const field = x?.errors ? Object.entries(x.errors).map(([k, v]) => (v?._errors?.[0]?.message ? `${k}: ${v._errors[0].message}` : '')).find(Boolean) : '';
  return field || x?.message || 'Something went wrong';
};
export const toastError = (e: unknown) => useUI.getState().toast(errorText(e), 'error');
