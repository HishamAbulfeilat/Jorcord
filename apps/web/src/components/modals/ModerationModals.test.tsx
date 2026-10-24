import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOD_SETTINGS, type ModNotice, type ModSettings } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { guilds: { modSettings: vi.fn(), kick: vi.fn(), ban: vi.fn() }, modNotices: { markRead: vi.fn().mockResolvedValue(undefined) } } }));
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { ModNoticeModal, RemoveMemberModal } from './ModerationModals';

const settings = (o: Partial<ModSettings> = {}): ModSettings => ({ ...DEFAULT_MOD_SETTINGS, ...o });
const mount = (el: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);
beforeEach(() => {
  vi.mocked(api.guilds.modSettings).mockReset().mockResolvedValue(settings()); vi.mocked(api.guilds.kick).mockReset().mockResolvedValue(undefined as never); vi.mocked(api.guilds.ban).mockReset().mockResolvedValue(undefined as never);
  useUI.setState({ toasts: [] }); useData.setState({ users: { u2: { id: 'u2', username: 'bob' } as never }, guilds: {} });
});
afterEach(cleanup);

describe('RemoveMemberModal', () => {
  it('kick: sends the reason and the dialog toggles (roles remembered, notice on by default)', async () => {
    const close = vi.fn();
    mount(<RemoveMemberModal mode="kick" guildId="g" userId="u2" close={close} />);
    await screen.findByTestId('remember-row');
    expect(screen.getByRole('switch', { name: 'Remember their roles' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' spam ' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Remember their roles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kick' }));
    await waitFor(() => expect(api.guilds.kick).toHaveBeenCalledWith('g', 'u2', { reason: 'spam', rememberRoles: false, notify: true }));
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
  it('hides the toggles the server turned off', async () => {
    vi.mocked(api.guilds.modSettings).mockResolvedValue(settings({ rememberRoles: { ...DEFAULT_MOD_SETTINGS.rememberRoles, enabled: false }, notices: { ...DEFAULT_MOD_SETTINGS.notices, enabled: false } }));
    mount(<RemoveMemberModal mode="kick" guildId="g" userId="u2" close={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Kick' }) as HTMLButtonElement).disabled).toBe(false)); // settings loaded
    expect(screen.queryByTestId('remember-row')).toBeNull();
    expect(screen.queryByTestId('notify-row')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kick' }));
    await waitFor(() => expect(api.guilds.kick).toHaveBeenCalledWith('g', 'u2', { reason: undefined }));
  });
  it('ban: no roles toggle, mentions the appeal link, can opt out of the notice', async () => {
    mount(<RemoveMemberModal mode="ban" guildId="g" userId="u2" close={vi.fn()} />);
    const row = await screen.findByTestId('notify-row');
    expect(row.textContent).toContain('A link to appeal is included.');
    expect(screen.queryByTestId('remember-row')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Tell them why' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(api.guilds.ban).toHaveBeenCalledWith('g', 'u2', { reason: undefined, deleteMessageSeconds: 0, notify: false }));
  });
});

describe('ModNoticeModal', () => {
  const notice = (o: Partial<ModNotice> = {}): ModNotice => ({ id: 'n', guildId: 'g', guildName: 'Cafe', kind: 'ban', reason: 'spamming', moderatorId: null, appeal: true, until: null, createdAt: new Date().toISOString(), readAt: null, ...o });
  it('shows the reason and an appeal button for bans, without naming a moderator', () => {
    const close = vi.fn();
    render(<ModNoticeModal notice={notice()} close={close} />);
    expect(screen.getByRole('dialog').textContent).toContain('You were banned from Cafe');
    expect(screen.getByTestId('mod-notice-reason').textContent).toBe('spamming');
    expect(screen.queryByText(/Decided by a moderator/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Appeal' }));
    expect(close).toHaveBeenCalled(); expect(api.modNotices.markRead).toHaveBeenCalled();
    expect(useUI.getState().settings).toEqual({ kind: 'user', tab: 'privacy' });
  });
  it('a kick without a reason says so and offers no appeal', () => {
    render(<ModNoticeModal notice={notice({ kind: 'kick', reason: null, appeal: false })} close={vi.fn()} />);
    expect(screen.getByText('The moderators did not give a reason.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Appeal' })).toBeNull();
  });
});
