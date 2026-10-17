import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayView } from './OverlayView';
import type { OverlayState } from '@/lib/overlay';

const state = (over: Partial<OverlayState> = {}): OverlayState => ({
  active: true, channel: 'General', guild: 'My Server', locked: false, selfMuted: false, selfDeafened: false,
  participants: [
    { id: 'u1', name: 'Ada Lovelace', speaking: true, muted: false, self: false },
    { id: 'u2', name: 'Alan Turing', speaking: false, muted: true, self: true },
  ],
  ...over,
});

afterEach(cleanup);

describe('OverlayView', () => {
  it('lists the members and marks who is speaking', () => {
    render(<OverlayView state={state()} toasts={[]} onAction={() => {}} />);
    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.getByText('My Server')).toBeTruthy();
    const rows = screen.getAllByTestId('overlay-member');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-speaking')).toBe('true');
    expect(rows[1].getAttribute('data-speaking')).toBeNull();
    expect(screen.getByText('(you)')).toBeTruthy();
    expect(screen.getByLabelText('Muted')).toBeTruthy();
  });

  it('sends mute, deafen and lock actions', () => {
    const onAction = vi.fn();
    render(<OverlayView state={state()} toasts={[]} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deafen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock overlay' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['toggle-mute', 'toggle-deafen', 'toggle-lock']);
  });

  it('reflects locked, muted and deafened flags', () => {
    render(<OverlayView state={state({ locked: true, selfMuted: true, selfDeafened: true })} toasts={[]} onAction={() => {}} />);
    expect(screen.getByRole('button', { name: 'Unlock overlay' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Undeafen' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a fallback and disables the controls when not connected', () => {
    render(<OverlayView state={state({ active: false, participants: [] })} toasts={[]} onAction={() => {}} />);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText('Join a voice channel to see who is in the call.')).toBeTruthy();
    expect(screen.queryAllByTestId('overlay-member')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Mute' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders incoming message toasts', () => {
    render(<OverlayView state={state()} toasts={[{ id: 'm1', author: 'Ada', channel: 'General', text: 'hello there' }]} onAction={() => {}} />);
    expect(screen.getByTestId('overlay-toast').textContent).toContain('Ada');
    expect(screen.getByTestId('overlay-toast').textContent).toContain('hello there');
  });
});
