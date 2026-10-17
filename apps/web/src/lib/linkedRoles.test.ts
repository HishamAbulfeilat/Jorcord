import { describe, expect, it } from 'vitest';
import type { RoleMetadataApp } from '@jorcord/shared';
import { blankDraft, describeCriterion, draftToCriterion, draftsToCriteria, progressText } from './linkedRoles';

const apps: RoleMetadataApp[] = [{ appId: '9', name: 'Rank', icon: null, fields: [{ key: 'level', name: 'Level', type: 'integer' }, { key: 'pro', name: 'Pro', type: 'boolean' }] }];
describe('linked role criteria', () => {
  it('describes every criterion in words', () => {
    expect(describeCriterion({ type: 'account_age_days', value: 1 })).toBe('Account is at least 1 day old');
    expect(describeCriterion({ type: 'join_age_days', value: 30 })).toBe('Member of this server for 30 days');
    expect(describeCriterion({ type: 'message_count', value: 1 })).toBe('Has sent at least 1 message here');
    expect(describeCriterion({ type: 'connection' })).toBe('Has a verified connection'); expect(describeCriterion({ type: 'connection', provider: 'github' })).toBe('Has a verified github connection');
    expect(describeCriterion({ type: 'app_metadata', appId: '9', key: 'level', op: '>=', value: 5 }, apps)).toBe('Rank: Level is at least 5');
    expect(describeCriterion({ type: 'app_metadata', appId: '9', key: 'pro', op: '=', value: true }, apps)).toBe('Rank: Pro is yes');
    expect(describeCriterion({ type: 'app_metadata', appId: 'x', key: 'k', op: '!=', value: 2 })).toBe('App: k is not equal to 2');
  });
  it('shows the caller their progress', () => {
    expect(progressText({ type: 'message_count', value: 30 }, { met: false, current: 12 })).toBe('12 / 30 messages');
    expect(progressText({ type: 'join_age_days', value: 7 }, { met: true, current: 9 })).toBe('9 / 7 days');
    expect(progressText({ type: 'connection' }, { met: false, current: false })).toBe('Not verified yet');
    expect(progressText({ type: 'app_metadata', appId: '9', key: 'level', op: '>=', value: 5 }, { met: false, current: null })).toBe('No value reported yet');
    expect(progressText({ type: 'app_metadata', appId: '9', key: 'level', op: '>=', value: 5 }, { met: true, current: 7 })).toBe('Currently 7');
  });
  it('turns editor drafts into criteria and rejects bad numbers', () => {
    expect(draftToCriterion({ ...blankDraft('message_count'), value: '25' })).toEqual({ criterion: { type: 'message_count', value: 25 } });
    expect(draftToCriterion({ ...blankDraft('message_count'), value: '0' })).toHaveProperty('error');
    expect(draftToCriterion({ ...blankDraft('account_age_days'), value: '3651' })).toHaveProperty('error');
    expect(draftToCriterion({ ...blankDraft('account_age_days'), value: '1.5' })).toHaveProperty('error');
    expect(draftToCriterion({ ...blankDraft('connection'), provider: 'twitch' })).toEqual({ criterion: { type: 'connection', provider: 'twitch' } });
    expect(draftToCriterion({ ...blankDraft('app_metadata'), appId: '9', key: 'level', op: '<=', value: '4' }, apps)).toEqual({ criterion: { type: 'app_metadata', appId: '9', key: 'level', op: '<=', value: 4 } });
    expect(draftToCriterion({ ...blankDraft('app_metadata'), appId: '9', key: 'pro', op: '>=', value: 'false' }, apps)).toEqual({ criterion: { type: 'app_metadata', appId: '9', key: 'pro', op: '=', value: false } }); // booleans only compare with = / !=
    expect(draftToCriterion({ ...blankDraft('app_metadata'), appId: '9', key: 'nope' }, apps)).toHaveProperty('error');
    expect(draftsToCriteria([])).toEqual({ error: 'Add at least one criterion' });
    expect(draftsToCriteria([blankDraft('message_count'), { ...blankDraft('join_age_days'), value: 'x' }])).toHaveProperty('error');
  });
});
