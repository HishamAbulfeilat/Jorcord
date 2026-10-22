/**
 * DM / group-DM call ringing.
 *
 * The first person into a DM voice channel starts a ring: every other participant who may be rung gets CALL_RING (gateway) and a
 * push. The ring ends when they join (`answered`, also tells their other devices to stop), decline, 30 s pass (`timeout`) or the
 * caller leaves before anyone answered (`cancelled`). A ring nobody answered leaves a "missed call" system message.
 *
 * State is per process (a ring lives 30 s): after a restart pending rings are simply gone and clients drop theirs at `expiresAt`.
 */
import { snowflake, type CallRing, type CallRingEndReason } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { postSystemMessage } from './messages';

interface Ring { callId: string; channelId: string; callerId: string; payload: Omit<CallRing, 'silent'>; ringing: Map<string, boolean /* silent */>; answered: boolean; timer: ReturnType<typeof setTimeout> }

const registry = new WeakMap<object, Map<string, Ring>>();
const ringsOf = (ctx: Ctx) => { let m = registry.get(ctx); if (!m) registry.set(ctx, m = new Map()); return m; };

/** Who may be rung for a call started by `callerId` in this DM: participants other than the caller who are real, unblocked (either way), have accepted the conversation and are not already in the call. */
export async function ringableRecipients(ctx: Ctx, channel: { id: string }, callerId: string): Promise<{ id: string; silent: boolean }[]> {
  const rows = await ctx.db.query(
    `SELECT p.user_id AS id, u.presence FROM dm_participants p JOIN users u ON u.id = p.user_id
      WHERE p.channel_id = $1 AND p.user_id <> $2 AND NOT p.request AND NOT u.bot AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM relationships r WHERE r.type = 'blocked' AND ((r.user_id = p.user_id AND r.other_id = $2) OR (r.user_id = $2 AND r.other_id = p.user_id)))`,
    [channel.id, callerId]);
  const inCall = new Set((await ctx.voice.inChannel(channel.id)).map((s) => s.userId));
  return rows.filter((r) => !inCall.has(r.id)).map((r) => ({ id: r.id as string, silent: r.presence === 'dnd' }));
}

const toDTO = (r: Ring, silent: boolean): CallRing => ({ ...r.payload, silent });

/** Start ringing for a call the caller just opened. No-op when nobody can be rung. */
export async function startRing(ctx: Ctx, channel: any, callerId: string): Promise<void> {
  if (channel.type !== 'dm' && channel.type !== 'group_dm') return;
  if (ctx.config.rateLimit && ctx.rl.hit(`callring:${channel.id}:${callerId}`, 5, 60_000)) return; // redial spam
  const rings = ringsOf(ctx);
  const old = rings.get(channel.id);
  if (old) await finish(ctx, old, 'cancelled', { missed: false });
  const to = await ringableRecipients(ctx, channel, callerId);
  if (!to.length) return;
  const [caller] = await ctx.db.query('SELECT username, display_name FROM users WHERE id = $1', [callerId]);
  const now = Date.now(); const ms = ctx.config.callRingMs;
  const ring: Ring = {
    callId: snowflake(), channelId: channel.id, callerId, answered: false,
    payload: { callId: '', channelId: channel.id, userId: callerId, name: caller?.display_name || caller?.username || 'Someone', channelType: channel.type, groupName: channel.type === 'group_dm' ? channel.name ?? null : null, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + ms).toISOString() },
    ringing: new Map(to.map((t) => [t.id, t.silent])),
    timer: setTimeout(() => { void finish(ctx, ring, 'timeout', { missed: true }).catch((e) => ctx.log.warn({ err: e }, 'call ring timeout failed')); }, ms),
  };
  ring.payload.callId = ring.callId; ring.timer.unref();
  rings.set(channel.id, ring);
  for (const [id, silent] of ring.ringing) await ctx.hub.toUser(id, 'CALL_RING', toDTO(ring, silent));
  ctx.push.notifyCall(channel, callerId);
}

async function finish(ctx: Ctx, ring: Ring, reason: CallRingEndReason, o: { missed: boolean }) {
  const rings = ringsOf(ctx);
  if (rings.get(ring.channelId) !== ring) return;
  rings.delete(ring.channelId); clearTimeout(ring.timer);
  const remaining = [...ring.ringing.keys()]; ring.ringing.clear();
  for (const id of remaining) await ctx.hub.toUser(id, 'CALL_RING_END', { channelId: ring.channelId, callId: ring.callId, reason });
  if (!ring.answered && o.missed) {
    await ctx.hub.toUser(ring.callerId, 'CALL_RING_END', { channelId: ring.channelId, callId: ring.callId, reason });
    await postSystemMessage(ctx, ring.channelId, ring.callerId, 'call', 'missed').catch((e) => ctx.log.warn({ err: e }, 'missed-call message failed'));
  }
}

/** A user connected to the call's voice channel (on any device): their ring stops everywhere. */
export async function onVoiceJoined(ctx: Ctx, userId: string, channelId: string): Promise<void> {
  const ring = ringsOf(ctx).get(channelId); if (!ring || userId === ring.callerId || !ring.ringing.has(userId)) return;
  ring.ringing.delete(userId); ring.answered = true;
  await ctx.hub.toUser(userId, 'CALL_RING_END', { channelId, callId: ring.callId, reason: 'answered', by: userId });
  if (!ring.ringing.size) await finish(ctx, ring, 'answered', { missed: false });
}

/** The caller left voice: if nobody picked up, the call is cancelled and counts as missed. */
export async function onVoiceLeft(ctx: Ctx, userId: string, channelId: string): Promise<void> {
  const ring = ringsOf(ctx).get(channelId); if (!ring || ring.callerId !== userId || ring.answered) return;
  await finish(ctx, ring, 'cancelled', { missed: true });
}

/** A ringing user declined (all their devices stop). Returns false when there was nothing to decline. */
export async function declineRing(ctx: Ctx, userId: string, channelId: string): Promise<boolean> {
  const ring = ringsOf(ctx).get(channelId); if (!ring || !ring.ringing.has(userId)) return false;
  ring.ringing.delete(userId);
  await ctx.hub.toUser(userId, 'CALL_RING_END', { channelId, callId: ring.callId, reason: 'declined', by: userId });
  if (!ring.ringing.size && !ring.answered) await finish(ctx, ring, 'declined', { missed: true });
  else if (!ring.ringing.size) await finish(ctx, ring, 'answered', { missed: false });
  return true;
}

/** Rings still active for this user (READY replay for a new or reconnected session). */
export function activeRingsFor(ctx: Ctx, userId: string): CallRing[] {
  const out: CallRing[] = [];
  for (const r of ringsOf(ctx).values()) { const s = r.ringing.get(userId); if (s !== undefined) out.push(toDTO(r, s)); }
  return out;
}
