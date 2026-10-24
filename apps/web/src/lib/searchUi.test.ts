import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_RECENT, findMatches, hasToken, highlightTerms, loadRecent, pushRecent, saveRecent, splitHits, toggleToken } from './searchUi';

beforeEach(() => localStorage.clear());

describe('recent searches', () => {
  it('puts the newest first, de-dupes case-insensitively, ignores blanks and caps the list', () => {
    let l: string[] = [];
    l = pushRecent(l, 'pizza'); l = pushRecent(l, 'from:alice'); l = pushRecent(l, 'PIZZA ');
    expect(l).toEqual(['PIZZA', 'from:alice']);
    expect(pushRecent(l, ' ')).toBe(l); expect(pushRecent(l, 'a')).toBe(l);
    for (let i = 0; i < 20; i++) l = pushRecent(l, 'query ' + i);
    expect(l).toHaveLength(MAX_RECENT); expect(l[0]).toBe('query 19');
  });
  it('persists and survives corrupt storage', () => {
    saveRecent(['a b']); expect(loadRecent()).toEqual(['a b']);
    localStorage.setItem('jorcord.recentSearches.v1', '{nope'); expect(loadRecent()).toEqual([]);
  });
});

describe('highlighting', () => {
  it('takes words of two letters or more, longest first', () => expect(highlightTerms('Pizza, a night! pizza')).toEqual(['pizza', 'night']));
  it('finds case-insensitive, merged, non-overlapping ranges', () => {
    expect(findMatches('Pizza night, more pizzas', ['pizza'])).toEqual([[0, 5], [18, 23]]);
    expect(findMatches('foobar', ['foo', 'oob', 'bar'])).toEqual([[0, 6]]);
    expect(findMatches('nothing here', ['pizza'])).toEqual([]);
  });
  it('splits text into plain and hit segments', () => {
    expect(splitHits('a Pizza b', ['pizza'])).toEqual([{ text: 'a ', hit: false }, { text: 'Pizza', hit: true }, { text: ' b', hit: false }]);
  });
});

describe('filter chips', () => {
  it('toggles a token in the query string', () => {
    expect(toggleToken('hello', 'from:me')).toBe('hello from:me');
    expect(toggleToken('hello from:me', 'from:me')).toBe('hello');
    expect(hasToken('x FROM:Me', 'from:me')).toBe(true);
    expect(hasToken('x', 'from:me')).toBe(false);
  });
});
