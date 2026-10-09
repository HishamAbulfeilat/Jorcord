import { PassThrough, Transform, type Readable } from 'node:stream';
import type { Storage } from './storage';

/** The slice of S3Client we use. Narrow on purpose so tests can fake it. */
export interface S3Like { send(cmd: any): Promise<any> }
export interface S3Options { bucket: string; prefix?: string }
type Commands = { GetObjectCommand: any; HeadObjectCommand: any; DeleteObjectCommand: any };

const KEY_RE = /^[a-f0-9]{16,64}$/;

/** S3-compatible object storage (AWS S3, MinIO, R2, ...). Same contract as LocalStorage. */
export class S3Storage implements Storage {
  constructor(private client: S3Like, private opts: S3Options, private cmds: Commands, private upload: (client: S3Like, params: any) => { done(): Promise<unknown>; abort(): Promise<void> }) {}

  private objectKey(key: string) {
    if (!KEY_RE.test(key)) throw new Error('invalid storage key');
    return `${this.opts.prefix ?? ''}${key.slice(0, 2)}/${key}`;
  }

  async put(key: string, data: Readable, maxBytes: number) {
    let n = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        n += chunk.length;
        if (n > maxBytes) return cb(new Error('FILE_TOO_LARGE'));
        cb(null, chunk);
      },
    });
    data.on('error', (e) => counter.destroy(e));
    counter.on('error', () => data.destroy());
    const up = this.upload(this.client, { params: { Bucket: this.opts.bucket, Key: this.objectKey(key), Body: data.pipe(counter) }, queueSize: 3, partSize: 8 * 1024 * 1024, leavePartsOnError: false });
    try { await up.done(); }
    catch (e) {
      await up.abort().catch(() => {});
      await this.delete(key).catch(() => {});
      throw e;
    }
    return n;
  }

  get(key: string, range?: { start: number; end: number }) {
    const out = new PassThrough();
    this.client.send(new this.cmds.GetObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }))
      .then((r: any) => { (r.Body as Readable).on('error', (e) => out.destroy(e)).pipe(out); })
      .catch((e: any) => out.destroy(e));
    return out;
  }

  async size(key: string) {
    try { const r = await this.client.send(new this.cmds.HeadObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) })); return Number(r.ContentLength); }
    catch (e: any) { if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null; throw e; }
  }

  async head(key: string, bytes: number) {
    const r = await this.client.send(new this.cmds.GetObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key), Range: `bytes=0-${bytes - 1}` }));
    const chunks: Buffer[] = [];
    for await (const c of r.Body as Readable) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async delete(key: string) { await this.client.send(new this.cmds.DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) })); }
}

export async function createS3Storage(cfg: { bucket: string; region: string; endpoint: string | null; accessKeyId: string | null; secretAccessKey: string | null; forcePathStyle: boolean; prefix: string }): Promise<S3Storage> {
  if (!cfg.bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  const s3 = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const client = new s3.S3Client({
    region: cfg.region, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}), forcePathStyle: cfg.forcePathStyle,
    ...(cfg.accessKeyId && cfg.secretAccessKey ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } } : {}),
  });
  return new S3Storage(client, { bucket: cfg.bucket, prefix: cfg.prefix }, s3, (c, params) => new Upload({ client: c as any, ...params }));
}
