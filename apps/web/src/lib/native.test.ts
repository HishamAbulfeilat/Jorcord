import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBack, applyDeepLink } from './native';
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
