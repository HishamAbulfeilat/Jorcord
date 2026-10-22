import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, has } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, forbidden, notFound } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { claimAttachments } from '../services/files';
import { audit, visibleChannelRows } from '../services/guilds';
import { createMessage } from '../services/messages';
import { channelAccess, guildAccess, guildPerms, loadGuildPerm, need, needOutrankMember } from '../services/perms';
import { startVoiceRecording, stopVoiceRecording } from '../services/recordings';
import { declineRing } from '../services/calls';
import { VOICE_TYPES, disconnectMember, moveMember, requestToSpeak, setServerVoiceFlags, setSuppressed } from '../services/voice';

const memberParams = z.object({ id: idSchema, userId: idSchema });

/** Voice moderation (mute / deafen / move / disconnect) and stage speaker management. */
export function voiceRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Actor must hold `perm` guild-wide and outrank the target (owner always passes; self is not allowed for moderation). */
  async function moderationTarget(guildId: string, actorId: string, targetId: string, perm: bigint) {
    const actor = await guildAccess(ctx, actorId, guildId);
    need(guildPerms(actor), perm);
    const target = await loadGuildPerm(ctx, guildId, targetId);
    if (!target) throw notFound('Member');
    if (targetId !== actorId) needOutrankMember(actor, target);
    return { actor, target };
  }

  /** Decline an incoming DM / group-DM call: stops the ring on all my devices (and ends it for a 1:1 call). */
  app.post('/channels/:id/call/decline', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, id);
    if (a.channel.type !== 'dm' && a.channel.type !== 'group_dm') throw badRequest('Only direct-message calls ring');
    if (!(await declineRing(ctx, req.userId, id))) throw notFound('Call');
    return reply.code(204).send();
  });

  app.get('/guilds/:id/voice-states', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await guildAccess(ctx, req.userId, id);
    // one permission load for the whole guild instead of channelAccess() per voice channel
    const mine = new Set((await visibleChannelRows(ctx, id, req.userId)).filter((c) => c.type === 'voice' || c.type === 'stage').map((c) => c.id as string));
    return (await ctx.voice.all()).filter((s) => s.guildId === id && s.channelId && mine.has(s.channelId));
  });

  app.patch('/guilds/:id/voice-states/:userId', async (req) => {
    const p = parse(memberParams, req.params);
    const b = parse(z.object({ mute: z.boolean(), deaf: z.boolean() }).partial().strict(), req.body);
    if (b.mute === undefined && b.deaf === undefined) throw badRequest('Provide mute and/or deaf');
    if (p.userId === req.userId) throw badRequest('Use the gateway to mute or deafen yourself');
    const actor = await guildAccess(ctx, req.userId, p.id);
    const perms = guildPerms(actor);
    if (b.mute !== undefined) need(perms, Perm.MUTE_MEMBERS);
    if (b.deaf !== undefined) need(perms, Perm.DEAFEN_MEMBERS);
    const target = await loadGuildPerm(ctx, p.id, p.userId);
    if (!target) throw notFound('Member');
    needOutrankMember(actor, target);
    const voiceState = await setServerVoiceFlags(ctx, p.id, p.userId, b);
    await audit(ctx, p.id, req.userId, 'VOICE_MODERATE', p.userId, b);
    const [m] = await ctx.db.query('SELECT voice_mute, voice_deaf FROM members WHERE guild_id = $1 AND user_id = $2', [p.id, p.userId]);
    return { userId: p.userId, serverMute: !!m.voice_mute, serverDeaf: !!m.voice_deaf, voiceState };
  });

  app.post('/guilds/:id/voice-states/:userId/move', async (req) => {
    const p = parse(memberParams, req.params);
    const { channelId } = parse(z.object({ channelId: idSchema }).strict(), req.body);
    if (p.userId === req.userId) throw badRequest('Use the gateway to switch channels yourself');
    await moderationTarget(p.id, req.userId, p.userId, Perm.MOVE_MEMBERS);
    const st = await ctx.voice.get(p.userId);
    if (!st?.channelId || st.guildId !== p.id) throw badRequest('Target is not connected to voice in this server');
    // the mover needs MOVE_MEMBERS where the member is now, and must be able to join the destination
    const src = await channelAccess(ctx, req.userId, st.channelId);
    need(src.perms, Perm.MOVE_MEMBERS);
    const dst = await channelAccess(ctx, req.userId, channelId);
    if (dst.channel.guild_id !== p.id) throw badRequest('Destination must be a voice channel of the same server');
    need(dst.perms, Perm.CONNECT);
    const next = await moveMember(ctx, p.userId, channelId);
    await audit(ctx, p.id, req.userId, 'VOICE_MOVE', p.userId, { from: st.channelId, to: channelId });
    return next;
  });

  app.delete('/guilds/:id/voice-states/:userId', async (req, reply) => {
    const p = parse(memberParams, req.params);
    if (p.userId === req.userId) throw badRequest('Use the gateway to leave voice yourself');
    await moderationTarget(p.id, req.userId, p.userId, Perm.MOVE_MEMBERS);
    const st = await ctx.voice.get(p.userId);
    if (!st?.channelId || st.guildId !== p.id) throw badRequest('Target is not connected to voice in this server');
    const src = await channelAccess(ctx, req.userId, st.channelId);
    need(src.perms, Perm.MOVE_MEMBERS);
    await disconnectMember(ctx, p.userId);
    await audit(ctx, p.id, req.userId, 'VOICE_DISCONNECT', p.userId, { channelId: st.channelId });
    return reply.code(204).send();
  });

  // ---------- stage channels ----------
  const stageAccess = async (userId: string, channelId: string) => {
    const a = await channelAccess(ctx, userId, channelId);
    if (a.channel.type !== 'stage') throw badRequest('Not a stage channel');
    return a;
  };
  const stageParams = z.object({ id: idSchema });

  app.put('/channels/:id/stage/request', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await stageAccess(req.userId, id);
    need(a.perms, Perm.REQUEST_TO_SPEAK);
    return requestToSpeak(ctx, req.userId, id, true);
  });
  app.delete('/channels/:id/stage/request', async (req) => {
    const { id } = parse(stageParams, req.params);
    await stageAccess(req.userId, id);
    return requestToSpeak(ctx, req.userId, id, false);
  });

  /** The raised-hand queue: suppressed members who asked to speak, ordered by when they raised their hand. */
  app.get('/channels/:id/stage/queue', async (req) => {
    const { id } = parse(stageParams, req.params);
    await stageAccess(req.userId, id);
    return (await ctx.voice.inChannel(id))
      .filter((s) => s.suppress && s.requestToSpeakAt)
      .sort((a, b) => String(a.requestToSpeakAt).localeCompare(String(b.requestToSpeakAt)))
      .map((s) => ({ userId: s.userId, requestToSpeakAt: s.requestToSpeakAt }));
  });

  /** Invite to speak. `@me` lets a moderator step onto the stage themselves. */
  app.put('/channels/:id/stage/speakers/:userId', async (req) => {
    const p = parse(z.object({ id: idSchema, userId: z.union([idSchema, z.literal('@me')]) }), req.params);
    const a = await stageAccess(req.userId, p.id);
    need(a.perms, Perm.MUTE_MEMBERS);
    const target = p.userId === '@me' ? req.userId : p.userId;
    if (target !== req.userId) needOutrankMember(a.gp!, await loadGuildPerm(ctx, a.channel.guild_id, target));
    const next = await setSuppressed(ctx, target, p.id, false);
    await audit(ctx, a.channel.guild_id, req.userId, 'STAGE_INVITE_SPEAKER', target, { channelId: p.id });
    return next;
  });
  /** Move a speaker back to the audience. Anyone may step themselves down; others need MUTE_MEMBERS and rank. */
  app.delete('/channels/:id/stage/speakers/:userId', async (req) => {
    const p = parse(z.object({ id: idSchema, userId: z.union([idSchema, z.literal('@me')]) }), req.params);
    const a = await stageAccess(req.userId, p.id);
    const target = p.userId === '@me' ? req.userId : p.userId;
    if (target !== req.userId) {
      need(a.perms, Perm.MUTE_MEMBERS);
      needOutrankMember(a.gp!, await loadGuildPerm(ctx, a.channel.guild_id, target));
    }
    const next = await setSuppressed(ctx, target, p.id, true);
    if (target !== req.userId) await audit(ctx, a.channel.guild_id, req.userId, 'STAGE_SUPPRESS_SPEAKER', target, { channelId: p.id });
    return next;
  });

  // ---------- priority speaker ----------
  /**
   * Priority speaker: while the member talks, everyone else is ducked. The ducking itself is a LiveKit participant
   * attribute set by the client (it needs the `canUpdateOwnMetadata` token grant); this endpoint is the authorization
   * gate, so a member may only enable it where they hold PRIORITY_SPEAKER, and only while connected to the channel.
   * Allowing it to be turned off never needs the permission.
   */
  const priorityAccess = async (userId: string, channelId: string) => {
    const a = await channelAccess(ctx, userId, channelId);
    if (!VOICE_TYPES.includes(a.channel.type) || !a.channel.guild_id) throw badRequest('Not a guild voice channel');
    return a;
  };
  app.put('/channels/:id/voice/priority-speaker', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await priorityAccess(req.userId, id);
    need(a.perms, Perm.PRIORITY_SPEAKER);
    const st = await ctx.voice.get(req.userId);
    if (!st?.channelId || st.channelId !== id) throw badRequest('Join the channel before enabling priority speaker');
    return { channelId: id, prioritySpeaker: true };
  });
  app.delete('/channels/:id/voice/priority-speaker', async (req) => {
    const { id } = parse(stageParams, req.params);
    await priorityAccess(req.userId, id);
    return { channelId: id, prioritySpeaker: false };
  });

  // ---------- voice recording (with a visible, server-enforced indicator) ----------
  /**
   * RECORD_VOICE is intentionally not in DEFAULT_EVERYONE: by default only administrators (who hold every bit) and
   * members with MANAGE_CHANNELS may record. An explicit role grant of RECORD_VOICE also works.
   */
  const canRecordVoice = (perms: bigint) => has(perms, Perm.RECORD_VOICE) || has(perms, Perm.MANAGE_CHANNELS);
  const recordingAccess = async (userId: string, channelId: string) => {
    const a = await channelAccess(ctx, userId, channelId);
    if (!a.channel.guild_id || !VOICE_TYPES.includes(a.channel.type)) throw badRequest('Not a guild voice channel');
    if (!canRecordVoice(a.perms)) throw forbidden('Missing permissions');
    return a;
  };
  const requireInChannel = async (userId: string, channelId: string) => {
    const st = await ctx.voice.get(userId);
    if (!st?.channelId || st.channelId !== channelId) throw badRequest('Join the voice channel first');
  };

  app.post('/channels/:id/voice/recording/start', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await recordingAccess(req.userId, id);
    await requireInChannel(req.userId, id);
    const recording = await startVoiceRecording(ctx, id, a.channel.guild_id ?? null, req.userId);
    await audit(ctx, a.channel.guild_id, req.userId, 'VOICE_RECORDING_START', id, { recordingId: recording.id });
    return { channelId: id, recording };
  });

  /**
   * Stop the recording, clearing the indicator for everyone in the channel. Uploaded takes (`POST /uploads`) may be
   * passed as `attachments`; the server then claims them and posts them as a message in the channel's text chat.
   */
  app.post('/channels/:id/voice/recording/stop', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await recordingAccess(req.userId, id);
    await requireInChannel(req.userId, id);
    const { attachments: uploaded } = parse(z.object({ attachments: z.array(idSchema).max(10).optional() }).strict(), req.body);
    if (uploaded?.length) need(a.perms, Perm.SEND_MESSAGES, Perm.ATTACH_FILES); // before stopping: a refused post must not half-apply
    const recording = await stopVoiceRecording(ctx, id, req.userId);
    await audit(ctx, a.channel.guild_id, req.userId, 'VOICE_RECORDING_STOP', id, { recordingId: recording.id });
    if (!uploaded?.length) return { channelId: id, recording: null };
    const attachments = await claimAttachments(ctx, req.userId, uploaded);
    try {
      if (attachments.some((at) => at.contentType.startsWith('audio/'))) need(a.perms, Perm.SEND_VOICE_MESSAGES);
      const message = await createMessage(ctx, { channel: a.channel, authorId: req.userId, content: '', attachments, senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds });
      return { channelId: id, recording: null, message };
    } catch (e) {
      // release the claim exactly like POST /channels/:id/messages, so the upload stays sendable
      await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [attachments.map((x) => x.id)]);
      throw e;
    }
  });
}
