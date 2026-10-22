import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, startServer, type Client, type TestEnv } from './helpers';
import { lastClusterTimecode, webmDuration, webmInfo } from '../src/routes/clips';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const mpart = (filename: string, value: Buffer, type: string) => {
  const b = 'XBOUNDARYX';
  return {
    payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), value, Buffer.from(`\r\n--${b}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  };
};

const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
/** A minimal MP4: ftyp plus (optionally) a moov/mvhd that declares `seconds` at timescale 1000. */
const mp4 = (seconds?: number) => {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(8)]));
  if (seconds === undefined) return Buffer.concat([ftyp, Buffer.alloc(64, 2)]);
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([ftyp, box('moov', box('mvhd', mvhd))]);
};
const ebml = (id: number[], body: Buffer) => { const h = Buffer.from([...id, 0x80 | body.length]); return Buffer.concat([h, body]); };
/**
 * A minimal WebM like MediaRecorder writes it: EBML header, a Segment of unknown size, an Info element (TimecodeScale 1 ms, and a
 * Duration only when `durationMs` is given) and clusters with unknown size whose timecodes are `clusterMs`.
 */
const webm = (clusterMs: number[], durationMs?: number) => {
  const head = ebml([0x1a, 0x45, 0xdf, 0xa3], Buffer.from([0x42, 0x86, 0x81, 0x01]));
  const scale = Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
  const dur = Buffer.alloc(11); if (durationMs !== undefined) { dur.set([0x44, 0x89, 0x88], 0); dur.writeDoubleBE(durationMs, 3); }
  const info = ebml([0x15, 0x49, 0xa9, 0x66], durationMs === undefined ? scale : Buffer.concat([scale, dur]));
  const seg = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const clusters = clusterMs.map((ms) => { const t = Buffer.alloc(4); t.writeUInt32BE(ms); return Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x84]), t, Buffer.alloc(40, 7)]); });
  return Buffer.concat([head, seg, info, ...clusters]);
};
const uploadVideo = async (user: Client, bytes: Buffer = mp4(), type = 'video/mp4') => {
  const p = mpart('clip.mp4', bytes, type);
  return api.req('POST', '/uploads', user.token, p.payload as any, p.headers);
};

async function setup() {
  const owner = await api.register('co');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Clips' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const member = await api.register('cm'); await api.req('POST', `/invites/${code}`, member.token);
  const other = await api.register('cx'); await api.req('POST', `/invites/${code}`, other.token);
  const outsider = await api.register('cout');
  const general = guild.channels.find((c: any) => c.name === 'general');
  // clips only work in a channel an admin flagged as a clips channel
  await api.req('PATCH', `/channels/${general.id}`, owner.token, { isClipsChannel: true });
  return { owner, guild, member, other, outsider, general };
}

async function removeEveryonePerm(owner: Client, guild: any, bit: bigint) {
  const everyone = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === '@everyone');
  return api.req('PATCH', `/guilds/${guild.id}/roles/${everyone.id}`, owner.token, { permissions: String(BigInt(everyone.permissions) & ~bit) });
}

async function postClip(user: Client, channelId: string, body: Record<string, unknown>) {
  return api.req('POST', `/channels/${channelId}/clips`, user.token, { durationSeconds: 5, ...body });
}

describe('clips', () => {
  it('sets the clips channel flag with MANAGE_CHANNELS', async () => {
    const { owner, member, general } = await setup();
    expect((await api.req('PATCH', `/channels/${general.id}`, member.token, { isClipsChannel: true })).status).toBe(403);
    const r = await api.req('PATCH', `/channels/${general.id}`, owner.token, { isClipsChannel: true });
    expect(r.status).toBe(200); expect(r.body.isClipsChannel).toBe(true);
    expect((await api.req('GET', `/channels/${general.id}`, member.token)).body.isClipsChannel).toBe(true);
  });

  it('posts a clip as a normal message and lists only that channel', async () => {
    const { owner, guild, member, general } = await setup();
    const up = await uploadVideo(member);
    expect(up.status).toBe(201);
    const posted = await postClip(member, general.id, { attachments: [up.body.id], content: 'my clip', durationSeconds: 30 });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ id: posted.body.messageId, clipId: posted.body.id, durationSeconds: 30 });
    expect(posted.body.attachments[0].contentType).toBe('video/mp4');
    // it is a normal message in the channel's history
    const messages = (await api.req('GET', `/channels/${general.id}/messages`, member.token)).body;
    expect(messages.map((m: any) => m.id)).toContain(posted.body.id);

    const otherChannel = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'clips-2', type: 'text', isClipsChannel: true })).body;
    const up2 = await uploadVideo(owner);
    const posted2 = await postClip(owner, otherChannel.id, { attachmentId: up2.body.id, duration: 12 });
    expect(posted2.status).toBe(201);

    const list = await api.req('GET', `/channels/${general.id}/clips`, member.token);
    expect(list.status).toBe(200);
    expect(list.body.map((c: any) => c.id)).toEqual([posted.body.id]);
    const list2 = await api.req('GET', `/channels/${otherChannel.id}/clips`, member.token);
    expect(list2.body.map((c: any) => c.id)).toEqual([posted2.body.id]);
  });

  it('rejects non-video uploads and clips longer than the cap (120 s by default)', async () => {
    const { member, general } = await setup();
    const image = await api.req('POST', '/uploads', member.token, mpart('x.png', Buffer.alloc(64, 2), 'image/png').payload as any, mpart('x.png', Buffer.alloc(64, 2), 'image/png').headers);
    expect((await postClip(member, general.id, { attachmentId: image.body.id })).status).toBe(400);

    const up = await uploadVideo(member);
    const tooLong = await postClip(member, general.id, { attachmentId: up.body.id, durationSeconds: 121 });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toMatchObject({ code: 'CLIP_TOO_LONG', details: { maxSeconds: 120 } });
    expect((await postClip(member, general.id, { attachmentId: up.body.id, durationSeconds: 9999 })).status).toBe(400);
    // the rejected upload stays claimable, and the 1 and 2 minute recorder windows fit
    const one = await postClip(member, general.id, { attachmentId: up.body.id, durationSeconds: 60 });
    expect(one.status).toBe(201); expect(one.body.durationSeconds).toBe(60);
    const up2 = await uploadVideo(member);
    const two = await postClip(member, general.id, { attachmentId: up2.body.id, durationSeconds: 120 });
    expect(two.status).toBe(201); expect(two.body.durationSeconds).toBe(120);
  });

  it('exposes the cap and lets the operator change it', async () => {
    const { member } = await setup();
    expect((await api.req('GET', '/clips/limits', member.token)).body).toEqual({ maxSeconds: 120, maxBytes: 100 * 1024 * 1024 });
    expect((await api.req('GET', '/clips/limits', null)).status).toBe(401);
    const strict = await startServer({ clipMaxSeconds: 30 });
    try {
      const sapi = new Api(strict);
      const owner = await sapi.register('sco');
      const guild = (await sapi.req('POST', '/guilds', owner.token, { name: 'Strict' })).body;
      const ch = guild.channels.find((c: any) => c.name === 'general');
      await sapi.req('PATCH', `/channels/${ch.id}`, owner.token, { isClipsChannel: true });
      expect((await sapi.req('GET', '/clips/limits', owner.token)).body.maxSeconds).toBe(30);
      const p = mpart('c.mp4', mp4(), 'video/mp4');
      const up = await sapi.req('POST', '/uploads', owner.token, p.payload as any, p.headers);
      expect((await sapi.req('POST', `/channels/${ch.id}/clips`, owner.token, { attachmentId: up.body.id, durationSeconds: 31 })).body.code).toBe('CLIP_TOO_LONG');
      expect((await sapi.req('POST', `/channels/${ch.id}/clips`, owner.token, { attachmentId: up.body.id, durationSeconds: 30 })).status).toBe(201);
    } finally { await strict.close(); }
  });

  it('verifies the duration of a WebM from its cluster timecodes and Info duration', async () => {
    const { member, general } = await setup();
    // MediaRecorder writes no Duration: the last cluster says it is ~110 s although the client claims 5 s -> corrected, not rejected
    const ok = await uploadVideo(member, webm([0, 55_000, 110_000]), 'video/webm');
    const posted = await postClip(member, general.id, { attachmentId: ok.body.id, durationSeconds: 5 });
    expect(posted.status).toBe(201); expect(posted.body.durationSeconds).toBe(110);
    // ~150 s of media cannot be shared as a 10 s clip
    const long = await uploadVideo(member, webm([0, 75_000, 150_000]), 'video/webm');
    const refused = await postClip(member, general.id, { attachmentId: long.body.id, durationSeconds: 10 });
    expect(refused.status).toBe(400); expect(refused.body.code).toBe('CLIP_TOO_LONG');
    // an Info Duration is honoured too
    const declared = await uploadVideo(member, webm([0], 130_000), 'video/webm');
    expect((await postClip(member, general.id, { attachmentId: declared.body.id, durationSeconds: 10 })).status).toBe(400);
    // nothing to read: the claim is trusted
    const bare = await uploadVideo(member, webm([]), 'video/webm');
    const trusted = await postClip(member, general.id, { attachmentId: bare.body.id, durationSeconds: 100 });
    expect(trusted.status).toBe(201); expect(trusted.body.durationSeconds).toBe(100);
    // the duration is taken from the file when the client omits it
    const noClaim = await uploadVideo(member, webm([0, 20_000]), 'video/webm');
    const r = await api.req('POST', `/channels/${general.id}/clips`, member.token, { attachmentId: noClaim.body.id });
    expect(r.status).toBe(201); expect(r.body.durationSeconds).toBe(20);
  });

  it('parses WebM timing without being fooled by junk', () => {
    expect(webmInfo(webm([0], 90_000))).toEqual({ scaleNs: 1_000_000, durationSeconds: 90 });
    expect(webmInfo(webm([0])).durationSeconds).toBeNull();
    expect(webmInfo(Buffer.from('not a webm'))).toEqual({ scaleNs: 1_000_000, durationSeconds: null });
    expect(lastClusterTimecode(webm([1000, 3000, 2000]))).toBe(3000);
    expect(lastClusterTimecode(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x81]))).toBeNull(); // truncated
    expect(lastClusterTimecode(Buffer.alloc(100, 0xff))).toBeNull();
    expect(webmDuration(webm([0]), webm([0, 42_000]))).toBe(42);
    expect(webmDuration(webm([0]), Buffer.alloc(10))).toBeNull();
  });

  it('only works in a channel configured as a clips channel', async () => {
    const { owner, guild, member } = await setup();
    const plain = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'chat', type: 'text' })).body;
    const up = await uploadVideo(member);
    expect((await postClip(member, plain.id, { attachmentId: up.body.id, durationSeconds: 5 })).status).toBe(400);
    expect((await api.req('GET', `/channels/${plain.id}/clips`, member.token)).status).toBe(400);
    // the rejected upload is released, and a DM is never a clips channel
    const dm = (await api.req('POST', '/users/@me/channels', member.token, { recipientIds: [owner.id] })).body;
    expect((await postClip(member, dm.id, { attachmentId: up.body.id, durationSeconds: 5 })).status).toBe(400);
    const ok = await api.req('PATCH', `/channels/${plain.id}`, owner.token, { isClipsChannel: true });
    expect(ok.status).toBe(200);
    expect((await postClip(member, plain.id, { attachmentId: up.body.id, durationSeconds: 5 })).status).toBe(201);
  });

  it('checks the real file type, size and declared duration', async () => {
    const { member, general } = await setup();
    // a script uploaded with a video Content-Type is not a video
    const fake = await uploadVideo(member, Buffer.from('<script>alert(1)</script>'), 'video/mp4');
    expect((await postClip(member, general.id, { attachmentId: fake.body.id, durationSeconds: 5 })).status).toBe(400);
    // a real MP4 declared as WebM (or an unsupported container type) is refused
    const mismatch = await uploadVideo(member, mp4(), 'video/webm');
    expect((await postClip(member, general.id, { attachmentId: mismatch.body.id, durationSeconds: 5 })).status).toBe(400);
    const quicktime = await uploadVideo(member, mp4(), 'video/quicktime');
    expect((await postClip(member, general.id, { attachmentId: quicktime.body.id, durationSeconds: 5 })).status).toBe(400);
    // the container says 150 s although the client claims 10 s
    const long = await uploadVideo(member, mp4(150));
    expect((await postClip(member, general.id, { attachmentId: long.body.id, durationSeconds: 10 })).status).toBe(400);
    // the duration is read from the container when the client omits it
    const short = await uploadVideo(member, mp4(12.4));
    const r = await api.req('POST', `/channels/${general.id}/clips`, member.token, { attachmentId: short.body.id });
    expect(r.status).toBe(201); expect(r.body.durationSeconds).toBe(13);
    // no way to know the length at all
    const unknown = await uploadVideo(member, mp4());
    expect((await api.req('POST', `/channels/${general.id}/clips`, member.token, { attachmentId: unknown.body.id })).status).toBe(400);
    // fractional claims are accepted (rounded up)
    expect((await postClip(member, general.id, { attachmentId: unknown.body.id, durationSeconds: 7.2 })).body.durationSeconds).toBe(8);
  });

  it('rejects oversized clips', async () => {
    const { member, general } = await setup();
    const up = await uploadVideo(member);
    await env.ctx.db.query('UPDATE files SET size = $2 WHERE id = $1', [up.body.id, 101 * 1024 * 1024]);
    expect((await postClip(member, general.id, { attachmentId: up.body.id, durationSeconds: 5 })).status).toBe(413);
  });

  it('rate limits clip posting per user', async () => {
    const limited = await startServer({ rateLimit: true });
    try {
      const lapi = new Api(limited);
      const owner = await lapi.register('rlo');
      const guild = (await lapi.req('POST', '/guilds', owner.token, { name: 'RL' })).body;
      const ch = guild.channels.find((c: any) => c.name === 'general');
      await lapi.req('PATCH', `/channels/${ch.id}`, owner.token, { isClipsChannel: true });
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const p = mpart('c.mp4', mp4(), 'video/mp4');
        const up = await lapi.req('POST', '/uploads', owner.token, p.payload as any, p.headers);
        statuses.push((await lapi.req('POST', `/channels/${ch.id}/clips`, owner.token, { attachmentId: up.body.id, durationSeconds: 3 })).status);
      }
      expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
      expect(statuses).toContain(429);
    } finally { await limited.close(); }
  });

  it('requires SEND_MESSAGES to post a clip', async () => {
    const { owner, guild, member, general } = await setup();
    await removeEveryonePerm(owner, guild, Perm.SEND_MESSAGES);
    const up = await uploadVideo(member);
    expect((await postClip(member, general.id, { attachmentId: up.body.id })).status).toBe(403);
  });

  it('requires ATTACH_FILES to post a clip', async () => {
    const { owner, guild, member, general } = await setup();
    await removeEveryonePerm(owner, guild, Perm.ATTACH_FILES);
    const up = await uploadVideo(member);
    expect((await postClip(member, general.id, { attachmentId: up.body.id })).status).toBe(403);
  });

  it('hides clips when the caller cannot VIEW the channel', async () => {
    const { owner, member, general, outsider } = await setup();
    const up = await uploadVideo(member);
    const posted = await postClip(member, general.id, { attachmentId: up.body.id });
    expect(posted.status).toBe(201);
    // non-members get 404 on every clips endpoint
    expect((await api.req('GET', `/channels/${general.id}/clips`, outsider.token)).status).toBe(404);
    expect((await postClip(outsider, general.id, { attachmentId: up.body.id })).status).toBe(404);
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${posted.body.id}`, outsider.token)).status).toBe(404);
    // a channel overwrite that denies VIEW behaves the same
    await api.req('PUT', `/channels/${general.id}/permissions/${member.id}`, owner.token, { type: 'member', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect((await api.req('GET', `/channels/${general.id}/clips`, member.token)).status).toBe(404);
    const up2 = await uploadVideo(member);
    expect((await postClip(member, general.id, { attachmentId: up2.body.id })).status).toBe(404);
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${posted.body.id}`, member.token)).status).toBe(404);
  });

  it('requires READ_MESSAGE_HISTORY to list clips', async () => {
    const { owner, guild, member, general } = await setup();
    const up = await uploadVideo(member);
    expect((await postClip(member, general.id, { attachmentId: up.body.id })).status).toBe(201);
    await removeEveryonePerm(owner, guild, Perm.READ_MESSAGE_HISTORY);
    expect((await api.req('GET', `/channels/${general.id}/clips`, member.token)).status).toBe(403);
  });

  it('lets the author or a MANAGE_MESSAGES holder delete a clip', async () => {
    const { owner, member, other, general } = await setup();
    const up = await uploadVideo(member);
    const posted = await postClip(member, general.id, { attachmentId: up.body.id });
    // someone else without MANAGE_MESSAGES cannot delete it
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${posted.body.id}`, other.token)).status).toBe(403);
    // the author can
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${posted.body.id}`, member.token)).status).toBe(204);
    expect((await api.req('GET', `/channels/${general.id}/clips`, member.token)).body).toEqual([]);

    const up2 = await uploadVideo(member);
    const posted2 = await postClip(member, general.id, { attachmentId: up2.body.id });
    // the owner holds MANAGE_MESSAGES and can delete someone else's clip
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${posted2.body.id}`, owner.token)).status).toBe(204);
    // ordinary messages are not clips
    const normal = (await api.req('POST', `/channels/${general.id}/messages`, member.token, { content: 'hi' })).body;
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${normal.id}`, member.token)).status).toBe(404);
  });

  it('cannot act on a clip through another channel id', async () => {
    const { owner, guild, member, general } = await setup();
    const secret = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'secret', type: 'text', isClipsChannel: true })).body;
    const up = await uploadVideo(member);
    const posted = await postClip(member, secret.id, { attachmentId: up.body.id });
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${posted.body.id}`, member.token)).status).toBe(404);
    expect((await api.req('GET', `/channels/${general.id}/clips`, member.token)).body).toEqual([]);
  });
});
