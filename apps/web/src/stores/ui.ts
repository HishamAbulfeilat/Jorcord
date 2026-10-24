import { create } from 'zustand';
import type { Id, Message, Modal, ScheduledMessage } from '@jorcord/shared';
import type { CameraFrameRate, CameraQuality } from '@jorcord/voice';
import type { CameraBackground } from '@/voice/backgrounds';
import type { OverlayCorner } from '@/lib/overlay';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';

export type Theme = 'dark' | 'light' | 'amoled';
export interface Prefs {
  theme: Theme; density: 'cozy' | 'compact'; fontScale: number; reducedMotion: boolean; saturation: number;
  showEmbeds: boolean; autoplayGifs: boolean; twentyFourHour: boolean; language: string; highContrast: boolean;
  /** Accessibility: OpenDyslexic font, colour-blind safe status palette, clamp role colours to 4.5:1 contrast (saturation is above). */
  dyslexiaFont: boolean; colorBlindMode: 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia'; roleContrast: boolean;
  desktopNotifications: boolean; notificationSounds: boolean; /** Read /tts messages aloud (Web Speech API). Off by default. */ allowTtsPlayback: boolean; defaultNotify: 'all' | 'mentions' | 'none'; suppressEveryone: boolean;
  inputDevice: string; outputDevice: string; videoDevice: string; inputVolume: number; outputVolume: number;
  noiseSuppression: boolean; echoCancellation: boolean; autoGain: boolean; pushToTalk: boolean;
  noiseEngine: 'browser' | 'rnnoise' | 'high' | 'off'; voiceBitrate: number; musicMode: boolean; pttCode: string; pttGlobal: boolean; vadMode: boolean; vadThreshold: number;
  screenPreset: '720p30' | '1080p60' | '1440p60' | '4k60' | 'source'; cameraPreset: '720p30' | '1080p60' | '1440p60' | '4k60' | 'source'; screenHint: 'motion' | 'detail'; screenAudio: boolean; showVoiceStats: boolean;
  /** Camera capture: quality preset (auto steps 1080p -> 720p -> 480p) and requested frame rate. */
  videoQuality: CameraQuality; videoFps: CameraFrameRate;
  /** Local self-view only: mirror the preview, and opt-in canvas effects (both off by default except mirroring). */
  mirrorSelfView: boolean; cameraBlur: boolean; cameraAutoAdjust: boolean;
  /** Background effect applied to the PUBLISHED camera (person segmentation): 'none' | 'blur' | a preset backdrop id. */
  cameraBackground: CameraBackground;
  keybinds: Record<string, string>;
  streamerMode: boolean; streamerAuto: boolean; streamerHidePersonal: boolean; streamerHideInvites: boolean; streamerNoSounds: boolean; streamerNoNotifications: boolean;
  mutedChannels: Record<Id, boolean>; mutedGuilds: Record<Id, boolean>; collapsedCategories: Record<Id, boolean>;
  /** Soundboard: silence everything / one person's sounds (local), and playback gain 0-100. */
  /** "Hide Muted Channels" per server. */ hideMutedChannels: Record<Id, boolean>;
  /** Local listening volume (percent, 0-200) and local mute per person, applied to their mic and screen-share audio. Defaults omitted. */
  userVolumes: Record<Id, number>; userMuted: Record<Id, boolean>;
  /** Clip recorder: how much to keep (30/60/120 s) and whether to start the rolling buffer by itself when a stream starts (off: recording is opt-in). */
  clipWindow: 30 | 60 | 120; clipAutoBuffer: boolean;
  /** Live captions of my own speech (Web Speech API, local to this browser) and the recognition language ('' = browser language). */
  captions: boolean; captionsLang: string;
  /** Show a "you are muted" hint when the mic picks up speech while I am muted (the audio is only measured on this device). */
  mutedSpeakingHint: boolean;
  soundboardMuted: boolean; soundboardMutedUsers: Record<Id, boolean>; soundboardVolume: number;
  /** Desktop game detection: report "Playing <game>" and the games the user has registered. */
  gameActivity: boolean; registeredGames: RegisteredGame[];
  /** Desktop in-game overlay: a second always-on-top window mirroring the current voice call. */
  overlayEnabled: boolean; overlayLocked: boolean; overlayCorner: OverlayCorner;
  /** Go idle after this many minutes without input (0 = never). Only moves me from online to idle and back; DND and invisible are never touched. */
  idleMinutes: number;
  /** Link domains I chose to open without the external-link confirmation (synced with my account settings). */
  trustedLinkDomains: string[];
}
/** A game the user registered from the Running Games settings tab. */
export interface RegisteredGame { name: string; executables: string[] }
/** First-run language: the browser's, when we ship that translation. */
export function detectLanguage(): string {
  try {
    const l = (navigator.languages?.[0] ?? navigator.language ?? 'en-US');
    const base = l.toLowerCase().split('-')[0];
    return ({ es: 'es-ES', fr: 'fr-FR', de: 'de-DE', tr: 'tr-TR', ar: 'ar', pt: 'pt-BR', ru: 'ru-RU', hi: 'hi-IN', id: 'id-ID', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL' } as Record<string, string>)[base!] ?? 'en-US';
  } catch { return 'en-US'; }
}
export const defaultKeybinds: Record<string, string> = {
  quickSwitcher: 'Ctrl+K', markRead: 'Escape', prevChannel: 'Alt+ArrowUp', nextChannel: 'Alt+ArrowDown',
  prevServer: 'Ctrl+Alt+ArrowUp', nextServer: 'Ctrl+Alt+ArrowDown', toggleMembers: 'Ctrl+U', search: 'Ctrl+F', shortcuts: 'Ctrl+/', pushToTalk: 'Ctrl+`', toggleMute: 'Ctrl+Shift+M', toggleDeafen: 'Ctrl+Shift+D',
};
export const defaultPrefs: Prefs = {
  theme: 'dark', density: 'cozy', fontScale: 1, reducedMotion: false, saturation: 1, showEmbeds: true, autoplayGifs: true, twentyFourHour: false, language: detectLanguage(), highContrast: false, dyslexiaFont: false, colorBlindMode: 'off', roleContrast: false,
  desktopNotifications: false, notificationSounds: true, allowTtsPlayback: false, defaultNotify: 'mentions', suppressEveryone: false,
  inputDevice: 'default', outputDevice: 'default', videoDevice: 'default', inputVolume: 100, outputVolume: 100, noiseSuppression: true, echoCancellation: true, autoGain: true, pushToTalk: false,
  noiseEngine: 'browser', voiceBitrate: 64, musicMode: false, pttCode: 'Backquote', pttGlobal: false, vadMode: false, vadThreshold: 0.03,
  screenPreset: '1080p60', cameraPreset: '720p30', screenHint: 'motion', screenAudio: true, showVoiceStats: true,
  videoQuality: 'auto', videoFps: 30,
  mirrorSelfView: true, cameraBlur: false, cameraAutoAdjust: false, cameraBackground: 'none',
  keybinds: defaultKeybinds,
  streamerMode: false, streamerAuto: true, streamerHidePersonal: true, streamerHideInvites: true, streamerNoSounds: true, streamerNoNotifications: true,
  mutedChannels: {}, mutedGuilds: {}, collapsedCategories: {},
  hideMutedChannels: {}, userVolumes: {}, userMuted: {}, clipWindow: 30, clipAutoBuffer: false, captions: false, captionsLang: '', mutedSpeakingHint: true, soundboardMuted: false, soundboardMutedUsers: {}, soundboardVolume: 100,
  gameActivity: true, registeredGames: [],
  overlayEnabled: false, overlayLocked: false, overlayCorner: 'top-right',
  idleMinutes: 10, trustedLinkDomains: [],
};

export type RightPanel = 'members' | 'search' | 'pins' | 'threads' | 'reports' | null;
export type ModalSpec =
  | { kind: 'createServer' } | { kind: 'joinServer'; code?: string }
  | { kind: 'createChannel'; guildId: Id; parentId?: Id | null; type?: string } | { kind: 'createCategory'; guildId: Id }
  | { kind: 'invite'; guildId: Id; channelId?: Id } | { kind: 'profile'; userId: Id; guildId?: Id }
  | { kind: 'confirm'; title: string; body: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'image'; url: string; name?: string } | { kind: 'createThread'; channelId: Id; messageId: Id; suggested?: string }
  | { kind: 'newDm'; addTo?: Id } | { kind: 'groupDm'; channelId: Id } | { kind: 'voiceSettings' } | { kind: 'createForumPost'; channelId: Id } | { kind: 'shortcuts' } | { kind: 'clipPreview' } | { kind: 'clipsViewer'; channelId: Id }
  | { kind: 'channelSettings'; channelId: Id } | { kind: 'reactors'; channelId: Id; messageId: Id; emoji: string; emojiId: Id | null; burst?: boolean }
  | { kind: 'prompt'; title: string; label: string; initial?: string; onSubmit: (v: string) => void | Promise<void> }
  | { kind: 'leaveGuild'; guildId: Id }
  | { kind: 'customStatus' } | { kind: 'folder'; folderId: string } | { kind: 'notifSettings'; scope: 'guild' | 'channel'; id: Id }
  | { kind: 'onboarding'; guildId: Id; step?: 'welcome' | 'rules' } | { kind: 'streamerStart' }
  | { kind: 'interactionModal'; interactionId: Id; channelId: Id; modal: Modal }
  | { kind: 'createPoll'; channelId: Id } | { kind: 'pollVoters'; channelId: Id; messageId: Id; answerId?: number }
  | { kind: 'events'; guildId: Id } | { kind: 'eventEditor'; guildId: Id; eventId?: Id; channelId?: Id }
  | { kind: 'customize'; guildId: Id } | { kind: 'followChannel'; channelId: Id }| { kind: 'forward'; message: Message } | { kind: 'report'; messageId: Id; guildId: Id; channelId: Id } | { kind: 'removeMember'; mode: 'kick' | 'ban'; guildId: Id; userId: Id } | { kind: 'modNotice'; notice: import('@jorcord/shared').ModNotice } | { kind: 'modView'; guildId: Id; userId: Id } | { kind: 'inbox'; tab?: 'mentions' | 'digest' | 'saved' | 'reminders' | 'scheduled' } | { kind: 'safetyNumber'; channelId: Id } | { kind: 'screening'; guildId: Id } | { kind: 'threadSettings'; channelId: Id } | { kind: 'stage'; channelId: Id; mode: 'start' | 'edit' }
  | { kind: 'scheduleMessage'; channelId: Id; content: string; replyTo?: Id | null; files?: File[]; edit?: ScheduledMessage; onDone?: () => void }
  | { kind: 'externalLink'; url: string } | { kind: 'riskyFile'; url: string; filename: string; download: boolean }
  | { kind: 'gifPicker'; title?: string; onPick: (url: string) => void };
export type SettingsSpec = { kind: 'user'; tab?: string } | { kind: 'guild'; guildId: Id; tab?: string } | null;
export interface MenuItem { label?: string; icon?: any; onClick?: () => void; danger?: boolean; separator?: boolean; checked?: boolean; disabled?: boolean; hint?: string; children?: MenuItem[];
  /** Inline slider row (keyboard: Left/Right adjust, Up/Down leave). */
  slider?: { value: number; min: number; max: number; step?: number; label: string; format?: (v: number) => string; onChange: (v: number) => void } }
export interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }
export type Popout = { kind: 'user'; userId: Id; guildId?: Id; rect: DOMRect } | { kind: 'emoji'; rect: DOMRect; onPick: (e: { char?: string; name: string; id?: Id; animated?: boolean; gif?: string; sticker?: Id; burst?: boolean; burstColor?: string }) => void; guildId?: Id; stickers?: boolean; externalStickers?: boolean; allowBurst?: boolean; gifOnly?: boolean } | null;

interface UIState {
  prefs: Prefs; setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void;
  /** Merge the account's saved preferences (PATCH /users/@me settings) after login, newest wins. */
  hydrateFromServer(settings: Record<string, unknown> | undefined): void;
  leftDrawer: boolean; rightDrawer: boolean; setLeftDrawer(v: boolean): void; setRightDrawer(v: boolean): void;
  panel: RightPanel; setPanel(p: RightPanel): void; togglePanel(p: Exclude<RightPanel, null>): void;
  reportGuildId: Id | null; openReports(guildId: Id): void; closeReports(): void;
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
const UPDATED_KEY = 'jorcord.prefs.v1.updated';
const loadPrefs = (): Prefs => { try { return { ...defaultPrefs, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return defaultPrefs; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } };
const loadUpdated = () => { try { return Number(localStorage.getItem(UPDATED_KEY)) || 0; } catch { return 0; } };
const saveUpdated = (at: number) => { try { localStorage.setItem(UPDATED_KEY, String(at)); } catch { /* private mode */ } };
let tid = 1;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Settings follow the account: every preference change is written to `users.settings.prefs`
 * through the existing `PATCH /users/@me` endpoint (debounced like the rail layout), so the
 * switches in Appearance / Accessibility / Notifications / Streamer Mode / Keybinds / Language
 * are not lost when the account is opened on another device.
 */
function persistPrefs(prefs: Prefs, updatedAt: number) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const me = useData.getState().me; if (!me) return;
    const settings = { ...(me.settings ?? {}), prefs, prefsUpdatedAt: updatedAt };
    try {
      const patchMe = api?.users?.patchMe; if (!patchMe) return;
      void Promise.resolve(patchMe({ settings }))
        .then((u) => { const cur = useData.getState().me; if (cur) useData.getState().setMe({ ...cur, settings: u?.settings ?? settings }); })
        .catch(() => { /* offline: localStorage still has it */ });
    } catch { /* transport unavailable (e.g. demo/tests without a server) */ }
  }, 300);
}

export const useUI = create<UIState>((set, get) => ({
  prefs: loadPrefs(),
  setPref: (k, v) => {
    const prefs = { ...get().prefs, [k]: v }; const updatedAt = Date.now();
    savePrefs(prefs); saveUpdated(updatedAt); set({ prefs });
    persistPrefs(prefs, updatedAt);
  },
  hydrateFromServer(settings) {
    const remote = (settings as any)?.prefs as Partial<Prefs> | undefined;
    const updatedAt = Number((settings as any)?.prefsUpdatedAt) || 0;
    if (!remote || typeof remote !== 'object' || updatedAt <= loadUpdated()) return;
    const prefs = { ...defaultPrefs, ...remote };
    savePrefs(prefs); saveUpdated(updatedAt); set({ prefs });
  },
  leftDrawer: false, rightDrawer: false, setLeftDrawer: (leftDrawer) => set({ leftDrawer }), setRightDrawer: (rightDrawer) => set({ rightDrawer }),
  panel: 'members', setPanel: (panel) => set({ panel }), togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  reportGuildId: null, openReports: (guildId: Id) => set({ panel: 'reports', reportGuildId: guildId }), closeReports: () => set({ panel: null as any, reportGuildId: null }),
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
