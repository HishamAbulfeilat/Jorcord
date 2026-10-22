import { describe, it, expect, vi } from 'vitest';
import { VoiceClient } from '../src/client';
import { DUCK_FACTOR, DUCK_RELEASE_MS, DuckGate, isPriorityIdentity } from '../src/priority';
import { MUTED_SPEAKING_DEFAULTS, MutedSpeakingDetector, rmsOf } from '../src/mutedSpeaking';

function room(ids: { identity: string; speaking?: boolean; attr?: string }[], local: { identity: string; speaking?: boolean; attr?: string } = { identity: 'me' }) {
  const c = new VoiceClient();
  const mk = (f: { identity: string; speaking?: boolean; attr?: string }) => ({ identity: f.identity, isSpeaking: !!f.speaking, attributes: f.attr ? { 'jv.priority': f.attr } : {}, setVolume: vi.fn(), getTrackPublication: () => undefined });
  const remotes = ids.map(mk);
  (c.room as any).remoteParticipants = new Map(remotes.map((f) => [f.identity, f]));
  (c.room as any).localParticipant = { ...mk(local), permissions: undefined };
  return { c, remotes, last: (f: any) => [...f.setVolume.mock.calls].reverse().find((x: any[]) => x[1] === 'microphone')?.[0] };
}

describe('priority speaker identity', () => {
  it('uses the attribute only when the app has no authoritative list', () => {
    expect(isPriorityIdentity('a', '1', null)).toBe(true);
    expect(isPriorityIdentity('a', '0', null)).toBe(false);
    expect(isPriorityIdentity('a', undefined, null)).toBe(false);
    // a member who wrote the attribute themselves is ignored once the server's list is known
    expect(isPriorityIdentity('a', '1', new Set(['b']))).toBe(false);
    expect(isPriorityIdentity('b', undefined, new Set(['b']))).toBe(true);
  });
});

describe('DuckGate', () => {
  it('stays engaged for the release time after the priority speaker stops', () => {
    const g = new DuckGate();
    expect(g.update(0, false)).toBe(false);
    expect(g.update(100, true)).toBe(true);
    expect(g.update(100 + DUCK_RELEASE_MS - 1, false)).toBe(true);
    expect(g.update(100 + DUCK_RELEASE_MS, false)).toBe(false);
    g.update(1000, true); g.reset();
    expect(g.update(1001, false)).toBe(false);
  });
});

describe('ducking in the client', () => {
  it('ducks everyone else while a server-confirmed priority speaker talks, and not the priority speaker', () => {
    const { c, remotes, last } = room([{ identity: 'boss', speaking: true }, { identity: 'x' }]);
    c.setPrioritySpeakers(['boss']);
    expect(last(remotes[0])).toBe(1);
    expect(last(remotes[1])).toBeCloseTo(DUCK_FACTOR);
  });
  it('ignores a self-set attribute when the server list exists, but honours it without one', () => {
    const { c, remotes, last } = room([{ identity: 'spoof', speaking: true, attr: '1' }, { identity: 'x' }]);
    c.setUserVolume('x', 1);
    expect(last(remotes[1])).toBeCloseTo(DUCK_FACTOR); // advisory mode: the attribute counts
    c.setPrioritySpeakers([]);
    (c as any).duckGate.reset(); (c as any).applyVolumes(); // skip the release hangover
    expect(last(remotes[1])).toBe(1); // authoritative mode: nobody holds priority
    c.setPrioritySpeakers(null);
    expect(last(remotes[1])).toBeCloseTo(DUCK_FACTOR);
  });
  it('does not duck the priority speaker themself, and shows the flag on participants', () => {
    const { c, remotes, last } = room([{ identity: 'a', speaking: true }], { identity: 'me', speaking: true });
    c.setPrioritySpeakers(['me']);
    expect(last(remotes[0])).toBe(1); // I am the priority speaker: others are not attenuated for me
    expect(c.getSnapshot().participants.find((p) => p.identity === 'me')?.priority).toBe(true);
    expect(c.getSnapshot().participants.find((p) => p.identity === 'a')?.priority).toBe(false);
  });
});

describe('MutedSpeakingDetector', () => {
  const loud = MUTED_SPEAKING_DEFAULTS.threshold * 2;
  const run = (d: MutedSpeakingDetector, from: number, to: number, level: number, muted = true, step = 100) => {
    let fired: number | null = null;
    for (let t = from; t <= to; t += step) if (d.feed(t, level, muted) && fired === null) fired = t;
    return fired;
  };
  it('fires after sustained speech while muted, not on a short blip', () => {
    const d = new MutedSpeakingDetector();
    expect(run(d, 0, 200, loud)).toBeNull(); // 200 ms < 400 ms
    expect(run(d, 300, 2000, 0)).toBeNull();
    const d2 = new MutedSpeakingDetector();
    expect(run(d2, 0, 1000, loud)).toBe(400);
  });
  it('never fires while not muted', () => {
    const d = new MutedSpeakingDetector();
    expect(run(d, 0, 5000, loud, false)).toBeNull();
  });
  it('rate limits with a cooldown and allows a hint again afterwards', () => {
    const d = new MutedSpeakingDetector();
    expect(run(d, 0, 1000, loud)).toBe(400);
    expect(run(d, 1100, 9000, loud)).toBeNull(); // still talking, inside the cooldown
    expect(run(d, 9100, 11_000, loud)).not.toBeNull();
  });
  it('quiet gaps shorter than gapMs keep the burst alive; longer ones restart it', () => {
    const d = new MutedSpeakingDetector();
    run(d, 0, 300, loud); run(d, 400, 400, 0); // a 200 ms pause: same burst
    expect(run(d, 500, 800, loud)).toBe(500);
    const e = new MutedSpeakingDetector();
    run(e, 0, 300, loud); run(e, 400, 1000, 0); // long pause: burst reset
    expect(run(e, 1100, 1300, loud)).toBeNull();
  });
  it('unmuting resets the burst, rearm() clears the cooldown', () => {
    const d = new MutedSpeakingDetector();
    run(d, 0, 300, loud); d.feed(350, loud, false);
    expect(run(d, 400, 600, loud)).toBeNull();
    const e = new MutedSpeakingDetector();
    expect(run(e, 0, 1000, loud)).toBe(400);
    e.rearm();
    expect(run(e, 1100, 2000, loud)).not.toBeNull();
  });
  it('rmsOf is the root mean square', () => {
    expect(rmsOf([])).toBe(0);
    expect(rmsOf([1, -1, 1, -1])).toBe(1);
    expect(rmsOf([0.5, 0.5])).toBeCloseTo(0.5);
  });
});

describe('Go Live audience (streamer side)', () => {
  function streamer(remoteIds: string[]) {
    const c = new VoiceClient();
    const set = vi.fn();
    const pubs = [{ trackSid: 'mic1', source: 'microphone' }, { trackSid: 'cam1', source: 'camera' }, { trackSid: 'scr1', source: 'screen_share' }, { trackSid: 'scra1', source: 'screen_share_audio' }];
    (c.room as any).remoteParticipants = new Map(remoteIds.map((id) => [id, { identity: id }]));
    (c.room as any).localParticipant = { identity: 'me', trackPublications: new Map(pubs.map((p) => [p.trackSid, p])), setTrackSubscriptionPermissions: set, attributes: {} };
    Object.defineProperty(c.room, 'state', { value: 'connected', configurable: true });
    return { c, set };
  }
  it('lets only the accepted viewers receive the screen share, everybody else still gets mic and camera', () => {
    const { c, set } = streamer(['a', 'b', 'c']);
    c.setStreamAudience(['a']);
    expect(set).toHaveBeenLastCalledWith(false, [
      { participantIdentity: 'a', allowAll: false, allowedTrackSids: ['mic1', 'cam1', 'scr1', 'scra1'] },
      { participantIdentity: 'b', allowAll: false, allowedTrackSids: ['mic1', 'cam1'] },
      { participantIdentity: 'c', allowAll: false, allowedTrackSids: ['mic1', 'cam1'] },
    ]);
  });
  it('an empty audience hides the screen from everyone, and null opens it again (only once)', () => {
    const { c, set } = streamer(['a']);
    c.setStreamAudience([]);
    expect(set).toHaveBeenLastCalledWith(false, [{ participantIdentity: 'a', allowAll: false, allowedTrackSids: ['mic1', 'cam1'] }]);
    c.setStreamAudience(null);
    expect(set).toHaveBeenLastCalledWith(true);
    set.mockClear();
    c.setStreamAudience(null); // nothing was restricted: no signalling
    expect(set).not.toHaveBeenCalled();
  });
  it('does nothing while not connected', () => {
    const { c, set } = streamer(['a']);
    Object.defineProperty(c.room, 'state', { value: 'disconnected', configurable: true });
    c.setStreamAudience(['a']);
    expect(set).not.toHaveBeenCalled();
  });
});

describe('speaking-while-muted setting on the client', () => {
  it('defaults on, can be turned off, and clears the flag when disabled', () => {
    const c = new VoiceClient();
    expect(c.getSnapshot().settings.mutedSpeakingHint).toBe(true);
    expect(c.getSnapshot().speakingWhileMuted).toBe(false);
    (c as any).snap = { ...(c as any).snap, speakingWhileMuted: true };
    c.setMutedSpeakingHint(false);
    expect(c.getSnapshot().settings.mutedSpeakingHint).toBe(false);
    expect(c.getSnapshot().speakingWhileMuted).toBe(false);
    c.setMutedSpeakingHint(true);
    expect(c.getSnapshot().settings.mutedSpeakingHint).toBe(true);
  });
});
