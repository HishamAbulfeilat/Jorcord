import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { interactions: { send: vi.fn().mockResolvedValue({ id: 'ix' }) }, messages: { vote: vi.fn(), removeVote: vi.fn(), endPoll: vi.fn() } } }));
import { api } from '@/lib/api';
import { EphemeralNotice, InteractionHeader, MessageComponents, PollResultBody, PollView, ThinkingBody, isLoadingMsg } from './MessageExtras';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { usePlatform } from '@/stores/platform';
import { useUI } from '@/stores/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = (id: string, o: Record<string, unknown> = {}) => ({ id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '', ...o });
const msg = (o: Partial<Message> = {}): Message => ({ id: 'm1', channelId: 'ch', guildId: null, author: user('bot1', { bot: true }), content: '', createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, applicationId: 'app1', ...o });

let host: HTMLDivElement; let root: Root;
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); };
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const q = (sel: string) => host.querySelector(sel); const qa = (sel: string) => [...host.querySelectorAll(sel)];

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useData.setState({ me: user('me') as never, users: { me: user('me'), bot1: user('bot1', { bot: true }), u2: user('u2') } as never, dms: { ch: { id: 'ch', guildId: null, type: 'dm', recipients: [user('u2'), user('me')] } as never } });
  usePlatform.getState().reset(); useMessages.setState({ ch: {}, pending: [] }); useUI.setState({ modal: null });
  vi.mocked(api.interactions.send).mockClear().mockResolvedValue({ id: 'ix' });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('message components', () => {
  const rows = [{ type: 1, components: [{ type: 2, style: 1, label: 'Accept', customId: 'ok' }, { type: 2, style: 4, label: 'Reject', customId: 'no' }, { type: 2, style: 5, label: 'Docs', url: 'https://example.test/docs' }, { type: 2, style: 2, label: 'Nope', customId: 'dis', disabled: true }] }];
  it('renders buttons with their style, a safe link button and a disabled one', async () => {
    await render(<MessageComponents m={msg({ components: rows })} />);
    const btns = qa('[data-component=button]'); expect(btns.map((b) => b.textContent)).toEqual(['Accept', 'Reject', 'Docs', 'Nope']);
    expect(btns[0]!.className).toContain('bg-brand'); expect(btns[1]!.className).toContain('bg-danger');
    const link = btns[2] as HTMLAnchorElement; expect(link.tagName).toBe('A'); expect(link.getAttribute('href')).toBe('https://example.test/docs'); expect(link.rel).toContain('noopener'); expect(link.target).toBe('_blank');
    expect((btns[3] as HTMLButtonElement).disabled).toBe(true);
  });
  it('pressing a button posts a type 3 interaction and shows a spinner until the app answers', async () => {
    await render(<MessageComponents m={msg({ components: rows })} />);
    await click(q('[data-custom-id=ok]'));
    expect(api.interactions.send).toHaveBeenCalledWith({ type: 3, channelId: 'ch', messageId: 'm1', data: { customId: 'ok' } });
    expect((q('[data-custom-id=ok]') as HTMLButtonElement).disabled).toBe(true); expect(q('[data-custom-id=ok] svg.animate-spin')).toBeTruthy();
    await act(async () => { usePlatform.getState().settle('ix'); });
    expect((q('[data-custom-id=ok]') as HTMLButtonElement).disabled).toBe(false);
  });
  it('a single string select submits the picked value at once', async () => {
    const select = { type: 1, components: [{ type: 3, customId: 'color', placeholder: 'Pick a colour', options: [{ label: 'Red', value: 'r' }, { label: 'Blue', value: 'b', description: 'cool' }] }] };
    await render(<MessageComponents m={msg({ components: [select] })} />);
    expect(q('[role=combobox]')!.textContent).toContain('Pick a colour');
    await click(q('[role=combobox]')); expect(qa('[role=option]')).toHaveLength(2);
    await click(qa('[role=option] button')[1]!);
    expect(api.interactions.send).toHaveBeenCalledWith({ type: 3, channelId: 'ch', messageId: 'm1', data: { customId: 'color', values: ['b'] } });
  });
  it('a multi select collects values and submits once when the list closes', async () => {
    const select = { type: 1, components: [{ type: 3, customId: 'multi', minValues: 1, maxValues: 2, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }] }] };
    await render(<MessageComponents m={msg({ components: [select] })} />);
    await click(q('[role=combobox]'));
    await click(qa('[role=option] button')[0]!); await click(qa('[role=option] button')[2]!); await click(qa('[role=option] button')[1]!); // third pick exceeds max 2: ignored
    expect(api.interactions.send).not.toHaveBeenCalled();
    await click(q('[role=combobox]'));
    expect(api.interactions.send).toHaveBeenCalledTimes(1); expect(api.interactions.send).toHaveBeenCalledWith({ type: 3, channelId: 'ch', messageId: 'm1', data: { customId: 'multi', values: ['a', 'c'] } });
  });
  it('a user select lists the people in the conversation', async () => {
    await render(<MessageComponents m={msg({ components: [{ type: 1, components: [{ type: 5, customId: 'who', placeholder: 'Who?' }] }] })} />);
    await click(q('[role=combobox]')); expect(qa('[role=option] .text-header').map((o) => o.textContent)).toEqual(['u2', 'me']);
  });
  it('renders nothing without action rows', async () => { await render(<MessageComponents m={msg({ components: [] })} />); expect(q('[data-testid=components]')).toBeNull(); });
});

describe('interaction chrome', () => {
  it('shows "X used /name" and the invoker is resolved from the user store', async () => {
    await render(<InteractionHeader m={msg({ interaction: { id: 'i', type: 2, name: 'roll', userId: 'u2' } })} />);
    expect(q('[data-testid=interaction-header]')!.textContent).toContain('u2'); expect(q('[data-testid=interaction-header]')!.textContent).toContain('/roll');
  });
  it('ephemeral notice says who can see it and Dismiss removes the message locally', async () => {
    const m = msg({ flags: 64 }); useMessages.getState().init('ch', [m], 50);
    await render(<EphemeralNotice m={m} />); expect(q('[data-testid=ephemeral-notice]')!.textContent).toContain('Only you can see this');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss message')!);
    expect(useMessages.getState().ch.ch!.list).toEqual([]);
  });
  it('LOADING messages read "is thinking…"', async () => { const m = msg({ flags: 128 }); expect(isLoadingMsg(m)).toBe(true); expect(isLoadingMsg(msg())).toBe(false); await render(<ThinkingBody m={m} />); expect(q('[data-testid=thinking]')!.textContent).toContain('bot1 is thinking…'); });
  it('poll results render as a card', async () => { await render(<PollResultBody m={msg({ type: 'poll_result', content: 'Lunch? - Pizza won with 2 votes' })} />); expect(q('[data-testid=poll-result]')!.textContent).toContain('Pizza won with 2 votes'); });
});

describe('PollView', () => {
  const poll = (o: Partial<NonNullable<Message['poll']>> = {}) => ({ question: 'Lunch?', answers: [{ id: 1, text: 'Pizza', count: 2, meVoted: false, emoji: null }, { id: 2, text: 'Sushi', count: 1, meVoted: false, emoji: null }], allowMultiselect: false, layoutType: 1 as const, expiry: new Date(Date.now() + 3 * 3600_000).toISOString(), isFinalized: false, totalVotes: 3, ...o });
  it('shows the question, counts and percentages, and the time left', async () => {
    await render(<PollView m={msg({ poll: poll() })} />);
    expect(q('[data-testid=poll]')!.textContent).toContain('Lunch?'); expect(qa('[data-testid=answer-count]').map((e) => e.textContent)).toEqual(['2 · 67%', '1 · 33%']); expect(q('[data-testid=poll-status]')!.textContent).toBe('Ends in 3 hours');
  });
  it('single choice: pick, Vote sends the answer ids and the response replaces the message', async () => {
    const m = msg({ poll: poll() }); useMessages.getState().init('ch', [m], 50);
    vi.mocked(api.messages.vote).mockResolvedValue({ ...m, poll: poll({ totalVotes: 4, answers: [{ id: 1, text: 'Pizza', count: 3, meVoted: true, emoji: null }, { id: 2, text: 'Sushi', count: 1, meVoted: false, emoji: null }] }) });
    await render(<PollView m={m} />);
    const vote = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Vote') as HTMLButtonElement; expect(vote.disabled).toBe(true);
    await click(q('[data-answer="1"]')); await click(q('[data-answer="2"]')); // single: second pick replaces the first
    expect(q('[data-answer="2"]')!.getAttribute('aria-checked')).toBe('true'); expect(q('[data-answer="1"]')!.getAttribute('aria-checked')).toBe('false');
    await click(q('[data-answer="1"]')); expect(vote.disabled).toBe(false); await click(vote);
    expect(api.messages.vote).toHaveBeenCalledWith('ch', 'm1', [1]);
    expect(useMessages.getState().ch.ch!.list[0]!.poll!.totalVotes).toBe(4);
  });
  it('multi choice toggles several answers', async () => {
    vi.mocked(api.messages.vote).mockResolvedValue(msg({ poll: poll() }));
    await render(<PollView m={msg({ poll: poll({ allowMultiselect: true }) })} />);
    expect(q('[data-testid=poll]')!.textContent).toContain('Select one or more answers');
    await click(q('[data-answer="1"]')); await click(q('[data-answer="2"]'));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Vote')!);
    expect(api.messages.vote).toHaveBeenCalledWith('ch', 'm1', [1, 2]);
  });
  it('a finalized poll is read-only with final results', async () => {
    await render(<PollView m={msg({ poll: poll({ isFinalized: true }) })} />);
    expect(q('[data-testid=poll-status]')!.textContent).toBe('Poll closed'); expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Vote')).toBe(false); expect((q('[data-answer="1"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid=poll]')!.textContent).toContain('Final results');
  });
  it('the author can end the poll, others cannot', async () => {
    await render(<PollView m={msg({ author: user('me') as never, poll: poll() })} />);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'End poll')).toBe(true);
    await render(<PollView m={msg({ poll: poll() })} />);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'End poll')).toBe(false);
  });
  it('"Remove vote" appears once I voted', async () => {
    vi.mocked(api.messages.removeVote).mockResolvedValue(msg({ poll: poll() }));
    await render(<PollView m={msg({ poll: poll({ answers: [{ id: 1, text: 'Pizza', count: 2, meVoted: true, emoji: null }, { id: 2, text: 'Sushi', count: 1, meVoted: false, emoji: null }] }) })} />);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove vote')!); expect(api.messages.removeVote).toHaveBeenCalledWith('ch', 'm1');
  });
});
