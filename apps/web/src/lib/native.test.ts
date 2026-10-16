import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBack, applyDeepLink, desktop } from './native';
import { useUI } from '@/stores/ui';
import { getServerUrl, setServerUrl } from './server';
import { urlBase64ToUint8Array } from './push';

const ctx = () => ({ canGoBack: false, goBack: vi.fn(), exit: vi.fn() });
beforeEach(() => { useUI.setState({ menu: null, popout: null, modal: null, settings: null, switcher: false, leftDrawer: false, rightDrawer: false, panel: 'members' }); setServerUrl(null); });

describe('android back button', () => {
  it('closes the topmost layer first', () => {
    useUI.setState({ modal: { kind: 'shortcuts' }, settings: { kind: 'user' }, leftDrawer: true });
    const c = ctx();
    expect(handleBack(c)).toBe(true); expect(useUI.getState().modal).toBeNull(); expect(useUI.getState().settings).not.toBeNull();
    handleBack(c); expect(useUI.getState().settings).toBeNull();
    useUI.setState({ leftDrawer: true }); handleBack(c); expect(useUI.getState().leftDrawer).toBe(false);
    expect(c.exit).not.toHaveBeenCalled(); expect(c.goBack).not.toHaveBeenCalled();
  });
  it('closes side panels other than the member list, then navigates back, then exits', () => {
    useUI.setState({ panel: 'search' }); const c = ctx(); handleBack(c); expect(useUI.getState().panel).toBeNull();
    const nav = { ...ctx(), canGoBack: true }; handleBack(nav); expect(nav.goBack).toHaveBeenCalled(); expect(nav.exit).not.toHaveBeenCalled();
    handleBack(c); expect(c.exit).toHaveBeenCalled();
  });
});

describe('applyDeepLink', () => {
  it('routes invites and switches the server when the link names another one', () => {
    const nav = vi.fn(); setServerUrl('https://old.example.com');
    expect(applyDeepLink({ kind: 'invite', code: 'abc', server: 'https://new.example.com' }, nav)).toBe('/invite/abc');
    expect(getServerUrl()).toBe('https://new.example.com'); expect(nav).toHaveBeenCalledWith('/invite/abc');
  });
  it('keeps the current server when the link has none or the same one', () => {
    const nav = vi.fn(); setServerUrl('https://s.example.com');
    applyDeepLink({ kind: 'open' }, nav); applyDeepLink({ kind: 'open', server: 'https://s.example.com' }, nav);
    expect(getServerUrl()).toBe('https://s.example.com'); expect(nav).toHaveBeenCalledTimes(2);
  });
});

describe('push helpers', () => {
  it('decodes a VAPID key', () => {
    const k = urlBase64ToUint8Array('BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U');
    expect(k.length).toBe(65); expect(k[0]).toBe(4);
  });
});

describe('desktop helpers (Tauri only)', () => {
  const w = window as any;
  afterEach(() => { delete w.__TAURI__; delete w.__TAURI_INTERNALS__; });

  it('is a no-op in a plain browser', async () => {
    expect(desktop.available()).toBe(false);
    await expect(desktop.autostart()).resolves.toBeNull();
    await expect(desktop.setAutostart(true)).resolves.toBeUndefined();
    await expect(desktop.checkUpdate()).resolves.toBeNull();
  });

  it('reads and writes autostart through the Tauri plugin', async () => {
    let on = false;
    w.__TAURI__ = { autostart: { isEnabled: () => Promise.resolve(on), enable: () => { on = true; return Promise.resolve(); }, disable: () => { on = false; return Promise.resolve(); } } };
    expect(desktop.available()).toBe(true);
    expect(await desktop.autostart()).toBe(false);
    await desktop.setAutostart(true); expect(await desktop.autostart()).toBe(true);
    await desktop.setAutostart(false); expect(await desktop.autostart()).toBe(false);
  });

  it('checks for updates, then installs and relaunches', async () => {
    const calls: string[] = [];
    w.__TAURI__ = {
      updater: { check: () => Promise.resolve({ version: '1.2.3', downloadAndInstall: () => { calls.push('install'); return Promise.resolve(); } }) },
      process: { relaunch: () => { calls.push('relaunch'); return Promise.resolve(); } },
    };
    const u = await desktop.checkUpdate();
    expect(u?.version).toBe('1.2.3');
    await u!.install();
    expect(calls).toEqual(['install', 'relaunch']);
  });

  it('reports no update when the app is up to date', async () => {
    w.__TAURI__ = { updater: { check: () => Promise.resolve(null) } };
    await expect(desktop.checkUpdate()).resolves.toBeNull();
  });
});
