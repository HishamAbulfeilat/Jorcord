import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsHere, activeAccountId, forgetAccount, loadAccounts, rememberAccount, switchAccount, syncActiveTokens } from './accounts';

const u = (id: string) => ({ id, username: `user${id}`, displayName: `User ${id}`, avatar: null });
beforeEach(() => { localStorage.clear(); });
describe('saved accounts', () => {
  it('remembers accounts, marks the latest active and keeps tokens current when they rotate', () => {
    rememberAccount(u('1'), { access: 'a1', refresh: 'r1' }); rememberAccount(u('2'), { access: 'a2', refresh: 'r2' });
    expect(accountsHere().map((a) => a.id).sort()).toEqual(['1', '2']); expect(activeAccountId()).toBe('2');
    syncActiveTokens('a2b', 'r2b'); expect(loadAccounts().find((a) => a.id === '2')).toMatchObject({ access: 'a2b', refresh: 'r2b' });
    expect(loadAccounts().find((a) => a.id === '1')).toMatchObject({ access: 'a1' }); // others untouched
    rememberAccount(u('1'), { access: 'a1c', refresh: 'r1c' }); expect(loadAccounts()).toHaveLength(2); expect(activeAccountId()).toBe('1'); // upsert, no duplicates
  });
  it('ignores sessions without a token and survives corrupt storage', () => {
    rememberAccount(u('1'), { access: null, refresh: null }); expect(loadAccounts()).toEqual([]);
    localStorage.setItem('jorcord.accounts.v1', '{not json'); expect(loadAccounts()).toEqual([]);
    localStorage.setItem('jorcord.accounts.v1', JSON.stringify([{ id: 5 }, { id: '6', access: 'x' }])); expect(loadAccounts().map((a) => a.id)).toEqual(['6']);
  });
  it('forgets accounts and switches by swapping tokens then reloading', () => {
    rememberAccount(u('1'), { access: 'a1', refresh: 'r1' }); rememberAccount(u('2'), { access: 'a2', refresh: 'r2' });
    const assign = vi.fn(); Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
    const order: string[] = []; const set = vi.fn(() => { order.push(`tokens@${activeAccountId()}`); }); expect(switchAccount('1', set)).toBe(true);
    expect(order).toEqual(['tokens@1']); // the new account is already active when tokens are written (no clobbering of the old one's entry)
    expect(set).toHaveBeenCalledWith('a1', 'r1'); expect(activeAccountId()).toBe('1'); expect(assign).toHaveBeenCalledWith('/channels/@me');
    expect(switchAccount('nope', set)).toBe(false);
    forgetAccount('1'); expect(accountsHere().map((a) => a.id)).toEqual(['2']); expect(activeAccountId()).toBeNull();
  });
});
