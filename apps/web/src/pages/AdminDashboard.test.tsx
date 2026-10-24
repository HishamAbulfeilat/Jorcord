import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api', () => ({
  api: { admin: { me: vi.fn(), stats: vi.fn(), users: vi.fn(), user: vi.fn(), admins: vi.fn(), grantAdmin: vi.fn(), revokeAdmin: vi.fn(), disable: vi.fn(), enable: vi.fn(), setFlags: vi.fn(), godMode: vi.fn() } },
}));
import { api } from '@/lib/api';
import { AdminDashboard } from './AdminDashboard';

const a = vi.mocked(api.admin) as any;
const user = (o: object = {}) => ({ id: 'u1', username: 'carol', displayName: 'Carol', email: 'c@x.io', bot: false, guilds: [], sessions: [], publicFlags: 0, instanceAdmin: false, disabledAt: null, deletedAt: null, ...o });
const view = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AdminDashboard /></MemoryRouter></QueryClientProvider>);

beforeEach(() => {
  a.stats.mockResolvedValue({}); a.admins.mockResolvedValue([{ id: 'u9', username: 'dave', displayName: 'Dave', grantedAt: null }]);
  a.users.mockResolvedValue([user(), user({ id: 'u2', username: 'dave', instanceAdmin: true })]);
  a.user.mockResolvedValue(user()); a.grantAdmin.mockResolvedValue({}); a.revokeAdmin.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

async function openUsers() {
  fireEvent.click(await screen.findByRole('button', { name: /Users/ }));
}

describe('admin dashboard roles', () => {
  it('super admin: god mode, Admin column and a confirmed Make admin button', async () => {
    a.me.mockResolvedValue({ admin: true, role: 'super', userId: 's', mfaEnabled: true, godModeUntil: null });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    view(); await openUsers();
    expect(screen.getByText('God mode is off.')).toBeTruthy();
    expect(await screen.findByText('Admin', { selector: 'th' })).toBeTruthy();
    expect((await screen.findByTestId('admin-col-dave')).textContent).toBe('Admin');
    fireEvent.click(await screen.findByText(/@carol/));
    fireEvent.click(await screen.findByRole('button', { name: 'Make admin' }));
    expect(confirm.mock.calls[0]![0]).toContain('@carol');
    await waitFor(() => expect(a.grantAdmin).toHaveBeenCalledWith('u1'));
  });

  it('does not grant when the confirm is declined, and removes admin from an admin', async () => {
    a.me.mockResolvedValue({ admin: true, role: 'super', userId: 's', mfaEnabled: true, godModeUntil: null });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    view(); await openUsers();
    fireEvent.click(await screen.findByText(/@carol/));
    fireEvent.click(await screen.findByRole('button', { name: 'Make admin' }));
    expect(a.grantAdmin).not.toHaveBeenCalled();
    cleanup(); a.user.mockResolvedValue(user({ id: 'u2', username: 'dave', instanceAdmin: true }));
    view(); await openUsers();
    fireEvent.click(await screen.findByText(/@dave/));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove admin' }));
    expect(confirm.mock.calls.at(-1)![0]).toContain('@dave');
    await waitFor(() => expect(a.revokeAdmin).toHaveBeenCalledWith('u2'));
  });

  it('delegated admin: dashboard and Admins list, but no god mode, badges, grant button or admin log', async () => {
    a.me.mockResolvedValue({ admin: true, role: 'delegated', userId: 'd', mfaEnabled: true, godModeUntil: null });
    view(); await openUsers();
    expect(screen.queryByText('God mode is off.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Admin log/ })).toBeNull();
    expect(await screen.findByText('Admin', { selector: 'th' })).toBeTruthy();
    fireEvent.click(await screen.findByText(/@carol/));
    await screen.findByTestId('admin-status');
    expect(screen.queryByRole('button', { name: 'Make admin' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Badges' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Admins/ }));
    await waitFor(() => expect(screen.getByTestId('admins-list').textContent).toContain('@dave'));
  });
});
