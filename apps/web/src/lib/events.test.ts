import { describe, expect, it } from 'vitest';
import type { ScheduledEvent } from '@jorcord/shared';
import { applyInterest, entityLabel, isoToLocalInput, localInputToIso, sortEvents, validateEvent, whenText } from './events';

const ev = (id: string, status: number, start: string, o: Partial<ScheduledEvent> = {}): ScheduledEvent => ({ id, guildId: 'g', channelId: 'c', creatorId: 'u', name: id, description: null, scheduledStartTime: start, scheduledEndTime: null, privacyLevel: 2, status, entityType: 2, location: null, image: null, userCount: 0, ...o });
const now = Date.parse('2026-10-10T12:00:00');

describe('event list', () => {
  it('lists active first, then by start; completed and canceled are hidden', () => {
    const l = sortEvents([ev('late', 1, '2026-10-12T10:00:00Z'), ev('soon', 1, '2026-10-11T10:00:00Z'), ev('live', 2, '2026-10-09T10:00:00Z'), ev('done', 3, '2026-10-08T10:00:00Z'), ev('gone', 4, '2026-10-08T10:00:00Z')]);
    expect(l.map((e) => e.id)).toEqual(['live', 'soon', 'late']);
  });
  it('interest changes the count and my flag, never below zero', () => {
    const e = ev('a', 1, '2026-10-11T10:00:00Z', { userCount: 1 });
    expect(applyInterest(e, 1, true)).toMatchObject({ userCount: 2, interested: true }); expect(applyInterest(e, 1, false)).toMatchObject({ userCount: 2 });
    expect(applyInterest({ ...e, userCount: 0, interested: true }, -1, true)).toMatchObject({ userCount: 0, interested: false });
  });
  it('labels entity types', () => { expect(entityLabel(1)).toBe('Stage'); expect(entityLabel(2)).toBe('Voice Channel'); expect(entityLabel(3)).toBe('Somewhere Else'); });
  it('whenText says today / tomorrow / a date', () => {
    const f = () => '6:30 PM';
    expect(whenText(new Date(2026, 9, 10, 18, 30).toISOString(), new Date(2026, 9, 10, 9).getTime(), f)).toBe('Today at 6:30 PM');
    expect(whenText(new Date(2026, 9, 11, 18, 30).toISOString(), new Date(2026, 9, 10, 9).getTime(), f)).toBe('Tomorrow at 6:30 PM');
    expect(whenText(new Date(2026, 9, 20, 18, 30).toISOString(), new Date(2026, 9, 10, 9).getTime(), f)).toMatch(/ at 6:30 PM$/);
  });
});

describe('datetime-local conversion', () => {
  it('round-trips local time through ISO', () => { const v = '2026-10-12T18:45'; expect(isoToLocalInput(localInputToIso(v))).toBe(v); expect(localInputToIso('')).toBeNull(); expect(localInputToIso('nope')).toBeNull(); expect(isoToLocalInput(null)).toBe(''); });
});

describe('validateEvent (mirrors the server rules)', () => {
  const base = { name: ' Game night ', description: ' fun ', entityType: 2, channelId: 'c1', location: '', start: '2026-10-12T18:00', end: '', recurrenceRule: null };
  it('voice/stage events need a channel and a future start', () => {
    const r = validateEvent(base, now); expect(r).toMatchObject({ ok: true, body: { name: 'Game night', description: 'fun', channelId: 'c1', location: null, scheduledEndTime: null, privacyLevel: 2, entityType: 2 } });
    expect(validateEvent({ ...base, channelId: '' }, now)).toEqual({ ok: false, error: 'Choose a channel' });
    expect(validateEvent({ ...base, start: '2026-10-09T18:00' }, now)).toEqual({ ok: false, error: 'The start time must be in the future' });
    expect(validateEvent({ ...base, start: '' }, now)).toEqual({ ok: false, error: 'Pick a start time' });
    expect(validateEvent({ ...base, name: ' ' }, now)).toEqual({ ok: false, error: 'Give your event a name' });
  });
  it('external events need a location and an end time, and send no channel', () => {
    const ext = { ...base, entityType: 3, channelId: 'c1', location: 'Town square', end: '2026-10-12T20:00' };
    expect(validateEvent(ext, now)).toMatchObject({ ok: true, body: { channelId: null, location: 'Town square' } });
    expect(validateEvent({ ...ext, location: ' ' }, now)).toEqual({ ok: false, error: 'Add a location' });
    expect(validateEvent({ ...ext, end: '' }, now)).toEqual({ ok: false, error: 'External events need an end time' });
  });
  it('the end must follow the start', () => { expect(validateEvent({ ...base, end: '2026-10-12T17:00' }, now)).toEqual({ ok: false, error: 'The end time must be after the start time' }); });
  it('recurrence: null when not set, included when set', () => {
    const r = validateEvent({ ...base, recurrenceRule: null }, now);
    expect(r).toMatchObject({ ok: true, body: { recurrenceRule: null } });
    const withRec = validateEvent({ ...base, recurrenceRule: { frequency: 'weekly', interval: 2, until: '' } }, now);
    expect(withRec).toMatchObject({ ok: true, body: { recurrenceRule: { frequency: 'weekly', interval: 2 } } });
  });
  it('recurrence: until must be after start', () => {
    const r = validateEvent({ ...base, recurrenceRule: { frequency: 'daily', interval: 1, until: '2026-10-12T17:00' } }, now);
    expect(r).toEqual({ ok: false, error: 'The repeat end date must be after the start time' });
  });
});
