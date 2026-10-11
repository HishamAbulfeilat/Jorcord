import { describe, expect, it } from 'vitest';
import { RegexError, compileSafeRegex as c } from '../src/lib/saferegex';

describe('safe regex engine', () => {
  const t = (p: string, s: string) => c(p).test(s);
  it('matches the supported syntax like RegExp/i', () => {
    const cases: [string, string][] = [
      ['abc', 'xxABCxx'], ['^abc$', 'abc'], ['^abc$', 'abcd'], ['a.c', 'a-c'], ['a.c', 'a\nc'], ['colou?r', 'color'], ['colou?r', 'colour'], ['a{2,3}', 'a'], ['a{2,3}', 'aa'],
      ['^a{2}$', 'aaa'], ['^a{2,}$', 'aaaaa'], ['(ab|cd)+e', 'abcde'], ['(ab|cd)+e', 'abce'], ['[a-c]+z', 'abz'], ['[^a-c]z', 'bz'], ['[^a-c]z', 'dz'], ['\\d{3}-\\d{4}', 'call 555-1234'],
      ['\\bcat\\b', 'a cat sat'], ['\\bcat\\b', 'concatenate'], ['\\Bcat', 'concat'], ['free\\s+nitro', 'FREE   nitro'], ['(?:x|y)z', 'yz'], ['\\w+@\\w+\\.com', 'me@site.com'], ['[\\d.]+', 'v1.2'], ['a\\.b', 'a.b'], ['a\\.b', 'axb'],
      ['é+', 'ÉÉ'], ['^$', ''], ['(a|b)*c', 'ababc'], ['x*', 'anything'],
    ];
    for (const [p, s] of cases) expect(t(p, s), `${p} on ${JSON.stringify(s)}`).toBe(new RegExp(p, 'i').test(s));
  });
  it('rejects unsafe or unsupported syntax with a RegexError', () => {
    for (const p of ['(a)\\1', '(?=a)', '(?<n>a)', '\\p{L}', 'a**', '*a', '(a', 'a)', '[a-', 'a{200}', 'a{3,1}', '', 'x'.repeat(101), '\\', '[b-a]', '(((a{50}){50}){50})', 'a++']) {
      expect(() => c(p), p.slice(0, 20)).toThrow(RegexError);
    }
  });
  it('is linear time on catastrophic patterns', () => {
    const evil = ['(a+)+$', '(a|a)*b', '(a*)*b', '(x+x+)+y', '^(a+)+$', '(.*a){20}', 'a*a*a*a*a*a*a*b'];
    const input = 'a'.repeat(3900) + '!';
    for (const p of evil) {
      const t0 = Date.now(); c(p).test(input);
      expect(Date.now() - t0, p).toBeLessThan(1500);
    }
    expect(c('(a+)+$').test('a'.repeat(30) + '!')).toBe(false);
    expect(c('(a+)+$').test('aaa')).toBe(true);
  });
});
