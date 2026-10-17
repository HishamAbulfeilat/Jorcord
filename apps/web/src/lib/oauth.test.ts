import { describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { buildAuthorizeUrl, needsGuild, parseAuthorizeQuery, permissionBits, permissionNames, redirectWithCode, validScopes } from './oauth';

describe('authorize link', () => {
  it('parses Discord-style snake_case and our camelCase, scopes by space / + / comma', () => {
    expect(parseAuthorizeQuery('?client_id=123&scope=bot%20applications.commands&permissions=2048&guild_id=9&redirect_uri=https%3A%2F%2Fx.test%2Fcb&state=abc'))
      .toEqual({ clientId: '123', scopes: ['bot', 'applications.commands'], permissions: '2048', guildId: '9', redirectUri: 'https://x.test/cb', state: 'abc' });
    expect(parseAuthorizeQuery('clientId=5&scope=bot+identify,bot')).toMatchObject({ clientId: '5', scopes: ['bot', 'identify'], permissions: '0' });
    expect(parseAuthorizeQuery('client_id=1&scope=bot&permissions=junk').permissions).toBe('0'); expect(parseAuthorizeQuery('').clientId).toBe('');
  });
  it('validates scopes and knows which need a server', () => { expect(validScopes(['bot'])).toBe(true); expect(validScopes(['bot', 'email'])).toBe(false); expect(validScopes([])).toBe(false); expect(needsGuild(['identify'])).toBe(false); expect(needsGuild(['applications.commands'])).toBe(true); });
  it('builds the invite URL the generator shows', () => {
    const u = new URL(buildAuthorizeUrl('https://chat.example.com/', { clientId: '42', scopes: ['bot', 'applications.commands'], permissions: '2048' }));
    expect(u.origin + u.pathname).toBe('https://chat.example.com/oauth2/authorize'); expect(u.searchParams.get('client_id')).toBe('42'); expect(u.searchParams.get('scope')).toBe('bot applications.commands'); expect(u.searchParams.get('permissions')).toBe('2048');
    expect(buildAuthorizeUrl('http://h', { clientId: '1', scopes: ['bot'], permissions: '0' })).not.toContain('permissions');
    expect(buildAuthorizeUrl('http://h', { clientId: '1', scopes: ['identify'], permissions: '8', redirectUri: 'https://a.test/cb', state: 's' })).toMatch(/redirect_uri=https%3A%2F%2Fa\.test%2Fcb&response_type=code&state=s$/);
    expect(buildAuthorizeUrl('http://h', { clientId: '1', scopes: ['identify'], permissions: '8' })).not.toContain('permissions'); // permissions only matter for bots
  });
  it('permission names and bits round-trip; unknown bits are ignored', () => {
    const bits = (Perm.SEND_MESSAGES | Perm.SEND_POLLS | Perm.CREATE_EVENTS).toString();
    expect(permissionNames(bits)).toEqual(['SEND_MESSAGES', 'CREATE_EVENTS', 'SEND_POLLS']); expect(permissionBits(permissionNames(bits))).toBe(bits);
    expect(permissionNames((1n << 62n).toString())).toEqual([]); expect(permissionNames('nope')).toEqual([]); expect(permissionBits([])).toBe('0');
  });
  it('appends code and state to the redirect', () => { expect(redirectWithCode('https://a.test/cb?x=1', 'CODE', 'st')).toBe('https://a.test/cb?x=1&code=CODE&state=st'); expect(redirectWithCode('https://a.test/cb', 'C')).toBe('https://a.test/cb?code=C'); });
});
