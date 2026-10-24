import { describe, expect, it } from 'vitest';
import type { Member, User } from '@jorcord/shared';
import { parseSearchTokens, resolveUser, toSearchRequest } from './searchTokens';

const member = (id: string, username: string, nick: string | null = null, displayName: string | null = null) =>
  ({ user: { id, username, displayName } as User, nick }) as Pick<Member, 'user' | 'nick'>;
const members = [member('11', 'alice', 'Ally'), member('22', 'bob', null, 'Bobby Tables')];

describe('parseSearchTokens', () => {
  it('returns plain text untouched', () => {
    expect(parseSearchTokens('hello   world')).toMatchObject({ text: 'hello world', from: [], has: [], mentions: [] });
  });
  it('extracts every token type and leaves the rest as text', () => {
    const p = parseSearchTokens('deploy from:alice mentions:<@22> has:image has:link before:2026-03-01 after:123456789 during:2026-03-02 pinned:true sort:relevance order:asc notes');
    expect(p).toEqual({ text: 'deploy notes', from: ['alice'], mentions: ['22'], inChannel: [], has: ['image', 'link'], before: '2026-03-01', after: '123456789', during: '2026-03-02', pinned: true, sortBy: 'relevance', sortOrder: 'asc' });
  });
  it('is case-insensitive on keys and has values, and de-duplicates has', () => {
    expect(parseSearchTokens('HAS:Video has:video From:Bob').has).toEqual(['video']);
    expect(parseSearchTokens('From:Bob').from).toEqual(['Bob']);
  });
  it('supports quoted values and strips @ / <@!id>', () => {
    expect(parseSearchTokens('from:"Bobby Tables" x').from).toEqual(['Bobby Tables']);
    expect(parseSearchTokens('from:@alice mentions:<@!22>')).toMatchObject({ from: ['alice'], mentions: ['22'] });
  });
  it('keeps invalid tokens as text', () => {
    const p = parseSearchTokens('has:banana before:soon after:2026-13-45 sort:size order:up from: foo:bar');
    expect(p.has).toEqual([]);
    expect(p.before).toBeUndefined();
    expect(p.after).toBeUndefined();
    expect(p.sortBy).toBeUndefined();
    expect(p.text).toBe('has:banana before:soon after:2026-13-45 sort:size order:up from: foo:bar');
  });
  it('accepts ISO datetimes for bounds', () => {
    expect(parseSearchTokens('before:2026-03-01T10:30:00Z').before).toBe('2026-03-01T10:30:00Z');
  });
  it('parses pinned and during, case-insensitively', () => {
    expect(parseSearchTokens('x pinned:true during:2026-03-01')).toMatchObject({ text: 'x', pinned: true, during: '2026-03-01' });
    expect(parseSearchTokens('PINNED:False').pinned).toBe(false);
    expect(parseSearchTokens('during:"2026-03-01"').during).toBe('2026-03-01');
  });
  it('keeps invalid pinned/during tokens as text', () => {
    const p = parseSearchTokens('pinned:yes during:soon during:2026-13-45 during:2026-03-01T10:30Z');
    expect(p.pinned).toBeUndefined();
    expect(p.during).toBeUndefined();
    expect(p.text).toBe('pinned:yes during:soon during:2026-13-45 during:2026-03-01T10:30Z');
  });
  it('keeps quoted phrases without a key intact', () => {
    expect(parseSearchTokens('"exact phrase" has:file').text).toBe('"exact phrase"');
  });
});

describe('resolveUser / toSearchRequest', () => {
  it('resolves ids, usernames, nicknames and display names', () => {
    expect(resolveUser('99', members)).toBe('99');
    expect(resolveUser('ALICE', members)).toBe('11');
    expect(resolveUser('ally', members)).toBe('11');
    expect(resolveUser('bobby tables', members)).toBe('22');
    expect(resolveUser('nobody', members)).toBeNull();
  });
  it('builds API params and reports unknown names', () => {
    const { req, unresolved } = toSearchRequest(parseSearchTokens('hi from:alice mentions:bob has:image has:video before:2026-01-01 during:2026-01-02 pinned:true sort:relevance'), members);
    expect(req).toEqual({ q: 'hi', authorId: '11', mentions: '22', has: 'image,video', before: '2026-01-01', after: undefined, during: '2026-01-02', pinned: 'true', sort_by: 'relevance', sort_order: undefined });
    expect(unresolved).toEqual([]);
    expect(toSearchRequest(parseSearchTokens('from:ghost'), members).unresolved).toEqual(['ghost']);
    expect(toSearchRequest(parseSearchTokens('pinned:false'), members).req).toMatchObject({ pinned: 'false', q: undefined });
  });
});
