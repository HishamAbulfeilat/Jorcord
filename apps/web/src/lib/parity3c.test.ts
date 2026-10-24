import { describe, expect, it } from 'vitest';
import { BLANK_FORM, buildRuleBody, formProblem } from './automod';
import { nameStyleClass } from './nameStyle';
import { usernameProblem } from '@/components/settings/AccountChanges';
import { isFoldedByIgnore } from '@/components/chat/IgnoredStub';
import { ttlSystemText } from '@/components/chat/JoinExtras';

const form = (o: Partial<typeof BLANK_FORM>) => ({ ...BLANK_FORM, name: 'r', ...o });
describe('display-name style', () => {
  it('maps catalog ids to classes and ignores unknown or default ones', () => {
    expect(nameStyleClass({ font: 'serif', effect: 'neon' })).toBe('dnf-serif dnx-neon');
    expect(nameStyleClass({ font: 'default', effect: 'none' })).toBe('');
    expect(nameStyleClass({ font: 'nope', effect: 'nope' })).toBe('');
    expect(nameStyleClass(null)).toBe('');
  });
});
describe('member profile AutoMod form', () => {
  it('needs a word or pattern and sends keywords and patterns', () => {
    expect(formProblem(form({ trigger: 'member_profile' }))).toBe('Add at least one word or pattern');
    expect(formProblem(form({ trigger: 'member_profile', keywords: 'scam' }))).toBeNull();
    expect(buildRuleBody(form({ trigger: 'member_profile', keywords: 'scam, free nitro', regex: '^bot\\d+$' }))).toMatchObject({ trigger: 'member_profile', keywords: ['scam', 'free nitro'], regexPatterns: ['^bot\\d+$'] });
  });
});
describe('username form check', () => {
  it('mirrors the server rule', () => {
    expect(usernameProblem('a', 'me')).toBeTruthy();
    expect(usernameProblem('bad name', 'me')).toBeTruthy();
    expect(usernameProblem('ME', 'me')).toBe('That is already your username');
    expect(usernameProblem('fresh.name', 'me')).toBeNull();
  });
});
describe('ignore folding', () => {
  const m = (type: string, id = 'u1') => ({ type, author: { id } }) as any;
  it('folds ordinary messages of ignored others only', () => {
    expect(isFoldedByIgnore(m('default'), { u1: true }, 'me')).toBe(true);
    expect(isFoldedByIgnore(m('default'), {}, 'me')).toBe(false);
    expect(isFoldedByIgnore(m('default', 'me'), { me: true }, 'me')).toBe(false);
    expect(isFoldedByIgnore(m('join'), { u1: true }, 'me')).toBe(false);
  });
});
describe('disappearing notice', () => {
  it('words the timer', () => {
    expect(ttlSystemText('86400')).toContain('1 day');
    expect(ttlSystemText('0')).toContain('turned off');
  });
});
