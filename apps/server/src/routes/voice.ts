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
import { VOICE_TYPES, disconnectMember, moveMember, publishVoice, requestToSpeak, setPrioritySpeaker, setServerVoiceFlags, setSuppressed } from '../services/voice';
import { blockDTO, listBlocks, listHandQueue, lowerHand, publishHandQueue } from '../services/stage';
import { kickViewer, listStreams, readmitViewer, setStreamLimit, stopWatching, watchStream } from '../services/streams';

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
    const b = parse(z.object({ anonymous: z.boolean().optional() }).strict(), req.body ?? {});
    const a = await stageAccess(req.userId, id);
    need(a.perms, Perm.REQUEST_TO_SPEAK);
    return requestToSpeak(ctx, req.userId, id, true, { anonymous: b.anonymous });
  });
  app.delete('/channels/:id/stage/request', async (req) => {
    const { id } = parse(stageParams, req.params);
    await stageAccess(req.userId, id);
    return requestToSpeak(ctx, req.userId, id, false);
  });

  /**
   * The raised-hand queue, first come first served and persisted (a member who reconnects within two minutes keeps their place).
   * Moderators only (MUTE_MEMBERS): they see who is asking, including anonymous hands. Everyone else learns the order from
   * STAGE_QUEUE_UPDATE (anonymous hands without identity) and their own position from STAGE_HAND_UPDATE / the request response.
   */
  app.get('/channels/:id/stage/queue', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await stageAccess(req.userId, id);
    need(a.perms, Perm.MUTE_MEMBERS);
    return listHandQueue(ctx, id);
  });

  /** Members barred from asking to speak / speaking on this stage (cleared when the stage ends). */
  app.get('/channels/:id/stage/blocked', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await stageAccess(req.userId, id);
    need(a.perms, Perm.MUTE_MEMBERS);
    return listBlocks(ctx, id);
  });
  app.put('/channels/:id/stage/blocked/:userId', async (req) => {
    const p = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
    const b = parse(z.object({ reason: z.string().trim().max(200).optional() }).strict(), req.body ?? {});
    const a = await stageAccess(req.userId, p.id);
    need(a.perms, Perm.MUTE_MEMBERS);
    if (p.userId === req.userId) throw badRequest('You cannot block yourself');
    const target = await loadGuildPerm(ctx, a.channel.guild_id, p.userId);
    if (!target) throw notFound('Member');
    needOutrankMember(a.gp!, target);
    const [row] = await ctx.db.query(
      `INSERT INTO stage_speaker_blocks (channel_id, user_id, blocked_by, reason) VALUES ($1,$2,$3,$4)
       ON CONFLICT (channel_id, user_id) DO UPDATE SET blocked_by = EXCLUDED.blocked_by, reason = EXCLUDED.reason RETURNING *`, [p.id, p.userId, req.userId, b.reason || null]);
    // take away what they already have: a raised hand and a seat among the speakers
    const hadHand = await lowerHand(ctx, p.id, p.userId);
    const st = await ctx.voice.get(p.userId);
    if (st?.channelId === p.id && !st.suppress) await setSuppressed(ctx, p.userId, p.id, true);
    else if (st?.channelId === p.id && st.requestToSpeakAt) { const next = { ...st, requestToSpeakAt: null }; await ctx.voice.set(next); await publishVoice(ctx, p.id, next); }
    if (hadHand) await publishHandQueue(ctx, p.id, p.userId);
    await audit(ctx, a.channel.guild_id, req.userId, 'STAGE_BLOCK_SPEAKER', p.userId, { channelId: p.id, reason: b.reason || null });
    return blockDTO(row);
  });
  app.delete('/channels/:id/stage/blocked/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
    const a = await stageAccess(req.userId, p.id);
    need(a.perms, Perm.MUTE_MEMBERS);
    const gone = (await ctx.db.query('DELETE FROM stage_speaker_blocks WHERE channel_id = $1 AND user_id = $2 RETURNING 1', [p.id, p.userId])).length > 0;
    if (!gone) throw notFound('Block');
    await audit(ctx, a.channel.guild_id, req.userId, 'STAGE_UNBLOCK_SPEAKER', p.userId, { channelId: p.id });
    return reply.code(204).send();
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
   * Priority speaker: while the member talks, everyone else is ducked by the clients. The server owns the flag: it is kept in the
   * member's voice state (VoiceState.prioritySpeaker, broadcast) and written to the LiveKit attribute `jv.priority` by the
   * server (tokens carry no canUpdateOwnMetadata). A member may enable it only where they hold PRIORITY_SPEAKER, only while
   * connected to the channel and only while they may speak; it is dropped again when that stops being true (role change,
   * server mute, stage suppression, leaving or moving). Turning it off never needs the permission.
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
    const voiceState = await setPrioritySpeaker(ctx, req.userId, a.channel, a.perms, true);
    return { channelId: id, prioritySpeaker: true, voiceState };
  });
  app.delete('/channels/:id/voice/priority-speaker', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await priorityAccess(req.userId, id);
    const voiceState = await setPrioritySpeaker(ctx, req.userId, a.channel, a.perms, false);
    return { channelId: id, prioritySpeaker: false, voiceState };
  });

  // ---------- Go Live: viewers, audience cap, kicking ----------
  /** Callers must be connected to the channel; stream info (including who watches) is visible to everyone in it. */
  const streamAccess = async (userId: string, channelId: string) => {
    const a = await channelAccess(ctx, userId, channelId);
    if (!VOICE_TYPES.includes(a.channel.type)) throw badRequest('Not a voice channel');
    const st = await ctx.voice.get(userId);
    if (!st?.channelId || st.channelId !== channelId) throw badRequest('Join the voice channel first');
    return a;
  };
  const streamerParam = z.union([idSchema, z.literal('@me')]);
  const streamerOf = (p: string, me: string) => (p === '@me' ? me : p);

  /** Streams running in the channel and who watches them. `kicked` is added for your own stream, and for every stream if you hold MOVE_MEMBERS. */
  app.get('/channels/:id/voice/streams', async (req) => {
    const { id } = parse(stageParams, req.params);
    const a = await streamAccess(req.userId, id);
    const mod = has(a.perms, Perm.MOVE_MEMBERS);
    return listStreams(ctx, id, (streamer) => mod || streamer === req.userId);
  });
  /** The streamer picks the audience cap of their stream (1..STREAM_MAX_VIEWERS, null = as many as the server allows). */
  app.put('/channels/:id/voice/stream', async (req) => {
    const { id } = parse(stageParams, req.params);
    const b = parse(z.object({ viewerLimit: z.number().int().min(1).nullable() }).strict(), req.body);
    const a = await streamAccess(req.userId, id);
    need(a.perms, Perm.STREAM);
    return setStreamLimit(ctx, req.userId, id, b.viewerLimit);
  });
  /** Start watching a stream. 409 STREAM_FULL when the cap is reached, 403 STREAM_VIEWER_KICKED when you were removed from it. */
  app.put('/channels/:id/voice/stream/:streamerId/watch', async (req) => {
    const p = parse(z.object({ id: idSchema, streamerId: streamerParam }), req.params);
    await streamAccess(req.userId, p.id);
    return watchStream(ctx, req.userId, p.id, streamerOf(p.streamerId, req.userId));
  });
  app.delete('/channels/:id/voice/stream/:streamerId/watch', async (req) => {
    const p = parse(z.object({ id: idSchema, streamerId: streamerParam }), req.params);
    await streamAccess(req.userId, p.id);
    return stopWatching(ctx, req.userId, p.id);
  });
  /** Remove a viewer from a stream until it ends. The streamer may always; anyone else needs MOVE_MEMBERS and to outrank the viewer. */
  app.delete('/channels/:id/voice/stream/:streamerId/viewers/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, streamerId: streamerParam, userId: idSchema }), req.params);
    const a = await streamAccess(req.userId, p.id);
    const streamerId = streamerOf(p.streamerId, req.userId);
    if (streamerId !== req.userId) {
      if (!a.channel.guild_id) throw forbidden('Only the streamer can remove viewers');
      need(a.perms, Perm.MOVE_MEMBERS);
      const target = await loadGuildPerm(ctx, a.channel.guild_id, p.userId);
      if (target) needOutrankMember(a.gp!, target);
    }
    await kickViewer(ctx, p.id, streamerId, p.userId, req.userId);
    if (streamerId !== req.userId && a.channel.guild_id) await audit(ctx, a.channel.guild_id, req.userId, 'STREAM_VIEWER_KICK', p.userId, { channelId: p.id, streamerId });
    return reply.code(204).send();
  });
  /** Let a removed viewer back in. */
  app.delete('/channels/:id/voice/stream/:streamerId/kicks/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, streamerId: streamerParam, userId: idSchema }), req.params);
    const a = await streamAccess(req.userId, p.id);
    const streamerId = streamerOf(p.streamerId, req.userId);
    if (streamerId !== req.userId) need(a.perms, Perm.MOVE_MEMBERS);
    if (!(await readmitViewer(ctx, p.id, streamerId, p.userId))) throw notFound('Kick');
    return reply.code(204).send();
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
