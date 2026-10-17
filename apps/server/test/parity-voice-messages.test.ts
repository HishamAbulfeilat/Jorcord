import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE, DISCORD_PERMISSION_BITS, Perm } from '@jorcord/shared';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const mpart = (filename: string, value: Buffer, type: string) => {
  const b = 'XBOUNDARYX';
  return { payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), value, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Voice Msgs' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const m = await api.register('m'); await api.req('POST', `/invites/${code}`, m.token);
  const d = await api.register('d');
  // DMs require a friendship (strangers cannot DM)
  await api.req('PUT', `/users/@me/relationships/${d.id}`, m.token, { type: 'friend' });
  await api.req('PUT', `/users/@me/relationships/${m.id}`, d.token, { type: 'friend' });
  const dm = (await api.req('POST', '/users/@me/channels', m.token, { recipientIds: [d.id] })).body;
  const general = guild.channels.find((c: any) => c.name === 'general');
  return { owner, guild, m, d, dm, general };
}

describe('voice messages (SEND_VOICE_MESSAGES)', () => {
  it('the bit exists at its own position, is mapped to Discord and granted by default', () => {
    expect(Perm.SEND_VOICE_MESSAGES).toBe(1n << 19n);
    expect(DISCORD_PERMISSION_BITS.SEND_VOICE_MESSAGES).toBe(45);
    expect((DEFAULT_EVERYONE & Perm.SEND_VOICE_MESSAGES) === Perm.SEND_VOICE_MESSAGES).toBe(true);
  });

  it('audio attachments send by default, and the permission is enforced', async () => {
    const { owner, guild, m, general } = await setup();
    const up1 = await api.req('POST', '/uploads', m.token, mpart('voice.mp3', Buffer.alloc(64, 2), 'audio/mpeg').payload as any, mpart('voice.mp3', Buffer.alloc(64, 2), 'audio/mpeg').headers);
    expect(up1.status).toBe(201);
    // DEFAULT_EVERYONE grants SEND_VOICE_MESSAGES: a voice message goes through
    const ok = await api.req('POST', `/channels/${general.id}/messages`, m.token, { attachments: [up1.body.id] });
    expect(ok.status).toBe(201); expect(ok.body.attachments[0]).toMatchObject({ contentType: 'audio/mpeg' });
    // taking the bit away from @everyone refuses the send
    const everyone = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === '@everyone');
    await api.req('PATCH', `/guilds/${guild.id}/roles/${everyone.id}`, owner.token, { permissions: String(BigInt(everyone.permissions) & ~Perm.SEND_VOICE_MESSAGES) });
    const up2 = await api.req('POST', '/uploads', m.token, mpart('v2.mp3', Buffer.alloc(64, 2), 'audio/mpeg').payload as any, mpart('v2.mp3', Buffer.alloc(64, 2), 'audio/mpeg').headers);
    expect((await api.req('POST', `/channels/${general.id}/messages`, m.token, { attachments: [up2.body.id] })).status).toBe(403);
    // the rejected message released the claim: the upload is sendable again once allowed
    await api.req('PUT', `/channels/${general.id}/permissions/${everyone.id}`, owner.token, { type: 'role', allow: String(Perm.SEND_VOICE_MESSAGES), deny: '0' });
    expect((await api.req('POST', `/channels/${general.id}/messages`, m.token, { attachments: [up2.body.id] })).status).toBe(201);
    // the owner (full permissions) is never blocked
    const up3 = await api.req('POST', '/uploads', owner.token, mpart('o.mp3', Buffer.alloc(64, 2), 'audio/webm').payload as any, mpart('o.mp3', Buffer.alloc(64, 2), 'audio/webm').headers);
    expect((await api.req('POST', `/channels/${general.id}/messages`, owner.token, { attachments: [up3.body.id] })).status).toBe(201);
  });

  it('voice messages work in DMs and non-audio files never need the permission', async () => {
    const { owner, guild, m, d, dm, general } = await setup();
    // DM participants always hold SEND_VOICE_MESSAGES (DM_PERMS)
    const up = await api.req('POST', '/uploads', m.token, mpart('dm.mp3', Buffer.alloc(64, 2), 'audio/ogg').payload as any, mpart('dm.mp3', Buffer.alloc(64, 2), 'audio/ogg').headers);
    expect((await api.req('POST', `/channels/${dm.id}/messages`, m.token, { attachments: [up.body.id] })).status).toBe(201);
    // even with the bit taken away everywhere, ordinary file attachments are untouched
    const everyone = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === '@everyone');
    await api.req('PATCH', `/guilds/${guild.id}/roles/${everyone.id}`, owner.token, { permissions: String(BigInt(everyone.permissions) & ~Perm.SEND_VOICE_MESSAGES) });
    const png = await api.req('POST', '/uploads', m.token, mpart('x.png', Buffer.alloc(64, 2), 'image/png').payload as any, mpart('x.png', Buffer.alloc(64, 2), 'image/png').headers);
    expect((await api.req('POST', `/channels/${general.id}/messages`, m.token, { attachments: [png.body.id] })).status).toBe(201);
  });
});
