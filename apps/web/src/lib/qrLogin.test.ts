import { afterEach, describe, expect, it } from 'vitest';
import { describeDevice, isOtherServer, parseQrPayload, qrPayload } from './qrLogin';

afterEach(() => { localStorage.clear(); });

describe('QR login payload', () => {
  const code = { id: '123456789', scanSecret: 'abcdefghijklmnopqrstuvwxyz0123456789-_AB' };
  it('round-trips and never carries anything but id, scan secret and server', () => {
    const text = qrPayload(code);
    expect(text.startsWith('jorcord://qr-login?')).toBe(true);
    const p = parseQrPayload(text)!;
    expect(p.id).toBe('123456789'); expect(p.secret).toBe(code.scanSecret); expect(p.server).toBe(location.origin);
    expect(isOtherServer(p)).toBe(false);
    expect(isOtherServer({ ...p, server: 'https://elsewhere.example' })).toBe(true);
  });
  it('rejects text that is not a login code', () => {
    for (const bad of ['', 'hello', 'https://jorcord.app/qr-login?i=1&c=x', 'jorcord://invite/abc', 'jorcord://qr-login?i=abc&c=' + 'x'.repeat(30), 'jorcord://qr-login?i=1&c=short', 'jorcord://qr-login?i=1&c=' + 'x'.repeat(30) + '<script>'])
      expect(parseQrPayload(bad)).toBeNull();
  });
});

describe('describeDevice', () => {
  it('summarises browsers and platforms', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0')).toBe('Edge on Windows');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0')).toBe('Firefox on Linux');
    expect(describeDevice(null)).toBe('an unknown device');
  });
});
