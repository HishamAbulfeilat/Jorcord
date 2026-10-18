import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE, DISCORD_PERMISSION_BITS, Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const mpart = (filename: string, value: Buffer, type: string) => {
  const b = 'XBOUNDARYX';
  return { payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), value, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};

async function setup(...members: string[]) {
  const owner = await api.register('recowner');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Recorders' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const joined: Client[] = [];
  for (const name of members) {
    const u = await api.register(name);
    expect((await api.req('POST', `/invites/${code}`, u.token)).status).toBe(200);
    joined.push(u);
  }
  return { owner, guild, members: joined, voice: guild.channels.find((c: any) => c.type === 'voice'), text: guild.channels.find((c: any) => c.type === 'text') };
}

/** Connect a gateway client and join `channelId` as the identified user. */
async function joinVoice(w: WsClient, watcher: WsClient, guildId: string, channelId: string, userId: string) {
  w.send({ op: 4, d: { guildId, channelId } });
  await watcher.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === userId && d.channelId === channelId);
}

describe('voice channel recording (RECORD_VOICE)', () => {
  it('is a new, non-default permission bit mapped for documentation', () => {
    expect(Perm.RECORD_VOICE).toBe(1n << 43n);
    expect(DEFAULT_EVERYONE & Perm.RECORD_VOICE).toBe(0n);
    expect(typeof DISCORD_PERMISSION_BITS.RECORD_VOICE).toBe('number');
  });

  it('requires RECORD_VOICE and channel membership, and broadcasts the indicator to channel viewers only', async () => {
    const { owner, guild, members, voice, text } = await setup('recbob');
    const bob = members[0]!;
    const outsider = await api.register('recout');
    const startUrl = `/channels/${voice.id}/voice/recording/start`;
    const stopUrl = `/channels/${voice.id}/voice/recording/stop`;

    // no channel access -> 404 (existence is not leaked)
    expect((await api.req('POST', startUrl, outsider.token)).status).toBe(404);
    // no RECORD_VOICE -> 403, checked before "are you connected"
    expect((await api.req('POST', startUrl, bob.token)).status).toBe(403);
    // the owner holds every permission but is not connected to the channel -> 400
    expect((await api.req('POST', startUrl, owner.token)).status).toBe(400);
    // not a voice channel -> 400
    expect((await api.req('POST', `/channels/${text.id}/voice/recording/start`, owner.token)).status).toBe(400);

    // grant the new bit explicitly (the bit is not in DEFAULT_EVERYONE)
    const role = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Recorders', permissions: String(Perm.RECORD_VOICE) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${bob.id}`, owner.token, { roles: [role.id] });

    const wOwner = await WsClient.connect(env.port); await wOwner.identify(owner.token);
    const wBob = await WsClient.connect(env.port); await wBob.identify(bob.token);
    const wOut = await WsClient.connect(env.port); await wOut.identify(outsider.token);
    await joinVoice(wBob, wOwner, guild.id, voice.id, bob.id);

    const started = await api.req('POST', startUrl, bob.token);
    expect(started.status).toBe(200);
    expect(started.body.recording).toMatchObject({ channelId: voice.id, guildId: guild.id, startedBy: bob.id });
    expect(Number.isNaN(Date.parse(started.body.recording.startedAt))).toBe(false);

    // every viewer of the channel gets the indicator; an outsider gets nothing
    const ev = await wOwner.waitEvent('VOICE_RECORDING_UPDATE', (d) => d.channelId === voice.id && d.recording?.startedBy === bob.id);
    expect(ev.d.recording.id).toBe(started.body.recording.id);
    await wBob.waitEvent('VOICE_RECORDING_UPDATE', (d) => d.channelId === voice.id && d.recording?.startedBy === bob.id);
    await wOut.expectNone((f) => f.t === 'VOICE_RECORDING_UPDATE');

    // who started it and when is stored server-side
    const [row] = await env.ctx.db.query('SELECT * FROM voice_recordings WHERE channel_id = $1 AND stopped_at IS NULL', [voice.id]);
    expect(row.started_by).toBe(bob.id);
    expect(row.started_at).toBeTruthy();

    // only one active recording per channel
    expect((await api.req('POST', startUrl, bob.token)).status).toBe(409);

    const stopped = await api.req('POST', stopUrl, bob.token);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ channelId: voice.id, recording: null });
    await wOwner.waitEvent('VOICE_RECORDING_UPDATE', (d) => d.channelId === voice.id && d.recording === null);
    const [closed] = await env.ctx.db.query('SELECT * FROM voice_recordings WHERE channel_id = $1 ORDER BY started_at DESC LIMIT 1', [voice.id]);
    expect(closed.stopped_at).toBeTruthy();
    expect(closed.stopped_by).toBe(bob.id);
    expect((await api.req('POST', stopUrl, bob.token)).status).toBe(409);

    wOwner.close(); wBob.close(); wOut.close();
  });

  it('lets MANAGE_CHANNELS holders and administrators record by default, and nobody else stop it', async () => {
    const { owner, guild, members, voice } = await setup('recmod', 'recplain', 'recadmin');
    const [mod, plain, admin] = members as [Client, Client, Client];
    const startUrl = `/channels/${voice.id}/voice/recording/start`;
    const stopUrl = `/channels/${voice.id}/voice/recording/stop`;

    const mgr = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Channel managers', permissions: String(Perm.MANAGE_CHANNELS) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${mod.id}`, owner.token, { roles: [mgr.id] });
    const adm = (await api.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: 'Admins', permissions: String(Perm.ADMINISTRATOR) })).body;
    await api.req('PATCH', `/guilds/${guild.id}/members/${admin.id}`, owner.token, { roles: [adm.id] });

    const wOwner = await WsClient.connect(env.port); await wOwner.identify(owner.token);
    const wMod = await WsClient.connect(env.port); await wMod.identify(mod.token);
    const wPlain = await WsClient.connect(env.port); await wPlain.identify(plain.token);
    const wAdmin = await WsClient.connect(env.port); await wAdmin.identify(admin.token);
    await joinVoice(wMod, wOwner, guild.id, voice.id, mod.id);
    await joinVoice(wPlain, wOwner, guild.id, voice.id, plain.id);
    await joinVoice(wAdmin, wOwner, guild.id, voice.id, admin.id);

    // MANAGE_CHANNELS implies the default right to record
    expect((await api.req('POST', startUrl, mod.token)).status).toBe(200);
    // a plain member, even while connected, cannot stop someone else's recording
    expect((await api.req('POST', stopUrl, plain.token)).status).toBe(403);
    // an administrator can
    expect((await api.req('POST', stopUrl, admin.token)).status).toBe(200);
    // and an administrator can start one too
    expect((await api.req('POST', startUrl, admin.token)).status).toBe(200);
    expect((await api.req('POST', stopUrl, admin.token)).status).toBe(200);

    wOwner.close(); wMod.close(); wPlain.close(); wAdmin.close();
  });

  it('posts the uploaded recording as an attachment in the voice channel text chat on stop', async () => {
    const { owner, guild, voice } = await setup();
    const wOwner = await WsClient.connect(env.port); await wOwner.identify(owner.token);
    await joinVoice(wOwner, wOwner, guild.id, voice.id, owner.id);

    expect((await api.req('POST', `/channels/${voice.id}/voice/recording/start`, owner.token)).status).toBe(200);
    const take = await api.req('POST', '/uploads', owner.token, mpart('recording.webm', Buffer.alloc(64, 7), 'audio/webm').payload as any, mpart('recording.webm', Buffer.alloc(64, 7), 'audio/webm').headers);
    expect(take.status).toBe(201);

    const stopped = await api.req('POST', `/channels/${voice.id}/voice/recording/stop`, owner.token, { attachments: [take.body.id] });
    expect(stopped.status).toBe(200);
    expect(stopped.body.recording).toBeNull();
    expect(stopped.body.message).toMatchObject({ channelId: voice.id, author: { id: owner.id } });
    expect(stopped.body.message.attachments[0]).toMatchObject({ id: take.body.id, contentType: 'audio/webm', url: take.body.url });

    // it really landed in the channel's text chat
    const history = await api.req('GET', `/channels/${voice.id}/messages`, owner.token);
    expect(history.status).toBe(200);
    const posted = history.body.find((m: any) => m.id === stopped.body.message.id);
    expect(posted.attachments[0].id).toBe(take.body.id);

    wOwner.close();
  });
});
