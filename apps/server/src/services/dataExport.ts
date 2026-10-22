import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { snowflake, snowflakeTime } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { iso } from '../lib/ids';
import { safeEqual } from '../lib/crypto';
import { ZipFileWriter } from '../lib/zip';
import { actionEmail } from './emailTemplates';
import { selfUserDTO } from './serializers';

export const EXPORT_COOLDOWN_MS = 24 * 3600_000;   // one export per account per day
export const EXPORT_TTL_MS = 7 * 24 * 3600_000;    // the finished file is deleted after a week
const EMAIL_LINK_TTL_MS = 48 * 3600_000, UI_LINK_TTL_MS = 10 * 60_000, STALE_MS = 30 * 60_000;
const PAGE = 1000, MESSAGES_PER_FILE = 5000, MAX_MESSAGES = 1_000_000;

export const jobDTO = (r: any) => ({
  id: r.id as string, status: r.status as 'queued' | 'running' | 'ready' | 'failed' | 'expired', createdAt: iso(r.created_at)!, finishedAt: iso(r.finished_at), expiresAt: iso(r.expires_at),
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), counts: (r.counts ?? null) as Record<string, number> | null, error: (r.error ?? null) as string | null,
});

// ---- signed, expiring download links (the signature is the credential; it only unlocks one job until `exp`) ----
const sigOf = (ctx: Ctx, jobId: string, exp: number) => createHmac('sha256', `${ctx.config.jwtSecret}:export-download`).update(`${jobId}.${exp}`).digest('base64url');
export function signedDownloadUrl(ctx: Ctx, jobId: string, ttlMs: number, notAfter?: number) {
  const exp = Math.min(Date.now() + ttlMs, notAfter ?? Infinity);
  return `${ctx.config.publicUrl.replace(/\/$/, '')}/api/v1/exports/${jobId}/download?exp=${exp}&sig=${sigOf(ctx, jobId, exp)}`;
}
export const uiDownloadUrl = (ctx: Ctx, r: any) => signedDownloadUrl(ctx, r.id, UI_LINK_TTL_MS, new Date(r.expires_at).getTime());
export function verifyDownloadSig(ctx: Ctx, jobId: string, exp: number, sig: string) {
  return Number.isFinite(exp) && exp > Date.now() && safeEqual(sig, sigOf(ctx, jobId, exp));
}

/** Removes finished files past their expiry and marks jobs stuck in queued/running as failed (node died mid-export). Idempotent, multi-node safe. */
export async function expireExports(ctx: Ctx) {
  const due = await ctx.db.query(`SELECT id, storage_key FROM export_jobs WHERE storage_key IS NOT NULL AND ((status = 'ready' AND expires_at <= now()) OR status = 'expired')`);
  for (const r of due) {
    await ctx.storage.delete(r.storage_key).catch(() => {});
    await ctx.db.query(`UPDATE export_jobs SET status = 'expired', storage_key = NULL WHERE id = $1`, [r.id]);
  }
  await ctx.db.query(`UPDATE export_jobs SET status = 'failed', error = 'The export did not finish. Please request a new one.', finished_at = now()
    WHERE status IN ('queued','running') AND COALESCE(started_at, created_at) < now() - ($1 || ' milliseconds')::interval`, [String(STALE_MS)]);
}

/** Creates a job unless the account exported in the last 24h (failed jobs do not count). The check and insert share one statement, so parallel requests cannot both pass. */
export async function requestExport(ctx: Ctx, userId: string) {
  await expireExports(ctx).catch(() => {});
  const id = snowflake();
  const rows = await ctx.db.query(
    `INSERT INTO export_jobs (id, user_id) SELECT $1, $2 WHERE NOT EXISTS (
       SELECT 1 FROM export_jobs WHERE user_id = $2 AND status <> 'failed' AND created_at > now() - ($3 || ' milliseconds')::interval) RETURNING *`, [id, userId, String(EXPORT_COOLDOWN_MS)]);
  if (!rows.length) {
    const [last] = await ctx.db.query(`SELECT created_at FROM export_jobs WHERE user_id = $1 AND status <> 'failed' ORDER BY created_at DESC LIMIT 1`, [userId]);
    const wait = Math.max(1, Math.ceil((new Date(last.created_at).getTime() + EXPORT_COOLDOWN_MS - Date.now()) / 1000));
    throw new ApiError(429, 'EXPORT_RATE_LIMITED', 'You can request one data export per day', { retryAfter: wait }, { 'retry-after': String(wait) }).with({ retry_after: wait, global: false });
  }
  setImmediate(() => { void runExportJob(ctx, id); });
  return rows[0];
}

export async function runExportJob(ctx: Ctx, jobId: string) {
  const [job] = await ctx.db.query(`UPDATE export_jobs SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`, [jobId]); // one node wins
  if (!job) return;
  const dir = join(ctx.config.dataDir, 'tmp-export'); mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${jobId}.zip`), key = randomBytes(24).toString('hex');
  try {
    const counts = await buildBundle(ctx, job.user_id, tmp);
    const size = await ctx.storage.put(key, createReadStream(tmp), 8 * 1024 ** 3);
    const [done] = await ctx.db.query(`UPDATE export_jobs SET status = 'ready', storage_key = $2, size_bytes = $3, counts = $4::jsonb, finished_at = now(), expires_at = now() + ($5 || ' milliseconds')::interval WHERE id = $1 RETURNING *`,
      [jobId, key, size, JSON.stringify(counts), String(EXPORT_TTL_MS)]);
    if (!done) { await ctx.storage.delete(key).catch(() => {}); return; } // account was deleted while exporting
    await notifyReady(ctx, done).catch((e) => ctx.log.warn({ err: e }, 'export notification failed'));
  } catch (e) {
    ctx.log.error({ err: e, jobId }, 'data export failed');
    await ctx.storage.delete(key).catch(() => {});
    await ctx.db.query(`UPDATE export_jobs SET status = 'failed', error = 'Something went wrong while preparing your export. Please try again later.', finished_at = now() WHERE id = $1`, [jobId]);
    await ctx.hub.toUser(job.user_id, 'DATA_EXPORT_UPDATE', { id: jobId, status: 'failed' }).catch(() => {});
  } finally { await rm(tmp, { force: true }); }
}

async function notifyReady(ctx: Ctx, job: any) {
  await ctx.hub.toUser(job.user_id, 'DATA_EXPORT_UPDATE', { id: job.id, status: 'ready' });
  const [u] = await ctx.db.query('SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL', [job.user_id]);
  if (!u?.email) return;
  const m = actionEmail({
    subject: 'Your Jorcord data export is ready', heading: 'Your data export is ready',
    paragraphs: ['The archive with your profile, messages and account data has been prepared. The link below works for 48 hours; you can also download it from Settings > My Account until it expires in 7 days.'],
    action: { label: 'Download your data', url: signedDownloadUrl(ctx, job.id, EMAIL_LINK_TTL_MS, new Date(job.expires_at).getTime()) },
    footnote: ['If you did not request this export, change your password right away: anyone with this link can download the archive.'],
  });
  await ctx.mailer.send({ to: u.email, ...m });
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Writes the bundle to `path`. Returns row counts per section. Never includes password hashes, MFA secrets, refresh tokens, passkey keys or other users' private data. */
export async function buildBundle(ctx: Ctx, userId: string, path: string): Promise<Record<string, number>> {
  const z = await ZipFileWriter.create(path);
  const counts: Record<string, number> = {};
  const q = (sql: string, p: unknown[] = [userId]) => ctx.db.query(sql, p);
  try {
    const [u] = await q('SELECT * FROM users WHERE id = $1');
    await z.add('account/profile.json', json({ ...selfUserDTO(ctx, u), createdAt: iso(u.created_at), bio: u.bio ?? null, pronouns: u.pronouns ?? null }));
    const notif = await q('SELECT scope, target_id, muted, muted_until, suppress_everyone, suppress_roles, level FROM notification_settings WHERE user_id = $1');
    await z.add('account/notification-settings.json', json(notif)); counts.notificationSettings = notif.length;

    const rel = await q('SELECT other_id, type, created_at FROM relationships WHERE user_id = $1 ORDER BY created_at');
    await z.add('account/relationships.json', json(rel.map((r) => ({ userId: r.other_id, type: r.type, since: iso(r.created_at) })))); counts.relationships = rel.length;
    const notes = await q('SELECT target_id, note FROM user_notes WHERE user_id = $1'); await z.add('account/notes.json', json(notes.map((n) => ({ userId: n.target_id, note: n.note })))); counts.notes = notes.length;
    const conns = await q('SELECT type, handle, url, visible, verified, created_at FROM connections WHERE user_id = $1 ORDER BY created_at'); // verify_token is a proof secret: left out
    await z.add('account/connections.json', json(conns.map((c) => ({ type: c.type, handle: c.handle, url: c.url, visible: c.visible, verified: c.verified, createdAt: iso(c.created_at) })))); counts.connections = conns.length;
    const saved = await q('SELECT message_id, channel_id, saved_at FROM saved_messages WHERE user_id = $1'); await z.add('account/saved-messages.json', json(saved.map((s) => ({ messageId: s.message_id, channelId: s.channel_id, savedAt: iso(s.saved_at) })))); counts.savedMessages = saved.length;

    const guilds = await q(`SELECT g.id, g.name, m.nick, m.joined_at, (g.owner_id = m.user_id) AS owner,
        COALESCE((SELECT json_agg(r.name) FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.guild_id = m.guild_id AND mr.user_id = m.user_id), '[]'::json) AS roles
        FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = $1 ORDER BY m.joined_at`);
    await z.add('guilds/memberships.json', json(guilds.map((g) => ({ id: g.id, name: g.name, nick: g.nick ?? null, joinedAt: iso(g.joined_at), owner: g.owner, roles: g.roles })))); counts.guilds = guilds.length;
    const bans = await q(`SELECT b.guild_id, g.name, b.reason, b.created_at FROM bans b JOIN guilds g ON g.id = b.guild_id WHERE b.user_id = $1`);
    const appeals = await q('SELECT guild_id, message, status, decision_reason, created_at, decided_at FROM ban_appeals WHERE user_id = $1 ORDER BY created_at');
    await z.add('guilds/bans-and-appeals.json', json({ bans: bans.map((b) => ({ guildId: b.guild_id, guild: b.name, reason: b.reason ?? null, at: iso(b.created_at) })), appeals: appeals.map((a) => ({ guildId: a.guild_id, message: a.message, status: a.status, decisionReason: a.decision_reason ?? null, createdAt: iso(a.created_at), decidedAt: iso(a.decided_at) })) }));
    const dms = await q('SELECT c.id, c.type, c.name FROM channels c JOIN dm_participants p ON p.channel_id = c.id WHERE p.user_id = $1');
    const dmUsers = await q(`SELECT p.channel_id, p.user_id FROM dm_participants p WHERE p.channel_id IN (SELECT channel_id FROM dm_participants WHERE user_id = $1)`);
    await z.add('channels/direct-channels.json', json(dms.map((c) => ({ id: c.id, type: c.type, name: c.name ?? null, participantIds: dmUsers.filter((p) => p.channel_id === c.id).map((p) => p.user_id) })))); counts.directChannels = dms.length;

    // messages authored by the user, keyset-paged (never one giant query), split into files of MESSAGES_PER_FILE
    let cursor = 'z'.repeat(40), total = 0, fileNo = 0, buf: unknown[] = [];
    const flush = async () => { if (!buf.length) return; await z.add(`messages/messages-${String(++fileNo).padStart(4, '0')}.json`, json(buf)); buf = []; };
    while (total < MAX_MESSAGES) {
      const page = await q(`SELECT id, channel_id, guild_id, content, type, reply_to, edited_at, attachments, embeds FROM messages WHERE author_id = $1 AND webhook_id IS NULL AND type NOT IN ('join','boost','thread_created','poll_result') AND id < $2 ORDER BY id DESC LIMIT ${PAGE}`, [userId, cursor]);
      if (!page.length) break;
      for (const m of page) buf.push({ id: m.id, channelId: m.channel_id, guildId: m.guild_id ?? null, createdAt: msgTime(m.id), content: m.content, type: m.type, replyTo: m.reply_to ?? null, editedAt: iso(m.edited_at), attachments: m.attachments });
      total += page.length; cursor = page[page.length - 1].id;
      if (buf.length >= MESSAGES_PER_FILE) await flush();
      if (page.length < PAGE) break;
    }
    await flush(); counts.messages = total; counts.messageFiles = fileNo;

    const files = await q('SELECT id, filename, content_type, size, width, height, spoiler, attached, created_at FROM files WHERE uploader_id = $1 ORDER BY created_at');
    await z.add('attachments/uploads.json', json(files.map((f) => ({ id: f.id, filename: f.filename, contentType: f.content_type, size: Number(f.size), width: f.width ?? null, height: f.height ?? null, spoiler: f.spoiler, attached: f.attached, uploadedAt: iso(f.created_at) })))); counts.uploads = files.length;
    const reactions = await q('SELECT message_id, emoji, created_at FROM reactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200000');
    await z.add('messages/reactions.json', json(reactions.map((r) => ({ messageId: r.message_id, emoji: r.emoji, at: iso(r.created_at) })))); counts.reactions = reactions.length;

    const sessions = await q('SELECT id, user_agent, ip, created_at, last_used_at, expires_at, revoked FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500'); // no refresh hashes
    await z.add('security/sessions.json', json(sessions.map((s) => ({ id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: iso(s.created_at), lastUsedAt: iso(s.last_used_at), expiresAt: iso(s.expires_at), revoked: s.revoked })))); counts.sessions = sessions.length;
    const keys = await q('SELECT id, name, created_at, last_used_at, device_type, backed_up, transports FROM user_passkeys WHERE user_id = $1 ORDER BY created_at'); // no credential id / public key
    await z.add('security/passkeys.json', json(keys.map((k) => ({ id: k.id, name: k.name, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at), deviceType: k.device_type, backedUp: k.backed_up, transports: k.transports })))); counts.passkeys = keys.length;

    await z.add('README.txt', [
      'Jorcord data export', `Generated: ${new Date().toISOString()}`, '',
      'account/      profile, settings, relationships, notes, connections, saved messages',
      'guilds/       server memberships, bans and your ban appeals', 'channels/     your direct and group conversations',
      'messages/     every message you authored (messages-NNNN.json, newest first) and your reactions',
      'attachments/  metadata of files you uploaded (the files themselves are not included)',
      'security/     sessions summary and passkey metadata', '',
      'Not included, by design: password hash, two-factor secret, session tokens, passkey keys, other people\'s private data.', '',
    ].join('\n'));
    await z.add('manifest.json', json({ format: 'jorcord-export-v2', exportedAt: new Date().toISOString(), userId, counts }));
    await z.finish();
    return counts;
  } catch (e) { await z.abort(); throw e; }
}

function msgTime(id: string) { try { return new Date(snowflakeTime(id)).toISOString(); } catch { return null; } }
