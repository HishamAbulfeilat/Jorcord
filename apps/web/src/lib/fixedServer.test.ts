import { afterEach, describe, expect, it, vi } from 'vitest';

// FIXED_SERVER is read once at import time, so each case imports a fresh copy of the module.
const load = async (url: string) => { vi.stubEnv('VITE_SERVER_URL', url); vi.resetModules(); return import('./server'); };

afterEach(() => { vi.unstubAllEnvs(); delete (window as any).Capacitor; delete (window as any).__TAURI__; localStorage.clear(); });

describe('single fixed server (VITE_SERVER_URL)', () => {
  it('native apps always use the baked-in server, never ask for one, and cannot be repointed', async () => {
    (window as any).__TAURI__ = {};
    const s = await load('https://jorcord.duckdns.org/');
    expect(s.FIXED_SERVER).toBe('https://jorcord.duckdns.org');
    expect(s.getServerUrl()).toBe('https://jorcord.duckdns.org');
    expect(s.needsServerSetup()).toBe(false);
    expect(s.apiBase()).toBe('https://jorcord.duckdns.org/api/v1');
    expect(s.gatewayUrl()).toBe('wss://jorcord.duckdns.org/gateway');
    s.setServerUrl('https://evil.example');
    expect(s.getServerUrl()).toBe('https://jorcord.duckdns.org');
  });

  it('ignores a server address left over from an older build', async () => {
    localStorage.setItem('jorcord.server.v1', 'https://old.example');
    (window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    const s = await load('https://jorcord.duckdns.org');
    expect(s.getServerUrl()).toBe('https://jorcord.duckdns.org');
  });

  it('a web bundle served by the server itself keeps using its own origin', async () => {
    const s = await load('https://jorcord.duckdns.org');
    expect(s.getServerUrl()).toBe('');
    expect(s.apiBase()).toBe('/api/v1');
  });

  it('without VITE_SERVER_URL the wrappers still ask for a server', async () => {
    (window as any).__TAURI__ = {};
    const s = await load('');
    expect(s.FIXED_SERVER).toBeNull();
    expect(s.needsServerSetup()).toBe(true);
  });
});
