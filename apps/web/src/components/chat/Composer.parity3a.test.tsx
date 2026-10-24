import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageFlags, Perm, snowflake } from '@jorcord/shared';
import type { Channel, Message } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { useUI } from '@/stores/ui';

const h = vi.hoisted(() => ({ perms: 0n }));
vi.mock('@/lib/api', () => ({ api: { messages: { send: vi.fn() }, channels: { typing: vi.fn().mockResolvedValue(undefined), ack: vi.fn().mockResolvedValue(undefined) } } }));
vi.mock('@/lib/gateway', () => ({ getGateway: () => ({ status: 'disconnected', sendTyping: vi.fn() }) }));
vi.mock('@/lib/useGuild', () => ({ useGuildPerms: () => h.perms }));
vi.mock('@/lib/hooks', () => ({ useIsMobile: () => false }));
import { api } from '@/lib/api';
import { Composer } from './Composer';

const BASE = Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.ATTACH_FILES | Perm.READ_MESSAGE_HISTORY;
const me = { id: 'u1', username: 'me', displayName: 'Me', avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' };
const chan = (o: Record<string, unknown> = {}) => ({ id: 'c1', type: 'text', name: 'general', guildId: 'g1', slowmode: 0, ...o }) as unknown as Channel;
const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;
const sent = () => (api.messages.send as ReturnType<typeof vi.fn>).mock.calls;
const type = (value: string) => { const ta = screen.getByPlaceholderText(/^Message #/) as HTMLTextAreaElement; fireEvent.change(ta, { target: { value } }); return ta; };
const enter = (ta: HTMLElement) => fireEvent.keyDown(ta, { key: 'Enter' });

beforeEach(() => {
  localStorage.clear(); h.perms = BASE;
  (api.messages.send as ReturnType<typeof vi.fn>).mockResolvedValue({ id: snowflake(), channelId: 'c1', author: me } as unknown as Message);
  useData.setState({ me, users: {}, guilds: {}, dms: {}, channels: {} } as never);
  useMessages.setState({ ch: {}, pending: [] } as never);
  useUI.setState({ drafts: {} } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('Composer: send silently / no embeds / @silent / /tts', () => {
  it('the silent and no-embeds toggles add flags to the next message and reset after sending', async () => {
    render(wrap(<Composer channel={chan()} />));
    const ta = type('see https://example.com');
    const silent = screen.getByTestId('composer-silent'); const noEmb = screen.getByTestId('composer-noembeds');
    fireEvent.click(silent); fireEvent.click(noEmb);
    expect(silent.getAttribute('aria-pressed')).toBe('true');
    enter(ta);
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]![1]).toMatchObject({ content: 'see https://example.com', flags: MessageFlags.SUPPRESS_NOTIFICATIONS | MessageFlags.SUPPRESS_EMBEDS });
    const ta2 = type('next one'); expect(screen.getByTestId('composer-silent').getAttribute('aria-pressed')).toBe('false');
    enter(ta2); await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]![1].flags).toBe(0);
  });

  it('a leading @silent token is stripped and sent as a flag', async () => {
    render(wrap(<Composer channel={chan()} />));
    enter(type('@silent quiet please'));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]![1]).toMatchObject({ content: 'quiet please', flags: MessageFlags.SUPPRESS_NOTIFICATIONS });
  });

  it('/tts sends with the TTS flag when SEND_TTS is held, and is refused without it', async () => {
    h.perms = BASE | Perm.SEND_TTS;
    const { unmount } = render(wrap(<Composer channel={chan()} />));
    enter(type('/tts hello room'));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]![1]).toMatchObject({ content: 'hello room', flags: MessageFlags.TTS });
    unmount();
    h.perms = BASE;
    render(wrap(<Composer channel={chan({ id: 'c2' })} />));
    enter(type('/tts nope'));
    await Promise.resolve();
    expect(sent()).toHaveLength(1); // nothing more was sent
  });
});

describe('Composer: attachment alt text', () => {
  it('lets you describe a staged file and sends the description with it', async () => {
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x'); URL.revokeObjectURL = vi.fn();
    const { container } = render(wrap(<Composer channel={chan()} />));
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['png'], 'cat.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByTestId('alt-toggle'));
    const alt = screen.getByTestId('alt-input') as HTMLTextAreaElement;
    expect(alt.maxLength).toBe(1024); expect(alt.getAttribute('aria-label')).toContain('cat.png');
    fireEvent.change(alt, { target: { value: 'A cat on a sofa' } });
    expect(screen.getByTestId('alt-toggle').getAttribute('aria-pressed')).toBe('true');
    enter(screen.getByPlaceholderText(/^Message #/));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]![1].descriptions).toEqual(['A cat on a sofa']);
    expect(sent()[0]![1].files).toHaveLength(1);
  });
});

describe('Composer: persistent drafts', () => {
  it('restores the saved draft after a reload and clears it on send', async () => {
    const first = render(wrap(<Composer channel={chan()} />));
    type('unfinished thought');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('jorcord.drafts.v1')!).items.c1.t).toBe('unfinished thought'), { timeout: 2000 });
    first.unmount(); useUI.setState({ drafts: {} } as never); // simulate a full reload: in-memory state is gone
    const ta = render(wrap(<Composer channel={chan()} />)).getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.value).toBe('unfinished thought');
    enter(ta);
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(localStorage.getItem('jorcord.drafts.v1')).toBeNull();
  });
});

describe('Composer: slowmode countdown', () => {
  const own = (ago: number) => ({ id: snowflake(Date.now() - ago), channelId: 'c1', author: me, type: 'default', content: 'x' }) as unknown as Message;
  it('shows a countdown after my recent message and blocks sending until it ends', async () => {
    useMessages.setState({ ch: { c1: { list: [own(2_000)], loading: false, loadedInitial: true, hasMoreOlder: false, hasMoreNewer: false } } } as never);
    render(wrap(<Composer channel={chan({ slowmode: 10 })} />));
    const timer = screen.getByTestId('slowmode-countdown');
    expect(timer.textContent).toMatch(/[789]s/); expect(timer.getAttribute('role')).toBe('timer');
    enter(type('too soon'));
    await Promise.resolve();
    expect(sent()).toHaveLength(0);
  });
  it('shows nothing when the wait is over, or for members who bypass slowmode', () => {
    useMessages.setState({ ch: { c1: { list: [own(60_000)], loading: false, loadedInitial: true, hasMoreOlder: false, hasMoreNewer: false } } } as never);
    const a = render(wrap(<Composer channel={chan({ slowmode: 10 })} />)); expect(screen.queryByTestId('slowmode-countdown')).toBeNull(); a.unmount();
    useMessages.setState({ ch: { c1: { list: [own(1_000)], loading: false, loadedInitial: true, hasMoreOlder: false, hasMoreNewer: false } } } as never);
    h.perms = BASE | Perm.BYPASS_SLOWMODE;
    render(wrap(<Composer channel={chan({ slowmode: 10 })} />)); expect(screen.queryByTestId('slowmode-countdown')).toBeNull();
  });
  it('a 429 SLOWMODE answer starts the countdown', async () => {
    const { ApiException } = await import('@/lib/transport');
    (api.messages.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiException(429, { code: 'SLOWMODE', message: 'Slowmode: wait 7s', details: { retryAfter: 7 } } as never, 7000));
    render(wrap(<Composer channel={chan({ slowmode: 7 })} />));
    enter(type('first'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect((await screen.findByTestId('slowmode-countdown')).textContent).toMatch(/[67]s/);
  });
});
