import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsPanel } from './PermissionsPanel';
import { PermissionHost } from '@/components/ui/PermissionHost';
import { ensurePermission, usePermFlow } from '@/lib/permissionFlow';

type Listener = () => void;
let states: Record<string, string>; let listeners: Record<string, Listener[]>; let gum: ReturnType<typeof vi.fn>;

beforeEach(() => {
  states = { microphone: 'prompt', camera: 'denied' }; listeners = {};
  gum = vi.fn();
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
    permissions: { query: vi.fn(async ({ name }: { name: string }) => {
      if (!(name in states)) throw new TypeError('unsupported');
      return { get state() { return states[name]; }, addEventListener: (_: string, f: Listener) => { (listeners[name] ??= []).push(f); }, removeEventListener: (_: string, f: Listener) => { listeners[name] = (listeners[name] ?? []).filter((x) => x !== f); } };
    }) },
    mediaDevices: { getUserMedia: gum, getDisplayMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) },
  });
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'granted') });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  try { localStorage.clear(); } catch { /* */ }
});
afterEach(() => { cleanup(); usePermFlow.getState().set(null); vi.unstubAllGlobals(); });

describe('Settings > Permissions', () => {
  it('shows the live state of every permission and updates when the browser setting changes', async () => {
    render(<PermissionsPanel />);
    await waitFor(() => expect(screen.getByTestId('perm-state-camera').textContent).toMatch(/Blocked/i));
    expect(screen.getByTestId('perm-state-microphone').textContent).toMatch(/Not asked yet/i);
    expect(screen.getByTestId('perm-state-notifications').textContent).toMatch(/Not asked yet/i);
    expect(screen.getByTestId('perm-state-screen').textContent).toMatch(/Not asked yet/i);
    await waitFor(() => expect(listeners.camera?.length).toBeGreaterThan(0));
    states.camera = 'granted';
    act(() => { listeners.camera!.forEach((f) => f()); });
    await waitFor(() => expect(screen.getByTestId('perm-state-camera').textContent).toMatch(/Allowed/i));
  });

  it('explains how to fix a blocked permission and offers Retry', async () => {
    render(<PermissionsPanel />);
    await waitFor(() => screen.getByTestId('perm-howto-camera'));
    fireEvent.click(screen.getByTestId('perm-howto-camera'));
    expect(screen.getByTestId('perm-blocked').textContent).toMatch(/Site settings/);
    expect(screen.getByTestId('perm-retry')).toBeTruthy();
    expect(screen.queryByTestId('perm-open-settings')).toBeNull(); // plain browser: no deep link
  });

  it('shows no permission prompt just by opening the panel', async () => {
    render(<PermissionsPanel />);
    await waitFor(() => screen.getByTestId('perm-state-microphone'));
    expect(gum).not.toHaveBeenCalled();
    expect((Notification as any).requestPermission).not.toHaveBeenCalled();
  });
});

describe('just-in-time explainer', () => {
  it('shows the explainer first, and only calls getUserMedia after Continue', async () => {
    render(<PermissionHost />);
    gum.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    let result: boolean | undefined;
    void ensurePermission('microphone').then((r) => { result = r; });
    await waitFor(() => screen.getByTestId('perm-explain'));
    expect(gum).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('perm-continue'));
    await waitFor(() => expect(result).toBe(true));
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('Not now resolves false without ever touching the device', async () => {
    render(<PermissionHost />);
    let result: boolean | undefined;
    void ensurePermission('microphone').then((r) => { result = r; });
    await waitFor(() => screen.getByTestId('perm-not-now'));
    fireEvent.click(screen.getByTestId('perm-not-now'));
    await waitFor(() => expect(result).toBe(false));
    expect(gum).not.toHaveBeenCalled();
  });

  it('a blocked permission skips the explainer, explains, and closes by itself once allowed in the browser', async () => {
    states.microphone = 'denied';
    render(<PermissionHost />);
    let result: boolean | undefined;
    void ensurePermission('microphone').then((r) => { result = r; });
    await waitFor(() => screen.getByTestId('perm-blocked'));
    expect(screen.queryByTestId('perm-explain')).toBeNull();
    await waitFor(() => expect(listeners.microphone?.length).toBeGreaterThan(0));
    states.microphone = 'granted';
    act(() => { listeners.microphone!.forEach((f) => f()); });
    await waitFor(() => expect(result).toBe(true));
    expect(screen.queryByTestId('perm-blocked')).toBeNull();
  });

  it('a refusal at the prompt switches to the blocked view with the right wording, and Retry asks again', async () => {
    states.camera = 'prompt';
    render(<PermissionHost />);
    gum.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotFoundError' }));
    void ensurePermission('camera');
    await waitFor(() => screen.getByTestId('perm-continue'));
    fireEvent.click(screen.getByTestId('perm-continue'));
    await waitFor(() => expect(screen.getByTestId('perm-blocked').getAttribute('data-failure')).toBe('no-device'));
    expect(screen.getByTestId('perm-blocked').textContent).toMatch(/No camera was found/);
    gum.mockResolvedValueOnce({ getTracks: () => [{ stop: vi.fn() }] });
    fireEvent.click(screen.getByTestId('perm-retry'));
    await waitFor(() => expect(screen.queryByTestId('perm-blocked')).toBeNull());
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it('does not nag when the permission is already granted', async () => {
    states.microphone = 'granted';
    render(<PermissionHost />);
    expect(await ensurePermission('microphone')).toBe(true);
    expect(screen.queryByTestId('perm-explain')).toBeNull();
  });
});
