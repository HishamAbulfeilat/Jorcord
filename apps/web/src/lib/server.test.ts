import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBase, gatewayUrl, getServerUrl, normalizeServerUrl, publicOrigin, serverPath, setServerUrl, validateServer, isNative, needsServerSetup } from './server';

afterEach(() => { setServerUrl(null); delete (window as any).Capacitor; delete (window as any).__TAURI__; });

describe('server url', () => {
  it('normalises user input', () => {
    expect(normalizeServerUrl('chat.example.com')).toBe('https://chat.example.com');
    expect(normalizeServerUrl(' https://chat.example.com/ ')).toBe('https://chat.example.com');
    expect(normalizeServerUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeServerUrl('192.168.1.5:3000/api')).toBe('http://192.168.1.5:3000/api');
    expect(normalizeServerUrl('ftp://x')).toBeNull();
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('http://')).toBeNull();
  });
  it('same-origin default keeps relative paths; a server prefixes REST, media and the gateway', () => {
    expect(getServerUrl()).toBe(''); expect(apiBase()).toBe('/api/v1'); expect(serverPath('/api/v1/files/x')).toBe('/api/v1/files/x');
    expect(gatewayUrl()).toMatch(/^wss?:\/\/.+\/gateway$/);
    setServerUrl('https://chat.example.com');
    expect(apiBase()).toBe('https://chat.example.com/api/v1'); expect(serverPath('/api/v1/files/x')).toBe('https://chat.example.com/api/v1/files/x');
    expect(serverPath('https://cdn.example/x.png')).toBe('https://cdn.example/x.png'); expect(gatewayUrl()).toBe('wss://chat.example.com/gateway');
    expect(publicOrigin()).toBe('https://chat.example.com');
    setServerUrl('http://localhost:3000'); expect(gatewayUrl()).toBe('ws://localhost:3000/gateway');
  });
  it('detects wrappers and asks for a server only there', () => {
    expect(isNative()).toBe(false); expect(needsServerSetup()).toBe(false);
    (window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    expect(isNative()).toBe(true); expect(needsServerSetup()).toBe(true);
    setServerUrl('https://x.test'); expect(needsServerSetup()).toBe(false);
  });
  it('validateServer hits /health', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await validateServer('chat.example.com', ok as any)).toEqual({ ok: true, origin: 'https://chat.example.com' });
    expect(ok).toHaveBeenCalledWith('https://chat.example.com/health', expect.anything());
    const bad = vi.fn(async () => new Response('nope', { status: 502 }));
    expect((await validateServer('chat.example.com', bad as any)).ok).toBe(false);
    const down = vi.fn(async () => { throw new TypeError('failed'); });
    const r = await validateServer('chat.example.com', down as any); expect(r.ok).toBe(false);
    expect((await validateServer('::::', ok as any)).ok).toBe(false);
  });
});
