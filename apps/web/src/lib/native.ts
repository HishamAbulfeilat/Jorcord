/**
 * Glue for the Tauri (desktop) and Capacitor (mobile) wrappers. Everything is feature-detected and a no-op in a plain browser.
 * Capacitor plugins are reached through the native bridge (`Capacitor.Plugins.*`) so this bundle needs no @capacitor/* dependency.
 */
import { capPlugin, getServerUrl, isCapacitor, isTauri, nativePlatform } from './server';
import { invokeFn, secureStore } from './secureStore';
export { secureStore };
import { parseDeepLink, routeFor, type DeepLink } from './deeplink';
import { normalizeServerUrl } from './server';
import { switchServer } from './serverSwitch';
import { useUI } from '@/stores/ui';

const tauri = (): any => (window as any).__TAURI__;

/** A game the desktop app can recognise: a display name plus the executable names that mean it is running. */
export interface GameExecutable { name: string; executables: string[] }
/** A catalog or user game that is currently running. */
export interface DetectedGame { name: string; executable: string }
/** Result of a desktop detection pass: running games plus every running process name (for the "add a game" picker). */
export interface RunningGames { games: DetectedGame[]; processes: string[] }

/** Navigate for a deep link, switching server first when the link names another one. Returns the route. */
export function applyDeepLink(link: DeepLink, navigate: (to: string) => void): string {
  const server = link.server ? normalizeServerUrl(link.server) : null;
  if (server && server !== getServerUrl() && (isCapacitor() || isTauri() || getServerUrl())) switchServer(server);
  const route = routeFor(link);
  navigate(route);
  return route;
}

/** Android hardware back: close the topmost transient UI, otherwise go back, otherwise let the OS exit. Returns true when handled. */
export function handleBack(ctx: { canGoBack: boolean; goBack: () => void; exit: () => void }): boolean {
  const s = useUI.getState();
  if (s.menu) { s.closeMenu(); return true; }
  if (s.popout) { s.closePopout(); return true; }
  if (s.modal) { s.closeModal(); return true; }
  if (s.settings) { s.openSettings(null); return true; }
  if (s.switcher) { s.setSwitcher(false); return true; }
  if (s.leftDrawer) { s.setLeftDrawer(false); return true; }
  if (s.rightDrawer) { s.setRightDrawer(false); return true; }
  if (s.panel && s.panel !== 'members') { s.setPanel(null); return true; }
  if (ctx.canGoBack) { ctx.goBack(); return true; }
  ctx.exit(); return true;
}

export const STATUS_BAR_COLORS = { dark: '#1e1f22', light: '#e3e5e8', amoled: '#000000' } as const;
export function syncStatusBar(theme: keyof typeof STATUS_BAR_COLORS) {
  const bar = capPlugin('StatusBar'); if (!bar) return;
  try { bar.setStyle?.({ style: theme === 'light' ? 'LIGHT' : 'DARK' }); if (nativePlatform() === 'android') bar.setBackgroundColor?.({ color: STATUS_BAR_COLORS[theme] }); } catch { /* */ }
}

/** Unread badge on the dock/taskbar icon (Tauri) or the PWA app badge. */
export function setBadgeCount(n: number) {
  try {
    if (isTauri()) {
      const win = tauri().window?.getCurrentWindow?.() ?? tauri().webviewWindow?.getCurrentWebviewWindow?.();
      void win?.setBadgeCount?.(n > 0 ? n : undefined);
    } else if ('setAppBadge' in navigator) { void (n > 0 ? (navigator as any).setAppBadge(n) : (navigator as any).clearAppBadge()); }
  } catch { /* */ }
}

export function haptic(kind: 'light' | 'medium' = 'light') {
  try { capPlugin('Haptics')?.impact?.({ style: kind === 'light' ? 'LIGHT' : 'MEDIUM' }); } catch { /* */ }
}

/** Keep Android's foreground service alive while in a call (custom CallService plugin, apps/mobile/android). */
export const callService = {
  start(title: string, camera: boolean) { try { void capPlugin('CallService')?.start?.({ title, camera }); } catch { /* */ } },
  stop() { try { void capPlugin('CallService')?.stop?.(); } catch { /* */ } },
};

/** Desktop-only helpers behind the settings page. Every call is a no-op outside Tauri (plain web / PWA). */
export const desktop = {
  available: () => isTauri(),
  async autostart(): Promise<boolean | null> { if (!isTauri()) return null; try { return (await tauri().autostart?.isEnabled?.()) ?? null; } catch { return null; } },
  async setAutostart(on: boolean) { if (!isTauri()) return; const a = tauri().autostart; if (!a) throw new Error('Launch at login is unavailable'); await (on ? a.enable() : a.disable()); },
  async checkUpdate(): Promise<{ version: string; install: () => Promise<void> } | null> {
    if (!isTauri()) return null;
    const u = tauri().updater; if (!u?.check) throw new Error('Updater is unavailable');
    const up = await u.check(); if (!up) return null;
    return { version: up.version, install: async () => { await up.downloadAndInstall(); await tauri().process?.relaunch?.(); } };
  },
  /** Scan running processes for detectable games. No-op outside Tauri (returns empty). */
  async listRunningGames(userGames: GameExecutable[]): Promise<RunningGames> {
    if (!isTauri()) return { games: [], processes: [] };
    const t = tauri();
    const invoke = t.core?.invoke ?? t.invoke;
    if (typeof invoke !== 'function') return { games: [], processes: [] };
    return invoke('list_running_games', { userGames });
  },
};

/**
 * Clipboard: the native plugin on desktop (works without a user gesture and in webviews that block `navigator.clipboard`), the async clipboard API
 * in the browser. Both return false / null instead of throwing.
 */
export const clipboard = {
  async writeText(text: string): Promise<boolean> {
    if (isTauri()) { try { await tauri().clipboardManager?.writeText?.(text); if (tauri().clipboardManager?.writeText) return true; } catch { /* fall through to the web API */ } }
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  },
  async readText(): Promise<string | null> {
    if (isTauri()) { try { const v = await tauri().clipboardManager?.readText?.(); if (typeof v === 'string') return v; } catch { /* */ } }
    try { return await navigator.clipboard.readText(); } catch { return null; }
  },
};

/** Seconds since the last keyboard / mouse input system-wide (Windows, macOS), or null when the platform cannot say. */
export async function systemIdleSeconds(): Promise<number | null> {
  const inv = invokeFn(); if (!isTauri() || !inv) return null;
  try { const v = await inv('idle_seconds'); return typeof v === 'number' ? v : null; } catch { return null; }
}

/** Desktop wake-from-sleep notification (`jorcord://power`). Returns the unsubscribe. */
export function onPowerEvent(fn: (kind: 'resume') => void): () => void {
  if (!isTauri()) return () => {};
  let off: (() => void) | null = null; let dead = false;
  void Promise.resolve(tauri().event?.listen?.('jorcord://power', (e: { payload: unknown }) => { if (e.payload === 'resume') fn('resume'); }))
    .then((un: any) => { if (typeof un === 'function') { if (dead) un(); else off = un; } }).catch(() => {});
  return () => { dead = true; off?.(); };
}

let coldStartHandled = false;
/** Register every wrapper listener. Returns the cleanup. */
export function initNative(o: { navigate: (to: string) => void; canGoBack: () => boolean; goBack: () => void }): () => void {
  const offs: (() => void)[] = [];
  const onUrl = (url: string) => { const l = parseDeepLink(url); if (l) applyDeepLink(l, o.navigate); };
  if (isTauri()) {
    const t = tauri();
    void Promise.resolve(t.event?.listen?.('jorcord://open', (e: { payload: unknown }) => onUrl(String(e.payload)))).then((un: any) => { if (typeof un === 'function') offs.push(un); }).catch(() => {});
    if (!coldStartHandled) void Promise.resolve(t.deepLink?.getCurrent?.()).then((urls: string[] | null) => urls?.forEach(onUrl)).catch(() => {});
  }
  if (isCapacitor()) {
    const App = capPlugin('App');
    const add = (ev: string, fn: (d: any) => void) => { try { void Promise.resolve(App?.addListener?.(ev, fn)).then((h: any) => h?.remove && offs.push(() => h.remove())); } catch { /* */ } };
    add('appUrlOpen', (d: { url: string }) => onUrl(d.url));
    add('backButton', () => { handleBack({ canGoBack: o.canGoBack(), goBack: o.goBack, exit: () => { void App?.exitApp?.(); } }); });
    if (!coldStartHandled) void Promise.resolve(App?.getLaunchUrl?.()).then((r: { url?: string } | undefined) => r?.url && onUrl(r.url)).catch(() => {});
    // Keyboard plugin uses resize:'body'; keep the composer above it when the plugin reports a height.
    const kb = capPlugin('Keyboard');
    const setKb = (h: number) => document.documentElement.style.setProperty('--kb', `${h}px`);
    try { void Promise.resolve(kb?.addListener?.('keyboardWillShow', (i: { keyboardHeight: number }) => setKb(i.keyboardHeight))).then((h: any) => h?.remove && offs.push(() => h.remove())); } catch { /* */ }
    try { void Promise.resolve(kb?.addListener?.('keyboardWillHide', () => setKb(0))).then((h: any) => h?.remove && offs.push(() => h.remove())); } catch { /* */ }
  }
  coldStartHandled = true; // the launch URL belongs to this page load only
  // Web / PWA: the service worker posts notification clicks back to the open tab.
  const sw = (e: MessageEvent) => { if (e.data?.type === 'jorcord:goto') window.dispatchEvent(new CustomEvent('jorcord:goto', { detail: { guildId: e.data.guildId, channelId: e.data.channelId } })); };
  navigator.serviceWorker?.addEventListener?.('message', sw); offs.push(() => navigator.serviceWorker?.removeEventListener?.('message', sw));
  // visualViewport: on-screen keyboards shrink the visual viewport; expose it so the shell can follow it.
  const vv = window.visualViewport;
  if (vv && (isCapacitor() || isTauri() || /Android|iPhone|iPad/i.test(navigator.userAgent))) {
    const upd = () => { document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`); document.documentElement.dataset.vv = Math.abs(window.innerHeight - vv.height) > 80 ? 'kb' : ''; };
    vv.addEventListener('resize', upd); upd(); offs.push(() => vv.removeEventListener('resize', upd));
  }
  return () => offs.forEach((f) => f());
}
