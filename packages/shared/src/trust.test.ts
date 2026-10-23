import { describe, expect, it } from 'vitest';
import { accountAge, assessLink, assessMessageLinks, decodeHost, linkWarnings, levenshtein, matchImpersonation, messageFingerprint, normalizeLinkList, skeleton } from './trust';

describe('skeleton / levenshtein', () => {
  it('folds homoglyphs, leet and accents', () => {
    expect(skeleton('Аdmin')).toBe('admin'); // Cyrillic A
    expect(skeleton('4dm1n')).toBe('admin');
    expect(skeleton('Ádmín_')).toBe('admin');
  });
  it('measures edits with a cap', () => {
    expect(levenshtein('discord', 'dlscord')).toBe(1);
    expect(levenshtein('abc', 'abcdefgh', 2)).toBeGreaterThan(2);
  });
});

describe('assessLink', () => {
  const lvl = (u: string, l = {}) => assessLink(u, l).level;
  it('trusts official and ordinary sites', () => {
    for (const u of ['https://discord.com/channels/1', 'https://cdn.discordapp.com/a.png', 'https://github.com/x/y', 'https://store.steampowered.com/app/1', 'https://discord.gg/abc', 'https://en.wikipedia.org/wiki/Discord']) expect(lvl(u)).toBe('ok');
  });
  it('flags look-alike domains', () => {
    for (const u of ['https://dlscord.com/gift', 'https://discord-nitro.xyz', 'https://discordnitro.gift/claim', 'https://disc0rd.com', 'https://steamcommunlty.com/trade', 'https://discord.com.verify-login.ru', 'https://discord.xyz']) expect([u, lvl(u)]).not.toEqual([u, 'ok']);
  });
  it('flags punycode and mixed scripts', () => {
    expect(decodeHost('xn--80ak6aa92e.com')).toBe('аррӏе.com');
    const r = assessLink('https://xn--80ak6aa92e.com/login');
    expect(r.reasons).toEqual(expect.arrayContaining(['punycode', 'mixed_script']));
    expect(assessLink('https://dіscord.com').reasons).toContain('punycode');
  });
  it('does not flag legitimate internationalised domains', () => {
    expect(lvl('https://пример.рф/page')).toBe('ok');
  });
  it('flags userinfo tricks, IP hosts and shorteners', () => {
    expect(assessLink('https://discord.com@evil.example/x').reasons).toContain('userinfo');
    expect(assessLink('http://192.168.4.4/login').reasons).toContain('ip_host');
    expect(assessLink('https://bit.ly/3abc').reasons).toContain('shortener');
    expect(lvl('https://bit.ly/3abc')).toBe('ok'); // a shortener alone is only a hint
  });
  it('flags free nitro bait in the url or the message', () => {
    expect(lvl('https://free-nitro.example.com/claim')).not.toBe('ok');
    expect(linkWarnings('CLAIM YOUR FREE NITRO here https://evil.example/x').length).toBe(1);
  });
  it('honours allow and deny lists (deny wins)', () => {
    expect(lvl('https://discord-nitro.xyz', { allow: ['discord-nitro.xyz'] })).toBe('ok');
    expect(lvl('https://sub.evil.example/x', { deny: ['evil.example'] })).toBe('dangerous');
    expect(lvl('https://evil.example', { allow: ['evil.example'], deny: ['evil.example'] })).toBe('dangerous');
  });
});

describe('assessMessageLinks', () => {
  it('finds bare domains, markdown links and label mismatches', () => {
    expect(assessMessageLinks('look at dlscord.com now')[0]?.level).not.toBe('ok');
    const r = assessMessageLinks('[discord.com](https://evil.example/login)');
    expect(r[0]!.reasons).toContain('label_mismatch');
    expect(assessMessageLinks('see https://github.com/a/b and notes.txt')[0]?.level).toBe('ok');
    expect(assessMessageLinks('no links here')).toEqual([]);
  });
  it('cleans lists', () => {
    expect(normalizeLinkList(['HTTPS://www.Example.com/path', 'bad', 'example.com', 5])).toEqual(['example.com']);
  });
});

describe('matchImpersonation', () => {
  const targets = [{ kind: 'owner' as const, name: 'Hisham' }, { kind: 'staff' as const, name: 'Moderator Mike' }, { kind: 'server' as const, name: 'Jorcord Official' }];
  it('matches homoglyphs, leet and one-off typos', () => {
    expect(matchImpersonation('Hіsham', targets)?.kind).toBe('owner'); // Cyrillic i
    expect(matchImpersonation('H1sham', targets)?.kind).toBe('owner');
    expect(matchImpersonation('Hishem', targets)?.kind).toBe('owner');
    expect(matchImpersonation('Moderat0r Mike', targets)?.kind).toBe('staff');
    expect(matchImpersonation('Jorcord 0fficial', targets)?.kind).toBe('server');
  });
  it('leaves unrelated and very short names alone', () => {
    expect(matchImpersonation('Hannah', targets)).toBeNull();
    expect(matchImpersonation('Al', [{ kind: 'owner', name: 'Al' }])).toBeNull();
    expect(matchImpersonation('Michael', targets)).toBeNull();
  });
});

describe('account age + fingerprints', () => {
  const now = Date.parse('2026-01-31T00:00:00Z');
  it('labels age', () => {
    expect(accountAge('2026-01-30T12:00:00Z', now)).toMatchObject({ isNew: true, label: 'Created 12h ago' });
    expect(accountAge('2026-01-20T00:00:00Z', now)).toMatchObject({ isNew: false, days: 11 });
    expect(accountAge('2020-01-01T00:00:00Z', now).label).toMatch(/years ago/);
  });
  it('fingerprints near-identical spam together', () => {
    expect(messageFingerprint('Hey 123! Join https://a.example/x NOW')).toBe(messageFingerprint('hey 987 join https://b.example/y now!!'));
  });
});
