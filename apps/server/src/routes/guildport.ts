import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { IMPORT_LIMITS, Perm } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { readZip } from '../lib/unzip';
import { ZipFileWriter } from '../lib/zip';
import { guildAccess, guildPerms, need } from '../services/perms';
import { audit } from '../services/guilds';
import { applyImport, exportGuild, normalizeImport } from '../services/guildPort';

const gid = z.object({ id: idSchema });

/** Reads a stream into memory, refusing (and destroying it) the moment it passes `max` bytes. */
async function readCapped(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of stream) {
    n += (c as Buffer).length;
    if (n > max) { stream.destroy(); throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `The file is larger than ${Math.round(max / 1024 / 1024)} MB`); }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Server structure backup (export) and migration helper (import). Owner or MANAGE_GUILD only; structure only, never messages or members. */
export function guildPortRoutes(app: FastifyInstance, ctx: Ctx) {
  async function requireManager(userId: string, guildId: string) {
    const gp = await guildAccess(ctx, userId, guildId);
    const perms = guildPerms(gp);
    need(perms, Perm.MANAGE_GUILD); // the owner holds every bit
    return perms;
  }

  /** `?format=json` (default) or `zip` (adds the emoji images: `server.json` + `emoji/*`). */
  app.get('/guilds/:id/export', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ format: z.enum(['json', 'zip']).optional() }), req.query);
    await requireManager(req.userId, id);
    limitOrThrow(ctx.rl, `gexport:${req.userId}`, 10, 3_600_000, ctx.config.rateLimit);
    const { doc, emojiFiles } = await exportGuild(ctx, id);
    await audit(ctx, id, req.userId, 'GUILD_EXPORT', null, { roles: doc.roles.length, channels: doc.channels.length, emoji: doc.emoji.length, format: q.format ?? 'json' });
    const base = `${doc.source.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'server'}-structure`;
    if (q.format !== 'zip') {
      reply.header('content-disposition', `attachment; filename="${base}.json"`);
      return reply.type('application/json').send(JSON.stringify({ ...doc, emoji: doc.emoji.map((e) => ({ ...e, file: null })) }, null, 2));
    }
    const dir = await mkdtemp(join(tmpdir(), 'jorcord-export-'));
    try {
      const path = join(dir, 'export.zip');
      const w = await ZipFileWriter.create(path);
      try {
        let total = 0;
        const kept = new Set<string>();
        for (const f of emojiFiles) {
          const size = await ctx.storage.size(f.key);
          if (size === null || size > IMPORT_LIMITS.emojiBytes || (total += size) > 48 * 1024 * 1024) continue; // oversized images would not import back anyway
          const chunks: Buffer[] = []; for await (const c of ctx.storage.get(f.key)) chunks.push(c as Buffer);
          await w.add(f.file, Buffer.concat(chunks)); kept.add(f.file);
        }
        await w.add('server.json', JSON.stringify({ ...doc, emoji: doc.emoji.map((e) => ({ ...e, file: e.file && kept.has(e.file) ? e.file : null })) }, null, 2));
        await w.finish();
      } catch (e) { await w.abort(); throw e; }
      const data = await readFile(path);
      reply.header('content-disposition', `attachment; filename="${base}.zip"`);
      return reply.type('application/zip').send(data);
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });

  /**
   * Body: the JSON document itself (up to 2 MB), or multipart with one `file` field holding a .json or a .zip (up to 8 MB).
   * `?dryRun=true` validates and reports without creating anything. `?applyEveryone=true` also replaces the server's @everyone permissions.
   */
  app.post('/guilds/:id/import', { bodyLimit: IMPORT_LIMITS.jsonBytes }, async (req, reply) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ dryRun: z.enum(['true', 'false']).optional(), applyEveryone: z.enum(['true', 'false']).optional() }), req.query);
    const perms = await requireManager(req.userId, id);
    const dryRun = q.dryRun === 'true';
    limitOrThrow(ctx.rl, dryRun ? `gimport-dry:${req.userId}` : `gimport:${req.userId}`, dryRun ? 30 : 5, 3_600_000, ctx.config.rateLimit);
    if (!dryRun) limitOrThrow(ctx.rl, `gimport-guild:${id}`, 10, 3_600_000, ctx.config.rateLimit);
    let doc: unknown; const files = new Map<string, Buffer>();
    if (req.isMultipart()) {
      let buf: Buffer | null = null;
      for await (const part of req.parts({ limits: { files: 1, fields: 4, fileSize: IMPORT_LIMITS.zipBytes } })) {
        if (part.type === 'file' && !buf) buf = await readCapped(part.file, IMPORT_LIMITS.zipBytes);
        else if (part.type === 'file') part.file.resume();
      }
      if (!buf?.length) throw badRequest('Attach the export as a "file" field (.json or .zip)');
      let jsonText: string;
      if (isZip(buf)) {
        let entries: Map<string, Buffer>;
        try { entries = readZip(buf, { maxEntries: IMPORT_LIMITS.entries, maxEntryBytes: IMPORT_LIMITS.jsonBytes, maxTotalBytes: 3 * IMPORT_LIMITS.zipBytes }); }
        catch (e: any) { throw badRequest(String(e?.message ?? 'Invalid zip file')); }
        const main = entries.get('server.json') ?? [...entries.entries()].find(([n]) => n.endsWith('.json') && !n.includes('/'))?.[1];
        if (!main) throw badRequest('The zip has no server.json');
        for (const [name, data] of entries) if (name.startsWith('emoji/')) files.set(name, data);
        jsonText = main.toString('utf8');
      } else {
        if (buf.length > IMPORT_LIMITS.jsonBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON files can be at most 2 MB; use a zip');
        jsonText = buf.toString('utf8');
      }
      try { doc = JSON.parse(jsonText); } catch { throw badRequest('The file is not valid JSON'); }
    } else doc = req.body;
    const norm = normalizeImport(doc, files);
    const report = await applyImport(ctx, id, { userId: req.userId, perms }, norm, { dryRun, applyEveryone: q.applyEveryone === 'true' });
    return reply.code(dryRun ? 200 : 201).send(report);
  });
}
