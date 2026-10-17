import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { DirectoryApp } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { directory: { apps: vi.fn(), categories: vi.fn() } } }));
import { api } from '@/lib/api';
import { AppDirectory } from './AppDirectory';

const apps = vi.mocked(api.directory.apps), cats = vi.mocked(api.directory.categories);
const item = (o: Partial<DirectoryApp>): DirectoryApp => ({ id: '1', name: 'Welcome', summary: 'Greets new members.', description: '', icon: null, botUserId: 'b', category: 'community', tags: ['welcome'], installs: 3, official: true, permissions: '2048', listedAt: '', ...o });
function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }
const view = (guildId?: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AppDirectory guildId={guildId} /><Where /></MemoryRouter></QueryClientProvider>);

beforeEach(() => { apps.mockReset(); cats.mockReset().mockResolvedValue([]); });
afterEach(cleanup);

describe('App Directory', () => {
  it('marks official built-in bots and leaves third-party ones unmarked', async () => {
    apps.mockResolvedValue({ total: 2, items: [item({}), item({ id: '2', name: 'ThirdParty', official: false })] });
    view();
    const cards = await screen.findAllByRole('listitem');
    const withBadge = cards.filter((c) => c.hasAttribute('data-app-card') && c.querySelector('[data-testid=official-badge]'));
    expect(withBadge).toHaveLength(1);
    expect(withBadge[0]!.textContent).toContain('Welcome');
  });

  it('"Add to Server" opens the consent page with the suggested permissions', async () => {
    apps.mockResolvedValue({ total: 1, items: [item({})] });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Welcome to a server' }));
    expect(screen.getByTestId('where').textContent).toBe('/oauth2/authorize?client_id=1&scope=bot%20applications.commands&permissions=2048');
  });

  it('when opened from a server "Add App", that server is preselected', async () => {
    apps.mockResolvedValue({ total: 1, items: [item({})] });
    view('g42');
    fireEvent.click(await screen.findByRole('button', { name: 'Add Welcome to a server' }));
    expect(screen.getByTestId('where').textContent).toContain('guild_id=g42');
  });
});
