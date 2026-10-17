import type { FastifyReply, FastifyRequest } from 'fastify';
import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';

/**
 * Super-admin "god mode": while active, the super admin (SUPER_ADMIN_USER_ID) is treated as the owner of every guild, so every
 * permission and hierarchy check passes, member or not. It is opt-in, re-authenticated, expires on its own after GOD_MODE_MS and
 * lives only in memory (a restart turns it off). Every non-GET request made while it is on is written to admin_audit.
 */
export const GOD_MODE_MS = 60 * 60_000;
const until = new Map<string, number>();

export const isSuperAdminId = (ctx: Ctx, userId: string) => !!ctx.config.superAdminId && userId === ctx.config.superAdminId;

export function godModeUntil(ctx: Ctx, userId: string): number | null {
  if (!isSuperAdminId(ctx, userId)) return null;
  const t = until.get(userId);
  if (t === undefined) return null;
  if (t <= Date.now()) { until.delete(userId); return null; }
  return t;
}
export const godModeActive = (ctx: Ctx, userId: string) => godModeUntil(ctx, userId) !== null;

export function setGodMode(ctx: Ctx, userId: string, on: boolean): number | null {
  if (!isSuperAdminId(ctx, userId)) return null;
  if (on) until.set(userId, Date.now() + GOD_MODE_MS); else until.delete(userId);
  return godModeUntil(ctx, userId);
}

export async function adminAudit(ctx: Ctx, userId: string, action: string, path: string, status: number | null) {
  await ctx.db.query('INSERT INTO admin_audit (id, user_id, action, path, status) VALUES ($1,$2,$3,$4,$5)', [snowflake(), userId, action, path.slice(0, 500), status]);
}

/** onResponse hook: record every state-changing request the super admin makes while god mode is on. */
export function godModeAuditHook(ctx: Ctx) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.userId || req.isBot || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!godModeActive(ctx, req.userId)) return;
    await adminAudit(ctx, req.userId, req.method, req.url.split('?')[0] ?? '', reply.statusCode).catch((e) => req.log.error(e, 'admin audit write failed'));
  };
}
