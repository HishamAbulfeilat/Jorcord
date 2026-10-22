import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { ApiError, notFound } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { expireExports, jobDTO, requestExport, uiDownloadUrl, verifyDownloadSig } from '../services/dataExport';

/** Public: the signed link is the credential (emailed, or handed out for 10 minutes to the signed-in owner). */
export function exportPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/exports/:id/download', async (req, reply) => {
    limitOrThrow(ctx.rl, `export-dl:${req.ip}`, 30, 3600_000, ctx.config.rateLimit);
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(z.object({ exp: z.coerce.number().int(), sig: z.string().min(20).max(100) }), req.query);
    if (!verifyDownloadSig(ctx, id, q.exp, q.sig)) throw new ApiError(403, 'INVALID_LINK', 'This download link is invalid or has expired');
    const [job] = await ctx.db.query(`SELECT * FROM export_jobs WHERE id = $1 AND status = 'ready' AND expires_at > now() AND storage_key IS NOT NULL`, [id]);
    if (!job) throw new ApiError(410, 'EXPORT_GONE', 'This export has expired. Request a new one from Settings.');
    await ctx.db.query('UPDATE export_jobs SET downloads = downloads + 1 WHERE id = $1', [id]);
    ctx.log.info({ userId: job.user_id, exportId: id }, 'data export downloaded');
    return reply.header('content-type', 'application/zip').header('content-length', String(job.size_bytes))
      .header('content-disposition', `attachment; filename="jorcord-export-${id}.zip"`).header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
      .send(ctx.storage.get(job.storage_key));
  });
}

export function exportRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Starts an export. 202 + job; poll GET /users/@me/exports/:id. One per account per 24h (failed attempts do not count). */
  app.post('/users/@me/exports', async (req, reply) => {
    limitOrThrow(ctx.rl, `export-req:${req.userId}`, 10, 3600_000, ctx.config.rateLimit); // burst brake in front of the daily DB rule
    const job = await requestExport(ctx, req.userId);
    return reply.code(202).send(jobDTO(job));
  });
  app.get('/users/@me/exports', async (req) => {
    await expireExports(ctx).catch(() => {});
    const rows = await ctx.db.query('SELECT * FROM export_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [req.userId]);
    return rows.map((r) => ({ ...jobDTO(r), ...(r.status === 'ready' ? { downloadUrl: uiDownloadUrl(ctx, r) } : {}) }));
  });
  app.get('/users/@me/exports/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await expireExports(ctx).catch(() => {});
    const [r] = await ctx.db.query('SELECT * FROM export_jobs WHERE id = $1 AND user_id = $2', [id, req.userId]); // owner only
    if (!r) throw notFound('Export');
    return { ...jobDTO(r), ...(r.status === 'ready' ? { downloadUrl: uiDownloadUrl(ctx, r) } : {}) };
  });
  app.delete('/users/@me/exports/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    // the row stays (status 'expired') so deleting an archive does not reset the once-a-day limit
    const rows = await ctx.db.query(`UPDATE export_jobs SET status = 'expired', storage_key = NULL WHERE id = $1 AND user_id = $2 AND status = 'ready' RETURNING (SELECT storage_key FROM export_jobs x WHERE x.id = $1) AS key`, [id, req.userId]);
    if (!rows.length) throw notFound('Export');
    if (rows[0].key) await ctx.storage.delete(rows[0].key).catch(() => {});
    return reply.code(204).send();
  });
}
