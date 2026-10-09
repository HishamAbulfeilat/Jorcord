export type VoiceErrorCode =
  | 'permission-denied' | 'no-device' | 'device-busy' | 'constraints' | 'insecure-context'
  | 'screen-cancelled' | 'unsupported' | 'token' | 'connection' | 'unknown';

export interface VoiceError { code: VoiceErrorCode; message: string; cause?: unknown }

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
  unknown: 'An unexpected voice error occurred.',
};

/** Map DOMException / LiveKit errors to stable codes the UI can switch on. */
export function mapVoiceError(err: unknown, ctx: 'media' | 'screen' | 'connect' | 'token' = 'media'): VoiceError {
  const name = (err as any)?.name as string | undefined;
  const msg = (err as any)?.message as string | undefined;
  let code: VoiceErrorCode = 'unknown';
  if (ctx === 'token') code = 'token';
  else if (ctx === 'connect') code = 'connection';
  switch (name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      code = ctx === 'screen' ? 'screen-cancelled' : 'permission-denied'; break;
    case 'NotFoundError': case 'DevicesNotFoundError': code = 'no-device'; break;
    case 'NotReadableError': case 'TrackStartError': case 'AbortError': code = 'device-busy'; break;
    case 'OverconstrainedError': case 'ConstraintNotSatisfiedError': code = 'constraints'; break;
    case 'TypeError': if (/mediaDevices|getUserMedia/i.test(msg ?? '')) code = 'insecure-context'; break;
  }
  if (typeof window !== 'undefined' && (window as any).isSecureContext === false && ctx === 'media') code = 'insecure-context';
  return { code, message: MESSAGES[code], cause: err };
}
