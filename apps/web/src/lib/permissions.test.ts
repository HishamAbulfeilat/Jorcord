import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canOpenSettings, classifyMediaError, failureFromVoiceCode, failureMessage, fixSteps, queryPermission, requestPermission, settingsDeepLink, watchPermission, type Env } from './permissions';

const err = (name: string, message = '') => Object.assign(new Error(message), { name });
const env = (o: Partial<Env>): Env => ({ shell: 'web', os: 'linux', browser: 'chrome', ...o });

function stubPermissions(map: Record<string, string | 'throw'>) {
  const statuses: Record<string, { state: string; listeners: (() => void)[]; addEventListener: any; removeEventListener: any }> = {};
  const query = vi.fn(async ({ name }: { name: string }) => {
    if (map[name] === 'throw' || !(name in map)) throw new TypeError('unknown permission name');
    const st = statuses[name] ??= { state: map[name]!, listeners: [], addEventListener: (_: string, f: () => void) => { st.listeners.push(f); }, removeEventListener: (_: string, f: () => void) => { st.listeners = st.listeners.filter((x) => x !== f); } };
    st.state = map[name]!;
    return st;
  });
  vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', permissions: { query }, mediaDevices: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
  return { query, statuses, flip: (name: string, state: string) => { map[name] = state; statuses[name]!.state = state; statuses[name]!.listeners.slice().forEach((f) => f()); } };
}

beforeEach(() => { Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('classifyMediaError', () => {
  it('tells denied, no device and busy apart', () => {
    expect(classifyMediaError(err('NotAllowedError', 'Permission denied'))).toBe('denied');
    expect(classifyMediaError(err('NotFoundError'))).toBe('no-device');
    expect(classifyMediaError(err('NotReadableError'))).toBe('busy');
    expect(classifyMediaError(err('OverconstrainedError'))).toBe('constraints');
    expect(classifyMediaError(err('Boom'))).toBe('other');
  });
  it('treats a dismissed prompt as cancelled and a missing mediaDevices as unsupported', () => {
    expect(classifyMediaError(err('NotAllowedError', 'Permission dismissed'))).toBe('cancelled');
    expect(classifyMediaError(new TypeError("Cannot read properties of undefined (reading 'getUserMedia') mediaDevices"))).toBe('unsupported');
  });
  it('reports insecure contexts first', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    expect(classifyMediaError(err('NotAllowedError'))).toBe('insecure');
  });
  it('gives each failure a different message and maps voice codes', () => {
    const msgs = (['denied', 'no-device', 'busy'] as const).map((f) => failureMessage('microphone', f));
    expect(new Set(msgs).size).toBe(3);
    expect(failureMessage('camera', 'no-device')).toMatch(/camera/);
    expect(failureFromVoiceCode('device-busy')).toBe('busy');
    expect(failureFromVoiceCode('token')).toBeNull();
  });
});

describe('platform help', () => {
  it('has per-platform steps and deep links', () => {
    expect(fixSteps('microphone', env({ shell: 'tauri', os: 'macos' })).join(' ')).toMatch(/System Settings > Privacy & Security > Microphone/);
    expect(fixSteps('camera', env({ shell: 'tauri', os: 'windows' })).join(' ')).toMatch(/Windows Settings > Privacy & security > Camera/);
    expect(fixSteps('microphone', env({ shell: 'capacitor', os: 'android' })).join(' ')).toMatch(/Android Settings/);
    expect(fixSteps('microphone', env({ shell: 'capacitor', os: 'ios' })).join(' ')).toMatch(/Settings app/);
    expect(fixSteps('microphone', env({ browser: 'firefox' })).join(' ')).toMatch(/Firefox asks again/);
    expect(fixSteps('microphone', env({ browser: 'safari', os: 'macos' })).join(' ')).toMatch(/Settings for This Website/);
    expect(settingsDeepLink('microphone', env({ shell: 'tauri', os: 'macos' }))).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    expect(settingsDeepLink('camera', env({ shell: 'tauri', os: 'windows' }))).toBe('ms-settings:privacy-webcam');
    expect(settingsDeepLink('microphone', env({ shell: 'tauri', os: 'linux' }))).toBeNull();
    expect(settingsDeepLink('microphone', env({}))).toBeNull();
    expect(canOpenSettings('microphone', env({ shell: 'capacitor', os: 'ios' }))).toBe(true);
    expect(canOpenSettings('microphone', env({}))).toBe(false);
  });
});

describe('queryPermission', () => {
  it('reads navigator.permissions for microphone, camera and notifications', async () => {
    stubPermissions({ microphone: 'granted', camera: 'denied' });
    vi.stubGlobal('Notification', { permission: 'default' });
    expect(await queryPermission('microphone')).toBe('granted');
    expect(await queryPermission('camera')).toBe('denied');
    expect(await queryPermission('notifications')).toBe('prompt');
  });
  it('degrades to unknown when the browser cannot query (Safari/Firefox) and uses device labels as a hint', async () => {
    stubPermissions({ microphone: 'throw' });
    expect(await queryPermission('microphone')).toBe('unknown');
    (navigator.mediaDevices.enumerateDevices as any).mockResolvedValue([{ kind: 'audioinput', label: 'Headset' }]);
    expect(await queryPermission('microphone')).toBe('granted');
  });
  it('is unsupported without the API, and screen sharing is asked each time', async () => {
    vi.stubGlobal('navigator', { userAgent: 'x' });
    vi.stubGlobal('Notification', undefined);
    expect(await queryPermission('microphone')).toBe('unsupported');
    expect(await queryPermission('notifications')).toBe('unsupported');
    expect(await queryPermission('screen')).toBe('unsupported');
    vi.stubGlobal('navigator', { userAgent: 'x', mediaDevices: { getDisplayMedia: vi.fn() } });
    expect(await queryPermission('screen')).toBe('prompt');
  });
});

describe('watchPermission', () => {
  it('pushes live changes from the Permissions API onchange and stops after cleanup', async () => {
    const s = stubPermissions({ microphone: 'denied' });
    const seen: string[] = [];
    const off = watchPermission('microphone', (st) => seen.push(st));
    await vi.waitFor(() => expect(s.statuses.microphone).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    s.flip('microphone', 'granted');
    await vi.waitFor(() => expect(seen).toContain('granted'));
    off();
    const n = seen.length;
    s.flip('microphone', 'denied');
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBe(n);
  });
  it('does not throw when the name cannot be queried', () => {
    stubPermissions({ microphone: 'throw' });
    expect(() => watchPermission('microphone', () => {})()).not.toThrow();
  });
});

describe('requestPermission', () => {
  it('opens and immediately releases the stream on success', async () => {
    stubPermissions({});
    const stop = vi.fn();
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValue({ getTracks: () => [{ stop }] });
    const r = await requestPermission('microphone');
    expect(r.ok).toBe(true); expect(stop).toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });
  it.each([['NotAllowedError', 'denied', 'denied'], ['NotFoundError', 'no-device', 'prompt'], ['NotReadableError', 'busy', 'prompt']])('maps %s to %s', async (name, failure, state) => {
    stubPermissions({});
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValue(err(name, 'Permission denied'));
    const r = await requestPermission('camera');
    expect(r).toMatchObject({ ok: false, failure, state });
  });
  it('asks for notifications through Notification.requestPermission and reports a refusal as denied', async () => {
    const req = vi.fn(async () => 'denied');
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: req });
    stubPermissions({});
    expect(await requestPermission('notifications')).toMatchObject({ ok: false, state: 'denied', failure: 'denied' });
    expect(req).toHaveBeenCalledTimes(1);
  });
  it('never touches screen capture when asked to pre-request it', async () => {
    stubPermissions({});
    const gdm = vi.fn(); (navigator.mediaDevices as any).getDisplayMedia = gdm;
    expect((await requestPermission('screen')).ok).toBe(true);
    expect(gdm).not.toHaveBeenCalled();
  });
});
