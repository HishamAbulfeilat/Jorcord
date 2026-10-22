import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionEngine, captionsSupported, getRecognizerCtor, reduceCaptions, pruneCaptions, type RecognizerLike } from './captions';

class MockRec implements RecognizerLike {
  static all: MockRec[] = []; static failStart = false;
  lang = ''; continuous = false; interimResults = false; onresult: any = null; onerror: any = null; onend: any = null; started = false; aborted = false;
  constructor() { MockRec.all.push(this); }
  start() { if (MockRec.failStart) throw new Error('InvalidStateError'); this.started = true; }
  stop() { this.onend?.(); } abort() { this.aborted = true; }
  say(text: string, final: boolean) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] }); }
}
const mk = (o: Partial<ConstructorParameters<typeof CaptionEngine>[0]> = {}) => {
  const texts: any[] = [], states: string[] = [];
  const e = new CaptionEngine({ ctor: MockRec, lang: 'en-US', onText: (t) => texts.push(t), onState: (s) => states.push(s), ...o });
  return { e, texts, states };
};
beforeEach(() => { MockRec.all = []; MockRec.failStart = false; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('CaptionEngine (mocked Web Speech API)', () => {
  it('feature-detects the standard and the webkit-prefixed constructor', () => {
    expect(captionsSupported({})).toBe(false); expect(getRecognizerCtor({ webkitSpeechRecognition: MockRec })).toBe(MockRec); expect(captionsSupported({ SpeechRecognition: MockRec })).toBe(true);
  });
  it('reports unsupported instead of throwing', () => {
    const { e, states } = mk({ ctor: null }); expect(e.start()).toBe('unsupported'); expect(states).toEqual(['unsupported']);
  });
  it('configures a continuous interim recognizer in the chosen language and forwards results', () => {
    const { e, texts, states } = mk({ lang: 'fr-FR' }); e.start();
    const r = MockRec.all[0]!; expect(r).toMatchObject({ lang: 'fr-FR', continuous: true, interimResults: true, started: true }); expect(states).toEqual(['listening']);
    r.say('hello wor', false); r.say('hello world', true);
    expect(texts).toEqual([{ text: 'hello wor', final: false }, { text: 'hello world', final: true }]);
  });
  it('restarts after the browser ends the session (silence) and gives up after repeated failures', () => {
    const { e, states } = mk(); e.start(); MockRec.all[0]!.onend();
    vi.advanceTimersByTime(10); expect(MockRec.all).toHaveLength(2);
    for (let i = 0; i < 12; i++) { MockRec.all.at(-1)!.onend?.(); vi.advanceTimersByTime(6000); }
    expect(states.at(-1)).toBe('error'); expect(e.isRunning).toBe(false);
  });
  it('permission denied => blocked and no restart loop; no-speech is ignored', () => {
    const { e, states } = mk(); e.start(); const r = MockRec.all[0]!;
    r.onerror({ error: 'no-speech' }); expect(states).toEqual(['listening']);
    r.onerror({ error: 'not-allowed' }); r.onend(); vi.advanceTimersByTime(10_000);
    expect(states.at(-1)).toBe('blocked'); expect(MockRec.all).toHaveLength(1);
  });
  it('start() throwing (already started / no mic) is an error state, stop() releases the recognizer', () => {
    MockRec.failStart = true; const a = mk(); a.e.start(); expect(a.states.at(-1)).toBe('error');
    MockRec.failStart = false; const b = mk(); b.e.start(); const r = MockRec.all.at(-1)!; b.e.stop();
    expect(r.aborted).toBe(true); expect(b.states.at(-1)).toBe('off'); r.say('late', true); expect(b.texts).toEqual([]);
  });
});

describe('caption lines', () => {
  it('replaces the interim line, appends after a final one, caps the list', () => {
    let l = reduceCaptions([], { speaker: 'Me', text: 'hel', final: false, at: 1 });
    l = reduceCaptions(l, { speaker: 'Me', text: 'hello', final: true, at: 2 }); expect(l).toHaveLength(1); expect(l[0]).toMatchObject({ text: 'hello', final: true });
    for (let i = 0; i < 10; i++) l = reduceCaptions(l, { speaker: 'Me', text: `line ${i}`, final: true, at: 3 + i });
    expect(l).toHaveLength(4); expect(reduceCaptions(l, { speaker: 'Me', text: '  ', final: true, at: 99 })).toBe(l);
  });
  it('clears finished lines after the TTL', () => {
    const l = reduceCaptions([], { speaker: 'Me', text: 'hi', final: true, at: 1000 });
    expect(pruneCaptions(l, 5000)).toBe(l); expect(pruneCaptions(l, 9000)).toEqual([]);
  });
});

// ---- hook + overlay with a mocked recognizer ----
const snap: any = { status: 'connected', muted: false, deafened: false };
vi.mock('@jorcord/voice/react', () => ({ useVoiceSnapshot: () => snap }));
import { useUI } from '@/stores/ui';
import { useData } from '@/stores/data';
import { useCaptions } from '@/stores/captions';
import { CaptionsOverlay, LiveCaptionsRunner, useLiveCaptions } from './Captions';

function Harness() { useLiveCaptions({ ctor: MockRec }); return <CaptionsOverlay />; }
describe('live captions in the call', () => {
  beforeEach(() => {
    Object.assign(snap, { status: 'connected', muted: false, deafened: false });
    useData.setState({ me: { id: 'me', username: 'amy', displayName: 'Amy' } } as never); useCaptions.setState({ lines: [], state: 'off' });
    useUI.setState((s) => ({ prefs: { ...s.prefs, captions: true, captionsLang: '' } }));
  });
  it('shows what the recognizer hears under the tiles, labelled as local', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Live captions').textContent).toMatch(/your speech only/);
    act(() => MockRec.all.at(-1)!.say('good morning', true));
    expect(screen.getByText('good morning')).toBeTruthy(); expect(screen.getByText('Amy:')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(9000); }); expect(screen.queryByText('good morning')).toBeNull();
  });
  it('stops listening (releases the mic) while muted, and resumes when unmuted', () => {
    const { rerender } = render(<Harness />); const first = MockRec.all.at(-1)!; expect(first.started).toBe(true);
    snap.muted = true; rerender(<Harness />); expect(first.aborted).toBe(true);
    const n = MockRec.all.length; snap.muted = false; rerender(<Harness />); expect(MockRec.all.length).toBe(n + 1);
  });
  it('does nothing when the toggle is off', () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, captions: false } }));
    const n = MockRec.all.length; const { container } = render(<Harness />); expect(MockRec.all.length).toBe(n); expect(container.querySelector('[data-testid=captions]')).toBeNull();
  });
  it('unsupported browsers get a clear message instead of a broken overlay', () => {
    function NoApi() { useLiveCaptions({ ctor: null }); return <CaptionsOverlay />; }
    render(<NoApi />); expect(screen.getByTestId('captions').getAttribute('data-state')).toBe('unsupported'); expect(screen.getByRole('status').textContent).toMatch(/not supported/);
  });
  it('blocked permission is explained', () => {
    render(<Harness />); act(() => MockRec.all.at(-1)!.onerror({ error: 'not-allowed' }));
    expect(screen.getByRole('status').textContent).toMatch(/permission/);
  });
  void LiveCaptionsRunner;
});
