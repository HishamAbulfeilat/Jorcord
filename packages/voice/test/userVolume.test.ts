import { describe, it, expect, vi } from 'vitest';
import { VoiceClient } from '../src/client';
import { clampUserVolume } from '../src/priority';

function clientWith(ids: string[]) {
  const c = new VoiceClient();
  const fakes = ids.map((identity) => ({ identity, isSpeaking: false, attributes: {}, setVolume: vi.fn(), getTrackPublication: () => undefined }));
  (c.room as any).remoteParticipants = new Map(fakes.map((f) => [f.identity, f]));
  return { c, fakes };
}
const lastVol = (f: any, src: string) => [...f.setVolume.mock.calls].reverse().find((x: any[]) => x[1] === src)?.[0];

describe('per-user volume', () => {
  it('clamps garbage to 0..2', () => { expect(clampUserVolume(5)).toBe(2); expect(clampUserVolume(-1)).toBe(0); expect(clampUserVolume(NaN)).toBe(1); });
  it('applies to the mic and the screen-share audio of that user only', () => {
    const { c, fakes } = clientWith(['a', 'b']);
    c.setUserVolume('a', 0.6);
    expect(lastVol(fakes[0], 'microphone')).toBe(0.6); expect(lastVol(fakes[0], 'screen_share_audio')).toBe(0.6);
    expect(lastVol(fakes[1], 'microphone')).toBe(1); expect(c.getUserVolume('a')).toBe(0.6);
  });
  it('never hands the element a volume above 1 (that throws); boost is Web Audio only', () => {
    const { c, fakes } = clientWith(['a']);
    c.setUserVolume('a', 2);
    expect(fakes[0].setVolume.mock.calls.every((x: any[]) => x[0] <= 1)).toBe(true);
  });
  it('local mute silences both sources and keeps the volume for unmute', () => {
    const { c, fakes } = clientWith(['a']);
    c.setUserVolume('a', 0.5); c.setUserMuted('a', true);
    expect(lastVol(fakes[0], 'microphone')).toBe(0); expect(lastVol(fakes[0], 'screen_share_audio')).toBe(0);
    expect(c.isUserMuted('a')).toBe(true);
    c.setUserMuted('a', false);
    expect(lastVol(fakes[0], 'microphone')).toBe(0.5);
  });
  it('syncUserAudio replaces everything (persisted prefs replay)', () => {
    const { c, fakes } = clientWith(['a', 'b']);
    c.setUserVolume('a', 1);
    c.syncUserAudio({ b: 0.25 }, { a: true });
    expect(lastVol(fakes[0], 'microphone')).toBe(0); expect(lastVol(fakes[1], 'microphone')).toBe(0.25);
    expect(c.getUserVolume('a')).toBe(1);
  });
  it('deafen still wins over user volume', () => {
    const { c, fakes } = clientWith(['a']);
    c.setUserVolume('a', 2); (c as any).snap = { ...(c as any).snap, deafened: true }; (c as any).applyVolumes();
    expect(lastVol(fakes[0], 'microphone')).toBe(0);
  });
});
