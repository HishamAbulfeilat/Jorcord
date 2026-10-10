import { describe, expect, it } from 'vitest';
import { parseDeepLink, routeFor } from './deeplink';

describe('deep links', () => {
  it('jorcord://invite/<code>', () => {
    expect(parseDeepLink('jorcord://invite/aBc123')).toEqual({ kind: 'invite', code: 'aBc123', server: undefined });
    expect(routeFor(parseDeepLink('jorcord://invite/aBc123')!)).toBe('/invite/aBc123');
  });
  it('invite with a server parameter normalises the server', () => {
    expect(parseDeepLink('jorcord://invite/abc?server=chat.example.com')).toEqual({ kind: 'invite', code: 'abc', server: 'https://chat.example.com' });
  });
  it('jorcord://open?server=<url>', () => {
    expect(parseDeepLink('jorcord://open?server=https%3A%2F%2Fchat.example.com%2F')).toEqual({ kind: 'open', server: 'https://chat.example.com' });
    expect(parseDeepLink('jorcord://open?server=http://localhost:3000')).toEqual({ kind: 'open', server: 'http://localhost:3000' });
    expect(routeFor({ kind: 'open' })).toBe('/channels/@me');
  });
  it('tolerates triple-slash and missing-slash forms', () => {
    expect(parseDeepLink('jorcord:///invite/abc')?.kind).toBe('invite');
    expect(parseDeepLink('jorcord:invite/abc')?.kind).toBe('invite');
  });
  it('channel links', () => {
    const l = parseDeepLink('jorcord://channels/123/456')!;
    expect(l).toEqual({ kind: 'channel', guildId: '123', channelId: '456', server: undefined });
    expect(routeFor(l)).toBe('/channels/123/456');
    expect(routeFor(parseDeepLink('jorcord://channels/@me')!)).toBe('/channels/@me');
  });
  it('https app links carry their origin as the server', () => {
    expect(parseDeepLink('https://chat.example.com/invite/xyz')).toEqual({ kind: 'invite', code: 'xyz', server: 'https://chat.example.com' });
  });
  it('rejects junk, other schemes and path tricks', () => {
    for (const bad of ['', 'nonsense', 'javascript:alert(1)', 'ftp://x/invite/abc', 'jorcord://invite/', 'jorcord://invite/a b', 'jorcord://invite/../../etc', 'jorcord://unknown/path']) expect(parseDeepLink(bad)).toBeNull();
  });
});
