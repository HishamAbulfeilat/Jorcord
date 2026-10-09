/**
 * Push registration.
 *  - Browser / desktop webview: Web Push (service worker + VAPID key from GET /push/vapid-public-key).
 *  - Capacitor: native FCM/APNs token via the PushNotifications plugin.
 * The device row is created with POST /users/@me/push-devices and removed on logout / when the user turns push off.
 */
import { api, type PushRegistration } from './api';
import { capPlugin, isCapacitor, isNative, isTauri, nativePlatform } from './server';
import { useUI } from '@/stores/ui';

const KEY = 'jorcord.push.v1';
export interface PushState { enabled: boolean; kind: 'web' | 'native'; ref: string }
export const loadPushState = (): PushState | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
const savePushState = (s: PushState | null) => { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* */ } };

export type PushSupport = { kind: 'native' | 'web'; platform: 'web' | 'desktop' | 'android' | 'ios' } | { kind: 'none'; reason: string };
export function pushSupport(): PushSupport {
  if (isCapacitor()) return capPlugin('PushNotifications') ? { kind: 'native', platform: nativePlatform() === 'ios' ? 'ios' : 'android' } : { kind: 'none', reason: 'Push notifications are not built into this app.' };
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && typeof Notification !== 'undefined') {
    // Wrappers register no service worker (docs/WRAPPER_WEB_NEEDS.md section 7), so desktop falls back to the Notification API.
    if (isTauri()) return { kind: 'none', reason: 'Desktop notifications use the system notification API while the app is running.' };
    return { kind: 'web', platform: 'web' };
  }
  return { kind: 'none', reason: 'This browser does not support push notifications.' };
}

export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function swRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The service worker is not ready yet. Reload the page and try again.')), 8000))]);
  return reg;
}

export type PushResult = { ok: true } | { ok: false; reason: string };

async function enableWeb(): Promise<PushResult> {
  if (Notification.permission === 'denied') return { ok: false, reason: 'Notifications are blocked in your browser settings.' };
  if (Notification.permission !== 'granted') { const r = await Notification.requestPermission(); if (r !== 'granted') return { ok: false, reason: 'Permission was not granted.' }; }
  const { publicKey } = await api.push.vapidKey();
  if (!publicKey) return { ok: false, reason: 'This server has no push key configured.' };
  const reg = await swRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource });
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) return { ok: false, reason: 'The browser returned an incomplete subscription.' };
  await api.push.register({ platform: 'web', subscription: { endpoint: j.endpoint, expirationTime: j.expirationTime ?? null, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } } });
  savePushState({ enabled: true, kind: 'web', ref: j.endpoint });
  return { ok: true };
}

let nativeListening = false;
async function enableNative(platform: 'android' | 'ios'): Promise<PushResult> {
  const P = capPlugin('PushNotifications'); if (!P) return { ok: false, reason: 'Push notifications are not available in this app build.' };
  const perm = await P.requestPermissions(); if (perm?.receive !== 'granted') return { ok: false, reason: 'Notification permission was not granted.' };
  if (!nativeListening) {
    nativeListening = true;
    await P.addListener('registration', (t: { value: string }) => { void api.push.register({ platform, token: t.value }).then(() => savePushState({ enabled: true, kind: 'native', ref: t.value })).catch(() => {}); });
    await P.addListener('registrationError', () => useUI.getState().toast('Could not register for push notifications.', 'error'));
    await P.addListener('pushNotificationReceived', (n: any) => { useUI.getState().toast(`${n?.title ?? 'Jorcord'}${n?.body ? ': ' + n.body : ''}`, 'info'); });
    await P.addListener('pushNotificationActionPerformed', (a: any) => {
      const d = a?.notification?.data ?? {};
      if (d.channelId) window.dispatchEvent(new CustomEvent('jorcord:goto', { detail: { guildId: d.guildId || null, channelId: d.channelId } }));
    });
  }
  await P.register();
  return { ok: true };
}

export async function enablePush(): Promise<PushResult> {
  const sup = pushSupport();
  try {
    if (sup.kind === 'none') return { ok: false, reason: sup.reason };
    return sup.kind === 'native' ? await enableNative(sup.platform as 'android' | 'ios') : await enableWeb();
  } catch (e) { return { ok: false, reason: (e as Error).message || 'Could not enable push notifications.' }; }
}

/** Forget this device on the server and stop the local subscription. */
export async function disablePush(opts: { keepSubscription?: boolean } = {}) {
  const st = loadPushState();
  try {
    if (st?.kind === 'web') {
      await api.push.unregister({ endpoint: st.ref }).catch(() => {});
      if (!opts.keepSubscription) { const reg = await navigator.serviceWorker.getRegistration(); await (await reg?.pushManager.getSubscription())?.unsubscribe(); }
    } else if (st?.kind === 'native') {
      await api.push.unregister({ token: st.ref, platform: nativePlatform() === 'ios' ? 'ios' : 'android' }).catch(() => {});
      await capPlugin('PushNotifications')?.unregister?.().catch?.(() => {});
    }
  } finally { savePushState(null); }
}

/** After login: re-register a device that had push enabled (tokens rotate, accounts change). Never prompts. */
export async function syncPush() {
  const st = loadPushState(); if (!st?.enabled) return;
  const sup = pushSupport(); if (sup.kind === 'none') return;
  if (sup.kind === 'web' && (typeof Notification === 'undefined' || Notification.permission !== 'granted')) return;
  await enablePush();
}

export async function currentWebSubscriptionEndpoint(): Promise<string | null> {
  try { const reg = await navigator.serviceWorker.getRegistration(); return (await reg?.pushManager.getSubscription())?.endpoint ?? null; } catch { return null; }
}
export type { PushRegistration };
void isNative;
