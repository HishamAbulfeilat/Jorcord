import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perm } from '@jorcord/shared';

const perms = vi.hoisted(() => ({ value: 0n }));
vi.mock('@/lib/session', () => ({ myChannelPerms: () => perms.value }));
vi.mock('@/lib/api', () => ({ api: { channels: { startThread: vi.fn() } } }));
import { api } from '@/lib/api';
import { NewThreadForm } from './Panels';

const chan = { id: 'c1', name: 'general', type: 'text', guildId: 'g1', position: 0, parentId: null } as never;
const start = vi.mocked(api.channels.startThread);
beforeEach(() => { start.mockReset(); start.mockResolvedValue({ id: 't9', guildId: 'g1', type: 'thread', parentId: 'c1', name: 'x' } as never); });
afterEach(cleanup);

describe('NewThreadForm', () => {
  it('renders nothing without a create-thread permission', () => {
    perms.value = 0n;
    const { container } = render(<NewThreadForm channel={chan} onCreated={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
  it('starts a public thread when only CREATE_PUBLIC_THREADS is held (no private toggle)', async () => {
    perms.value = Perm.CREATE_PUBLIC_THREADS;
    const onCreated = vi.fn();
    render(<NewThreadForm channel={chan} onCreated={onCreated} />);
    expect(screen.queryByLabelText('Private thread')).toBeNull();
    fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: ' ideas ' } });
    fireEvent.click(screen.getByText('Start Thread'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(start).toHaveBeenCalledWith('c1', { name: 'ideas', type: 'public' });
  });
  it('can start a private non-invitable thread', async () => {
    perms.value = Perm.CREATE_PUBLIC_THREADS | Perm.CREATE_PRIVATE_THREADS;
    render(<NewThreadForm channel={chan} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: 'plans' } });
    fireEvent.click(screen.getByLabelText('Private thread'));
    fireEvent.click(await screen.findByLabelText('Members can invite others'));
    fireEvent.click(screen.getByText('Start Thread'));
    await waitFor(() => expect(start).toHaveBeenCalledWith('c1', { name: 'plans', type: 'private', invitable: false }));
  });
});
