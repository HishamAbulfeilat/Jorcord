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

const uploadVideo = async (user: Client) => {
  const p = mpart('clip.mp4', Buffer.alloc(64, 2), 'video/mp4');
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
  return { owner, guild, member, other, outsider, general };
}

async function removeEveryonePerm(owner: Client, guild: any, bit: bigint) {
  const everyone = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === '@everyone');
  return api.req('PATCH', `/guilds/${guild.id}/roles/${everyone.id}`, owner.token, { permissions: String(BigInt(everyone.permissions) & ~bit) });
}

async function postClip(user: Client, channelId: string, body: Record<string, unknown>) {
  return api.req('POST', `/channels/${channelId}/clips`, user.token, body);
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

    const otherChannel = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'clips-2', type: 'text' })).body;
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
    const secret = (await api.req('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'secret', type: 'text' })).body;
    const up = await uploadVideo(member);
    const posted = await postClip(member, secret.id, { attachmentId: up.body.id });
    expect((await api.req('DELETE', `/channels/${general.id}/clips/${posted.body.id}`, member.token)).status).toBe(404);
    expect((await api.req('GET', `/channels/${general.id}/clips`, member.token)).body).toEqual([]);
  });
});
