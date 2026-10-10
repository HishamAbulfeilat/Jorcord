export type VoiceErrorCode =
  | 'permission-denied' | 'no-device' | 'device-busy' | 'constraints' | 'insecure-context'
  | 'screen-cancelled' | 'unsupported' | 'token' | 'connection'
  | 'timeout' | 'signal-unreachable' | 'ice-failed' | 'unknown';

export interface VoiceError {
  code: VoiceErrorCode; message: string;
  /** What to check next (shown in the Troubleshoot panel). */
  hint?: string;
  cause?: unknown;
}

const MESSAGES: Record<VoiceErrorCode, string> = {
  'permission-denied': 'Permission was denied. Allow microphone/camera access in your browser or system settings.',
  'no-device': 'No matching input device was found.',
  'device-busy': 'The device is in use by another application or could not be started.',
  constraints: 'The requested capture settings are not supported by this device.',
  'insecure-context': 'Media capture requires HTTPS (or localhost).',
  'screen-cancelled': 'Screen share was cancelled.',
  unsupported: 'This feature is not supported by this browser.',
  token: 'Could not obtain a voice token.',
  connection: 'Could not connect to the voice server.',
  timeout: 'Connecting to the voice server timed out.',
  'signal-unreachable': 'Could not reach the voice server (signalling).',
  'ice-failed': 'Reached the voice server, but no audio/video path could be established (ICE failed).',
  unknown: 'An unexpected voice error occurred.',
};

const HINTS: Partial<Record<VoiceErrorCode, string>> = {
  'permission-denied': 'Click the lock/camera icon in the address bar and allow the microphone, then retry. On Windows also check Settings > Privacy > Microphone.',
  'no-device': 'Plug in or enable a microphone and pick it in Voice Settings.',
  'device-busy': 'Close other apps that use the microphone (or another browser tab) and retry.',
  'insecure-context': 'Browsers only allow the microphone on https:// pages or http://localhost. Open the app via https (a reverse proxy with TLS) or use localhost.',
  token: 'The Jorcord server refused the join (you may lack the Connect permission, the channel may be full, or you were signed out). Reload the page and retry.',
  timeout: 'Neither the signalling connection nor the media path came up in time. Check that the LiveKit service is running and that the LIVEKIT_URL / ports are reachable from THIS browser.',
  'signal-unreachable': 'The browser could not open a WebSocket to the LiveKit URL. Make sure the livekit container is running, LIVEKIT_URL points at an address reachable from this browser (not an internal Docker name), and that a firewall/proxy is not blocking it. With LIVEKIT_URL=auto signalling goes through the Jorcord server on the same port.',
  'ice-failed': 'Signalling works but media cannot flow: UDP 50000-50200 and TCP 7881 (or the single UDP port) must be published and reachable, and LIVEKIT_NODE_IP must be the address your browser can reach (127.0.0.1 for localhost, the LAN/public IP otherwise). Behind strict firewalls enable TURN/TLS.',
  connection: 'Check that the voice service is running and reachable, then retry.',
};

/** Map DOMException / LiveKit errors to stable codes the UI can switch on. */
export function mapVoiceError(err: unknown, ctx: 'media' | 'screen' | 'connect' | 'token' = 'media'): VoiceError {
  const name = (err as any)?.name as string | undefined;
  const msg = (err as any)?.message as string | undefined;
  let code: VoiceErrorCode = 'unknown';
  if (ctx === 'token') code = 'token';
  else if (ctx === 'connect') code = classifyConnect(err);
  switch (name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      code = ctx === 'screen' ? 'screen-cancelled' : 'permission-denied'; break;
    case 'NotFoundError': case 'DevicesNotFoundError': code = 'no-device'; break;
    case 'NotReadableError': case 'TrackStartError': case 'AbortError': code = 'device-busy'; break;
    case 'OverconstrainedError': case 'ConstraintNotSatisfiedError': code = 'constraints'; break;
    case 'TypeError': if (/mediaDevices|getUserMedia/i.test(msg ?? '')) code = 'insecure-context'; break;
  }
  if (typeof window !== 'undefined' && (window as any).isSecureContext === false && ctx === 'media') code = 'insecure-context';
  return { code, message: MESSAGES[code], hint: HINTS[code], cause: err };
}

/** livekit-client ConnectionError reasons: 0 NotAllowed, 1 ServerUnreachable, 2 InternalError, 3 Cancelled, 5 Timeout, 6 WebSocket. */
function classifyConnect(err: unknown): VoiceErrorCode {
  const e = err as any; const msg = String(e?.message ?? '');
  if (e?.name === 'VoiceConnectTimeout') return e.phase === 'ice' ? 'ice-failed' : 'timeout';
  if (/pc connection|peerconnection|ice|dtls/i.test(msg)) return 'ice-failed';
  switch (e?.reason) {
    case 0: return 'token';
    case 1: case 6: return 'signal-unreachable';
    case 5: return /pc|peer|ice/i.test(msg) ? 'ice-failed' : 'timeout';
    case 7: return 'signal-unreachable';
  }
  if (/websocket|failed to fetch|network|unreachable|ECONNREFUSED/i.test(msg)) return 'signal-unreachable';
  if (/timed? ?out|timeout/i.test(msg)) return 'timeout';
  return 'connection';
}
