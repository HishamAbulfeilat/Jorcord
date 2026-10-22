import { crc32, deflateRawSync } from 'node:zlib';
import { open, type FileHandle } from 'node:fs/promises';

/**
 * Minimal streaming ZIP writer (deflate, no zip64): entries are compressed one at a time in memory and appended to a file, so peak memory is one entry.
 * Enough for export bundles (< 4 GB, < 65k entries); `add` throws rather than writing a corrupt archive when a limit is hit.
 */
export class ZipFileWriter {
  private fh!: FileHandle; private offset = 0; private central: Buffer[] = []; private names = new Set<string>();
  private constructor(private path: string) {}
  static async create(path: string) { const w = new ZipFileWriter(path); w.fh = await open(path, 'w', 0o600); return w; }
  private async write(b: Buffer) { await this.fh.write(b, 0, b.length); this.offset += b.length; }
  async add(name: string, data: Buffer | string, when = new Date()) {
    if (!/^[A-Za-z0-9_.\-\/]{1,200}$/.test(name) || name.includes('..') || name.startsWith('/')) throw new Error(`bad zip entry name ${name}`);
    if (this.names.has(name)) throw new Error(`duplicate zip entry ${name}`);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (this.central.length >= 65_000 || this.offset + raw.length > 0xF000_0000 || raw.length > 0xF000_0000) throw new Error('zip limits exceeded');
    this.names.add(name);
    const body = deflateRawSync(raw), crc = crc32(raw), nameBuf = Buffer.from(name, 'utf8');
    const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xFFFF;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(crc >>> 0, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(this.offset, 42);
    this.central.push(Buffer.concat([c, nameBuf]));
    await this.write(Buffer.concat([h, nameBuf, body]));
  }
  async finish() {
    const start = this.offset, dir = Buffer.concat(this.central);
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(this.central.length, 8); e.writeUInt16LE(this.central.length, 10); e.writeUInt32LE(dir.length, 12); e.writeUInt32LE(start, 16);
    await this.write(Buffer.concat([dir, e]));
    await this.fh.close();
  }
  async abort() { await this.fh.close().catch(() => {}); }
}
