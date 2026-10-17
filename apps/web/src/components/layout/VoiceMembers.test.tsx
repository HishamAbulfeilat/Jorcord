import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@jorcord/voice/react', () => ({ useVoiceSnapshot: () => ({ channelId: null, participants: [] }) }));
import { useData } from '@/stores/data';
import { VoiceMembers } from './ChannelSidebar';

const user = (id: string) => ({ id, username: id, displayName: id, avatar: null });
const vs = (userId: string, o: object = {}) => ({ userId, guildId: 'g1', channelId: 'v1', selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false, suppress: false, ...o });
beforeEach(() => useData.setState({ users: { a: user('a'), b: user('b'), c: user('c'), d: user('d') }, voiceStates: {} } as never));
afterEach(cleanup);

describe('voice channel participants in the sidebar', () => {
  it('shows mute/deaf/server icons, LIVE and camera for other users, and updates live from VOICE_STATE_UPDATE', () => {
    useData.setState({ voiceStates: { a: vs('a', { selfMute: true }), b: vs('b', { selfDeaf: true }), c: vs('c', { serverMute: true, streaming: true, video: true }), d: vs('d', { serverDeaf: true }) } } as never);
    render(<VoiceMembers channelId="v1" />);
    const row = (n: string) => screen.getByText(n).closest('li')!;
    expect(within(row('a')).getByTestId('vs-self-mute')).toBeTruthy();
    expect(within(row('b')).getByTestId('vs-self-deaf')).toBeTruthy();
    expect(within(row('c')).getByTestId('vs-server-mute')).toBeTruthy();
    expect(within(row('c')).getByTestId('vs-live')).toBeTruthy();
    expect(within(row('c')).getByLabelText('Camera on')).toBeTruthy();
    expect(within(row('d')).getByTestId('vs-server-deaf')).toBeTruthy();
    act(() => { useData.getState().apply('VOICE_STATE_UPDATE', vs('a', { selfMute: false }) as never); });
    expect(within(row('a')).queryByLabelText('Muted')).toBeNull();
    act(() => { useData.getState().apply('VOICE_STATE_UPDATE', vs('a', { selfMute: true, selfDeaf: true }) as never); });
    expect(within(row('a')).getByTestId('vs-self-deaf')).toBeTruthy();
  });
});
