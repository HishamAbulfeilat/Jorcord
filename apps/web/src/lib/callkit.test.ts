import { describe, expect, it, vi } from 'vitest';
import { callKit, callKitPlugin } from './callkit';

const ios = (plugin: any) => ({ isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { JorcordCallKit: plugin } });

describe('CallKit bridge', () => {
  it('is a no-op outside the iOS app', async () => {
    expect(callKitPlugin(undefined)).toBeUndefined();
    expect(callKitPlugin({ isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { JorcordCallKit: {} } })).toBeUndefined();
    expect(callKitPlugin({ isNativePlatform: () => false, getPlatform: () => 'ios' })).toBeUndefined();
    await expect(callKit.incoming('c1', 'Amy')).resolves.toBeUndefined();
    expect(await callKit.supported()).toBe(false);
    expect(typeof callKit.listen({})).toBe('function');
  });
  it('forwards calls to the plugin and swallows native errors', async () => {
    const plugin = { reportIncomingCall: vi.fn().mockResolvedValue({}), endCall: vi.fn().mockRejectedValue(new Error('boom')), isSupported: vi.fn().mockResolvedValue({ supported: true }) };
    const p = callKitPlugin(ios(plugin))!;
    expect(p).toBe(plugin);
    await callKit.incoming('c1', 'Amy', true, p);
    expect(plugin.reportIncomingCall).toHaveBeenCalledWith({ callId: 'c1', caller: 'Amy', video: true });
    await expect(callKit.end('c1', 'remoteEnded', p)).resolves.toBeUndefined();
    expect(plugin.endCall).toHaveBeenCalledWith({ callId: 'c1', reason: 'remoteEnded' });
    expect(await callKit.supported(p)).toBe(true);
  });
  it('routes native events, validates payloads and unsubscribes', async () => {
    const handlers: Record<string, (d: any) => void> = {}; const removed: string[] = [];
    const plugin = { addListener: (ev: string, fn: (d: any) => void) => { handlers[ev] = fn; return Promise.resolve({ remove: () => removed.push(ev) }); } };
    const h = { onAnswer: vi.fn(), onEnd: vi.fn(), onMuted: vi.fn(), onVoipToken: vi.fn() };
    const off = callKit.listen(h, plugin as any);
    handlers.answer!({ callId: 'c1' }); handlers.end!({ callId: 'c1' }); handlers.muted!({ callId: 'c1', muted: true });
    handlers.answer!({ callId: 5 }); handlers.voipToken!({ token: 'zz' }); handlers.voipToken!({ token: 'ab12'.repeat(8) });
    expect(h.onAnswer).toHaveBeenCalledTimes(1); expect(h.onEnd).toHaveBeenCalledWith('c1'); expect(h.onMuted).toHaveBeenCalledWith('c1', true);
    expect(h.onVoipToken).toHaveBeenCalledTimes(1);
    await Promise.resolve(); off(); await Promise.resolve();
    expect(removed.sort()).toEqual(['answer', 'end', 'muted', 'voipToken']);
  });
});
