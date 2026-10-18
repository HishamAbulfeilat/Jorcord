import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({
  api: {
    admin: { me: vi.fn().mockRejectedValue(new Error('no')) },
    users: { patchMe: vi.fn() },
    files: { uploadImage: vi.fn(), uploadImageFromUrl: vi.fn() },
    notifications: { get: vi.fn(), setPushEnabled: vi.fn(), putGuild: vi.fn(), putChannel: vi.fn(), reset: vi.fn() },
    push: { devices: vi.fn(), removeDevice: vi.fn() },
  },
}));
vi.mock('@/voice/VoiceSettings', () => ({ VoiceSettingsForm: () => null }));
vi.mock('@/lib/push', () => ({
  pushSupport: () => ({ kind: 'none', reason: 'not supported here' }),
  loadPushState: () => null,
  notificationPermission: () => 'default',
  enablePush: vi.fn(), disablePush: vi.fn(), sendTestNotification: vi.fn(), syncPush: vi.fn(),
}));

import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, defaultPrefs, defaultKeybinds } from '@/stores/ui';
import { UserSettings } from './UserSettings';
import { CustomStatusModal } from '@/components/modals/ExtraModals';

const patchMe = vi.mocked(api.users.patchMe);
const notifGet = vi.mocked(api.notifications.get as any);

const me: any = {
  id: 'u1', username: 'me', displayName: 'Me', email: 'a@b.c', verified: true, avatar: null, banner: null,
  bio: '', pronouns: null, themeColors: null, accentColor: '#5865f2', avatarDecoration: null, profileEffect: null,
  namePlate: null, serverTag: null, customStatus: null, settings: {}, theme: 'dark', createdAt: new Date().toISOString(),
};

const mount = (tab: string) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter><UserSettings initialTab={tab} /></MemoryRouter>
  </QueryClientProvider>,
);

/** The preference blob is written 300 ms after the last change: wait for the matching PATCH. */
const savedPrefs = async (pred: (p: any) => boolean) => waitFor(() => {
  expect(patchMe.mock.calls.some(([b]: any[]) => b?.settings?.prefs && pred(b.settings.prefs))).toBe(true);
}, { timeout: 2000 });

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
  localStorage.removeItem('jorcord.prefs.v1');
  localStorage.removeItem('jorcord.prefs.v1.updated');
  patchMe.mockReset().mockImplementation(async (b: any) => ({ ...me, ...b, settings: { ...(me.settings ?? {}), ...(b.settings ?? {}) } }) as never);
  notifGet.mockReset().mockResolvedValue({ pushEnabled: true, guilds: [], channels: [] });
  vi.mocked(api.push.devices).mockReset().mockResolvedValue([] as never);
  useData.setState({ ready: true, me, guilds: {}, guildOrder: [], users: {}, presences: {} } as never);
  useUI.setState({ prefs: { ...defaultPrefs }, modal: null } as never);
});
afterEach(cleanup);

describe('preference controls save through the account', () => {
  it('Appearance: theme, message density and font scaling are applied and PATCHed', async () => {
    mount('appearance');
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(useUI.getState().prefs.theme).toBe('light');

    fireEvent.click(screen.getByRole('radio', { name: 'compact' }));
    expect(useUI.getState().prefs.density).toBe('compact');

    fireEvent.change(screen.getByLabelText('Font scale'), { target: { value: '1.2' } });
    expect(useUI.getState().prefs.fontScale).toBe(1.2);

    await waitFor(() => expect(patchMe).toHaveBeenCalledWith({ theme: 'light' }));
    expect((useData.getState().me as any).theme).toBe('light');
    await savedPrefs((p) => p.theme === 'light' && p.density === 'compact' && p.fontScale === 1.2);
  });

  it('Accessibility: every toggle is reflected in state and persisted', async () => {
    mount('accessibility');
    fireEvent.click(screen.getByRole('switch', { name: 'Reduce motion' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Autoplay GIFs' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Show embeds' }));
    fireEvent.click(screen.getByRole('switch', { name: 'High contrast' }));
    fireEvent.click(screen.getByRole('switch', { name: '24 hour time' }));
    expect(useUI.getState().prefs).toMatchObject({ reducedMotion: true, autoplayGifs: false, showEmbeds: false, highContrast: true, twentyFourHour: true });
    await savedPrefs((p) => p.reducedMotion === true && p.autoplayGifs === false && p.highContrast === true && p.twentyFourHour === true);
  });

  it('Keybinds: reset and rebinding are persisted', async () => {
    mount('keybinds');
    fireEvent.click(screen.getByText('Reset to defaults'));
    expect(useUI.getState().prefs.keybinds).toEqual(defaultKeybinds);
    await savedPrefs((p) => p.keybinds?.markRead === defaultKeybinds.markRead);

    fireEvent.click(screen.getByLabelText('Change keybind for Quick Switcher'));
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true, shiftKey: true });
    expect(useUI.getState().prefs.keybinds.quickSwitcher).toBe('Ctrl+Shift+J');
    await savedPrefs((p) => p.keybinds?.quickSwitcher === 'Ctrl+Shift+J');
  });

  it('Language: picking a locale stores it on the account', async () => {
    mount('language');
    const locales = screen.getAllByRole('radio');
    fireEvent.click(locales[2]!); // es-ES
    expect(useUI.getState().prefs.language).toBe('es-ES');
    await savedPrefs((p) => p.language === 'es-ES');
  });

  it('Streamer Mode: toggles are applied and stored', async () => {
    mount('streamer');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Streamer Mode' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Hide personal information' }));
    expect(useUI.getState().prefs.streamerMode).toBe(true);
    expect(useUI.getState().prefs.streamerHidePersonal).toBe(false);
    await savedPrefs((p) => p.streamerMode === true && p.streamerHidePersonal === false);
  });

  it('Notifications: local switches and the default level are stored (push keeps using its own endpoint)', async () => {
    mount('notifications');
    fireEvent.click(await screen.findByRole('switch', { name: 'Sounds' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Suppress everyone' }));
    const levels = screen.getAllByRole('radio');
    fireEvent.click(levels[0]!); // All Messages
    expect(useUI.getState().prefs).toMatchObject({ notificationSounds: false, suppressEveryone: true, defaultNotify: 'all' });
    await savedPrefs((p) => p.notificationSounds === false && p.suppressEveryone === true && p.defaultNotify === 'all');
  });

  it('hydrates newer preferences from the account and ignores older ones', () => {
    localStorage.setItem('jorcord.prefs.v1', JSON.stringify({ ...defaultPrefs, theme: 'dark' }));
    localStorage.setItem('jorcord.prefs.v1.updated', '10');
    useUI.getState().hydrateFromServer({ prefs: { theme: 'light', density: 'compact' }, prefsUpdatedAt: 5 });
    expect(useUI.getState().prefs.theme).toBe('dark'); // stale server copy loses
    useUI.getState().hydrateFromServer({ prefs: { theme: 'light', density: 'compact' }, prefsUpdatedAt: 20 });
    expect(useUI.getState().prefs).toMatchObject({ theme: 'light', density: 'compact' });
  });
});

describe('custom status editor', () => {
  it('saves and clears the status through PATCH /users/@me and updates the store', async () => {
    const close = vi.fn();
    render(<CustomStatusModal close={close} />);
    fireEvent.change(screen.getByLabelText('Status', { exact: true }), { target: { value: 'shipping it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchMe).toHaveBeenCalledWith({ customStatus: { text: 'shipping it', emoji: null, expiresAt: null } }));
    await waitFor(() => expect((useData.getState().me as any).customStatus?.text).toBe('shipping it'));
    expect(close).toHaveBeenCalled();

    patchMe.mockClear();
    useData.setState((s) => ({ me: { ...(s.me as any), customStatus: { text: 'shipping it', emoji: null, expiresAt: null } } }) as never);
    cleanup();
    render(<CustomStatusModal close={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Status' }));
    await waitFor(() => expect(patchMe).toHaveBeenCalledWith({ customStatus: null }));
    await waitFor(() => expect((useData.getState().me as any).customStatus).toBeNull());
  });
});
