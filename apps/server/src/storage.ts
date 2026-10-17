import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/** File storage abstraction. Implementations: LocalStorage (disk) and S3Storage (storage-s3.ts, S3-compatible). */
export interface Storage {
  /** Stream into storage. Rejects if more than maxBytes are written. Returns bytes written. */
  put(key: string, data: Readable, maxBytes: number): Promise<number>;
  get(key: string, range?: { start: number; end: number }): Readable;
  size(key: string): Promise<number | null>;
  /** First bytes of an object (for image dimension sniffing). */
  head(key: string, bytes: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  private path(key: string) {
    if (!/^[a-f0-9]{16,64}$/.test(key)) throw new Error('invalid storage key');
    return join(this.root, key.slice(0, 2), key);
  }
  async put(key: string, data: Readable, maxBytes: number) {
    const p = this.path(key); mkdirSync(dirname(p), { recursive: true });
    let n = 0;
    const out = createWriteStream(p, { flags: 'wx' });
    try {
      data.on('data', (c: Buffer) => { n += c.length; if (n > maxBytes) data.destroy(new Error('FILE_TOO_LARGE')); });
      await pipeline(data, out);
    } catch (e) { await rm(p, { force: true }); throw e; }
    return n;
  }
  get(key: string, range?: { start: number; end: number }) { return createReadStream(this.path(key), range); }
  async size(key: string) { try { return (await stat(this.path(key))).size; } catch { return null; } }
  async head(key: string, bytes: number) {
    const chunks: Buffer[] = [];
    for await (const c of createReadStream(this.path(key), { start: 0, end: bytes - 1 })) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
}

export async function createStorage(cfg: { dataDir: string; storage: { driver: 'local' | 's3'; s3: Parameters<typeof import('./storage-s3').createS3Storage>[0] } }): Promise<Storage> {
  if (cfg.storage.driver === 's3') return (await import('./storage-s3')).createS3Storage(cfg.storage.s3);
  return new LocalStorage(join(cfg.dataDir, 'files'));
}
