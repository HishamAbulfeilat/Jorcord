import type { PresetConstraints } from './presets';

export interface Platform { isIOS: boolean; isAndroid: boolean; isMobile: boolean; isSafari: boolean; canScreenShare: boolean; /** Screen share goes through the native Capacitor plugin (set by VoiceClient.setNativeScreenSource). */ nativeScreenShare?: boolean }

/** Capacitor (iOS/Android) webviews cannot start getDisplayMedia even when the API object exists; Tauri/WebKitGTK may lack it entirely. */
const insideCapacitor = (): boolean => { try { return !!(globalThis as any).Capacitor?.isNativePlatform?.(); } catch { return false; } };

export function detectPlatform(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '', nav: any = typeof navigator !== 'undefined' ? navigator : {}, native: boolean = insideCapacitor()): Platform {
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  const isAndroid = /Android/i.test(ua) || (native && /android/i.test(String((globalThis as any).Capacitor?.getPlatform?.() ?? '')));
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  const canScreenShare = !!nav.mediaDevices?.getDisplayMedia && !isIOS && !isAndroid && !native;
  return { isIOS: isIOS || (native && /ios/i.test(String((globalThis as any).Capacitor?.getPlatform?.() ?? ''))), isAndroid, isMobile: isIOS || isAndroid || native, isSafari, canScreenShare };
}

/** Conservative encode limits for mobile browsers (thermal + hardware encoder limits). */
export function mobileConstraints(p: Platform): PresetConstraints {
  if (!p.isMobile) return {};
  return { maxHeight: 1080, maxFps: 30, allowHd: true, uplinkKbps: 8000 };
}
