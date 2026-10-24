import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushToTalk } from '@jorcord/voice';
import { useUI, defaultPrefs } from '@/stores/ui';

vi.mock('@jorcord/voice/react', () => ({ useVoiceSnapshot: () => ({ pttActive: false }) }));
import { PttButton } from './PttButton';

afterEach(cleanup);
beforeEach(() => { window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as never; });
beforeEach(() => useUI.setState({ prefs: { ...defaultPrefs, pushToTalk: true, pttCode: 'Backquote' } }));

describe('on-screen hold-to-talk', () => {
  it('is hidden unless Push to Talk is the input mode', () => {
    useUI.setState({ prefs: { ...defaultPrefs, pushToTalk: false } });
    render(<PttButton force />);
    expect(screen.queryByTestId('ptt-button')).toBeNull();
  });
  it('is hidden on devices without a touch pointer', () => {
    render(<PttButton />);
    expect(screen.queryByTestId('ptt-button')).toBeNull();
  });
  it('presses and releases the configured PTT key, so the existing PTT logic engages and disengages', () => {
    const changes: boolean[] = [];
    const stop = createPushToTalk({ code: 'Backquote', onChange: (a) => changes.push(a) });
    render(<PttButton force />);
    const b = screen.getByTestId('ptt-button');
    fireEvent.pointerDown(b, { pointerId: 1 });
    expect(changes).toEqual([true]);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    fireEvent.pointerDown(b, { pointerId: 1 }); // a second finger / repeat does not double-fire
    expect(changes).toEqual([true]);
    fireEvent.pointerUp(b, { pointerId: 1 });
    expect(changes).toEqual([true, false]);
    expect(b.getAttribute('aria-pressed')).toBe('false');
    stop();
  });
  it('releases when the touch is cancelled (system gesture, scroll takeover)', () => {
    const changes: boolean[] = [];
    const stop = createPushToTalk({ code: 'Backquote', onChange: (a) => changes.push(a) });
    render(<PttButton force />);
    const b = screen.getByTestId('ptt-button');
    fireEvent.pointerDown(b, { pointerId: 2 }); fireEvent.pointerCancel(b, { pointerId: 2 });
    expect(changes).toEqual([true, false]);
    stop();
  });
});
