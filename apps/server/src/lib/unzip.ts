import { crc32, inflateRawSync } from 'node:zlib';

export interface UnzipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }

/**
 * Minimal, defensive ZIP reader for untrusted uploads (server structure imports). Reads the central directory, supports stored and deflated entries only
 * (no zip64, no encryption), never touches the filesystem and never trusts declared sizes: inflation is capped by `maxOutputLength` so a zip bomb
 * is refused before it is expanded. Entry names are only used as map keys; names that could escape a directory are rejected outright.
 */
export function readZip(buf: Buffer, lim: UnzipLimits): Map<string, Buffer> {
  const fail = (m: string): never => { throw new Error(`zip: ${m}`); };
  if (buf.length < 22) fail('too small');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('not a zip file');
  const count = buf.readUInt16LE(eocd + 10), dirSize = buf.readUInt32LE(eocd + 12), dirOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOff === 0xffffffff || dirSize === 0xffffffff) fail('zip64 is not supported');
  if (count > lim.maxEntries) fail('too many entries');
  if (dirOff + dirSize > eocd) fail('corrupt directory');
  const out = new Map<string, Buffer>();
  let total = 0, p = dirOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('corrupt directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen > buf.length) fail('corrupt directory');
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // directory entry
    if (flags & 1) fail('encrypted entries are not supported');
    if (!name || name.length > 200 || name.startsWith('/') || name.includes('\\') || name.split('/').some((s) => s === '..' || s === '.') || /[\u0000-\u001f]/.test(name)) fail('unsafe entry name');
    if (out.has(name)) fail('duplicate entry');
    if (usize > lim.maxEntryBytes) fail(`entry ${name} is too large`);
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) fail('corrupt entry');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    if (start + csize > buf.length) fail('corrupt entry');
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: lim.maxEntryBytes }); } catch { return fail(`entry ${name} is corrupt or too large`); }
    } else return fail('unsupported compression');
    if (data.length !== usize || (crc32(data) >>> 0) !== crc) fail(`entry ${name} failed its checksum`);
    total += data.length;
    if (total > lim.maxTotalBytes) fail('archive expands to too much data');
    out.set(name, data);
  }
  return out;
}
