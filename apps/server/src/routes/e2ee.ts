import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { E2EE_MAX_DEVICES, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, notFound } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { channelAccess } from '../services/perms';
import { activeDeviceCount, activeDevices, announceDevices, deviceDTO, validatePublicKey } from '../services/e2ee';

/** Device public keys for secret chats. The server stores public keys only; see docs/E2EE_DMS.md. */
export function e2eeRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/users/@me/e2ee/devices', async (req) => activeDevices(ctx, [req.userId]));

  /** Idempotent: registering the same public key again returns the existing device (and un-revokes nothing: a revoked key must be re-generated). */
  app.post('/users/@me/e2ee/devices', async (req, reply) => {
    const b = parse(z.object({ publicKey: z.string().min(80).max(100), label: z.string().trim().max(64).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `e2ee-dev:${req.userId}`, 10, 3_600_000, ctx.config.rateLimit);
    if (!validatePublicKey(b.publicKey)) throw badRequest('publicKey must be an uncompressed P-256 point (base64url)');
    const [ex] = await ctx.db.query('SELECT * FROM e2ee_devices WHERE user_id = $1 AND public_key = $2', [req.userId, b.publicKey]);
    if (ex) {
      if (ex.revoked_at) throw new ApiError(409, 'E2EE_DEVICE_REVOKED', 'This device key was revoked; generate a new one');
      await ctx.db.query('UPDATE e2ee_devices SET last_seen_at = now() WHERE id = $1', [ex.id]);
      return deviceDTO({ ...ex, last_seen_at: new Date() });
    }
    if ((await activeDeviceCount(ctx, req.userId)) >= E2EE_MAX_DEVICES) throw new ApiError(400, 'E2EE_DEVICE_LIMIT', `At most ${E2EE_MAX_DEVICES} active devices; revoke one first`);
    const id = snowflake();
    await ctx.db.query('INSERT INTO e2ee_devices (id, user_id, public_key, label, last_seen_at) VALUES ($1,$2,$3,$4,now())', [id, req.userId, b.publicKey, b.label || null]);
    await announceDevices(ctx, req.userId);
    const [row] = await ctx.db.query('SELECT * FROM e2ee_devices WHERE id = $1', [id]);
    return reply.code(201).send(deviceDTO(row));
  });

  app.delete('/users/@me/e2ee/devices/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const r = await ctx.db.query('UPDATE e2ee_devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id', [id, req.userId]);
    if (!r.length) throw notFound('Device');
    await announceDevices(ctx, req.userId);
    return reply.code(204).send();
  });

  /** Both participants' active device keys: what a client needs to encrypt to, and to compute the safety number. Participants only. */
  app.get('/channels/:id/e2ee/devices', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(z.object({ includeRevoked: z.enum(['true', 'false']).optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, id);
    if (!a.channel.encrypted) throw badRequest('This is not a secret chat');
    const parts = (await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1', [id])).map((r) => r.user_id as string);
    return { channelId: id, devices: await activeDevices(ctx, parts, q.includeRevoked === 'true') };
  });
}
