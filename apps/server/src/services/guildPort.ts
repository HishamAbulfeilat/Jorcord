import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { imageSize } from 'image-size';
import {
  ALL_PERMS, DEFAULT_EVERYONE, IMPORT_LIMITS, Perm, SERVER_EXPORT_FORMAT, discordToJorcordPerms, has, jorcordToDiscordPerms, permissionNames, snowflake,
  type ExportChannel, type ExportChannelType, type ExportEmoji, type ExportRole, type ImportReport, type ServerExport,
} from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest } from '../errors';
import { OWN_FILE_RE } from '../lib/ids';
import { fileUrl, sniffImageType } from './files';
import { audit, insertChannel } from './guilds';
import { channelsDTO, roleDTO } from './serializers';
import { slotLimits } from './boosts';

// =====================================================================================================================
// Export
// =====================================================================================================================

const EXPORT_TYPES = new Set<string>(['text', 'voice', 'announcement', 'stage', 'forum', 'media', 'category']);
const extOf = (filename: string) => (/\.(png|gif|webp|jpe?g)$/i.exec(filename)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');

/** Structure only: settings, roles (not bot-managed), categories and channels with role overwrites, and emoji names. Never messages, members, webhooks or secrets. */
export async function exportGuild(ctx: Ctx, guildId: string): Promise<{ doc: ServerExport; emojiFiles: { file: string; key: string }[] }> {
  const [g] = await ctx.db.query('SELECT name, description, verification_level, explicit_filter, default_notifications FROM guilds WHERE id = $1', [guildId]);
  const roleRows = await ctx.db.query('SELECT * FROM roles WHERE guild_id = $1 ORDER BY position, id', [guildId]);
  const everyone = roleRows.find((r) => r.id === guildId);
  const roles = roleRows.filter((r) => r.id !== guildId && !r.managed_app_id && !r.managed_kind);
  const roleKey = new Map(roles.map((r, i) => [r.id as string, `r${i}`]));
  const chRows = (await ctx.db.query(`SELECT * FROM channels WHERE guild_id = $1 AND type <> 'thread' ORDER BY position, id`, [guildId])).filter((c) => EXPORT_TYPES.has(c.type));
  const chKey = new Map(chRows.map((c, i) => [c.id as string, `c${i}`]));
  const ows = chRows.length ? await ctx.db.query(`SELECT * FROM overwrites WHERE type = 'role' AND channel_id = ANY($1::text[]) ORDER BY channel_id, target_id`, [chRows.map((c) => c.id)]) : [];
  const emojiRows = await ctx.db.query('SELECT * FROM emojis WHERE guild_id = $1 ORDER BY id', [guildId]);
  const used = new Set<string>();
  const emojiFiles: { file: string; key: string }[] = [];
  const emoji: ExportEmoji[] = emojiRows.map((e) => {
    const key = OWN_FILE_RE.test(e.url ?? '') ? /\/files\/([a-f0-9]{48})\//.exec(e.url)?.[1] : undefined;
    if (!key) return { name: e.name, animated: !!e.animated, file: null };
    let file = `emoji/${e.name}.${extOf(decodeURIComponent(e.url.split('/').pop() ?? ''))}`;
    for (let i = 2; used.has(file); i++) file = `emoji/${e.name}-${i}.${extOf(file)}`;
    used.add(file); emojiFiles.push({ file, key });
    return { name: e.name, animated: !!e.animated, file };
  });
  const doc: ServerExport = {
    format: SERVER_EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    source: { name: g?.name ?? 'server', description: g?.description ?? null },
    settings: { verificationLevel: g?.verification_level ?? 0, explicitFilter: g?.explicit_filter ?? 0, defaultNotifications: g?.default_notifications ?? 'mentions', everyonePermissions: everyone?.permissions ?? DEFAULT_EVERYONE.toString() },
    roles: roles.map((r): ExportRole => {
      const bits = BigInt(r.permissions) & ALL_PERMS;
      return { key: roleKey.get(r.id)!, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, position: r.position, permissions: bits.toString(), permissionNames: permissionNames(bits), discordPermissions: jorcordToDiscordPerms(bits).toString() };
    }),
    channels: chRows.map((c): ExportChannel => ({
      key: chKey.get(c.id)!, type: c.type as ExportChannelType, name: c.name ?? '', topic: c.topic ?? null, nsfw: !!c.nsfw, slowmode: c.slowmode ?? 0, bitrate: c.bitrate ?? null, userLimit: c.user_limit ?? null,
      position: c.position, parentKey: c.parent_id ? chKey.get(c.parent_id) ?? null : null,
      overwrites: ows.filter((o) => o.channel_id === c.id && (o.target_id === guildId || roleKey.has(o.target_id))).map((o) => ({ target: o.target_id === guildId ? 'everyone' : roleKey.get(o.target_id)!, allow: o.allow, deny: o.deny })),
    })),
    emoji,
  };
  return { doc, emojiFiles };
}

// =====================================================================================================================
// Parsing (Jorcord export or a Discord template-style document) -> one normalised shape
// =====================================================================================================================

interface NRole { key: string; name: string; color: number; hoist: boolean; mentionable: boolean; position: number; permissions: bigint }
interface NChannel { key: string; type: ExportChannelType; name: string; topic: string | null; nsfw: boolean; slowmode: number; bitrate: number | null; userLimit: number | null; position: number; parentKey: string | null; overwrites: { target: string; allow: bigint; deny: bigint }[] }
interface NEmoji { name: string; animated: boolean; file: string | null; data: Buffer | null }
export interface NormalizedImport { source: 'jorcord' | 'discord-template'; roles: NRole[]; channels: NChannel[]; emoji: NEmoji[]; everyonePermissions: bigint | null; /** ids the document uses for @everyone in channel overrides */ everyoneKeys: string[]; warnings: string[] }

const DISCORD_CHANNEL_TYPES: Record<number, ExportChannelType> = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media' };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : fallback);
const int = (v: unknown, lo: number, hi: number, fallback: number): number => { const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : NaN; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback; };
const bigOf = (v: unknown): bigint | null => { try { if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v); if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v); } catch { /* fall through */ } return null; };
const idKey = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 40) : null);

/** Reads a parsed JSON document. Throws a 400 for anything that is not a recognisable structure; collects non-fatal problems as warnings. */
export function normalizeImport(raw: unknown, files: Map<string, Buffer> = new Map()): NormalizedImport {
  if (!isObj(raw)) throw badRequest('Expected a JSON object');
  const warnings: string[] = [];
  const warn = (m: string) => { if (warnings.length < 50) warnings.push(m); };
  const isJorcord = raw.format === SERVER_EXPORT_FORMAT;
  if (isJorcord && raw.version !== 1) throw badRequest(`Unsupported export version ${String(raw.version)}`);
  const guild = isJorcord ? raw : isObj(raw.serialized_source_guild) ? raw.serialized_source_guild : raw;
  if (!Array.isArray(guild.roles) && !Array.isArray(guild.channels)) throw badRequest('No roles or channels found: expected a Jorcord server export or a Discord server template');
  if (!isJorcord && !(Array.isArray(guild.channels) && guild.channels.every((c: unknown) => isObj(c) && typeof c.type === 'number')) && !Array.isArray(guild.roles)) throw badRequest('Unrecognised document');
  const rolesIn: unknown[] = Array.isArray(guild.roles) ? guild.roles : [];
  const chIn: unknown[] = Array.isArray(guild.channels) ? guild.channels : [];
  if (rolesIn.length > IMPORT_LIMITS.roles) throw badRequest(`At most ${IMPORT_LIMITS.roles} roles can be imported`);
  if (chIn.length > IMPORT_LIMITS.channels) throw badRequest(`At most ${IMPORT_LIMITS.channels} channels can be imported`);
  const toPerms = (v: unknown): bigint => { const b = bigOf(v) ?? 0n; return isJorcord ? b & ALL_PERMS : discordToJorcordPerms(b); };

  const roles: NRole[] = []; let everyonePermissions: bigint | null = null; const everyoneKeys = new Set<string>(); const roleKeys = new Set<string>();
  rolesIn.forEach((r, i) => {
    if (!isObj(r)) return warn(`Role #${i + 1} is not an object: skipped`);
    const key = idKey(r.key ?? r.id) ?? `r${i}`;
    const name = str(r.name, 100);
    if (!isJorcord && (name === '@everyone' || key === '0')) { everyoneKeys.add(key); everyonePermissions = toPerms(r.permissions); return; }
    if (!name) return warn(`Role #${i + 1} has no name: skipped`);
    if (roleKeys.has(key)) return warn(`Duplicate role id ${key}: skipped`);
    roleKeys.add(key);
    let perms = toPerms(r.permissions);
    if (isJorcord && r.permissions === undefined && Array.isArray(r.permissionNames)) for (const n of r.permissionNames) if (typeof n === 'string' && n in Perm) perms |= Perm[n as keyof typeof Perm];
    roles.push({ key, name, color: int(r.color, 0, 0xffffff, 0), hoist: r.hoist === true, mentionable: r.mentionable === true, position: int(r.position, 0, 10_000, i), permissions: perms });
  });
  if (isJorcord && isObj(guild.settings)) everyonePermissions = toPerms((guild.settings as any).everyonePermissions) || null;

  const channels: NChannel[] = []; const chKeys = new Set<string>();
  chIn.forEach((c, i) => {
    if (!isObj(c)) return warn(`Channel #${i + 1} is not an object: skipped`);
    const type = isJorcord ? (typeof c.type === 'string' && EXPORT_TYPES.has(c.type) ? (c.type as ExportChannelType) : undefined) : typeof c.type === 'number' ? DISCORD_CHANNEL_TYPES[c.type] : undefined;
    const key = idKey(c.key ?? c.id) ?? `c${i}`;
    if (!type) return warn(`Channel "${str(c.name, 40) || key}" has an unsupported type: skipped`);
    if (chKeys.has(key)) return warn(`Duplicate channel id ${key}: skipped`);
    chKeys.add(key);
    const ow: NChannel['overwrites'] = [];
    const owIn = Array.isArray(isJorcord ? c.overwrites : c.permission_overwrites) ? ((isJorcord ? c.overwrites : c.permission_overwrites) as unknown[]).slice(0, 100) : [];
    for (const o of owIn) {
      if (!isObj(o)) continue;
      if (isJorcord) { const t = idKey(o.target); if (t) ow.push({ target: t, allow: toPerms(o.allow), deny: toPerms(o.deny) }); continue; }
      if (o.type !== 0 && o.type !== '0' && o.type !== 'role') { warn(`A member-specific permission override on "${str(c.name, 40)}" was skipped`); continue; }
      const t = idKey(o.id); if (t) ow.push({ target: t, allow: toPerms(o.allow), deny: toPerms(o.deny) });
    }
    const name = str(c.name, 100) || (type === 'category' ? 'Category' : 'channel');
    const parent = idKey(isJorcord ? c.parentKey : c.parent_id ?? c.parentId);
    const voiceish = type === 'voice' || type === 'stage';
    channels.push({
      key, type, name, topic: str(c.topic, 1024) || null, nsfw: c.nsfw === true, slowmode: int(isJorcord ? c.slowmode : c.rate_limit_per_user, 0, 21_600, 0),
      bitrate: voiceish && c.bitrate != null ? int(c.bitrate, 8000, 510_000, 64_000) : null, userLimit: voiceish && (isJorcord ? c.userLimit : c.user_limit) != null ? int(isJorcord ? c.userLimit : c.user_limit, 0, 99, 0) : null,
      position: int(c.position, 0, 10_000, i), parentKey: parent, overwrites: ow,
    });
  });
  for (const c of channels) {
    if (!c.parentKey) continue;
    const parent = channels.find((x) => x.key === c.parentKey);
    if (c.type === 'category' || !parent || parent.type !== 'category') { warn(`"${c.name}" does not sit in a valid category: placed at the top level`); c.parentKey = null; }
  }

  const emoji: NEmoji[] = [];
  const emIn = isJorcord && Array.isArray(raw.emoji) ? raw.emoji.slice(0, IMPORT_LIMITS.emoji + 50) : [];
  for (const e of emIn) {
    if (!isObj(e)) continue;
    const file = typeof e.file === 'string' ? e.file : null;
    const data = file ? files.get(file) ?? null : typeof e.data === 'string' && e.data.length <= IMPORT_LIMITS.emojiBytes * 1.4 ? Buffer.from(e.data.replace(/^data:[^,]*,/, ''), 'base64') : null;
    emoji.push({ name: str(e.name, 32).replace(/[^\w]/g, '_').padEnd(2, '_'), animated: e.animated === true, file, data });
  }
  if (!isJorcord && Array.isArray(guild.emojis) && guild.emojis.length) warn('Discord templates do not contain emoji; none were imported');

  return { source: isJorcord ? 'jorcord' : 'discord-template', roles, channels, emoji, everyonePermissions, everyoneKeys: isJorcord ? ['everyone'] : [...new Set(['0', ...everyoneKeys])], warnings };
}

// =====================================================================================================================
// Apply
// =====================================================================================================================

export interface ApplyActor { userId: string; perms: bigint }

async function storeEmojiImage(ctx: Ctx, userId: string, buf: Buffer, name: string, ext: string, type: string): Promise<string> {
  const key = randomBytes(24).toString('hex');
  const filename = `${name}.${ext}`;
  let w: number | null = null, h: number | null = null;
  try { const d = imageSize(buf); w = d.width ?? null; h = d.height ?? null; } catch { /* optional */ }
  const size = await ctx.storage.put(key, Readable.from(buf), IMPORT_LIMITS.emojiBytes);
  await ctx.db.query('INSERT INTO files (id, key, uploader_id, filename, content_type, size, width, height, spoiler) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)', [snowflake(), key, userId, filename, type, size, w, h]);
  return fileUrl(key, filename);
}

/**
 * Creates the described structure inside an existing server. Purely additive: nothing existing is renamed, changed or deleted (the only exception is the
 * opt-in @everyone permission set). Roles can never carry more permission than the importer holds, and land below every existing role.
 * With `dryRun` everything is validated and counted but nothing is written.
 */
export async function applyImport(ctx: Ctx, guildId: string, actor: ApplyActor, n: NormalizedImport, opts: { dryRun: boolean; applyEveryone: boolean }): Promise<ImportReport> {
  const warnings = [...n.warnings]; const warn = (m: string) => { if (warnings.length < 100) warnings.push(m); };
  const admin = has(actor.perms, Perm.ADMINISTRATOR);
  const [rc] = await ctx.db.query('SELECT count(*)::int AS n FROM roles WHERE guild_id = $1', [guildId]);
  if (rc.n + n.roles.length > 250) throw badRequest(`The server would exceed 250 roles (${rc.n} existing + ${n.roles.length} imported)`);
  const [cc] = await ctx.db.query(`SELECT count(*)::int AS n, coalesce(max(position), -1)::int AS mx FROM channels WHERE guild_id = $1 AND type <> 'thread'`, [guildId]);
  if (cc.n + n.channels.length > 500) throw badRequest(`The server would exceed 500 channels (${cc.n} existing + ${n.channels.length} imported)`);

  // roles: highest position first in the source -> highest new position; all of them below every existing role
  const roleOrder = [...n.roles].sort((a, b) => a.position - b.position);
  const maskPerms = (bits: bigint, what: string) => {
    const kept = admin ? bits & ALL_PERMS : bits & actor.perms;
    if (kept !== bits) warn(`${what}: permissions you do not hold yourself were dropped`);
    return kept;
  };
  const roleBits = new Map(roleOrder.map((r) => [r.key, maskPerms(r.permissions, `Role "${r.name}"`)]));
  const everyoneBits = opts.applyEveryone && n.everyonePermissions !== null ? maskPerms(n.everyonePermissions, '@everyone') : null;

  // channels in display order: top-level items by position, each category followed by its children
  const cats = new Set(n.channels.filter((c) => c.type === 'category').map((c) => c.key));
  const top = n.channels.filter((c) => c.type === 'category' || !c.parentKey || !cats.has(c.parentKey)).sort((a, b) => a.position - b.position);
  const ordered: NChannel[] = [];
  for (const t of top) { ordered.push(t); if (t.type === 'category') ordered.push(...n.channels.filter((c) => c.parentKey === t.key).sort((a, b) => a.position - b.position)); }
  const report: ImportReport = { dryRun: opts.dryRun, source: n.source, created: { roles: n.roles.length, categories: n.channels.filter((c) => c.type === 'category').length, channels: n.channels.filter((c) => c.type !== 'category').length, emoji: 0 }, warnings };

  // emoji: validated up front so a dry run reports the truth
  const slots = await slotLimits(ctx, guildId);
  const have = new Set((await ctx.db.query('SELECT name FROM emojis WHERE guild_id = $1', [guildId])).map((r) => (r.name as string).toLowerCase()));
  const [ec] = await ctx.db.query('SELECT count(*)::int AS n FROM emojis WHERE guild_id = $1', [guildId]);
  let room = Math.max(0, slots.emojiSlots - ec.n);
  const accepted: { name: string; animated: boolean; data: Buffer; ext: string; type: string }[] = [];
  for (const e of n.emoji) {
    if (!e.data) { warn(`Emoji :${e.name}: has no image in the file: skipped`); continue; }
    if (e.data.length > IMPORT_LIMITS.emojiBytes) { warn(`Emoji :${e.name}: is larger than ${IMPORT_LIMITS.emojiBytes / 1024} KB: skipped`); continue; }
    const kind = sniffImageType(e.data);
    if (!kind) { warn(`Emoji :${e.name}: is not a PNG, JPEG, GIF or WebP image: skipped`); continue; }
    if (have.has(e.name.toLowerCase())) { warn(`Emoji :${e.name}: already exists: skipped`); continue; }
    if (room <= 0) { warn(`Emoji :${e.name}: skipped, the server has no emoji slots left`); continue; }
    have.add(e.name.toLowerCase()); room--;
    accepted.push({ name: e.name, animated: e.animated, data: e.data, ext: kind.ext, type: kind.type });
  }
  report.created.emoji = accepted.length;
  if (opts.dryRun) return report;

  const newRoles: any[] = [];
  const newChannelIds: string[] = [];
  const shifted = await ctx.db.tx(async (q) => {
    const roleIds = new Map<string, string>(n.everyoneKeys.map((k) => [k, guildId]));
    let moved: any[] = [];
    if (roleOrder.length) {
      await q.query('UPDATE roles SET position = position + $2 WHERE guild_id = $1 AND position >= 1 AND id <> $1', [guildId, roleOrder.length]);
      moved = await q.query('SELECT * FROM roles WHERE guild_id = $1 AND position > $2', [guildId, roleOrder.length]);
    }
    let pos = 1;
    for (const r of roleOrder) {
      const rid = snowflake(); roleIds.set(r.key, rid);
      await q.query('INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [rid, guildId, r.name, r.color, r.hoist, pos++, roleBits.get(r.key)!.toString(), r.mentionable]);
      newRoles.push((await q.query('SELECT * FROM roles WHERE id = $1', [rid]))[0]);
    }
    if (everyoneBits !== null) await q.query('UPDATE roles SET permissions = $2 WHERE id = $1', [guildId, everyoneBits.toString()]);
    const chIds = new Map<string, string>();
    let p = cc.mx + 1;
    for (const c of ordered) {
      const cid = await insertChannel(q, { guildId, type: c.type, name: c.name, topic: c.topic, position: p++, parentId: c.parentKey ? chIds.get(c.parentKey) ?? null : null, nsfw: c.nsfw, slowmode: c.slowmode, bitrate: c.bitrate, userLimit: c.userLimit });
      chIds.set(c.key, cid); newChannelIds.push(cid);
      for (const o of c.overwrites) {
        const target = o.target === 'everyone' ? guildId : roleIds.get(o.target);
        if (!target) { warn(`A permission override on "${c.name}" refers to a role that was not imported: skipped`); continue; }
        const allow = admin ? o.allow & ALL_PERMS : o.allow & actor.perms; // never grant a channel permission the importer lacks
        await q.query(`INSERT INTO overwrites (channel_id, target_id, type, allow, deny) VALUES ($1,$2,'role',$3,$4) ON CONFLICT DO NOTHING`, [cid, target, allow.toString(), (o.deny & ALL_PERMS).toString()]);
      }
    }
    return moved;
  });
  await ctx.pcache.invalidate({ k: 'guild', guildId });
  for (const cid of newChannelIds) await ctx.pcache.invalidate({ k: 'channel', channelId: cid });

  // emoji after the structure: image storage is not transactional, and a failed image must not undo the channels
  let made = 0;
  for (const e of accepted) {
    try {
      const url = await storeEmojiImage(ctx, actor.userId, e.data, e.name, e.ext, e.type);
      await ctx.db.query('INSERT INTO emojis (id, guild_id, name, animated, url, role_ids) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [snowflake(), guildId, e.name, e.animated, url, '[]']);
      made++;
    } catch (err) { ctx.log.warn({ err }, 'emoji import failed'); warn(`Emoji :${e.name}: could not be stored`); }
  }
  report.created.emoji = made;

  for (const r of shifted) await ctx.hub.toGuild(guildId, 'ROLE_UPDATE', roleDTO(r));
  if (everyoneBits !== null) { const [ev] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [guildId]); if (ev) await ctx.hub.toGuild(guildId, 'ROLE_UPDATE', roleDTO(ev)); }
  for (const r of newRoles) await ctx.hub.toGuild(guildId, 'ROLE_CREATE', roleDTO(r));
  const chRows = newChannelIds.length ? await ctx.db.query('SELECT * FROM channels WHERE id = ANY($1::text[])', [newChannelIds]) : [];
  for (const dto of await channelsDTO(ctx, chRows)) await ctx.hub.toChannel(dto.id, 'CHANNEL_CREATE', dto);
  if (made) { const rows = await ctx.db.query('SELECT * FROM emojis WHERE guild_id = $1', [guildId]); await ctx.hub.toGuild(guildId, 'EMOJIS_UPDATE', { guildId, emojis: rows.map((e) => ({ id: e.id, guildId: e.guild_id, name: e.name, animated: e.animated, url: e.url, ...(e.role_ids?.length ? { roleIds: e.role_ids } : {}) })) }); }
  await audit(ctx, guildId, actor.userId, 'GUILD_IMPORT', null, { source: n.source, ...report.created });
  return report;
}

