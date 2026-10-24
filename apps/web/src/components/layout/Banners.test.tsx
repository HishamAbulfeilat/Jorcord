import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ tauri: false, capacitor: false }));
vi.mock('@/lib/server', () => ({
  isTauri: () => native.tauri, isCapacitor: () => native.capacitor, isNative: () => native.tauri || native.capacitor, nativePlatform: () => 'android',
  gatewayUrl: () => 'ws://x', getServerUrl: () => '',
}));
const checkUpdate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/native', () => ({ desktop: { checkUpdate } }));
vi.mock('@/lib/updates', async (orig) => ({ ...(await orig<typeof import('@/lib/updates')>()), newerRelease: vi.fn(), serverBuild: vi.fn(), applyWebUpdate: vi.fn(async () => {}) }));

import { gateway, type GatewayLike, type GatewayStatus } from '@/lib/gateway';
import { newerRelease, serverBuild, applyWebUpdate, dismissedUpdate } from '@/lib/updates';
import { useAuth } from '@/stores/auth';
import { BANNER_DELAY_MS, BANNER_SLOW_MS, ConnectionBanner, bannerKind } from './ConnectionBanner';
import { UpdateBanner } from './UpdateBanner';

class FakeGw implements GatewayLike {
  status: GatewayStatus = 'idle'; fns = new Set<(s: GatewayStatus) => void>(); retryNow = vi.fn();
  connect() {} disconnect() {} on() { return () => {}; } sendTyping() {} updatePresence() {} updateVoiceState() {}
  onStatus(f: (s: GatewayStatus) => void) { this.fns.add(f); return () => { this.fns.delete(f); }; }
  set(s: GatewayStatus) { this.status = s; this.fns.forEach((f) => f(s)); }
}
let gw: FakeGw;
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const setOnline = (v: boolean) => { Object.defineProperty(navigator, 'onLine', { value: v, configurable: true }); act(() => { window.dispatchEvent(new Event(v ? 'online' : 'offline')); }); };

describe('ConnectionBanner', () => {
  beforeEach(() => { vi.useFakeTimers(); gw = new FakeGw(); gateway.set(gw); setOnline(true); gw.status = 'connected'; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('maps states to banners', () => {
    expect(bannerKind('connected', true)).toBeNull();
    expect(bannerKind('closed', true)).toBeNull();
    expect(bannerKind('reconnecting', true)).toBe('reconnecting');
    expect(bannerKind('connected', false)).toBe('offline');
    expect(bannerKind('authfailed', true)).toBe('authfailed');
  });

  it('does not flash for a drop shorter than the debounce', () => {
    render(<ConnectionBanner />);
    act(() => gw.set('reconnecting')); tick(BANNER_DELAY_MS - 200);
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    act(() => gw.set('connected')); tick(5000);
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('shows after the debounce and clears the moment the gateway is READY/RESUMED', () => {
    render(<ConnectionBanner />);
    act(() => gw.set('reconnecting')); tick(BANNER_DELAY_MS + 10);
    expect(screen.getByTestId('connection-banner').textContent).toContain('Reconnecting');
    act(() => gw.set('connected'));
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('survives several rapid disconnects: the last reconnect still clears it', () => {
    render(<ConnectionBanner />);
    for (let i = 0; i < 4; i++) { act(() => gw.set('reconnecting')); tick(900); act(() => gw.set('connecting')); tick(900); }
    tick(BANNER_DELAY_MS); expect(screen.getByTestId('connection-banner')).toBeTruthy();
    act(() => gw.set('connected')); expect(screen.queryByTestId('connection-banner')).toBeNull();
    tick(BANNER_SLOW_MS * 2); expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('Retry now asks the gateway to reconnect immediately; text changes after a long outage', () => {
    render(<ConnectionBanner />);
    act(() => gw.set('reconnecting')); tick(BANNER_DELAY_MS + 10);
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' })); expect(gw.retryNow).toHaveBeenCalledTimes(1);
    tick(BANNER_SLOW_MS); expect(screen.getByTestId('connection-banner').textContent).toContain('Still trying');
  });

  it('offline then online: shows "offline", and clears when the network and gateway are back', () => {
    render(<ConnectionBanner />);
    setOnline(false); tick(BANNER_DELAY_MS + 10);
    expect(screen.getByTestId('connection-banner').getAttribute('data-kind')).toBe('offline');
    setOnline(true); // gateway never left 'connected' in this scenario
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('auth failure shows Session expired with a sign-in action instead of Reconnecting', () => {
    useAuth.setState({ access: 'a', refresh: 'r' });
    render(<ConnectionBanner />);
    act(() => gw.set('authfailed')); tick(BANNER_DELAY_MS + 10);
    expect(screen.getByTestId('connection-banner').textContent).toContain('Session expired');
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); expect(useAuth.getState().access).toBeNull();
  });

  it('a logout (closed) removes any banner', () => {
    render(<ConnectionBanner />);
    act(() => gw.set('reconnecting')); tick(BANNER_DELAY_MS + 10); act(() => gw.set('closed'));
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });
});

describe('UpdateBanner', () => {
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear(); native.tauri = false; native.capacitor = false; vi.mocked(serverBuild).mockReset(); vi.mocked(applyWebUpdate).mockClear(); checkUpdate.mockReset(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('web: no banner when the server build equals ours (or cannot be read)', async () => {
    vi.mocked(serverBuild).mockResolvedValue(__BUILD_ID__); render(<UpdateBanner />); await flush();
    expect(screen.queryByTestId('update-banner')).toBeNull();
    vi.mocked(serverBuild).mockResolvedValue(null); await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000); });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('web: shows for a newer build, Reload applies it (SW activation + reload) once', async () => {
    vi.mocked(serverBuild).mockResolvedValue('newbuild'); render(<UpdateBanner />); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(applyWebUpdate).toHaveBeenCalledWith('newbuild');
    expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('web: dismissing hides it for that build, even across later checks and tab focus', async () => {
    vi.mocked(serverBuild).mockResolvedValue('newbuild'); render(<UpdateBanner />); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('update-banner')).toBeNull();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(31 * 60_000); });
    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(dismissedUpdate()).toBe('web:newbuild');
  });

  it('web: a build newer than the dismissed one shows again', async () => {
    localStorage.setItem('jorcord.update.dismissed', 'web:newbuild');
    vi.mocked(serverBuild).mockResolvedValue('newer-still'); render(<UpdateBanner />); await flush();
    expect(screen.getByTestId('update-banner')).toBeTruthy();
  });

  it('web: the banner goes away by itself when the server build is back to ours', async () => {
    vi.mocked(serverBuild).mockResolvedValue('newbuild'); render(<UpdateBanner />); await flush();
    expect(screen.getByTestId('update-banner')).toBeTruthy();
    vi.mocked(serverBuild).mockResolvedValue(__BUILD_ID__); await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000); });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('web: after a reload that did not change the build (inconsistent deploy) it stays quiet instead of looping', async () => {
    sessionStorage.setItem('jorcord.update.reloaded', 'newbuild');
    vi.mocked(serverBuild).mockResolvedValue('newbuild'); render(<UpdateBanner />); await flush();
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('mobile: newer release shows once; dismissal is remembered per version', async () => {
    native.capacitor = true;
    vi.mocked(newerRelease).mockResolvedValue({ version: '9.9.9', page: 'https://github.com/x', apk: null });
    render(<UpdateBanner />); await flush();
    expect(screen.getByTestId('update-banner').textContent).toContain('9.9.9');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 3600_000); });
    expect(screen.queryByTestId('update-banner')).toBeNull();
    vi.mocked(newerRelease).mockResolvedValue({ version: '9.10.0', page: 'https://github.com/x', apk: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 3600_000); });
    expect(screen.getByTestId('update-banner').textContent).toContain('9.10.0');
  });

  it('desktop: dismissal sticks across re-checks; a failed install shows the error and re-enables the button', async () => {
    native.tauri = true;
    const install = vi.fn().mockRejectedValue(new Error('signature mismatch'));
    checkUpdate.mockResolvedValue({ version: '2.0.0', install });
    render(<UpdateBanner />); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' })); await flush();
    expect(screen.getByTestId('update-banner').textContent).toContain('signature mismatch');
    expect((screen.getByRole('button', { name: 'Restart to update' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 3600_000); });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('desktop: the banner disappears when the updater reports nothing pending any more', async () => {
    native.tauri = true;
    checkUpdate.mockResolvedValue({ version: '2.0.0', install: vi.fn() }); render(<UpdateBanner />); await flush();
    expect(screen.getByTestId('update-banner')).toBeTruthy();
    checkUpdate.mockResolvedValue(null); await act(async () => { await vi.advanceTimersByTimeAsync(7 * 3600_000); });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });
});
