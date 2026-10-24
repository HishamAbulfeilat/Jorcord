import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, Perm, snowflake, type SoundboardSound } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit } from '../services/guilds';
import { channelAccess, guildAccess, guildPerms, need, needAny } from '../services/perms';

export const soundDTO = (r: any): SoundboardSound => ({ id: r.id, guildId: r.guild_id, name: r.name, emoji: r.emoji ?? null, volume: Number(r.volume), url: r.url, creatorId: r.creator_id, createdAt: iso(r.created_at)! });

/** Soundboard: per-guild clip library (MANAGE_EMOJIS to edit) and playing a clip into the voice channel you are in (USE_SOUNDBOARD). */
export function soundboardRoutes(app: FastifyInstance, ctx: Ctx) {
  const gid = z.object({ id: idSchema });
  const sp = z.object({ id: idSchema, soundId: idSchema });
  const name = z.string().trim().min(2).max(32);
  const emoji = z.string().max(64).nullable();
  const volume = z.number().min(0).max(1);
  const list = async (guildId: string) => (await ctx.db.query('SELECT * FROM soundboard_sounds WHERE guild_id = $1 ORDER BY id', [guildId])).map(soundDTO);
  const push = async (guildId: string) => ctx.hub.toGuild(guildId, 'SOUNDBOARD_SOUNDS_UPDATE', { guildId, sounds: await list(guildId) });

  /** Only audio this server stored itself (an /uploads file): never an arbitrary third-party URL that would leak listeners' IPs. */
  async function ownAudio(url: string) {
    const m = /^\/api\/v1\/files\/([0-9a-f]{48})\/[^/?#]+$/.exec(url);
    if (!m) throw badRequest('url must be a file uploaded with POST /uploads');
    const [f] = await ctx.db.query('SELECT * FROM files WHERE key = $1', [m[1]]);
    if (!f) throw badRequest('Unknown upload');
    if (!/^audio\//.test(f.content_type)) throw badRequest('Sounds must be audio files');
    if (Number(f.size) > LIMITS.maxSoundBytes) throw new ApiError(413, 'FILE_TOO_LARGE', `Sounds can be at most ${LIMITS.maxSoundBytes} bytes`);
    return f;
  }

  app.get('/guilds/:id/soundboard-sounds', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    return list(id);
  });
  app.post('/guilds/:id/soundboard-sounds', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ name, url: z.string().max(512), emoji: emoji.optional(), volume: volume.optional() }).strict(), req.body);
    needAny(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_EMOJIS, Perm.CREATE_GUILD_EXPRESSIONS);
    limitOrThrow(ctx.rl, `sound-create:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM soundboard_sounds WHERE guild_id = $1', [id]);
    if (c.n >= LIMITS.maxSoundsPerServer) throw new ApiError(400, 'MAX_SOUNDS', 'Soundboard is full');
    const f = await ownAudio(b.url);
    if (f.uploader_id !== req.userId) throw forbidden('You can only use your own uploads');
    const sid = snowflake();
    await ctx.db.query('INSERT INTO soundboard_sounds (id, guild_id, name, emoji, volume, url, creator_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [sid, id, b.name, b.emoji ?? null, b.volume ?? 1, b.url, req.userId]);
    await ctx.db.query('UPDATE files SET attached = true WHERE id = $1', [f.id]);
    await audit(ctx, id, req.userId, 'SOUNDBOARD_SOUND_CREATE', sid, { name: b.name }); await push(id);
    return reply.code(201).send(soundDTO((await ctx.db.query('SELECT * FROM soundboard_sounds WHERE id = $1', [sid]))[0]));
  });
  app.patch('/guilds/:id/soundboard-sounds/:soundId', async (req) => {
    const p = parse(sp, req.params);
    const b = parse(z.object({ name: name.optional(), emoji: emoji.optional(), volume: volume.optional() }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('UPDATE soundboard_sounds SET name = COALESCE($3, name), emoji = CASE WHEN $4::boolean THEN $5 ELSE emoji END, volume = COALESCE($6, volume) WHERE id = $1 AND guild_id = $2 RETURNING *',
      [p.soundId, p.id, b.name ?? null, b.emoji !== undefined, b.emoji ?? null, b.volume ?? null]);
    if (!rows.length) throw notFound('Sound');
    await audit(ctx, p.id, req.userId, 'SOUNDBOARD_SOUND_UPDATE', p.soundId, b); await push(p.id);
    return soundDTO(rows[0]);
  });
  app.delete('/guilds/:id/soundboard-sounds/:soundId', async (req, reply) => {
    const p = parse(sp, req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('DELETE FROM soundboard_sounds WHERE id = $1 AND guild_id = $2 RETURNING id', [p.soundId, p.id]);
    if (!rows.length) throw notFound('Sound');
    await audit(ctx, p.id, req.userId, 'SOUNDBOARD_SOUND_DELETE', p.soundId); await push(p.id);
    return reply.code(204).send();
  });

  /**
   * Play a clip into the voice channel the caller is connected to. Delivered as a gateway event to everybody in that channel
   * (each client plays it locally and may mute individual users' sounds); the caller must hold USE_SOUNDBOARD + CONNECT there
   * and must not be server-muted / suppressed. Sounds of another server the caller belongs to need USE_EXTERNAL_SOUNDS (no Nitro paywall).
   */
  app.post('/channels/:id/send-soundboard-sound', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ soundId: idSchema }).strict(), req.body);
    limitOrThrow(ctx.rl, `sound-play:${req.userId}`, 8, 10_000, ctx.config.rateLimit);
    const acc = await channelAccess(ctx, req.userId, id);
    if (acc.channel.type !== 'voice' && acc.channel.type !== 'stage') throw badRequest('Not a voice channel');
    need(acc.perms, Perm.CONNECT, Perm.USE_SOUNDBOARD);
    const st = await ctx.voice.get(req.userId);
    if (!st || st.channelId !== id) throw new ApiError(400, 'NOT_IN_VOICE', 'Join the voice channel first');
    if (st.serverMute || st.suppress || st.selfDeaf) throw forbidden('You are muted', 'MUTED');
    const [row] = await ctx.db.query('SELECT s.* FROM soundboard_sounds s JOIN members m ON m.guild_id = s.guild_id AND m.user_id = $2 WHERE s.id = $1', [b.soundId, req.userId]);
    if (!row) throw notFound('Sound');
    // a sound of another server is an "external sound"
    if (acc.channel.guild_id && row.guild_id !== acc.channel.guild_id) need(acc.perms, Perm.USE_EXTERNAL_SOUNDS);
    const sound = soundDTO(row);
    const inRoom = (await ctx.voice.inChannel(id)).map((v) => v.userId);
    await ctx.hub.toUsers(inRoom, 'VOICE_CHANNEL_EFFECT_SEND', { guildId: acc.channel.guild_id ?? null, channelId: id, userId: req.userId, sound });
    return reply.code(204).send();
  });
}
