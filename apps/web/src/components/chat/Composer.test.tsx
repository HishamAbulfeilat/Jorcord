import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Channel, Message } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';

vi.mock('@/lib/api', () => ({ api: { messages: { send: vi.fn() }, channels: { typing: vi.fn(), ack: vi.fn().mockResolvedValue(undefined) } } }));
vi.mock('@/lib/gateway', () => ({ getGateway: () => ({ status: 'disconnected', sendTyping: vi.fn() }) }));
vi.mock('@/lib/useGuild', () => ({ useGuildPerms: () => 0n }));
vi.mock('@/lib/hooks', () => ({ useIsMobile: () => false }));
import { api } from '@/lib/api';
import { Composer } from './Composer';

/* MediaRecorder shim: fires its own dataavailable/stop, records what options we asked for. */
class FakeRecorder {
  static all: FakeRecorder[] = [];
  static isTypeSupported(m: string) { return m === 'audio/webm;codecs=opus'; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  options?: MediaRecorderOptions;
  private listeners = new Map<string, Array<(e: { data?: Blob }) => void>>();
  constructor(_stream: unknown, options?: MediaRecorderOptions) { this.options = options; FakeRecorder.all.push(this); }
  addEventListener(type: string, cb: (e: { data?: Blob }) => void) { const a = this.listeners.get(type) ?? []; a.push(cb); this.listeners.set(type, a); }
  start() { this.state = 'recording'; this.fire('dataavailable', { data: new Blob(['chunk'], { type: 'audio/webm' }) }); }
  stop() { this.state = 'inactive'; this.fire('dataavailable', { data: new Blob(['tail'], { type: 'audio/webm' }) }); this.fire('stop'); }
  private fire(type: string, e?: { data?: Blob }) { for (const cb of this.listeners.get(type) ?? []) cb(e ?? {}); }
}

class FakeAudioContext {
  createMediaStreamSource() { return { connect: vi.fn() }; }
  createAnalyser() { return { fftSize: 512, getByteTimeDomainData: () => {} }; }
  close() { return Promise.resolve(); }
}

const gmu = vi.fn();
let lastStream: { track: { stop: ReturnType<typeof vi.fn> }; getTracks: () => unknown[] };
const chan = { id: 'dm1', type: 'dm', name: null, recipients: [{ id: 'u2', username: 'jess', displayName: 'Jess' }] } as unknown as Channel;
const myMessage = (o: Partial<Message> = {}): Message => ({ id: 'm9', channelId: 'dm1', guildId: null, author: { id: 'u2', username: 'jess', displayName: 'Jess', avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' }, content: '', createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, ...o });
const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;

beforeEach(() => {
  FakeRecorder.all = [];
  lastStream = fakeStream();
  gmu.mockReset().mockResolvedValue(lastStream);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  (window as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia: gmu }, configurable: true });
  URL.createObjectURL = vi.fn().mockReturnValue('blob:fake');
  URL.revokeObjectURL = vi.fn();
  (HTMLElement.prototype as unknown as Record<string, unknown>).setPointerCapture = vi.fn();
  useData.setState({ users: {}, guilds: {}, dms: { dm1: chan }, channels: {} } as never);
  useMessages.setState({ ch: {}, pending: [] } as never);
});

function fakeStream() {
  const track = { stop: vi.fn() };
  return { track, getTracks: () => [track] };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals(); vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).AudioContext;
});

describe('Composer voice messages', () => {
  it('shows a mic in a DM (server DM perms include SEND_VOICE_MESSAGES)', () => {
    render(wrap(<Composer channel={chan} />));
    expect(screen.getByTestId('voice-mic')).toBeTruthy();
  });

  it('hides the mic without SEND_VOICE_MESSAGES (guild perms mocked to none)', () => {
    const gchan = { id: 'g1', type: 'text', name: 'general', guildId: 'g1' } as unknown as Channel;
    render(wrap(<Composer channel={gchan} />));
    expect(screen.queryByTestId('voice-mic')).toBeNull();
  });

  it('hold to record, release to preview, send goes out as an audio/webm attachment', async () => {
    vi.mocked(api.messages.send).mockResolvedValue(myMessage());
    render(wrap(<Composer channel={chan} />));
    const mic = screen.getByTestId('voice-mic');

    fireEvent.pointerDown(mic);
    await screen.findByTestId('voice-recording'); // live strip appears once the mic is granted
    expect(gmu).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.all[0]!.options?.mimeType).toBe('audio/webm;codecs=opus');

    fireEvent.pointerUp(mic); // release -> preview
    await screen.findByTestId('voice-preview');
    expect(screen.queryByTestId('voice-recording')).toBeNull();
    expect(screen.getByTestId('voice-player-audio').getAttribute('src')).toBe('blob:fake');
    expect(screen.queryByText('voice-message')).toBeNull(); // text draft area is untouched

    const sent = vi.mocked(api.messages.send).mock.results.length; // before click there is no send
    expect(sent).toBe(0);
    fireEvent.click(screen.getByTestId('voice-send'));
    await waitFor(() => expect(api.messages.send).toHaveBeenCalledTimes(1));
    const args = vi.mocked(api.messages.send).mock.calls[0]!;
    expect(args[0]).toBe('dm1');
    expect(args[1]).toEqual(expect.objectContaining({ content: '' }));
    const files = args[1].files ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(File);
    expect((files[0] as File).type).toBe('audio/webm'); // bare mime so the server keeps it inline
    expect((files[0] as File).name).toMatch(/^voice-message-/);
  });

  it('cancel while holding discards the take and releases the mic', async () => {
    render(wrap(<Composer channel={chan} />));
    fireEvent.pointerDown(screen.getByTestId('voice-mic'));
    await screen.findByTestId('voice-recording');
    const stream = lastStream;
    fireEvent.click(screen.getByTestId('voice-cancel'));
    await waitFor(() => expect(stream.track.stop).toHaveBeenCalled());
    expect(screen.queryByTestId('voice-preview')).toBeNull();
    expect(screen.queryByTestId('voice-recording')).toBeNull();
  });
});
