import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY, getRemember, loadAuth, saveAuth, setRemember } from './authStorage';
import { bindTokenStore, fetchTransport } from './transport';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('remember me', () => {
  it('defaults to remembering, so sessions saved before the option existed survive a restart', () => {
    expect(getRemember()).toBe(true);
    saveAuth('a1', 'r1');
    expect(JSON.parse(localStorage.getItem(AUTH_KEY)!)).toEqual({ access: 'a1', refresh: 'r1' });
    expect(sessionStorage.getItem(AUTH_KEY)).toBeNull();
    expect(loadAuth()).toEqual({ access: 'a1', refresh: 'r1' });
  });
  it('unchecked keeps the tokens in sessionStorage only', () => {
    setRemember(false);
    saveAuth('a1', 'r1');
    expect(localStorage.getItem(AUTH_KEY)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(AUTH_KEY)!).refresh).toBe('r1');
    expect(loadAuth().refresh).toBe('r1');
  });
  it('switching the choice moves the tokens and leaves no copy behind; logout clears everything', () => {
    saveAuth('a1', 'r1');
    setRemember(false); saveAuth('a2', 'r2');
    expect(localStorage.getItem(AUTH_KEY)).toBeNull();
    setRemember(true); saveAuth('a3', 'r3');
    expect(sessionStorage.getItem(AUTH_KEY)).toBeNull();
    expect(loadAuth().refresh).toBe('r3');
    saveAuth(null, null);
    expect(localStorage.getItem(AUTH_KEY)).toBeNull(); expect(sessionStorage.getItem(AUTH_KEY)).toBeNull();
    expect(loadAuth()).toEqual({});
  });
});

describe('keeping the session across launches', () => {
  const setup = (refreshResponse: () => Promise<Response>) => {
    const state = { access: 'old', refresh: 'r1', logouts: 0 };
    bindTokenStore({ get: () => ({ access: state.access, refresh: state.refresh }), set: (a, r) => { state.access = a!; state.refresh = r!; }, onLogout: () => { state.logouts++; } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/refresh')) return refreshResponse();
      return new Response(state.access === 'new' ? '{"ok":true}' : '{"code":"INVALID_TOKEN","message":"expired"}', { status: state.access === 'new' ? 200 : 401, headers: { 'content-type': 'application/json' } });
    }));
    return state;
  };

  it('refreshes an expired access token silently on launch', async () => {
    const s = setup(async () => new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'r2' }), { status: 200 }));
    await expect(fetchTransport({ method: 'GET', path: '/users/@me' })).resolves.toEqual({ ok: true });
    expect(s.refresh).toBe('r2'); expect(s.logouts).toBe(0);
  });
  it('does NOT log out when the server is unreachable or erroring during the refresh', async () => {
    const s = setup(async () => { throw new TypeError('network'); });
    await expect(fetchTransport({ method: 'GET', path: '/users/@me' })).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    expect(s.logouts).toBe(0); expect(s.refresh).toBe('r1');
    const s2 = setup(async () => new Response('{}', { status: 502 }));
    await expect(fetchTransport({ method: 'GET', path: '/users/@me' })).rejects.toMatchObject({ status: 0 });
    expect(s2.logouts).toBe(0);
  });
  it('logs out only when the server rejects the refresh token', async () => {
    const s = setup(async () => new Response('{"code":"INVALID_TOKEN"}', { status: 401 }));
    await expect(fetchTransport({ method: 'GET', path: '/users/@me' })).rejects.toMatchObject({ status: 401 });
    expect(s.logouts).toBe(1);
  });
  it('adopts a token another tab already rotated instead of replaying the old one', async () => {
    const state = { access: 'old', refresh: 'r1', logouts: 0 };
    let calls = 0;
    bindTokenStore({
      get: () => ({ access: state.access, refresh: state.refresh }), set: (a, r) => { state.access = a!; state.refresh = r!; }, onLogout: () => { state.logouts++; },
      reload: () => { state.access = 'new'; state.refresh = 'r2'; return true; }, // the other tab's copy
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/refresh')) { calls++; return new Response('{}', { status: 401 }); }
      return state.access === 'new' ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 401 });
    }));
    await expect(fetchTransport({ method: 'GET', path: '/users/@me' })).resolves.toEqual({ ok: true });
    expect(calls).toBe(0); expect(state.logouts).toBe(0);
  });
});
