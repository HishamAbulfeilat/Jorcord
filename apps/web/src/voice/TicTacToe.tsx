/**
 * Tic-Tac-Toe activity UI: a 3×3 board shared by the two players in a voice call. The server stores the
 * opaque state (`{ board, turn }`) and enforces its size limit; whose move it is, and which mark is yours,
 * are validated here on the client. Renders nothing until a tictactoe activity exists for the channel.
 */
import { useState } from 'react';
import { Gamepad2 } from 'lucide-react';
import type { ChannelActivity } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useChannelActivities } from '@/stores/channelActivities';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

export type Mark = 'X' | 'O';
export type Cell = Mark | null;
export interface TicTacToeState { board: Cell[]; turn: Mark }

export const BOARD_SIZE = 9;

/** A fresh, all-empty board. Always a new array: the state passed to the API must never alias a store value. */
export function emptyBoard(): Cell[] { return Array.from({ length: BOARD_SIZE }, () => null); }
export function initialTicTacToeState(): TicTacToeState { return { board: emptyBoard(), turn: 'X' }; }
export function ticTacToeState(board: Cell[], turn: Mark): TicTacToeState { return { board, turn }; }

const isMark = (v: unknown): v is Mark => v === 'X' || v === 'O';
export const otherMark = (m: Mark): Mark => (m === 'X' ? 'O' : 'X');

/** Read whatever the server stored as the activity state into a known shape (untrusted: it round-trips through the API). */
export function readTicTacToeState(state: unknown): TicTacToeState {
  const s = (state && typeof state === 'object' ? state : {}) as { board?: unknown; turn?: unknown };
  const board = Array.isArray(s.board) && s.board.length === BOARD_SIZE ? s.board.map((c) => (isMark(c) ? c : null)) : emptyBoard();
  return { board, turn: isMark(s.turn) ? s.turn : 'X' };
}

/** Place `mark` on an empty in-range cell; returns a new board, or null when the move is illegal. */
export function placeMark(board: Cell[], index: number, mark: Mark): Cell[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= BOARD_SIZE || board[index] !== null) return null;
  const next = board.slice();
  next[index] = mark;
  return next;
}

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export type Outcome = Mark | 'draw' | null;
/** The winning mark, 'draw' once the board is full, or null while the game is live. */
export function outcomeOf(board: Cell[]): Outcome {
  for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return board.every((c) => c !== null) ? 'draw' : null;
}

/** The mark the given user plays: the activity host is X, the other player in the call is O. */
export function markFor(activity: Pick<ChannelActivity, 'hostId'>, userId: string | undefined | null): Mark | null {
  return userId ? (activity.hostId === userId ? 'X' : 'O') : null;
}

/** Client-side turn validation: only the player whose mark matches the live turn may fill an empty cell. */
export function canPlay(board: Cell[], turn: Mark, mark: Mark | null, index: number): boolean {
  return mark !== null && mark === turn && outcomeOf(board) === null && board[index] === null;
}

const CELL = 'flex h-14 w-14 items-center justify-center rounded bg-[rgb(var(--active))] text-2xl font-bold text-header enabled:hover:bg-[rgb(var(--divider))] disabled:opacity-50 disabled:cursor-default';

/** The board is rendered under the call surface so every member in the call sees the same game. */
export function TicTacToeView({ channelId }: { channelId: string }) {
  const activity = useChannelActivities((s) => s.byChannel[channelId]?.find((a) => a.kind === 'tictactoe') ?? null);
  const upsert = useChannelActivities((s) => s.upsert);
  const me = useData((s) => s.me?.id);
  const [busy, setBusy] = useState(false);
  if (!activity) return null;
  const { board, turn } = readTicTacToeState(activity.state);
  const mine = markFor(activity, me);
  const outcome = outcomeOf(board);
  const myTurn = mine !== null && mine === turn && outcome === null;

  const play = async (index: number) => {
    if (busy || mine === null || !canPlay(board, turn, mine, index)) return;
    const next = placeMark(board, index, mine);
    if (!next) return;
    setBusy(true);
    try { upsert(await api.activities.update(activity.id, ticTacToeState(next, otherMark(mine)))); }
    catch { /* keep the current board; the next ACTIVITY_UPDATE catches up */ }
    finally { setBusy(false); }
  };

  const status = outcome === 'draw' ? t("It's a draw")
    : outcome ? t('{mark} wins', { mark: outcome })
    : myTurn ? t('Your turn')
    : t('Waiting for the other player…');

  return (
    <div data-testid="tictactoe" className="shrink-0 border-b border-divider/70 bg-[rgb(var(--rail)/0.35)] px-3 py-2">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 pb-2">
        <Gamepad2 size={18} className="shrink-0 text-muted" />
        <span className="truncate text-sm font-semibold text-header">{t('Tic-Tac-Toe')}</span>
        <span data-testid="tictactoe-status" aria-live="polite" className="ms-auto text-xs text-muted">{status}</span>
      </div>
      <div role="group" aria-label={t('Tic-Tac-Toe')} className="mx-auto grid w-fit grid-cols-3 gap-1.5">
        {board.map((cell, index) => {
          const playable = !busy && canPlay(board, turn, mine, index);
          return (
            <button key={index} type="button" data-testid={`ttt-cell-${index}`} disabled={!playable}
              aria-label={t('Row {row}, column {column}', { row: Math.floor(index / 3) + 1, column: (index % 3) + 1 })}
              onClick={() => void play(index)} className={cx(CELL, cell === 'X' && 'text-brand', cell === 'O' && 'text-mention')}>
              {cell ?? ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}
