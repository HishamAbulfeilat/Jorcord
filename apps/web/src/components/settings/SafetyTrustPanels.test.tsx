import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GuildSafety } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { guilds: { impersonationQueue: vi.fn(), clearImpersonation: vi.fn().mockResolvedValue({ cleared: true }), patchSafety: vi.fn() } } }));
import { api } from '@/lib/api';
import { ImpersonationSection, LinkListsSection, MemberDmsSection } from './SafetyTrustPanels';

const safety = (over: Partial<GuildSafety> = {}): GuildSafety => ({ verificationLevel: 0, explicitFilter: 0, defaultNotifications: 'mentions', raidProtection: { enabled: false, maxJoins: 10, windowSeconds: 60, lockMinutes: 60 }, invitesPausedUntil: null, checklist: [], score: 0, memberDms: 'open', linkAllow: [], linkDeny: [], impersonationGuard: { enabled: false, action: 'flag' }, ...over });
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('MemberDmsSection', () => {
  it('toggles the opt-in policy and can apply it to everyone', () => {
    const patch = vi.fn();
    const { rerender } = wrap(<MemberDmsSection s={safety()} patch={patch} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Members must opt in to DMs' }));
    expect(patch).toHaveBeenCalledWith({ memberDms: 'optin' });
    rerender(<QueryClientProvider client={new QueryClient()}><MemberDmsSection s={safety({ memberDms: 'optin' })} patch={patch} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply to everyone' }));
    expect(patch).toHaveBeenLastCalledWith({ memberDms: 'optin', memberDmsApplyToExisting: true });
  });
});

describe('LinkListsSection', () => {
  it('adds normalised domains to the trusted list and removes entries', () => {
    const patch = vi.fn();
    wrap(<LinkListsSection s={safety({ linkAllow: ['a.example'], linkDeny: ['evil.example'] })} patch={patch} />);
    fireEvent.change(screen.getByLabelText('Always trust these domains'), { target: { value: 'HTTPS://www.Good.example/page' } });
    fireEvent.submit(screen.getByLabelText('Always trust these domains').closest('form')!);
    expect(patch).toHaveBeenCalledWith({ linkAllow: ['a.example', 'good.example'] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove evil.example' }));
    expect(patch).toHaveBeenLastCalledWith({ linkDeny: [] });
  });
});

describe('ImpersonationSection', () => {
  it('shows the review queue when on and clears a flagged member', async () => {
    vi.mocked(api.guilds.impersonationQueue).mockResolvedValue([{ userId: 'u1', username: 'hisham_', displayName: null, avatar: null, accountCreatedAt: '2020-01-01T00:00:00Z', joinedAt: '2026-01-01T00:00:00Z', held: true, match: { kind: 'owner', target: 'Hisham', name: 'hisham_', distance: 1, at: '' } }]);
    const patch = vi.fn();
    wrap(<ImpersonationSection guildId="g1" s={safety({ impersonationGuard: { enabled: true, action: 'hold' } })} patch={patch} />);
    await screen.findByText('hisham_');
    expect(screen.getByText(/looks like Hisham/).textContent).toContain('held');
    fireEvent.click(screen.getByRole('button', { name: 'Not an impersonator' }));
    await waitFor(() => expect(api.guilds.clearImpersonation).toHaveBeenCalledWith('g1', 'u1'));
    fireEvent.click(screen.getByRole('switch', { name: 'Hold suspected impersonators' }));
    expect(patch).toHaveBeenCalledWith({ impersonationGuard: { action: 'flag' } });
  });
  it('hides the queue while the guard is off', () => {
    wrap(<ImpersonationSection guildId="g1" s={safety()} patch={vi.fn()} />);
    expect(screen.queryByTestId('impersonation-queue')).toBeNull();
    expect(api.guilds.impersonationQueue).not.toHaveBeenCalled();
  });
});
