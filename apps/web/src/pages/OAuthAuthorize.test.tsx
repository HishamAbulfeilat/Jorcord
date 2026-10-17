import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Perm } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { oauth: { preview: vi.fn(), authorize: vi.fn() } } }));
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { OAuthAuthorize } from './OAuthAuthorize';

const preview = vi.mocked(api.oauth.preview), authorize = vi.mocked(api.oauth.authorize);
const PERMS = String(Perm.SEND_MESSAGES | Perm.MODERATE_MEMBERS);
function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }
const view = (url: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><Routes><Route path="/oauth2/authorize" element={<OAuthAuthorize />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>
  </QueryClientProvider>);
const app = { id: '42', name: 'Moderation', description: 'Official moderation bot', icon: null, botUser: { id: 'b1' } as never };

beforeEach(() => {
  useAuth.setState({ access: 'tok', refresh: 'r' });
  preview.mockReset().mockResolvedValue({ application: app, scopes: ['bot', 'applications.commands'], permissions: PERMS, guilds: [{ id: 'g1', name: 'Alpha', icon: null, grantable: String(Perm.SEND_MESSAGES) }, { id: 'g2', name: 'Beta', icon: null, grantable: PERMS }] });
  authorize.mockReset().mockResolvedValue({ guildId: 'g2' });
});
afterEach(() => { cleanup(); useAuth.setState({ access: null, refresh: null }); });

describe('add-bot consent page', () => {
  it('sends logged-out visitors to log in and brings them back to the same link', () => {
    useAuth.setState({ access: null, refresh: null });
    view('/oauth2/authorize?client_id=42&scope=bot%20applications.commands&permissions=8');
    expect(screen.getByTestId('where').textContent).toBe('/login?next=' + encodeURIComponent('/oauth2/authorize?client_id=42&scope=bot%20applications.commands&permissions=8'));
  });

  it('offers only the servers the API returned, preselects the one named in the link and authorizes it with the ticked permissions', async () => {
    view('/oauth2/authorize?client_id=42&scope=bot%20applications.commands&permissions=' + PERMS + '&guild_id=g2');
    expect(await screen.findByTestId('oauth-title')).toBeTruthy();
    expect(preview).toHaveBeenCalledWith({ clientId: '42', scope: 'bot applications.commands', permissions: PERMS });
    const select = screen.getByLabelText('Add to server') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Alpha', 'Beta']);
    expect(select.value).toBe('g2');
    fireEvent.click(screen.getByLabelText('Timeout Members')); // untick one permission
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    expect(authorize).toHaveBeenCalledWith({ clientId: '42', scope: 'bot applications.commands', permissions: String(Perm.SEND_MESSAGES), guildId: 'g2' });
    expect(await screen.findByTestId('oauth-done')).toBeTruthy();
  });

  it('locks permissions the approver does not hold in the chosen server, so the approval can not be refused for them', async () => {
    view('/oauth2/authorize?client_id=42&scope=bot%20applications.commands&permissions=' + PERMS); // no guild in the link: the first server (Alpha) is chosen
    const timeout = (await screen.findByLabelText('Timeout Members')) as HTMLInputElement;
    expect(timeout.disabled).toBe(true); expect(timeout.checked).toBe(false);
    expect((screen.getByLabelText('Send Messages') as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    expect(authorize.mock.calls[0]![0]).toMatchObject({ guildId: 'g1', permissions: String(Perm.SEND_MESSAGES) });
  });

  it('tells members without Manage Server that there is nothing to add the bot to', async () => {
    preview.mockResolvedValue({ application: app, scopes: ['bot'], permissions: '0', guilds: [] });
    view('/oauth2/authorize?client_id=42&scope=bot');
    expect(await screen.findByText(/need the Manage Server permission/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Authorize' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server error when approval is refused', async () => {
    authorize.mockRejectedValue(Object.assign(new Error('You cannot grant permissions you do not have'), { status: 403 }));
    view('/oauth2/authorize?client_id=42&scope=bot%20applications.commands&permissions=' + PERMS);
    fireEvent.click(await screen.findByRole('button', { name: 'Authorize' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot grant permissions/);
  });
});
