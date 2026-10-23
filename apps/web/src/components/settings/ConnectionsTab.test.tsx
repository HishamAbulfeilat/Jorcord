import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({ api: { users: { connections: vi.fn(), connectionProviders: vi.fn(), startConnectionOAuth: vi.fn(), addConnection: vi.fn(), patchConnection: vi.fn(), deleteConnection: vi.fn(), verifyConnection: vi.fn() } } }));
import { api } from '@/lib/api';
import { ConnectionsTab } from './ConnectionsTab';

const u = vi.mocked(api.users);
const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>;
const original = window.location;
const assign = vi.fn();

beforeEach(() => {
  for (const f of Object.values(u)) (f as ReturnType<typeof vi.fn>).mockReset();
  assign.mockReset();
  u.connections.mockResolvedValue([]);
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
});
afterEach(() => { cleanup(); Object.defineProperty(window, 'location', { configurable: true, value: original }); });

describe('Settings > Connections: Connect with Twitch / YouTube', () => {
  it('shows a button per provider the server can verify and sends the browser to the authorize URL', async () => {
    u.connectionProviders.mockResolvedValue([{ id: 'github', name: 'GitHub', example: 'x' }, { id: 'twitch', name: 'Twitch', example: 'x', oauth: true }, { id: 'youtube', name: 'YouTube', example: 'x', oauth: true }]);
    u.startConnectionOAuth.mockResolvedValue({ url: 'https://id.twitch.tv/oauth2/authorize?state=abc', expiresIn: 600 });
    render(wrap(<ConnectionsTab />));
    expect(await screen.findByRole('button', { name: 'Connect with YouTube' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect with Twitch' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.twitch.tv/oauth2/authorize?state=abc'));
    expect(u.startConnectionOAuth).toHaveBeenCalledWith('twitch');
  });

  it('shows no buttons when the server has no credentials (or is older), and the manual flow stays', async () => {
    u.connectionProviders.mockResolvedValue([{ id: 'twitch', name: 'Twitch', example: 'x' }]);
    render(wrap(<ConnectionsTab />));
    expect(await screen.findByRole('button', { name: 'Add connection' })).toBeTruthy();
    await waitFor(() => expect(u.connectionProviders).toHaveBeenCalled());
    expect(screen.queryByTestId('oauth-connect')).toBeNull();
  });

  it('stays on the page and reports a server refusal', async () => {
    u.connectionProviders.mockResolvedValue([{ id: 'twitch', name: 'Twitch', example: 'x', oauth: true }]);
    u.startConnectionOAuth.mockRejectedValue(new Error('not enabled'));
    render(wrap(<ConnectionsTab />));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with Twitch' }));
    await waitFor(() => expect(u.startConnectionOAuth).toHaveBeenCalled());
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Connect with Twitch' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
