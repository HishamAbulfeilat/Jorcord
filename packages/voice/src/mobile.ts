import type { PresetConstraints } from './presets';

export interface Platform { isIOS: boolean; isAndroid: boolean; isMobile: boolean; isSafari: boolean; canScreenShare: boolean }

export function detectPlatform(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '', nav: any = typeof navigator !== 'undefined' ? navigator : {}): Platform {
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  const isAndroid = /Android/i.test(ua);
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  const canScreenShare = !!nav.mediaDevices?.getDisplayMedia && !isIOS && !isAndroid;
  return { isIOS, isAndroid, isMobile: isIOS || isAndroid, isSafari, canScreenShare };
}

/** Conservative encode limits for mobile browsers (thermal + hardware encoder limits). */
export function mobileConstraints(p: Platform): PresetConstraints {
  if (!p.isMobile) return {};
  return { maxHeight: 1080, maxFps: 30, allowHd: true, uplinkKbps: 8000 };
}
