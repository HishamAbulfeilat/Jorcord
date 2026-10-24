import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOD_SETTINGS } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { guilds: { modSettings: vi.fn(), patchModSettings: vi.fn(), modPrefs: vi.fn(), putModPrefs: vi.fn(), evasionHints: vi.fn(), handleEvasionHint: vi.fn() } } }));
import { api } from '@/lib/api';
import { ModerationTab } from './ModerationTab';

const mount = (canManage = true) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ModerationTab guildId="g" canManage={canManage} /></QueryClientProvider>);
const prefs = { blurMedia: null, quietStart: null, quietEnd: null, tzOffset: 0, serverBlurDefault: true };
beforeEach(() => {
  const g = api.guilds as unknown as Record<string, ReturnType<typeof vi.fn>>;
  for (const k of Object.keys(g)) g[k]!.mockReset();
  g.modSettings!.mockResolvedValue(DEFAULT_MOD_SETTINGS); g.patchModSettings!.mockResolvedValue(DEFAULT_MOD_SETTINGS);
  g.modPrefs!.mockResolvedValue(prefs); g.putModPrefs!.mockResolvedValue({ ...prefs, quietStart: 1320, quietEnd: 480 });
  g.evasionHints!.mockResolvedValue([{ id: 'h1', guildId: 'g', userId: 'u1', bannedUserId: 'u2', score: 65, status: 'open', createdAt: '', signals: [{ kind: 'name', weight: 45, detail: 'Name matches a banned account' }], user: { id: 'u1', username: 'twin' }, bannedUser: { id: 'u2', username: 'orig' } }]);
  g.handleEvasionHint!.mockResolvedValue({});
});
afterEach(cleanup);

describe('Moderation settings tab', () => {
  it('shows the defaults and saves a changed toggle as a partial patch', async () => {
    mount();
    const sw = await screen.findByRole('switch', { name: 'Name the moderator' });
    expect(sw.getAttribute('aria-checked')).toBe('false'); // moderator hidden by default
    expect(screen.getByRole('switch', { name: 'Remember on kick' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Flag possible ban evasion' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(api.guilds.patchModSettings).toHaveBeenCalledWith('g', { notices: { showModerator: true } }));
    fireEvent.change(screen.getByLabelText('Audit log retention'), { target: { value: '90' } });
    await waitFor(() => expect(api.guilds.patchModSettings).toHaveBeenCalledWith('g', { retention: { auditDays: 90 } }));
  });
  it('read-only without Manage Server, but wellbeing preferences stay editable', async () => {
    mount(false);
    expect((await screen.findByRole('switch', { name: 'Name the moderator' }) as HTMLButtonElement).disabled).toBe(true);
    const q = await screen.findByRole('switch', { name: 'Quiet hours' });
    expect((q as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(q);
    await waitFor(() => expect(api.guilds.putModPrefs).toHaveBeenCalledWith('g', expect.objectContaining({ quietStart: 1320, quietEnd: 480, tzOffset: expect.any(Number) })));
  });
  it('lists open ban-evasion hints with the signals used and lets a moderator triage them', async () => {
    vi.mocked(api.guilds.modSettings).mockResolvedValue({ ...DEFAULT_MOD_SETTINGS, evasion: { enabled: true } });
    mount();
    const q = await screen.findByTestId('evasion-queue');
    await waitFor(() => expect(q.textContent).toContain('Name matches a banned account'));
    expect(q.textContent).toContain('twin'); expect(q.textContent).toContain('65/100');
    fireEvent.click(screen.getByRole('button', { name: 'Not them' }));
    await waitFor(() => expect(api.guilds.handleEvasionHint).toHaveBeenCalledWith('g', 'h1', 'dismissed'));
  });
});
