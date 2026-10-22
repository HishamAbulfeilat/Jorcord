import { ApiError, badRequest, forbidden } from '../errors';

export type Mark = 'X' | 'O';
export type Cell = Mark | null;
/** Server-held Tic-Tac-Toe state. X is always the activity host; `o` is the first other voice participant to move as O. */
export interface TttState { board: Cell[]; turn: Mark; o: string | null }

const isMark = (v: unknown): v is Mark => v === 'X' || v === 'O';
const other = (m: Mark): Mark => (m === 'X' ? 'O' : 'X');
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const;

export const initialTtt = (): TttState => ({ board: Array.from({ length: 9 }, () => null), turn: 'X', o: null });

export function tttOutcome(board: Cell[]): Mark | 'draw' | null {
  for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]!;
  return board.every((c) => c !== null) ? 'draw' : null;
}

/** Strictly parse a client-supplied `{ board, turn }` (any `o` key is ignored: the server owns seat assignment). */
function parseProposed(v: unknown): { board: Cell[]; turn: Mark } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badRequest('Invalid game state');
  const s = v as Record<string, unknown>;
  if (Object.keys(s).some((k) => k !== 'board' && k !== 'turn' && k !== 'o')) throw badRequest('Invalid game state');
  if (!Array.isArray(s.board) || s.board.length !== 9 || !s.board.every((c) => c === null || isMark(c)) || !isMark(s.turn)) throw badRequest('Invalid game state');
  return { board: s.board as Cell[], turn: s.turn };
}

/** Read the stored state, tolerating legacy rows. */
export function readStored(v: unknown): TttState {
  try { const p = parseProposed(v); return { ...p, o: typeof (v as any).o === 'string' ? (v as any).o : null }; } catch { return initialTtt(); }
}

/**
 * Validate one move (or a rematch) from `userId` against the stored state and return the next state.
 * A move must place the current turn's mark on exactly one empty cell and pass the turn; only that seat's player may make it.
 */
export function applyTttMove(prev: TttState, hostId: string, userId: string, proposed: unknown): TttState {
  const next = parseProposed(proposed);
  const over = tttOutcome(prev.board) !== null;
  const isPlayer = userId === hostId || userId === prev.o;
  if (next.board.every((c) => c === null)) { // rematch / reset
    if (next.turn !== 'X') throw badRequest('Invalid game state');
    if (!isPlayer || (!over && userId !== hostId)) throw forbidden('Only a player can reset, and only the host before the game ends');
    return { board: next.board, turn: 'X', o: prev.o };
  }
  if (over) throw new ApiError(409, 'GAME_OVER', 'The game is over');
  const mark = prev.turn;
  let o = prev.o;
  if (mark === 'X') { if (userId !== hostId) throw forbidden('It is not your turn'); }
  else if (o) { if (userId !== o) throw forbidden('It is not your turn'); }
  else { if (userId === hostId) throw forbidden('It is not your turn'); o = userId; } // first non-host mover claims O
  if (next.turn !== other(mark)) throw badRequest('The turn must pass to the other player');
  let changed = -1;
  for (let i = 0; i < 9; i++) {
    if (next.board[i] === prev.board[i]) continue;
    if (changed !== -1 || prev.board[i] !== null || next.board[i] !== mark) throw badRequest('Illegal move');
    changed = i;
  }
  if (changed === -1) throw badRequest('Illegal move');
  return { board: next.board, turn: next.turn, o };
}
