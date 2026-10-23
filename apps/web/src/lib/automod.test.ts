import { describe, expect, it } from 'vitest';
import type { AutoModRule } from '@jorcord/shared';
import { BLANK_FORM, buildRuleBody, formProblem, ruleSummary, splitLines, toggleAction } from './automod';

const form = (o: Partial<typeof BLANK_FORM>) => ({ ...BLANK_FORM, name: 'r', ...o });
describe('suspicious_links rule', () => {
  it('sends the extra allowed domains and no keyword fields', () => {
    const b = buildRuleBody(form({ trigger: 'suspicious_links', allow: 'example.com, docs.example.org', actions: ['block', 'warn'] }));
    expect(b).toMatchObject({ trigger: 'suspicious_links', allowList: ['example.com', 'docs.example.org'], keywords: [], actions: ['block', 'warn'] });
    expect(formProblem(form({ trigger: 'suspicious_links' }))).toBeNull();
  });
});
describe('automod form', () => {
  it('validates before submit', () => {
    expect(formProblem(form({ name: ' ' }))).toBe('Name your rule');
    expect(formProblem(form({ keywords: '' }))).toBe('Add at least one word');
    expect(formProblem(form({ keywords: 'a' }))).toBeNull();
    expect(formProblem(form({ trigger: 'regex', regex: '' }))).toBe('Add at least one pattern');
    expect(formProblem(form({ trigger: 'regex', regex: 'x'.repeat(101) }))).toMatch(/100/);
    expect(formProblem(form({ trigger: 'regex', regex: Array(11).fill('a').join('\n') }))).toMatch(/10/);
    expect(formProblem(form({ trigger: 'link', actions: ['alert'] }))).toBe('Choose an alert channel');
    expect(formProblem(form({ trigger: 'link', actions: ['alert'], testMode: true }))).toBeNull();
    expect(formProblem(form({ trigger: 'link', actions: [] }))).toBe('Pick at least one action');
    expect(formProblem(form({ trigger: 'keyword_preset', presets: [] }))).toBe('Pick at least one word list');
  });
  it('sends only what the trigger and actions need, clamped to server limits', () => {
    expect(buildRuleBody(form({ trigger: 'regex', regex: 'a+\n\n  b ', actions: ['block', 'warn'], message: ' no ' }))).toMatchObject({ trigger: 'regex', regexPatterns: ['a+', 'b'], actions: ['block', 'warn'], customMessage: 'no', keywords: [] });
    const spam = buildRuleBody(form({ trigger: 'spam', spamCount: 99, spamSeconds: 0 })); expect(spam.options).toEqual({ spamCount: 30, spamSeconds: 2 }); expect(spam).not.toHaveProperty('regexPatterns');
    expect(buildRuleBody(form({ trigger: 'caps', capsPercent: 10 })).options).toEqual({ capsPercent: 50 });
    expect(buildRuleBody(form({ trigger: 'repeated_chars', repeatLimit: 7 })).options).toEqual({ repeatLimit: 7 });
    const t = buildRuleBody(form({ trigger: 'link', actions: ['timeout', 'alert'], timeoutMin: 2, alertChannelId: '9', testMode: true })); expect(t).toMatchObject({ timeoutSeconds: 120, alertChannelId: '9', testMode: true }); expect(t).not.toHaveProperty('customMessage');
    expect(buildRuleBody(form({ trigger: 'mention_spam', mentionLimit: 500 })).mentionLimit).toBe(50);
  });
  it('toggles actions in canonical order and summarises rules', () => {
    expect(toggleAction(['block'], 'alert')).toEqual(['block', 'alert']); expect(toggleAction(['alert'], 'block')).toEqual(['block', 'alert']); expect(toggleAction(['block'], 'block')).toEqual([]);
    expect(splitLines('a\r\n')).toEqual(['a']);
    const r = { trigger: 'regex', action: 'block', actions: ['block', 'alert'], keywords: [], regexPatterns: ['a'], testMode: true } as unknown as AutoModRule;
    expect(ruleSummary(r)).toBe('Pattern (regex) • → Block message + Send alert • 1 pattern • test mode');
  });
});
