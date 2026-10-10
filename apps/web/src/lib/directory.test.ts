import { describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { categoryName, installPath, installsLabel, permissionSummary } from './directory';
import { parseAuthorizeQuery } from './oauth';

describe('app directory helpers', () => {
  it('the install link is the add-bot OAuth page and round-trips through its parser', () => {
    const path = installPath({ id: '42', permissions: '2048' });
    expect(path).toBe('/oauth2/authorize?client_id=42&scope=bot%20applications.commands&permissions=2048');
    expect(parseAuthorizeQuery(path.split('?')[1]!)).toMatchObject({ clientId: '42', scopes: ['bot', 'applications.commands'], permissions: '2048' });
    expect(installPath({ id: '7', permissions: '0' })).not.toContain('permissions');
  });
  it('labels', () => {
    expect(categoryName('music')).toBe('Music'); expect(categoryName('zzz')).toBe('Other');
    expect(installsLabel(999)).toBe('999'); expect(installsLabel(1500)).toBe('1.5k'); expect(installsLabel(2000)).toBe('2k'); expect(installsLabel(12_345)).toBe('12k');
    expect(permissionSummary('0')).toBe('No special permissions');
    expect(permissionSummary((Perm.SEND_MESSAGES | Perm.EMBED_LINKS).toString())).toMatch(/Send Messages/);
    expect(permissionSummary((Perm.SEND_MESSAGES | Perm.EMBED_LINKS | Perm.ATTACH_FILES | Perm.ADD_REACTIONS | Perm.KICK_MEMBERS).toString())).toMatch(/\+2$/);
  });
});
