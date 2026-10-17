import { beforeEach, describe, expect, it } from 'vitest';
import { shouldPlayEffect } from './soundboard';
import { useUI, defaultPrefs } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';

const ev = (userId: string, channelId = 'c1') => ({ guildId: 'g1', channelId, userId, sound: { id: 's', guildId: 'g1', name: 'x', emoji: null, volume: 1, url: '/a.mp3', creatorId: userId, createdAt: '' } });
beforeEach(() => { useUI.setState({ prefs: { ...defaultPrefs } }); useVoiceUI.setState({ connectedChannelId: 'c1', selfDeaf: false }); });

describe('soundboard playback rules', () => {
  it('plays effects from my own call only', () => { expect(shouldPlayEffect(ev('u2'), 'me')).toBe(true); expect(shouldPlayEffect(ev('u2', 'other'), 'me')).toBe(false); });
  it('is silent while deafened or with the global soundboard mute', () => {
    useVoiceUI.setState({ selfDeaf: true }); expect(shouldPlayEffect(ev('u2'), 'me')).toBe(false);
    useVoiceUI.setState({ selfDeaf: false }); useUI.getState().setPref('soundboardMuted', true); expect(shouldPlayEffect(ev('u2'), 'me')).toBe(false);
  });
  it('honours the per-user soundboard mute', () => {
    useUI.getState().setPref('soundboardMutedUsers', { u2: true });
    expect(shouldPlayEffect(ev('u2'), 'me')).toBe(false); expect(shouldPlayEffect(ev('u3'), 'me')).toBe(true);
  });
});
