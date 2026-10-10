import { describe, expect, it } from 'vitest';
import type { Poll } from '@jorcord/shared';
import { applyPollVote, buildPoll, mergePollKeepingMine, pollEndsText, pollHint, pollOpen, pollPercent, sameSelection, toggleAnswer } from './polls';

const poll = (over: Partial<Poll> = {}): Poll => ({ question: 'Lunch?', answers: [{ id: 1, text: 'Pizza', count: 2, meVoted: false }, { id: 2, text: 'Sushi', count: 1, meVoted: true }], allowMultiselect: false, layoutType: 1, expiry: new Date(Date.now() + 3 * 3600_000).toISOString(), isFinalized: false, totalVotes: 3, ...over });

describe('poll votes', () => {
  it('applies live add/remove events to counts, totals and my own selection', () => {
    const a = applyPollVote(poll(), 1, 1, true); expect(a.answers[0]).toMatchObject({ count: 3, meVoted: true }); expect(a.totalVotes).toBe(3); // distinct voters: a person adding a 2nd answer does not add a voter
    const b = applyPollVote(a, 2, -1, true); expect(b.answers[1]).toMatchObject({ count: 0, meVoted: false }); expect(b.totalVotes).toBe(3);
    expect(applyPollVote(poll({ totalVotes: 2 }), 1, 1, false).totalVotes).toBe(3); // never below the biggest answer
    const c = applyPollVote(poll(), 1, 1, false); expect(c.answers[0]!.meVoted).toBe(false); expect(c.answers[0]!.count).toBe(3);
    expect(applyPollVote(poll(), 99, 1, true)).toEqual(poll()); // unknown answer: untouched
    expect(applyPollVote(poll({ answers: [{ id: 1, text: 'a', count: 0, meVoted: false }], totalVotes: 0 }), 1, -1, false).answers[0]!.count).toBe(0); // never negative
  });
  it('a broadcast update keeps what we know about my votes', () => {
    const fresh = poll({ isFinalized: true, answers: [{ id: 1, text: 'Pizza', count: 2, meVoted: false }, { id: 2, text: 'Sushi', count: 1, meVoted: false }] });
    const m = mergePollKeepingMine(fresh, poll()); expect(m.isFinalized).toBe(true); expect(m.answers.map((a) => a.meVoted)).toEqual([false, true]);
    expect(mergePollKeepingMine(fresh, null)).toBe(fresh);
  });
  it('percentages round and handle an empty poll', () => { expect(pollPercent(1, 3)).toBe(33); expect(pollPercent(2, 3)).toBe(67); expect(pollPercent(0, 0)).toBe(0); expect(pollPercent(5, 3)).toBe(100); });
  it('selection: single replaces/clears, multi toggles', () => {
    expect(toggleAnswer([], 1, false)).toEqual([1]); expect(toggleAnswer([1], 2, false)).toEqual([2]); expect(toggleAnswer([2], 2, false)).toEqual([]);
    expect(toggleAnswer([1], 2, true)).toEqual([1, 2]); expect(toggleAnswer([1, 2], 1, true)).toEqual([2]);
    expect(sameSelection([2, 1], [1, 2])).toBe(true); expect(sameSelection([1], [1, 2])).toBe(false);
  });
});

describe('poll status text', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  it('counts down in minutes, hours, days and closes at expiry or when finalized', () => {
    const at = (ms: number, o: Partial<Poll> = {}) => poll({ expiry: new Date(now + ms).toISOString(), ...o });
    expect(pollEndsText(at(90_000), now)).toBe('Ends in 2 minutes'); expect(pollEndsText(at(30_000), now)).toBe('Ends in 1 minute');
    expect(pollEndsText(at(3 * 3600_000), now)).toBe('Ends in 3 hours'); expect(pollEndsText(at(3 * 86_400_000), now)).toBe('Ends in 3 days');
    expect(pollEndsText(at(-1), now)).toBe('Poll closed'); expect(pollEndsText(at(3600_000, { isFinalized: true }), now)).toBe('Poll closed');
    expect(pollOpen(at(1000), now)).toBe(true); expect(pollOpen(at(1000, { isFinalized: true }), now)).toBe(false);
  });
  it('hints follow the mode', () => { expect(pollHint(poll())).toBe('Select one answer'); expect(pollHint(poll({ allowMultiselect: true }))).toBe('Select one or more answers'); expect(pollHint(poll({ isFinalized: true }))).toBe('Final results'); });
});

describe('poll draft', () => {
  const ok = { question: ' Lunch? ', answers: ['Pizza', ' ', 'Sushi'], hours: 24, multi: true };
  it('builds the send body, dropping blank answers', () => { expect(buildPoll(ok)).toEqual({ ok: true, poll: { question: 'Lunch?', answers: [{ text: 'Pizza' }, { text: 'Sushi' }], durationHours: 24, allowMultiselect: true } }); });
  it('rejects bad drafts with a readable error', () => {
    expect(buildPoll({ ...ok, question: ' ' })).toEqual({ ok: false, error: 'Ask a question' });
    expect(buildPoll({ ...ok, answers: ['one', ''] })).toEqual({ ok: false, error: 'Add at least two answers' });
    expect(buildPoll({ ...ok, answers: ['a', 'x'.repeat(56)] })).toMatchObject({ ok: false, error: expect.stringContaining('55') });
    expect(buildPoll({ ...ok, question: 'q'.repeat(301) })).toMatchObject({ ok: false, error: expect.stringContaining('300') });
  });
});
