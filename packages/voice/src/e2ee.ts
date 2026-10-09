import { ExternalE2EEKeyProvider } from 'livekit-client';

export interface E2EEHandle { keyProvider: ExternalE2EEKeyProvider; worker: Worker; setPassphrase(p: string): Promise<void> }

export { isE2EESupported } from 'livekit-client';

/**
 * Create E2EE options for `new Room({ e2ee })`. Bundlers: the worker is resolved via `new URL(..., import.meta.url)`
 * which Vite/webpack handle. Share the passphrase out-of-band (e.g. derived from a channel secret); the server never sees it.
 */
export function createE2EE(): E2EEHandle {
  const keyProvider = new ExternalE2EEKeyProvider();
  const worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });
  return { keyProvider, worker, setPassphrase: (p) => keyProvider.setKey(p) };
}
