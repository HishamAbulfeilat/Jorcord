import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { Api, startServer, type Client, type TestEnv } from './helpers';

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

  it('rejects non-video uploads and clips longer than 30 seconds', async () => {
    const { member, general } = await setup();
    const image = await api.req('POST', '/uploads', member.token, mpart('x.png', Buffer.alloc(64, 2), 'image/png').payload as any, mpart('x.png', Buffer.alloc(64, 2), 'image/png').headers);
    expect((await postClip(member, general.id, { attachmentId: image.body.id })).status).toBe(400);

    const up = await uploadVideo(member);
    expect((await postClip(member, general.id, { attachmentId: up.body.id, durationSeconds: 31 })).status).toBe(400);
    // the rejected upload stays claimable
    expect((await postClip(member, general.id, { attachmentId: up.body.id, durationSeconds: 30 })).status).toBe(201);
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
    // the container says 90 s although the client claims 10 s
    const long = await uploadVideo(member, mp4(90));
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
