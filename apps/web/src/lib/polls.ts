/** Poll helpers: duration choices, percentages, live vote application and the "ends in" text. */
import type { Poll } from '@jorcord/shared';

export const POLL_DURATIONS: { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' }, { hours: 4, label: '4 hours' }, { hours: 8, label: '8 hours' }, { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' }, { hours: 168, label: '1 week' }, { hours: 336, label: '2 weeks' },
];
export const POLL_LIMITS = { question: 300, answer: 55, answers: 10 } as const;

/** Share of voters (not of ballots: with several answers per person the bars can each reach 100%). */
export const pollPercent = (count: number, total: number) => (total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0);

/**
 * Apply a MESSAGE_POLL_VOTE_ADD (delta +1) / _REMOVE (-1) to a poll for instant feedback. `mine` keeps the viewer's own selection in sync.
 * `totalVotes` is the number of distinct voters, which one answer-level event cannot tell: it is only kept >= the biggest answer
 * until the caller re-reads the message (see `refreshPoll` in lib/session.ts) and gets the exact figure.
 */
export function applyPollVote(poll: Poll, answerId: number, delta: 1 | -1, mine: boolean): Poll {
  if (!poll.answers.some((a) => a.id === answerId)) return poll;
  const answers = poll.answers.map((a) => (a.id === answerId ? { ...a, count: Math.max(0, a.count + delta), meVoted: mine ? delta > 0 : a.meVoted } : a));
  return { ...poll, answers, totalVotes: Math.max(poll.totalVotes, ...answers.map((a) => a.count)) };
}

/** A broadcast MESSAGE_UPDATE has no viewer: keep what we know about my own votes when merging its poll. */
export function mergePollKeepingMine(next: Poll, prev: Poll | null | undefined): Poll {
  if (!prev) return next;
  const mine = new Map(prev.answers.map((a) => [a.id, a.meVoted]));
  return { ...next, answers: next.answers.map((a) => ({ ...a, meVoted: mine.get(a.id) ?? a.meVoted })) };
}

export const pollOpen = (p: Poll, now = Date.now()) => !p.isFinalized && Date.parse(p.expiry) > now;

/** "Ends in 3 hours", "Ends in 12 minutes", "Poll closed". */
export function pollEndsText(p: Poll, now = Date.now()): string {
  if (!pollOpen(p, now)) return 'Poll closed';
  const ms = Date.parse(p.expiry) - now; const min = Math.ceil(ms / 60_000);
  if (min < 60) return `Ends in ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.ceil(min / 60);
  if (h < 48) return `Ends in ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.ceil(h / 24);
  return `Ends in ${d} days`;
}

export const pollHint = (p: Poll) => (p.isFinalized ? 'Final results' : p.allowMultiselect ? 'Select one or more answers' : 'Select one answer');

/** Selection after clicking an answer: single-select replaces, multi-select toggles. */
export function toggleAnswer(sel: number[], id: number, multi: boolean): number[] {
  if (!multi) return sel.length === 1 && sel[0] === id ? [] : [id];
  return sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
}

export const sameSelection = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export interface PollDraft { question: string; answers: string[]; hours: number; multi: boolean }
/** Draft -> `poll` body, or an error string. At least two non-empty answers (like Discord's UI). */
export function buildPoll(d: PollDraft): { ok: true; poll: { question: string; answers: { text: string }[]; durationHours: number; allowMultiselect: boolean } } | { ok: false; error: string } {
  const question = d.question.trim(); const answers = d.answers.map((a) => a.trim()).filter(Boolean);
  if (!question) return { ok: false, error: 'Ask a question' };
  if (question.length > POLL_LIMITS.question) return { ok: false, error: `The question can be at most ${POLL_LIMITS.question} characters` };
  if (answers.length < 2) return { ok: false, error: 'Add at least two answers' };
  if (answers.some((a) => a.length > POLL_LIMITS.answer)) return { ok: false, error: `Answers can be at most ${POLL_LIMITS.answer} characters` };
  return { ok: true, poll: { question, answers: answers.map((text) => ({ text })), durationHours: d.hours, allowMultiselect: d.multi } };
}
