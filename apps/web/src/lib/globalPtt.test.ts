import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./server', () => ({ isTauri: () => !!(window as any).__TAURI__ }));
import { PTT_EVENT, codeToAccelerator, tauriPttSource } from './globalPtt';

afterEach(() => { delete (window as any).__TAURI__; });

describe('codeToAccelerator', () => {
  it('passes real keys through and rejects modifiers/escape/unknowns', () => {
    for (const c of ['KeyV', 'Backquote', 'F5', 'Digit1', 'Space', 'Numpad0', 'ArrowUp']) expect(codeToAccelerator(c)).toBe(c);
    for (const c of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'Escape', '', 'MouseButton4', 'Bogus']) expect(codeToAccelerator(c)).toBeNull();
  });
});

describe('tauriPttSource', () => {
  it('is undefined in a browser and for non-hotkey codes', () => {
    expect(tauriPttSource('KeyV')).toBeUndefined();
    (window as any).__TAURI__ = {};
    expect(tauriPttSource('ShiftLeft')).toBeUndefined();
  });
  it('registers the hotkey, forwards press/release events and unregisters on stop', async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined; const unlisten = vi.fn();
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as any).__TAURI__ = { core: { invoke }, event: { listen: vi.fn(async (name: string, cb: typeof handler) => { expect(name).toBe(PTT_EVENT); handler = cb; return unlisten; }) } };
    const src = tauriPttSource('KeyV')!;
    const seen: boolean[] = [];
    const stop = src((d) => seen.push(d));
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('ptt_register', { accelerator: 'KeyV' });
    handler!({ payload: true }); handler!({ payload: false }); handler!({ payload: 'junk' });
    expect(seen).toEqual([true, false, false]);
    stop();
    expect(unlisten).toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith('ptt_register', { accelerator: null });
  });
});
