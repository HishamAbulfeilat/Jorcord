import { LINKED_ROLE_LIMITS, type LinkedCriterion, type LinkedCriterionProgress, type LinkedOp, type LinkedRole, type LinkedRoleView, type RoleMetadataField } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { applyRoleChanges } from './roles';

const DAY = 86400_000;
export const linkedRoleDTO = (r: any): LinkedRole => ({ id: r.id, guildId: r.guild_id, roleId: r.role_id, description: r.description ?? null, criteria: r.criteria ?? [], createdAt: iso(r.created_at)! });

/** Everything about one member that criteria can look at. Fields are loaded on demand (see needsOf). */
export interface Facts {
  accountCreatedAt: number; joinedAt: number; now: number; messageCount: number;
  verifiedConnections: string[]; appValues: Record<string, Record<string, number | boolean>>;
}
const cmp = (a: number | boolean, op: LinkedOp, b: number | boolean) => op === '>=' ? Number(a) >= Number(b) : op === '<=' ? Number(a) <= Number(b) : op === '=' ? a === b : a !== b;

/** Pure: does this member satisfy the criterion, and what is their current standing? */
export function evalCriterion(c: LinkedCriterion, f: Facts): LinkedCriterionProgress {
  switch (c.type) {
    case 'account_age_days': { const d = Math.floor((f.now - f.accountCreatedAt) / DAY); return { met: d >= c.value, current: d }; }
    case 'join_age_days': { const d = Math.floor((f.now - f.joinedAt) / DAY); return { met: d >= c.value, current: d }; }
    case 'message_count': return { met: f.messageCount >= c.value, current: f.messageCount };
    case 'connection': { const has = c.provider ? f.verifiedConnections.includes(c.provider) : f.verifiedConnections.length > 0; return { met: has, current: has }; }
    case 'app_metadata': {
      const v = f.appValues[c.appId]?.[c.key];
      if (v === undefined) return { met: c.op === '!=', current: null }; // no value reported: only "is not" can hold
      return { met: typeof v === typeof c.value && cmp(v, c.op, c.value), current: v };
    }
  }
}
export const allMet = (criteria: LinkedCriterion[], f: Facts) => criteria.length > 0 && criteria.every((c) => evalCriterion(c, f).met);

/** Which fact groups a set of criteria needs (so cheap criteria do not pay for a message count). */
export function needsOf(criteria: LinkedCriterion[]) {
  const t = new Set(criteria.map((c) => c.type));
  return { messages: t.has('message_count'), connections: t.has('connection'), apps: t.has('app_metadata') };
}

export async function loadFacts(ctx: Ctx, guildId: string, userId: string, needs: ReturnType<typeof needsOf>): Promise<Facts | null> {
  const [m] = await ctx.db.query('SELECT m.joined_at, u.created_at, u.bot FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id = $2', [guildId, userId]);
  if (!m) return null;
  const f: Facts = { accountCreatedAt: new Date(m.created_at).getTime(), joinedAt: new Date(m.joined_at).getTime(), now: Date.now(), messageCount: 0, verifiedConnections: [], appValues: {} };
  if (needs.messages) { const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM (SELECT 1 FROM messages WHERE guild_id = $1 AND author_id = $2 AND type IN (\'default\',\'reply\') LIMIT $3) x', [guildId, userId, LINKED_ROLE_LIMITS.maxCount + 1]); f.messageCount = c.n; }
  if (needs.connections) f.verifiedConnections = (await ctx.db.query('SELECT DISTINCT type FROM connections WHERE user_id = $1 AND verified', [userId])).map((r) => r.type as string);
  if (needs.apps) for (const r of await ctx.db.query('SELECT application_id, data FROM app_user_metadata WHERE user_id = $1', [userId])) f.appValues[r.application_id] = r.data ?? {};
  return f;
}

/** Re-evaluates one member against every linked role of the guild and grants/revokes. Bots are never given linked roles. */
export async function refreshMember(ctx: Ctx, guildId: string, userId: string): Promise<boolean> {
  const roles = await ctx.db.query('SELECT * FROM linked_roles WHERE guild_id = $1', [guildId]);
  if (!roles.length) return false;
  const [u] = await ctx.db.query('SELECT bot FROM users WHERE id = $1', [userId]); if (!u || u.bot) return false;
  const f = await loadFacts(ctx, guildId, userId, needsOf(roles.flatMap((r) => r.criteria as LinkedCriterion[]))); if (!f) return false;
  const adds: string[] = [], removes: string[] = [];
  for (const r of roles) (allMet(r.criteria, f) ? adds : removes).push(r.role_id);
  return applyRoleChanges(ctx, guildId, userId, adds, removes);
}

/** Members of a guild that are not bots, in id order after `cursor`. */
async function memberBatch(ctx: Ctx, guildId: string, cursor: string, n: number): Promise<string[]> {
  return (await ctx.db.query('SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id > $2 AND NOT u.bot ORDER BY m.user_id LIMIT $3', [guildId, cursor, n])).map((r) => r.user_id as string);
}
/** Evaluates up to `limit` members (all by default, capped) one batch at a time; returns how many roles changed hands. */
export async function syncGuild(ctx: Ctx, guildId: string, limit = 5000, cursor = ''): Promise<{ checked: number; changed: number; next: string | null }> {
  let checked = 0, changed = 0, cur = cursor;
  while (checked < limit) {
    const ids = await memberBatch(ctx, guildId, cur, Math.min(100, limit - checked)); if (!ids.length) return { checked, changed, next: null };
    for (const id of ids) { if (await refreshMember(ctx, guildId, id)) changed++; checked++; }
    cur = ids[ids.length - 1]!;
  }
  return { checked, changed, next: cur };
}

/** Something about this user changed (a connection was verified, an app reported values): refresh them in every server that cares. */
export async function refreshUserEverywhere(ctx: Ctx, userId: string, only?: { appId?: string }) {
  const guilds = await ctx.db.query('SELECT DISTINCT l.guild_id FROM linked_roles l JOIN members m ON m.guild_id = l.guild_id AND m.user_id = $1', [userId]);
  for (const g of guilds) {
    if (only?.appId) { const rows = await ctx.db.query('SELECT criteria FROM linked_roles WHERE guild_id = $1', [g.guild_id]); if (!rows.some((r) => (r.criteria as LinkedCriterion[]).some((c) => c.type === 'app_metadata' && c.appId === only.appId))) continue; }
    await refreshMember(ctx, g.guild_id, userId).catch((e) => ctx.log.warn({ err: e }, 'linked role refresh failed'));
  }
}

// message_count criteria change with every message: re-check an author at most once a minute per guild
const throttle = new Map<string, number>(); const guildHas = new Map<string, { at: number; has: boolean }>();
export async function noteMessage(ctx: Ctx, guildId: string, userId: string) {
  const now = Date.now();
  let g = guildHas.get(guildId);
  if (!g || now - g.at > 30_000) {
    const [r] = await ctx.db.query(`SELECT 1 AS x FROM linked_roles WHERE guild_id = $1 AND criteria @> '[{"type":"message_count"}]'::jsonb LIMIT 1`, [guildId]);
    g = { at: now, has: !!r }; guildHas.set(guildId, g); if (guildHas.size > 5000) guildHas.clear();
  }
  if (!g.has) return;
  const key = `${guildId}:${userId}`; if ((throttle.get(key) ?? 0) > now - 60_000) return;
  throttle.set(key, now); if (throttle.size > 20000) throttle.clear();
  await refreshMember(ctx, guildId, userId);
}
export const forgetGuildCache = (guildId: string) => guildHas.delete(guildId);

/** Linked roles of a guild as one member sees them: role name, how many hold it, and their own progress. */
export async function linkedRoleViews(ctx: Ctx, guildId: string, userId: string): Promise<LinkedRoleView[]> {
  const rows = await ctx.db.query('SELECT l.*, r.name AS role_name, r.color AS role_color FROM linked_roles l LEFT JOIN roles r ON r.id = l.role_id WHERE l.guild_id = $1 ORDER BY l.id', [guildId]);
  if (!rows.length) return [];
  const f = await loadFacts(ctx, guildId, userId, needsOf(rows.flatMap((r) => r.criteria as LinkedCriterion[])));
  const holders = await ctx.db.query('SELECT role_id, count(*)::int AS n FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2::text[]) GROUP BY role_id', [guildId, rows.map((r) => r.role_id)]);
  const mine = new Set((await ctx.db.query('SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).map((r) => r.role_id as string));
  return rows.map((r) => ({
    ...linkedRoleDTO(r), role: r.role_name ? { name: r.role_name, color: r.role_color } : null, holders: holders.find((h) => h.role_id === r.role_id)?.n ?? 0,
    progress: (r.criteria as LinkedCriterion[]).map((c) => (f ? evalCriterion(c, f) : { met: false, current: null })), granted: mine.has(r.role_id),
  }));
}

/** Validates the criteria a manager submitted. Throws via the callback so the route decides the HTTP error. */
export async function validateCriteria(ctx: Ctx, guildId: string, criteria: LinkedCriterion[], fail: (msg: string) => never): Promise<void> {
  if (!criteria.length) fail('Add at least one criterion');
  if (criteria.length > LINKED_ROLE_LIMITS.criteria) fail(`At most ${LINKED_ROLE_LIMITS.criteria} criteria`);
  for (const c of criteria) {
    if (c.type === 'account_age_days' || c.type === 'join_age_days') { if (!Number.isInteger(c.value) || c.value < 0 || c.value > LINKED_ROLE_LIMITS.maxDays) fail('Days must be between 0 and 3650'); }
    else if (c.type === 'message_count') { if (!Number.isInteger(c.value) || c.value < 1 || c.value > LINKED_ROLE_LIMITS.maxCount) fail('Message count must be between 1 and 1,000,000'); }
    else if (c.type === 'app_metadata') {
      const [app] = await ctx.db.query('SELECT a.role_metadata FROM applications a JOIN application_installs i ON i.application_id = a.id WHERE a.id = $1 AND i.guild_id = $2', [c.appId, guildId]);
      if (!app) fail('That app is not installed in this server');
      const field = (app!.role_metadata as RoleMetadataField[]).find((x) => x.key === c.key);
      if (!field) fail(`The app has no metadata field "${c.key}"`);
      if (typeof c.value !== (field!.type === 'boolean' ? 'boolean' : 'number')) fail(`"${c.key}" is a ${field!.type}`);
      if (field!.type === 'boolean' && c.op !== '=' && c.op !== '!=') fail('Boolean fields can only be compared with = or !=');
    }
  }
}
