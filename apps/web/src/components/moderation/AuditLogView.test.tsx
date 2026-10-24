import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perm, type AuditEntry } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { guilds: { auditLogs: vi.fn(), auditCsv: vi.fn() } } }));
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { AuditLogView } from './AuditLogView';

const entry = (o: Partial<AuditEntry>): AuditEntry => ({ id: '100', guildId: 'g', actorId: 'u1', action: 'ROLE_UPDATE', targetId: 'r1', changes: { name: 'x' }, reason: null, createdAt: new Date().toISOString(), ...o });
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuditLogView guildId="g" /></QueryClientProvider>);
beforeEach(() => {
  vi.mocked(api.guilds.auditLogs).mockReset().mockResolvedValue([entry({ diff: { before: { permissions: '0' }, after: { permissions: Perm.KICK_MEMBERS.toString() } } }), entry({ id: '99', action: 'MEMBER_KICK', changes: null, reason: 'spam' })]);
  vi.mocked(api.guilds.auditCsv).mockReset().mockResolvedValue('id\r\n1' as never);
  const u = { id: 'u1', username: 'alice', discriminator: '0', avatar: null } as never;
  useData.setState({ users: { u1: u }, guilds: { g: { guild: { id: 'g' }, members: { u1: { user: u, roles: [] } }, roles: {}, channels: {} } as never } });
  (URL as any).createObjectURL = vi.fn(() => 'blob:x'); (URL as any).revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe('AuditLogView', () => {
  it('expands an entry to show what changed', async () => {
    mount();
    await screen.findAllByRole('button', { name: 'Show details' });
    expect(screen.queryByTestId('audit-diff')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show details' })[0]!);
    expect(screen.getByTestId('audit-diff').textContent).toContain('+ Kick members');
    expect(screen.getAllByRole('button', { name: 'Hide details' })).toHaveLength(1);
  });
  it('applies the filters on search and exports the same filter as CSV', async () => {
    mount(); await screen.findAllByRole('button', { name: 'Show details' });
    fireEvent.change(screen.getByLabelText('Any moderator'), { target: { value: 'u1' } });
    fireEvent.change(screen.getByLabelText('Search reasons and changes'), { target: { value: ' cooldown ' } });
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-01-02' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(api.guilds.auditLogs).toHaveBeenLastCalledWith('g', expect.objectContaining({ actorId: 'u1', q: 'cooldown', limit: 50 })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(api.guilds.auditCsv).toHaveBeenCalledWith('g', expect.objectContaining({ actorId: 'u1', q: 'cooldown' })));
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
  });
});
