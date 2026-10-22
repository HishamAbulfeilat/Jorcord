import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useData } from '@/stores/data';

vi.mock('@/lib/menus', () => ({ openDmWith: vi.fn() }));
import { ActiveNow } from './ActiveNow';

afterEach(cleanup);
const user = (id: string, name: string) => ({ id, username: id, displayName: name, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' });
const rel = (id: string, name: string, type = 'friend') => ({ user: user(id, name), type });
const act = { type: 'playing', name: 'Chess', startedAt: new Date().toISOString() };

describe('ActiveNow', () => {
  it('shows an empty state when nobody is active', () => {
    useData.setState({ relationships: { a: rel('a', 'Ann') }, activities: {}, presences: { a: 'online' } } as never);
    render(<ActiveNow />);
    expect(screen.getByText('It’s quiet for now…')).toBeTruthy();
  });
  it('lists only online friends that have an activity, by name', () => {
    useData.setState({
      relationships: { a: rel('a', 'Zed'), b: rel('b', 'Ann'), c: rel('c', 'Off'), d: rel('d', 'Blocked', 'blocked'), e: rel('e', 'Idle') },
      activities: { a: [act], b: [act], c: [act], d: [act] }, presences: { a: 'online', b: 'idle', c: 'offline', d: 'online', e: 'online' },
    } as never);
    render(<ActiveNow />);
    const items = screen.getAllByRole('listitem').length;
    expect(items).toBeGreaterThanOrEqual(2);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Message Ann', 'Message Zed']);
  });
});
