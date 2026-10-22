import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ request: vi.fn(), queue: vi.fn(), speaker: vi.fn(), block: vi.fn(), blocked: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { voice: { stageRequest: m.request, stageQueue: m.queue, stageSpeaker: m.speaker, stageBlock: m.block, stageBlocked: m.blocked } } }));

import { useData } from '@/stores/data';
import { useLiveVoice } from '@/stores/livevoice';
import { useUI } from '@/stores/ui';
import { RaiseHand, StageBlockedList, StageHands, useStageBlocks, useStageQueue } from './StageQueue';

const user = (id: string, name: string) => ({ id, username: name, displayName: name, avatar: null });
const entry = (userId: string | null, position: number, anonymous = false) => ({ userId, anonymous, requestToSpeakAt: `2026-01-01T00:00:0${position}.000Z`, position });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.request.mockResolvedValue({ handPosition: 2 }); m.queue.mockResolvedValue([]); m.speaker.mockResolvedValue({}); m.block.mockResolvedValue({}); m.blocked.mockResolvedValue([]);
  useLiveVoice.getState().reset();
  useData.setState({ me: { id: 'me' }, users: { a: user('a', 'Ann'), b: user('b', 'Bob') }, voiceStates: {} } as never);
});
afterEach(cleanup);

describe('hands queue', () => {
  it('lists hands in order with their place; non-moderators get no buttons', () => {
    render(<StageHands channelId="st" mod={false} entries={[entry('a', 1), entry(null, 2, true)]} names={{ a: 'Ann' }} onBlocked={vi.fn()} />);
    const rows = screen.getAllByTestId('stage-hand');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Ann'), expect.stringContaining('Anonymous')]);
    expect(rows[0]!.textContent).toMatch(/^1/); expect(rows[1]!.textContent).toMatch(/^2/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('moderators invite from the queue, see who an anonymous hand is, and can block the asker', async () => {
    const blocked = vi.fn();
    render(<StageHands channelId="st" mod entries={[entry('a', 1), entry('b', 2, true)]} names={{}} onBlocked={blocked} />);
    expect(screen.getAllByTestId('stage-hand')[1]!.textContent).toContain('anonymous hand');
    fireEvent.click(screen.getAllByRole('button', { name: 'Invite to Speak' })[1]!);
    expect(m.speaker).toHaveBeenCalledWith('st', 'b', true);
    fireEvent.click(screen.getByRole('button', { name: 'Block Ann from speaking' }));
    await waitFor(() => expect(m.block).toHaveBeenCalledWith('st', 'a', true));
    await waitFor(() => expect(blocked).toHaveBeenCalled());
  });

  it('renders nothing for an empty queue', () => {
    const { container } = render(<StageHands channelId="st" mod entries={[]} names={{}} onBlocked={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('moderators read the queue from the API and re-read it when the gateway reports a change; others use the pushed queue', async () => {
    m.queue.mockResolvedValue([entry('a', 1)]);
    const mod = renderHook(() => useStageQueue('st', true));
    await waitFor(() => expect(mod.result.current.map((e) => e.userId)).toEqual(['a']));
    m.queue.mockResolvedValue([entry('b', 1), entry('a', 2)]);
    act(() => useLiveVoice.getState().setQueue('st', [entry('b', 1), entry(null, 2, true)]));
    await waitFor(() => expect(mod.result.current.map((e) => e.userId)).toEqual(['b', 'a']));
    const audience = renderHook(() => useStageQueue('st', false));
    expect(audience.result.current.map((e) => e.userId)).toEqual(['b', null]); // identity of the anonymous hand stays hidden
    expect(m.queue).toHaveBeenCalledTimes(2);
  });

  it('falls back to the public hand marks in the voice states before any update arrived', () => {
    const vs = (userId: string, at: string | null, suppress = true) => ({ userId, channelId: 'st', suppress, requestToSpeakAt: at });
    useData.setState({ voiceStates: { a: vs('a', '2026-01-01T00:00:09.000Z'), b: vs('b', '2026-01-01T00:00:03.000Z'), c: vs('c', null), d: vs('d', '2026-01-01T00:00:01.000Z', false) } } as never);
    const { result } = renderHook(() => useStageQueue('st', false));
    expect(result.current.map((e) => [e.userId, e.position])).toEqual([['b', 1], ['a', 2]]);
  });
});

describe('blocked speakers', () => {
  it('lists blocks for moderators and unblocks', async () => {
    m.blocked.mockResolvedValue([{ userId: 'a', blockedBy: 'me', reason: 'spam', createdAt: '2026-01-01T00:00:00.000Z' }]);
    const hook = renderHook(() => useStageBlocks('st', true));
    await waitFor(() => expect(hook.result.current.blocks).toHaveLength(1));
    const refresh = vi.fn();
    render(<StageBlockedList channelId="st" blocks={hook.result.current.blocks} refresh={refresh} />);
    expect(screen.getByText('spam')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Unblock/ }));
    await waitFor(() => expect(m.block).toHaveBeenCalledWith('st', 'a', false));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const none = renderHook(() => useStageBlocks('st', false));
    await new Promise((r) => setTimeout(r, 10));
    expect(none.result.current.blocks).toEqual([]); expect(m.blocked).toHaveBeenCalledTimes(1);
  });
});

describe('raise hand', () => {
  it('raises a hand, shows the place in line, and lowers it again', async () => {
    render(<RaiseHand channelId="st" myHand={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request to Speak' }));
    await waitFor(() => expect(m.request).toHaveBeenCalledWith('st', true, { anonymous: false }));
    expect((await screen.findByTestId('hand-position')).textContent).toContain('number 2 in line');
    fireEvent.click(screen.getByRole('button', { name: 'Lower Hand' }));
    await waitFor(() => expect(m.request).toHaveBeenLastCalledWith('st', false, { anonymous: false }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request to Speak' })).toBeTruthy());
  });

  it('can raise the hand anonymously and says only moderators can see it', async () => {
    render(<RaiseHand channelId="st" myHand={false} />);
    fireEvent.click(screen.getByLabelText('Raise my hand anonymously'));
    fireEvent.click(screen.getByRole('button', { name: 'Request to Speak' }));
    await waitFor(() => expect(m.request).toHaveBeenCalledWith('st', true, { anonymous: true }));
    expect((await screen.findByTestId('hand-position')).textContent).toContain('only moderators can see it is you');
  });

  it('follows the gateway (position changes, hand taken by an invite) and shows a refusal as a toast', async () => {
    render(<RaiseHand channelId="st" myHand />);
    expect(screen.getByRole('button', { name: 'Lower Hand' })).toBeTruthy(); // the public voice state said my hand was up
    act(() => useLiveVoice.getState().setHand('st', { raised: true, anonymous: false, position: 1 }));
    expect(screen.getByTestId('hand-position').textContent).toContain('number 1 in line');
    act(() => useLiveVoice.getState().setHand('st', { raised: false, anonymous: false, position: null }));
    expect(screen.getByRole('button', { name: 'Request to Speak' })).toBeTruthy();
    m.request.mockRejectedValue(new Error('You cannot ask to speak on this stage'));
    fireEvent.click(screen.getByRole('button', { name: 'Request to Speak' }));
    await waitFor(() => expect(useUI.getState().toasts.some((x) => x.text.includes('cannot ask to speak'))).toBe(true));
  });
});
