/**
 * JS bridge to the iOS CallKit plugin (apps/mobile/ios/App/App/CallKitPlugin.swift). Every function is a safe no-op outside the iOS
 * Capacitor app, so callers need no platform checks. The native side is UNVERIFIED (no Mac in CI): see docs/PLATFORMS.md.
 */
export type CallEndReason = 'remoteEnded' | 'failed' | 'unanswered' | 'answeredElsewhere' | 'declinedElsewhere';
export interface CallKitHandlers {
  onAnswer?(callId: string): void;
  onEnd?(callId: string): void;
  onMuted?(callId: string, muted: boolean): void;
  /** Hex PushKit VoIP token, to be registered with the server for incoming-call pushes. */
  onVoipToken?(token: string): void;
}
interface PluginLike {
  isSupported?(): Promise<{ supported: boolean }>;
  reportIncomingCall?(o: { callId: string; caller: string; video: boolean }): Promise<unknown>;
  reportOutgoingCall?(o: { callId: string; callee: string; video: boolean }): Promise<unknown>;
  reportConnected?(o: { callId: string }): Promise<unknown>;
  endCall?(o: { callId: string; reason?: CallEndReason }): Promise<unknown>;
  setMuted?(o: { callId: string; muted: boolean }): Promise<unknown>;
  addListener?(event: string, fn: (d: any) => void): Promise<{ remove(): void }> | { remove(): void };
}

type Cap = { getPlatform?(): string; isNativePlatform?(): boolean; Plugins?: Record<string, PluginLike>; registerPlugin?(name: string): PluginLike };
const cap = (): Cap | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: Cap }).Capacitor);

/** The plugin, only inside the iOS app. */
export function callKitPlugin(c: Cap | undefined = cap()): PluginLike | undefined {
  try {
    if (!c?.isNativePlatform?.() || c.getPlatform?.() !== 'ios') return undefined;
    return c.Plugins?.JorcordCallKit ?? c.registerPlugin?.('JorcordCallKit');
  } catch { return undefined; }
}

const safe = async (fn: (() => Promise<unknown>) | undefined): Promise<void> => { try { await fn?.(); } catch { /* the call UI is an enhancement; the in-app UI keeps working */ } };

export const callKit = {
  async supported(p = callKitPlugin()): Promise<boolean> { try { return !!(await p?.isSupported?.())?.supported; } catch { return false; } },
  incoming(callId: string, caller: string, video = false, p = callKitPlugin()) { return safe(p?.reportIncomingCall && (() => p.reportIncomingCall!({ callId, caller, video }))); },
  outgoing(callId: string, callee: string, video = false, p = callKitPlugin()) { return safe(p?.reportOutgoingCall && (() => p.reportOutgoingCall!({ callId, callee, video }))); },
  connected(callId: string, p = callKitPlugin()) { return safe(p?.reportConnected && (() => p.reportConnected!({ callId }))); },
  end(callId: string, reason?: CallEndReason, p = callKitPlugin()) { return safe(p?.endCall && (() => p.endCall!({ callId, ...(reason ? { reason } : {}) }))); },
  setMuted(callId: string, muted: boolean, p = callKitPlugin()) { return safe(p?.setMuted && (() => p.setMuted!({ callId, muted }))); },
  /** Subscribe to native events. Returns an unsubscribe function (a no-op outside iOS). */
  listen(h: CallKitHandlers, p = callKitPlugin()): () => void {
    const subs: { remove(): void }[] = [];
    let dead = false;
    const add = (ev: string, fn: (d: any) => void) => {
      try {
        const r = p?.addListener?.(ev, fn);
        void Promise.resolve(r).then((s) => { if (!s) return; if (dead) s.remove(); else subs.push(s); });
      } catch { /* ignore */ }
    };
    add('answer', (d) => { if (typeof d?.callId === 'string') h.onAnswer?.(d.callId); });
    add('end', (d) => { if (typeof d?.callId === 'string') h.onEnd?.(d.callId); });
    add('muted', (d) => { if (typeof d?.callId === 'string') h.onMuted?.(d.callId, !!d.muted); });
    add('voipToken', (d) => { if (typeof d?.token === 'string' && /^[0-9a-f]{16,512}$/i.test(d.token)) h.onVoipToken?.(d.token); });
    return () => { dead = true; for (const s of subs.splice(0)) s.remove(); };
  },
};
