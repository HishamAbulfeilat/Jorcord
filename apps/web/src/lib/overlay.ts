/**
 * Desktop in-game overlay glue.
 *
 * The overlay is a second, always-on-top Tauri window that shows who is in the current voice
 * channel. It is a window overlay only — no game process is ever touched. Everything here is
 * feature-detected and a no-op in a plain browser, so importing it is always safe.
 */
import { isTauri } from './server';

export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface OverlayParticipant { id: string; name: string; speaking: boolean; muted: boolean; self: boolean }
/** Everything the overlay window needs to render the current call. */
export interface OverlayState {
  active: boolean; channel: string | null; guild: string | null; locked: boolean;
  selfMuted: boolean; selfDeafened: boolean; participants: OverlayParticipant[];
}
export interface OverlayToast { id: string; author: string; channel: string | null; text: string }
export type OverlayAction = 'toggle-mute' | 'toggle-deafen' | 'toggle-lock';
/** Appearance + behaviour the web app pushes down to the native window. */
export interface OverlaySpec { enabled: boolean; locked: boolean; corner: OverlayCorner; shortcut?: string }

/** Order matches the settings dropdown; the first entry is the default. */
export const OVERLAY_CORNERS: { id: OverlayCorner; label: string }[] = [
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' },
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
];
/** Fixed toggle accelerator (global, registered by the Rust side). */
export const DEFAULT_OVERLAY_SHORTCUT = 'Shift+Backquote';

const EVENT_STATE = 'overlay:state';
const EVENT_TOAST = 'overlay:toast';
const EVENT_ACTION = 'overlay:action';

const tauri = (): any => (window as any).__TAURI__;

/** Label of the current Tauri window ("main", "overlay", …), or null in a plain browser. */
export function windowLabel(): string | null {
  if (!isTauri()) return null;
  const t = tauri();
  const w = t.window?.getCurrentWindow?.() ?? t.webviewWindow?.getCurrentWebviewWindow?.();
  return typeof w?.label === 'string' ? w.label : null;
}
export const isOverlayWindow = (): boolean => windowLabel() === 'overlay';

/** Mark the document so index.css makes the page background transparent (overlay window only). */
export function markOverlayDocument(): void {
  document.documentElement.dataset.overlay = '1';
}

async function invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const t = tauri();
  const fn = t.core?.invoke ?? t.invoke;
  if (typeof fn !== 'function') throw new Error('Tauri IPC is unavailable');
  return fn(cmd, args);
}

/** Push appearance + behaviour to the Rust window (position, click-through, shortcut, show/hide). */
export async function applyOverlay(spec: OverlaySpec): Promise<void> {
  if (!isTauri() || isOverlayWindow()) return;
  try { await invoke('overlay_apply', { spec }); } catch { /* window may be missing in dev */ }
}

function emit(name: string, payload: unknown): void {
  if (!isTauri()) return;
  try { void tauri().event?.emit?.(name, payload); } catch { /* */ }
}
export const emitOverlayState = (s: OverlayState) => emit(EVENT_STATE, s);
export const emitOverlayToast = (t: OverlayToast) => emit(EVENT_TOAST, t);
export const sendOverlayAction = (a: OverlayAction) => emit(EVENT_ACTION, a);

function listen<T>(name: string, cb: (p: T) => void): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => {});
  const t = tauri();
  if (typeof t.event?.listen !== 'function') return Promise.resolve(() => {});
  return Promise.resolve(t.event.listen(name, (e: { payload: T }) => cb(e.payload)))
    .then((un: any) => (typeof un === 'function' ? un : () => {}))
    .catch(() => () => {});
}
export const onOverlayState = (cb: (s: OverlayState) => void) => listen<OverlayState>(EVENT_STATE, cb);
export const onOverlayToast = (cb: (t: OverlayToast) => void) => listen<OverlayToast>(EVENT_TOAST, cb);
export const onOverlayAction = (cb: (a: OverlayAction) => void) => listen<OverlayAction>(EVENT_ACTION, cb);
