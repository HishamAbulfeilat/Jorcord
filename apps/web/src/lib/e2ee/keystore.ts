/**
 * Where a device keeps its secret-chat state: the identity key pair (the private key is a non-extractable CryptoKey, stored by structured clone so
 * its bytes are never visible to script) and the trust pins for the people it chats with. IndexedDB only; localStorage cannot hold a CryptoKey.
 */
export interface StoredIdentity { deviceId: string; privateKey: CryptoKey; publicRaw: Uint8Array }
/** What this device has accepted about a peer: device id -> fingerprint, plus whether the user confirmed the safety number out of band. */
export interface StoredPin { devices: Record<string, string>; verified: boolean; updatedAt: number }

export interface KeyStore {
  /** false when the browser cannot persist keys (private window, storage blocked): keys then only live until the tab closes. */
  readonly persistent: boolean;
  getIdentity(userId: string): Promise<StoredIdentity | null>;
  putIdentity(userId: string, v: StoredIdentity): Promise<void>;
  deleteIdentity(userId: string): Promise<void>;
  getPin(key: string): Promise<StoredPin | null>;
  putPin(key: string, v: StoredPin): Promise<void>;
}

export function memoryKeyStore(): KeyStore {
  const ids = new Map<string, StoredIdentity>(), pins = new Map<string, StoredPin>();
  return {
    persistent: false,
    getIdentity: async (u) => ids.get(u) ?? null, putIdentity: async (u, v) => { ids.set(u, v); }, deleteIdentity: async (u) => { ids.delete(u); },
    getPin: async (k) => pins.get(k) ?? null, putPin: async (k, v) => { pins.set(k, v); },
  };
}

const DB = 'jorcord-e2ee', IDS = 'identity', PINS = 'pins';
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function indexedDbKeyStore(): KeyStore | null {
  if (typeof indexedDB === 'undefined') return null;
  let opened: Promise<IDBDatabase> | null = null;
  const open = () => (opened ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(IDS); r.result.createObjectStore(PINS); };
    r.onsuccess = () => res(r.result); r.onerror = () => { opened = null; rej(r.error); };
  }));
  const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => req(fn((await open()).transaction(store, mode).objectStore(store)));
  return {
    persistent: true,
    getIdentity: async (u) => ((await tx(IDS, 'readonly', (s) => s.get(u))) as StoredIdentity | undefined) ?? null,
    putIdentity: async (u, v) => { await tx(IDS, 'readwrite', (s) => s.put(v, u)); },
    deleteIdentity: async (u) => { await tx(IDS, 'readwrite', (s) => s.delete(u)); },
    getPin: async (k) => ((await tx(PINS, 'readonly', (s) => s.get(k))) as StoredPin | undefined) ?? null,
    putPin: async (k, v) => { await tx(PINS, 'readwrite', (s) => s.put(v, k)); },
  };
}

let shared: KeyStore | null = null;
/** The store used by the app: IndexedDB when it works (probed once), otherwise in memory. */
export async function defaultKeyStore(): Promise<KeyStore> {
  if (shared) return shared;
  const idb = indexedDbKeyStore();
  if (idb) { try { await idb.getPin('probe'); shared = idb; return idb; } catch { /* blocked or private window */ } }
  return (shared = memoryKeyStore());
}
