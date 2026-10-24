/**
 * OS / browser permission handling, shared by voice, voice messages, QR scan, notifications and Settings > Permissions.
 * Rules: nothing here runs at startup; a permission is only requested from `requestPermission()` (called after the
 * just-in-time explainer, on the user action that needs it). See docs/PERMISSIONS.md.
 */
import { capPlugin, isCapacitor, isTauri, nativePlatform } from './server';
import { invokeFn } from './secureStore';
import { t } from '@/i18n';

export type PermKind = 'microphone' | 'camera' | 'screen' | 'notifications' | 'clipboard';
export const PERM_KINDS: PermKind[] = ['microphone', 'camera', 'screen', 'notifications', 'clipboard'];
/** granted / denied (blocked) / prompt (will ask) / unknown (cannot be queried here) / unsupported (no such API or device). */
export type PermState = 'granted' | 'denied' | 'prompt' | 'unknown' | 'unsupported';
/** Why a capture request failed. */
export type MediaFailure = 'denied' | 'no-device' | 'busy' | 'insecure' | 'unsupported' | 'constraints' | 'cancelled' | 'other';

export type Os = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown';
export type Browser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
export interface Env { shell: 'web' | 'tauri' | 'capacitor'; os: Os; browser: Browser }

export function detectEnv(): Env {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const np = nativePlatform();
  const os: Os = np === 'ios' || /iPhone|iPad|iPod/i.test(ua) ? 'ios' : np === 'android' || /Android/i.test(ua) ? 'android' : /Mac OS X|Macintosh/i.test(ua) ? 'macos' : /Windows/i.test(ua) ? 'windows' : /Linux|X11/i.test(ua) ? 'linux' : 'unknown';
  const browser: Browser = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\/|CriOS\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  return { shell: isTauri() ? 'tauri' : isCapacitor() ? 'capacitor' : 'web', os, browser };
}

/* ------------------------------------------------------------------ errors */

/** NotAllowedError => denied, NotFoundError => no device, NotReadableError => busy, and so on. */
export function classifyMediaError(err: unknown): MediaFailure {
  const name = (err as { name?: string } | null)?.name;
  const msg = String((err as { message?: string } | null)?.message ?? '');
  if (typeof window !== 'undefined' && (window as { isSecureContext?: boolean }).isSecureContext === false) return 'insecure';
  switch (name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      return /dismiss/i.test(msg) ? 'cancelled' : 'denied'; // Chrome: "Permission dismissed" (closed the prompt) vs "Permission denied"
    case 'NotFoundError': case 'DevicesNotFoundError': return 'no-device';
    case 'NotReadableError': case 'TrackStartError': case 'AbortError': return 'busy';
    case 'OverconstrainedError': case 'ConstraintNotSatisfiedError': return 'constraints';
    case 'TypeError': return /mediaDevices|getUserMedia|getDisplayMedia/i.test(msg) ? 'unsupported' : 'other';
    case 'NotSupportedError': return 'unsupported';
  }
  return 'other';
}

/** Map the @jorcord/voice error codes onto the same failure kinds. */
export function failureFromVoiceCode(code: string | undefined): MediaFailure | null {
  const m: Record<string, MediaFailure> = { 'permission-denied': 'denied', 'no-device': 'no-device', 'device-busy': 'busy', 'insecure-context': 'insecure', constraints: 'constraints', unsupported: 'unsupported' };
  return (code && m[code]) || null;
}

const KIND_LABEL: Record<PermKind, string> = { microphone: 'microphone', camera: 'camera', screen: 'screen sharing', notifications: 'notifications', clipboard: 'clipboard' };
export const kindTitle = (k: PermKind) => t(({ microphone: 'Microphone', camera: 'Camera', screen: 'Screen sharing', notifications: 'Notifications', clipboard: 'Clipboard' } as const)[k]);

/** One user-facing sentence per failure. Denied / missing device / busy device read differently on purpose. */
export function failureMessage(kind: PermKind, f: MediaFailure): string {
  const what = t(KIND_LABEL[kind]);
  switch (f) {
    case 'denied': return t('Access to the {what} is blocked. Jorcord cannot ask again until you allow it in your settings.', { what });
    case 'no-device': return kind === 'camera' ? t('No camera was found. Plug one in or enable it, then try again.') : t('No microphone was found. Plug one in or enable it, then try again.');
    case 'busy': return t('The {what} could not be started. It may be in use by another app or browser tab. Close it and try again.', { what });
    case 'insecure': return t('The {what} only works on https:// pages or localhost.', { what });
    case 'unsupported': return t('This browser or device does not support the {what} here.', { what });
    case 'constraints': return t('The {what} does not support the requested settings.', { what });
    case 'cancelled': return t('The request for the {what} was dismissed. Try again when you are ready.', { what });
    default: return t('Could not use the {what}. Try again.', { what });
  }
}

/* ------------------------------------------------------------------ explainer copy */

export function explainer(kind: PermKind): { title: string; body: string } {
  switch (kind) {
    case 'microphone': return { title: t('Allow microphone access'), body: t('Jorcord needs your microphone so other people in the call can hear you, and to record voice messages. Audio is only captured while you are in a call or recording, and only the microphone you pick in Voice settings is used. Your browser or device will ask next.') };
    case 'camera': return { title: t('Allow camera access'), body: t('Jorcord needs your camera to show your video in a call or to scan a QR code that logs in another device. It stays off until you turn it on. Your browser or device will ask next.') };
    case 'screen': return { title: t('Share your screen'), body: t('You are about to share your screen or a window with everyone in this call. You will choose exactly what to share next, and you can stop at any time. Nothing is shared until you confirm.') };
    case 'notifications': return { title: t('Allow notifications'), body: t('Jorcord can notify you about mentions, direct messages and incoming calls when the app is in the background. You can mute servers and channels at any time. Your browser or device will ask next.') };
    case 'clipboard': return { title: t('Allow clipboard access'), body: t('Jorcord reads your clipboard only when you choose to paste (for example an invite link or a code). Your browser will ask next.') };
  }
}

/* ------------------------------------------------------------------ fix steps / deep links */

/** How to unblock `kind` on this platform. */
export function fixSteps(kind: PermKind, env: Env = detectEnv()): string[] {
  const what = t(KIND_LABEL[kind]);
  if (env.shell === 'capacitor') {
    return env.os === 'ios'
      ? [t('Open the Settings app and tap Jorcord.'), t('Turn on {what}.', { what: kind === 'notifications' ? t('Notifications (Allow Notifications)') : kindTitle(kind) }), t('Come back to Jorcord and press Retry.')]
      : [t('Open Android Settings > Apps > Jorcord > Permissions{n}.', { n: kind === 'notifications' ? ` (${t('Notifications')})` : '' }), t('Set {what} to Allow (or Allow only while using the app).', { what: kindTitle(kind) }), t('Come back to Jorcord and press Retry.')];
  }
  if (env.shell === 'tauri') {
    if (env.os === 'macos') {
      const pane = kind === 'microphone' ? 'Microphone' : kind === 'camera' ? 'Camera' : kind === 'screen' ? 'Screen & System Audio Recording' : 'Notifications';
      return [t('Open System Settings > Privacy & Security > {pane}.', { pane: kind === 'notifications' ? t('Notifications') : pane }), t('Turn on Jorcord in the list.'), t('macOS may ask you to quit and reopen Jorcord. Then press Retry.')];
    }
    if (env.os === 'windows') {
      const pane = kind === 'microphone' ? 'Microphone' : kind === 'camera' ? 'Camera' : kind === 'notifications' ? 'Notifications' : 'Privacy';
      return [t('Open Windows Settings > Privacy & security > {pane}.', { pane }), kind === 'notifications' ? t('Turn on notifications for Jorcord.') : t('Turn on access for apps, including desktop apps, and make sure Jorcord is allowed.'), t('Press Retry.')];
    }
    return [t('Check your system sound/privacy settings (and the desktop portal on Wayland) allow Jorcord to use the {what}.', { what }), t('Make sure no other app is holding the device, then press Retry.')];
  }
  switch (env.browser) {
    case 'firefox': return [t('Click the permissions icon (or lock) at the left of the address bar.'), t('Remove the blocked {what} permission for this site.', { what }), t('Reload the page and press Retry; Firefox asks again.')];
    case 'safari': return env.os === 'ios'
      ? [t('Open Settings > Safari > {what}.', { what: kindTitle(kind) }), t('Set it to Ask or Allow for this website.'), t('Reload the page and press Retry.')]
      : [t('In the menu bar choose Safari > Settings for This Website.'), t('Set {what} to Ask or Allow.', { what: kindTitle(kind) }), t('Reload the page and press Retry.')];
    default: return [t('Click the lock or tune icon at the left of the address bar to open Site settings.'), t('Set {what} to Allow.', { what: kindTitle(kind) }), t('Reload the page if the browser asks, then press Retry.')];
  }
}

/** OS settings URL we can open from a Tauri build (null when the platform has no deep link for it). */
export function settingsDeepLink(kind: PermKind, env: Env = detectEnv()): string | null {
  if (env.shell !== 'tauri') return null;
  if (env.os === 'macos') {
    const pane = { microphone: 'Privacy_Microphone', camera: 'Privacy_Camera', screen: 'Privacy_ScreenCapture', notifications: '', clipboard: '' }[kind];
    return kind === 'notifications' ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension' : pane ? `x-apple.systempreferences:com.apple.preference.security?${pane}` : null;
  }
  if (env.os === 'windows') return ({ microphone: 'ms-settings:privacy-microphone', camera: 'ms-settings:privacy-webcam', notifications: 'ms-settings:notifications', screen: null, clipboard: null } as const)[kind];
  return null;
}

/** True when the "Open settings" button can do something on this platform. */
export function canOpenSettings(kind: PermKind, env: Env = detectEnv()): boolean {
  return env.shell === 'capacitor' || settingsDeepLink(kind, env) !== null;
}

/** Open the OS settings page for `kind`. Resolves false when the platform cannot (the caller shows the written steps). */
export async function openSystemSettings(kind: PermKind, env: Env = detectEnv()): Promise<boolean> {
  try {
    if (env.shell === 'capacitor') {
      const p = env.os === 'ios' ? capPlugin('JorcordScreenShare') : capPlugin('CallService');
      if (!p?.openAppSettings) return false;
      await p.openAppSettings(); return true;
    }
    const url = settingsDeepLink(kind, env); if (!url) return false;
    const tauri = (window as { __TAURI__?: { opener?: { openUrl?: (u: string) => Promise<void> } } }).__TAURI__;
    if (tauri?.opener?.openUrl) { await tauri.opener.openUrl(url); return true; }
    const inv = invokeFn(); if (!inv) return false;
    await inv('plugin:opener|open_url', { url }); return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ querying state */

const queryName = (kind: PermKind): string | null => ({ microphone: 'microphone', camera: 'camera', notifications: 'notifications', clipboard: 'clipboard-read', screen: null })[kind];
const fromBrowser = (s: string | undefined): PermState => (s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : s === 'prompt' || s === 'default' ? 'prompt' : 'unknown');
const fromCap = (s: string | undefined): PermState => (s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : s === 'prompt' || s === 'prompt-with-rationale' ? 'prompt' : 'unknown');

/** Safari/Firefox cannot query some names (it throws): treat that as "unknown", never as an error. */
async function browserQuery(name: string): Promise<PermState> {
  try {
    const p = await navigator.permissions?.query?.({ name: name as PermissionName });
    return p ? fromBrowser(p.state) : 'unknown';
  } catch { return 'unknown'; }
}

/** When the Permissions API cannot say: device labels are only visible after mic/camera access was granted. */
async function labelHint(kind: 'microphone' | 'camera'): Promise<PermState> {
  try {
    const list = await navigator.mediaDevices?.enumerateDevices?.();
    if (!list) return 'unknown';
    const type = kind === 'microphone' ? 'audioinput' : 'videoinput';
    const mine = list.filter((d) => d.kind === type);
    if (!mine.length) return 'unknown';
    return mine.some((d) => d.label) ? 'granted' : 'unknown';
  } catch { return 'unknown'; }
}

/** The current state of a permission. Never prompts. */
export async function queryPermission(kind: PermKind): Promise<PermState> {
  const env = detectEnv();
  if (kind === 'screen') {
    if (env.shell === 'capacitor') return capPlugin('JorcordScreenShare') ? 'prompt' : 'unsupported'; // the system asks every time
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? (env.shell === 'tauri' && env.os === 'macos' ? 'unknown' : 'prompt') : 'unsupported';
  }
  if (kind === 'microphone' || kind === 'camera') {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return env.shell === 'capacitor' ? 'unknown' : 'unsupported';
    if (env.os === 'android' && env.shell === 'capacitor') {
      try { const r = await capPlugin('CallService')?.checkPermissions?.(); if (r?.[kind]) return fromCap(r[kind]); } catch { /* fall back to the web API */ }
    }
    const s = await browserQuery(kind);
    return s === 'unknown' ? labelHint(kind) : s;
  }
  if (kind === 'notifications') {
    if (env.shell === 'capacitor') {
      const P = capPlugin('PushNotifications');
      if (P?.checkPermissions) { try { return fromCap((await P.checkPermissions())?.receive); } catch { return 'unknown'; } }
      return 'unsupported';
    }
    if (typeof Notification === 'undefined') return 'unsupported';
    return fromBrowser(Notification.permission);
  }
  // clipboard: writing needs no permission (user gesture); reading is Chromium-only and prompts
  if (env.shell === 'tauri') return 'granted';
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return 'unsupported';
  return browserQuery(queryName('clipboard')!);
}

/**
 * Subscribe to live changes (user flips the site setting while the page is open). Uses navigator.permissions `onchange`;
 * browsers that cannot query a name get a light re-check when the tab becomes visible/focused again.
 */
export function watchPermission(kind: PermKind, cb: (s: PermState) => void): () => void {
  let dead = false;
  const refresh = () => { void queryPermission(kind).then((s) => { if (!dead) cb(s); }); };
  const cleanups: (() => void)[] = [];
  const name = queryName(kind);
  if (name && typeof navigator !== 'undefined' && navigator.permissions?.query) {
    try {
      void navigator.permissions.query({ name: name as PermissionName }).then((status) => {
        if (dead) return;
        const h = () => refresh();
        status.addEventListener('change', h);
        cleanups.push(() => { status.removeEventListener('change', h); });
      }).catch(() => {});
    } catch { /* Safari/Firefox: unknown name */ }
  }
  // Native settings and unsupported queries: re-check when the user comes back from the OS settings app.
  if (typeof document !== 'undefined') {
    const vis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', vis); window.addEventListener('focus', refresh);
    cleanups.push(() => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('focus', refresh); });
  }
  return () => { dead = true; cleanups.forEach((f) => f()); };
}

/* ------------------------------------------------------------------ requesting */

export interface RequestResult { ok: boolean; state: PermState; failure?: MediaFailure; error?: unknown }

async function probeMedia(kind: 'microphone' | 'camera'): Promise<RequestResult> {
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, state: 'unsupported', failure: window.isSecureContext === false ? 'insecure' : 'unsupported' };
  try {
    const s = await navigator.mediaDevices.getUserMedia(kind === 'microphone' ? { audio: true } : { video: true });
    s.getTracks().forEach((x) => x.stop()); // we only wanted the grant; the real capture opens its own stream
    return { ok: true, state: 'granted' };
  } catch (error) {
    const failure = classifyMediaError(error);
    return { ok: false, state: failure === 'denied' ? 'denied' : 'prompt', failure, error };
  }
}

/**
 * Trigger the real browser / OS prompt. Call this only from a user action (after the explainer).
 * Screen sharing cannot be pre-granted: the picker itself is the prompt, so this resolves ok and the caller starts the share.
 */
export async function requestPermission(kind: PermKind): Promise<RequestResult> {
  const env = detectEnv();
  try {
    if (kind === 'screen') return { ok: true, state: await queryPermission('screen') };
    if (kind === 'microphone' || kind === 'camera') {
      if (env.shell === 'capacitor' && env.os === 'android') {
        const P = capPlugin('CallService');
        if (P?.requestPermissions) {
          try { const r = await P.requestPermissions({ permissions: [kind] }); if (r?.[kind] === 'denied') return { ok: false, state: 'denied', failure: 'denied' }; } catch { /* the WebView prompt below still runs */ }
        }
      }
      return await probeMedia(kind);
    }
    if (kind === 'notifications') {
      if (env.shell === 'capacitor') {
        const P = capPlugin('PushNotifications');
        if (!P?.requestPermissions) return { ok: false, state: 'unsupported', failure: 'unsupported' };
        const state = fromCap((await P.requestPermissions())?.receive);
        return { ok: state === 'granted', state, failure: state === 'granted' ? undefined : 'denied' };
      }
      if (typeof Notification === 'undefined') return { ok: false, state: 'unsupported', failure: 'unsupported' };
      const state = fromBrowser(await Notification.requestPermission());
      return { ok: state === 'granted', state, failure: state === 'granted' ? undefined : state === 'denied' ? 'denied' : 'cancelled' };
    }
    if (env.shell === 'tauri') return { ok: true, state: 'granted' };
    if (!navigator.clipboard?.readText) return { ok: false, state: 'unsupported', failure: 'unsupported' };
    await navigator.clipboard.readText();
    return { ok: true, state: 'granted' };
  } catch (error) {
    const failure = classifyMediaError(error);
    return { ok: false, state: failure === 'denied' ? 'denied' : 'unknown', failure, error };
  }
}
