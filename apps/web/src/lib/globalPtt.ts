/**
 * Desktop global push-to-talk. The Tauri side registers an OS-wide hotkey (`ptt_register`) and emits `jorcord://ptt`
 * with `true` on press and `false` on release, so talking works while Jorcord is in the background (e.g. in a game).
 * Everything is feature-detected: in a browser (or when registration fails) the normal window key listener still works.
 */
import { isTauri } from './server';

export const PTT_EVENT = 'jorcord://ptt';
export type PttSource = (emit: (down: boolean) => void) => () => void;

const tauri = (): any => (window as any).__TAURI__;

/**
 * Maps a `KeyboardEvent.code` to the accelerator the native side parses. Modifier-only keys and unknown codes return null
 * (an OS hotkey needs one real key; mouse buttons are not supported).
 */
export function codeToAccelerator(code: string): string | null {
  if (!code || /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(code) || code === 'Escape') return null;
  if (/^(Key[A-Z]|Digit\d|F\d{1,2}|Numpad[\w]+|Arrow(Up|Down|Left|Right)|Space|Tab|Enter|Backspace|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Insert|Delete|Home|End|PageUp|PageDown|CapsLock)$/.test(code)) return code;
  return null;
}

async function invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const t = tauri();
  const fn = t?.core?.invoke ?? t?.invoke;
  if (typeof fn !== 'function') throw new Error('Tauri IPC is unavailable');
  return fn(cmd, args);
}

/** A push-to-talk source for the voice client, or undefined when not on desktop / the key cannot be a global hotkey. */
export function tauriPttSource(code: string): PttSource | undefined {
  if (!isTauri()) return undefined;
  const accelerator = codeToAccelerator(code);
  if (!accelerator) return undefined;
  return (emit) => {
    let unlisten: (() => void) | undefined; let dead = false;
    const listen = tauri()?.event?.listen;
    if (typeof listen === 'function') {
      void Promise.resolve(listen(PTT_EVENT, (e: { payload: unknown }) => emit(e.payload === true))).then((u: () => void) => { if (dead) u?.(); else unlisten = u; }, () => {});
    }
    void invoke('ptt_register', { accelerator }).catch(() => { /* e.g. Wayland without a portal: window keys still work */ });
    return () => {
      dead = true; unlisten?.();
      void invoke('ptt_register', { accelerator: null }).catch(() => {});
    };
  };
}
