import { api } from '@/lib/api';
import { setShareMaxSeconds } from './clipBuffer';

/** Reads the server's cap for shared clips (GET /clips/limits) once; the default (120 s) applies when it cannot be reached. */
let loaded: Promise<void> | null = null;
export function loadClipLimits(): Promise<void> {
  loaded ??= Promise.resolve().then(() => api.clips.limits()).then((l) => setShareMaxSeconds(l?.maxSeconds)).catch(() => { loaded = null; });
  return loaded;
}
