import { describe, expect, it } from 'vitest';
import { ageText, blankBulk, bulkRequest, flagInfo, historyLabel, parseIdList, parseWarnCommand } from './modtools';

describe('/warn parsing', () => {
  it('splits the mention and the reason', () => {
    expect(parseWarnCommand('/warn <@123> spamming links\nin chat')).toEqual({ userId: '123', reason: 'spamming links\nin chat' });
    expect(parseWarnCommand('  /warn <@!9>   x ')).toEqual({ userId: '9', reason: 'x' });
    expect(parseWarnCommand('hello /warn <@1> x')).toBeNull(); expect(parseWarnCommand('/warning <@1> x')).toBeNull(); expect(parseWarnCommand('/shrug')).toBeNull();
    expect(parseWarnCommand('/warn')).toEqual({ error: 'Usage: /warn @member reason' }); expect(parseWarnCommand('/warn bob rude')).toEqual({ error: 'Usage: /warn @member reason' });
    expect(parseWarnCommand('/warn <@1>')).toEqual({ error: 'Add a reason: /warn @member reason' });
    expect(parseWarnCommand(`/warn <@1> ${'x'.repeat(501)}`)).toHaveProperty('error');
  });
});
describe('/warn with typed names', () => {
  const resolve = (n: string) => ({ bob: '7' } as Record<string, string>)[n.toLowerCase()];
  it('resolves @name through the callback', () => {
    expect(parseWarnCommand('/warn @Bob be nice', resolve)).toEqual({ userId: '7', reason: 'be nice' });
    expect(parseWarnCommand('/warn @nobody x', resolve)).toEqual({ error: 'No member named nobody' });
    expect(parseWarnCommand('/warn @bob', resolve)).toEqual({ error: 'Add a reason: /warn @member reason' });
    expect(parseWarnCommand('/warn @bob x')).toEqual({ error: 'Usage: /warn @member reason' });
  });
});
describe('bulk form', () => {
  it('parses id lists with mentions, duplicates and junk', () => {
    expect(parseIdList('1, 2\n<@3> 2;4')).toEqual({ ids: ['1', '2', '3', '4'], invalid: [], tooMany: false });
    expect(parseIdList('12 abc 1x').invalid).toEqual(['abc', '1x']); expect(parseIdList(Array.from({ length: 201 }, (_, i) => String(i + 1)).join(' ')).tooMany).toBe(true);
  });
  it('needs ids or a real filter and builds the request', () => {
    expect(bulkRequest(blankBulk)).toEqual({ error: 'Paste user ids or choose at least one filter' });
    expect(bulkRequest({ ...blankBulk, ids: '5 6' })).toEqual({ userIds: ['5', '6'] });
    expect(bulkRequest({ ...blankBulk, joinedMinutes: '30', noRoles: true })).toEqual({ filter: { joinedWithinMinutes: 30, noRoles: true } });
    expect(bulkRequest({ ...blankBulk, joinedMinutes: '999999', youngDays: '3', raidFlagged: true })).toEqual({ filter: { joinedWithinMinutes: 10080, accountYoungerThanDays: 3, raidFlagged: true } });
    expect(bulkRequest({ ...blankBulk, joinedMinutes: 'x' })).toHaveProperty('error'); expect(bulkRequest({ ...blankBulk, ids: 'nope' })).toHaveProperty('error');
    expect(bulkRequest({ ...blankBulk, ids: '1', noRoles: true })).toEqual({ userIds: ['1'], filter: { noRoles: true } });
  });
});
describe('labels', () => {
  it('flags, history, ages', () => {
    expect(flagInfo('new_account').label).toBe('New account'); expect(historyLabel('MEMBER_BAN_ADD')).toBe('Ban'); expect(historyLabel('X')).toBe('X');
    const now = Date.parse('2026-01-10T00:00:00Z');
    expect([ageText('2026-01-07T00:00:00Z', now), ageText('2026-01-09T00:00:00Z', now), ageText('2026-01-09T20:00:00Z', now), ageText('2026-01-09T23:30:00Z', now), ageText('2026-01-09T23:59:50Z', now), ageText('2024-01-01T00:00:00Z', now), ageText(null, now)])
      .toEqual(['3 days', '1 day', '4 hours', '30 minutes', 'just now', '2 years', 'unknown']);
  });
});
