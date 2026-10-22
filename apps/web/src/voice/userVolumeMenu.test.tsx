import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { voice: {}, users: { patchMe: vi.fn() } } }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => 0n }));
vi.mock('@/lib/menus', () => ({ userMenu: () => [] }));
vi.mock('@/lib/hooks', () => ({ useIsMobile: () => false }));
vi.mock('./controller', () => ({ getVoiceClient: () => ({}) }));
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { ContextMenuHost } from '@/components/ui/ContextMenu';
import { voiceUserMenu } from './menu';

beforeEach(() => {
  localStorage.clear();
  useData.setState({ me: { id: 'me', username: 'me' }, users: {}, guilds: {}, dms: {}, voiceStates: {} } as never);
  useUI.setState((s) => ({ prefs: { ...s.prefs, userVolumes: {}, userMuted: {} } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const open = () => { render(<ContextMenuHost />); act(() => useUI.getState().openMenu(10, 10, voiceUserMenu('bob', 'dm1'))); };

describe('participant volume menu', () => {
  it('offers a 0-200% slider (and no volume for yourself)', () => {
    open();
    const s = screen.getByRole('slider', { name: 'User Volume' }) as HTMLInputElement;
    expect(s.min).toBe('0'); expect(s.max).toBe('200'); expect(s.value).toBe('100');
    act(() => useUI.getState().openMenu(0, 0, voiceUserMenu('me', 'dm1')));
    expect(screen.queryByRole('slider')).toBeNull();
  });
  it('persists the chosen volume per user and clears it at 100%', () => {
    open();
    const s = screen.getByRole('slider', { name: 'User Volume' });
    fireEvent.change(s, { target: { value: '150' } });
    expect(useUI.getState().prefs.userVolumes).toEqual({ bob: 150 });
    expect(JSON.parse(localStorage.getItem('jorcord.prefs.v1')!).userVolumes).toEqual({ bob: 150 });
    fireEvent.change(s, { target: { value: '100' } });
    expect(useUI.getState().prefs.userVolumes).toEqual({});
  });
  it('local mute toggles and is remembered; moving the slider un-mutes', () => {
    open();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 1000); // ignore the post-long-press guard window
    fireEvent.click(screen.getByRole('menuitem', { name: /Mute \(just for me\)/ }));
    expect(useUI.getState().prefs.userMuted).toEqual({ bob: true });
    act(() => useUI.getState().openMenu(10, 10, voiceUserMenu('bob', 'dm1')));
    expect(screen.getByRole('menuitem', { name: /Unmute \(just for me\)/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('slider', { name: 'User Volume' }), { target: { value: '80' } });
    expect(useUI.getState().prefs.userMuted).toEqual({}); expect(useUI.getState().prefs.userVolumes).toEqual({ bob: 80 });
  });
  it('keyboard: the slider takes focus first; Up/Down leave it instead of changing the value', () => {
    open();
    const s = screen.getByRole('slider', { name: 'User Volume' }) as HTMLInputElement; s.focus();
    fireEvent.keyDown(s, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Mute \(just for me\)/ }));
  });
});
