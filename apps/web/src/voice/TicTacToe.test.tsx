import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelActivity } from '@jorcord/shared';

const mocks = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), update: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { activities: mocks } }));

import { useData } from '@/stores/data';
import { useChannelActivities } from '@/stores/channelActivities';
import {
  BOARD_SIZE, TicTacToeView, canPlay, emptyBoard, initialTicTacToeState, markFor, otherMark,
  outcomeOf, placeMark, readTicTacToeState, ticTacToeState, type Cell,
} from './TicTacToe';
import { WatchTogetherPopover } from './WatchTogether';

const N = null;

const activity = (state: unknown, over: Partial<ChannelActivity> = {}): ChannelActivity => ({
  id: 'a1', channelId: 'v1', guildId: 'g1', kind: 'tictactoe', hostId: 'me', state,
  startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

beforeEach(() => {
  useData.setState({ me: { id: 'me' } } as never);
  useChannelActivities.setState({ byChannel: {} } as never);
  mocks.list.mockReset().mockResolvedValue({ activities: [] });
  mocks.start.mockReset().mockImplementation(async (_channelId: string, b: { kind: ChannelActivity['kind']; state: unknown }) => activity(b.state, { kind: b.kind }));
  mocks.update.mockReset().mockImplementation(async (_id: string, state: unknown) => activity(state, { updatedAt: '2026-01-01T00:00:10.000Z' }));
  mocks.end.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('tic-tac-toe state', () => {
  it('normalises untrusted stored state into a playable board', () => {
    expect(readTicTacToeState(undefined)).toEqual(initialTicTacToeState());
    expect(readTicTacToeState(null)).toEqual(initialTicTacToeState());
    expect(readTicTacToeState({ board: ['X', 'O'], turn: 'O' })).toEqual({ board: emptyBoard(), turn: 'O' });
    expect(readTicTacToeState({ board: ['X', 'bad', 'O', N, N, N, N, N, N], turn: 'nope' }))
      .toEqual({ board: ['X', N, 'O', N, N, N, N, N, N], turn: 'X' });
    expect(readTicTacToeState('not-an-object')).toEqual(initialTicTacToeState());
  });

  it('places a mark only on an empty in-range cell, without mutating the input', () => {
    const board = emptyBoard();
    expect(board).toHaveLength(BOARD_SIZE);
    const next = placeMark(board, 4, 'X');
    expect(next).toEqual([N, N, N, N, 'X', N, N, N, N]);
    expect(board).toEqual(emptyBoard());
    expect(placeMark(next!, 4, 'O')).toBeNull();
    expect(placeMark(board, -1, 'X')).toBeNull();
    expect(placeMark(board, 9, 'X')).toBeNull();
    expect(placeMark(board, 1.5, 'X')).toBeNull();
  });

  it('detects rows, columns, diagonals, draws and live games', () => {
    expect(outcomeOf(['X', 'X', 'X', N, N, N, N, N, N])).toBe('X');
    expect(outcomeOf(['O', N, N, 'O', N, N, 'O', N, N])).toBe('O');
    expect(outcomeOf(['X', N, N, N, 'X', N, N, N, 'X'])).toBe('X');
    expect(outcomeOf(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'])).toBe('draw');
    expect(outcomeOf(emptyBoard())).toBeNull();
  });

  it('gives the activity host X and the other player O', () => {
    const host = { hostId: 'u1' } as ChannelActivity;
    expect(markFor(host, 'u1')).toBe('X');
    expect(markFor(host, 'u2')).toBe('O');
    expect(markFor(host, undefined)).toBeNull();
    expect(otherMark('X')).toBe('O');
    expect(otherMark('O')).toBe('X');
  });

  it('only allows the player whose mark matches the live turn', () => {
    const board: Cell[] = ['X', N, N, N, N, N, N, N, N];
    expect(canPlay(board, 'O', 'O', 4)).toBe(true);
    expect(canPlay(board, 'O', 'X', 4)).toBe(false);
    expect(canPlay(board, 'O', 'O', 0)).toBe(false);
    expect(canPlay(board, 'O', null, 4)).toBe(false);
    expect(canPlay(['X', 'X', 'X', N, N, N, N, N, N], 'X', 'X', 4)).toBe(false);
  });

  it('round-trips a board and a turn', () => {
    const board: Cell[] = ['X', N, N, N, 'O', N, N, N, N];
    expect(ticTacToeState(board, 'X')).toEqual({ board, turn: 'X' });
  });
});

describe('TicTacToeView', () => {
  it('renders nothing when the channel has no tictactoe activity', () => {
    const { container } = render(<TicTacToeView channelId="v1" />);
    expect(container.querySelector('[data-testid="tictactoe"]')).toBeNull();
  });

  it('renders nine cells and announces the host’s turn', () => {
    useChannelActivities.setState({ byChannel: { v1: [activity(initialTicTacToeState())] } } as never);
    const { container } = render(<TicTacToeView channelId="v1" />);
    expect(container.querySelectorAll('[data-testid^="ttt-cell-"]')).toHaveLength(9);
    expect(screen.getByTestId('tictactoe-status').textContent).toBe('Your turn');
  });

  it('sends the host’s move as X and hands the turn to O', async () => {
    useChannelActivities.setState({ byChannel: { v1: [activity(initialTicTacToeState())] } } as never);
    render(<TicTacToeView channelId="v1" />);
    fireEvent.click(screen.getByTestId('ttt-cell-0'));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a1', {
      board: ['X', N, N, N, N, N, N, N, N], turn: 'O',
    }));
    await waitFor(() => expect(screen.getByTestId('tictactoe-status').textContent).toBe('Waiting for the other player…'));
  });

  it('validates the turn on the client: the wrong player cannot move', () => {
    useData.setState({ me: { id: 'u2' } } as never); // u2 is O, but it is X’s turn
    useChannelActivities.setState({ byChannel: { v1: [activity(initialTicTacToeState())] } } as never);
    render(<TicTacToeView channelId="v1" />);
    expect(screen.getByTestId('tictactoe-status').textContent).toBe('Waiting for the other player…');
    fireEvent.click(screen.getByTestId('ttt-cell-4'));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('lets the player whose turn it is move, and still refuses a taken cell', async () => {
    useData.setState({ me: { id: 'u2' } } as never); // u2 is O, and it is O’s turn
    useChannelActivities.setState({ byChannel: { v1: [activity({ board: ['X', N, N, N, N, N, N, N, N], turn: 'O' })] } } as never);
    render(<TicTacToeView channelId="v1" />);
    expect(screen.getByTestId('tictactoe-status').textContent).toBe('Your turn');
    fireEvent.click(screen.getByTestId('ttt-cell-0'));
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ttt-cell-4'));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a1', {
      board: ['X', N, N, N, 'O', N, N, N, N], turn: 'X',
    }));
  });

  it('announces the winner and freezes the board', () => {
    useChannelActivities.setState({ byChannel: { v1: [activity({ board: ['X', 'X', 'X', 'O', 'O', N, N, N, N], turn: 'X' })] } } as never);
    render(<TicTacToeView channelId="v1" />);
    expect(screen.getByTestId('tictactoe-status').textContent).toBe('X wins');
    fireEvent.click(screen.getByTestId('ttt-cell-5'));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('shows a draw when the board is full with no winner', () => {
    useChannelActivities.setState({ byChannel: { v1: [activity({ board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'], turn: 'O' })] } } as never);
    render(<TicTacToeView channelId="v1" />);
    expect(screen.getByTestId('tictactoe-status').textContent).toBe("It's a draw");
  });
});

describe('Tic-Tac-Toe in the activities popover', () => {
  it('starts a game with the initial board and turn', async () => {
    render(<WatchTogetherPopover channelId="v1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start Tic-Tac-Toe' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith('v1', {
      kind: 'tictactoe', state: { board: Array(9).fill(null), turn: 'X' },
    }));
  });

  it('lets the host end the running game, and tells viewers the host controls it', async () => {
    useChannelActivities.setState({ byChannel: { v1: [activity(initialTicTacToeState())] } } as never);
    mocks.list.mockResolvedValue({ activities: [activity(initialTicTacToeState())] });
    render(<WatchTogetherPopover channelId="v1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'End Tic-Tac-Toe' }));
    await waitFor(() => expect(mocks.end).toHaveBeenCalledWith('a1'));
  });

  it('does not offer a viewer the host-only end action', async () => {
    useData.setState({ me: { id: 'u2' } } as never);
    const game = activity(initialTicTacToeState());
    useChannelActivities.setState({ byChannel: { v1: [game] } } as never);
    mocks.list.mockResolvedValue({ activities: [game] });
    render(<WatchTogetherPopover channelId="v1" onClose={() => {}} />);
    expect(await screen.findByText('Tic-Tac-Toe is running in this channel.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End Tic-Tac-Toe' })).toBeNull();
  });
});
