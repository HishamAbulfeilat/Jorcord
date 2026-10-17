import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Perm, type GuildIntegration } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { guilds: { integrations: vi.fn(), patchIntegration: vi.fn(), removeIntegration: vi.fn() } } }));
import { api } from '@/lib/api';
import { useUI } from '@/stores/ui';
import { BotsAppsTab } from './BotsAppsTab';

const list = vi.mocked(api.guilds.integrations), patch = vi.mocked(api.guilds.patchIntegration), remove = vi.mocked(api.guilds.removeIntegration);
const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>;
const app = (o: Partial<GuildIntegration>): GuildIntegration => ({
  applicationId: 'a1', name: 'Moderation', description: 'Warn, timeout and purge.', icon: null, botUserId: 'b1', official: true, scopes: ['bot', 'applications.commands'], roleId: 'r1',
  permissions: String(Perm.SEND_MESSAGES | Perm.MODERATE_MEMBERS), installedBy: 'u1', installedAt: new Date().toISOString(), ...o,
});
const ADMIN = Perm.ADMINISTRATOR | Perm.MANAGE_GUILD;

beforeEach(() => { list.mockReset(); patch.mockReset(); remove.mockReset(); });
afterEach(() => { cleanup(); });

describe('Server Settings > Bots & Apps', () => {
  it('lists the installed apps, flags official ones and says what each may do', async () => {
    list.mockResolvedValue([app({}), app({ applicationId: 'a2', name: 'Cmds', official: false, roleId: null, description: '', permissions: '0' }), app({ applicationId: 'a3', name: 'Thirdparty', official: false })]);
    render(wrap(<BotsAppsTab guildId="g1" myPerms={ADMIN} />));
    const rows = await screen.findAllByTestId('integration');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByTestId('official-badge')).toBeTruthy();
    expect(within(rows[0]!).getByText(/Send Messages/)).toBeTruthy();
    expect(within(rows[1]!).queryByTestId('official-badge')).toBeNull();
    expect(within(rows[1]!).getByText('Slash commands only (no bot user)')).toBeTruthy();
    expect(within(rows[1]!).queryByLabelText(/Permissions of/)).toBeNull(); // nothing to edit without a bot role
    expect(within(rows[2]!).queryByTestId('official-badge')).toBeNull();
    expect(list).toHaveBeenCalledWith('g1');
  });

  it('shows an empty state and an Add App button that opens the App Directory for this server', async () => {
    list.mockResolvedValue([]);
    const seen: string[] = []; const h = (e: Event) => seen.push((e as CustomEvent).detail.to); window.addEventListener('jorcord:navigate', h);
    render(wrap(<BotsAppsTab guildId="g 1" myPerms={ADMIN} />));
    expect(await screen.findByText(/No apps are installed yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add App/ }));
    window.removeEventListener('jorcord:navigate', h);
    expect(seen).toEqual(['/discover?tab=apps&guild=g%201']);
  });

  it('edits the bot role permissions and saves exactly the new bits', async () => {
    list.mockResolvedValue([app({})]);
    patch.mockResolvedValue(app({}));
    render(wrap(<BotsAppsTab guildId="g1" myPerms={ADMIN} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions of Moderation' }));
    const save = screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing changed yet
    const timeout = screen.getByRole('switch', { name: 'Timeout Members' });
    expect(timeout.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(timeout);
    expect(timeout.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('switch', { name: 'Manage Messages' }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith('g1', 'a1', String(Perm.SEND_MESSAGES | Perm.MANAGE_MESSAGES));
  });

  it('only lets you switch on permissions you hold yourself (the server enforces it too)', async () => {
    list.mockResolvedValue([app({})]);
    render(wrap(<BotsAppsTab guildId="g1" myPerms={Perm.MANAGE_GUILD | Perm.SEND_MESSAGES | Perm.MANAGE_MESSAGES} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions of Moderation' }));
    expect((screen.getByRole('switch', { name: 'Manage Messages' }) as HTMLButtonElement).disabled).toBe(false); // you hold it
    expect((screen.getByRole('switch', { name: 'Kick Members' }) as HTMLButtonElement).disabled).toBe(true); // you do not, and the bot has not got it
  });

  it('removing asks for confirmation first, then kicks the app and refreshes the list', async () => {
    list.mockResolvedValueOnce([app({}), app({ applicationId: 'a3', name: 'Other', official: false })]).mockResolvedValue([app({ applicationId: 'a3', name: 'Other', official: false })]);
    remove.mockResolvedValue(null as never);
    const open = vi.spyOn(useUI.getState(), 'openModal');
    render(wrap(<BotsAppsTab guildId="g1" myPerms={ADMIN} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Moderation' }));
    expect(remove).not.toHaveBeenCalled(); // not before the confirmation
    expect(open).toHaveBeenCalledTimes(1);
    const modal = open.mock.calls[0]![0] as unknown as { kind: string; danger?: boolean; title: string; onConfirm: () => Promise<unknown> };
    expect(modal).toMatchObject({ kind: 'confirm', danger: true, title: 'Remove Moderation?' });
    await modal.onConfirm();
    expect(remove).toHaveBeenCalledWith('g1', 'a1');
    await waitFor(() => expect(screen.getAllByTestId('integration')).toHaveLength(1));
    expect(screen.queryByText('Moderation')).toBeNull();
    open.mockRestore();
  });

  it('shows an error instead of an empty list when the server refuses', async () => {
    list.mockRejectedValue(new Error('403'));
    render(wrap(<BotsAppsTab guildId="g1" myPerms={0n} />));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load/);
  });
});
