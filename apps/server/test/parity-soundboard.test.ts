import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, Perm } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const mpart = (filename: string, value: Buffer, type: string) => {
  const b = 'XBOUNDARYX';
  return { payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), value, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};
const upload = async (c: Client, name: string, size: number, type = 'audio/mpeg') => {
  const mp = mpart(name, Buffer.alloc(size, 1), type);
  return (await api.req('POST', '/uploads', c.token, mp.payload as any, mp.headers)).body.url as string;
};
async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Sounds', template: 'community' })).body;
  const code = (await api.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  const m = await api.register('m'); await api.req('POST', `/invites/${code}`, m.token);
  const voice = guild.channels.find((c: any) => c.type === 'voice');
  return { owner, guild, m, voice };
}
const join = async (c: Client, guildId: string, channelId: string) => {
  const w = await WsClient.connect(env.port); await w.identify(c.token);
  w.send({ op: 4, d: { guildId, channelId } }); await w.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === c.id && d.channelId === channelId);
  return w;
};

describe('soundboard', () => {
  it('manages sounds (MANAGE_EMOJIS), validates uploads and limits', async () => {
    const { owner, guild, m } = await setup();
    const url = await upload(owner, 'bonk.mp3', 2000);
    const ws = await WsClient.connect(env.port); await ws.identify(m.token);
    expect((await api.req('POST', `/guilds/${guild.id}/soundboard-sounds`, m.token, { name: 'bonk', url })).status).toBe(403);
    const c = await api.req('POST', `/guilds/${guild.id}/soundboard-sounds`, owner.token, { name: 'bonk', url, emoji: '🔨', volume: 0.5 });
    expect(c.status).toBe(201); expect(c.body).toMatchObject({ name: 'bonk', emoji: '🔨', volume: 0.5, url });
    await ws.waitEvent('SOUNDBOARD_SOUNDS_UPDATE', (d) => d.sounds.length === 1);
    expect((await api.req('GET', `/guilds/${guild.id}/soundboard-sounds`, m.token)).body).toHaveLength(1);
    // external urls, non-audio, oversize and someone else's uploads are refused
    expect((await api.req('POST', `/guilds/${guild.id}/soundboard-sounds`, owner.token, { name: 'x1', url: 'https://evil.example/a.mp3' })).status).toBe(400);
    expect((await api.req('POST', `/guilds/${guild.id}/soundboard-sounds`, owner.token, { name: 'x2', url: await upload(owner, 'a.png', 100, 'application/zip') })).status).toBe(400);
    expect((await api.req('POST', `/guilds/${guild.id}/soundboard-sounds`, owner.token, { name: 'big', url: await upload(owner, 'big.mp3', LIMITS.maxSoundBytes + 1) })).status).toBe(413);
    expect((await api.req('POST', `/guilds/${guild.id}/soundboard-sounds`, owner.token, { name: 'stolen', url: await upload(m, 's.mp3', 100) })).status).toBe(403);
    const p = await api.req('PATCH', `/guilds/${guild.id}/soundboard-sounds/${c.body.id}`, owner.token, { name: 'bonk2', emoji: null, volume: 1 });
    expect(p.body).toMatchObject({ name: 'bonk2', emoji: null, volume: 1 });
    expect((await api.req('DELETE', `/guilds/${guild.id}/soundboard-sounds/${c.body.id}`, owner.token)).status).toBe(204);
    expect((await api.req('GET', `/guilds/${guild.id}/soundboard-sounds`, m.token)).body).toHaveLength(0);
    ws.close();
  });

  it('plays into the voice channel you are in, honouring USE_SOUNDBOARD and mutes', async () => {
    const { owner, guild, m, voice } = await setup();
    const sound = (await api.req('POST', `/guilds/${guild.id}/soundboard-sounds`, owner.token, { name: 'airhorn', url: await upload(owner, 'a.mp3', 500) })).body;
    const play = (c: Client) => api.req('POST', `/channels/${voice.id}/send-soundboard-sound`, c.token, { soundId: sound.id });
    expect((await play(m)).status).toBe(400); // not connected yet
    const wo = await join(owner, guild.id, voice.id); const wm = await join(m, guild.id, voice.id);
    const outsider = await api.register('out'); const wout = await WsClient.connect(env.port); await wout.identify(outsider.token);
    expect((await play(m)).status).toBe(204);
    const ev = await wo.waitEvent('VOICE_CHANNEL_EFFECT_SEND'); expect(ev.d).toMatchObject({ userId: m.id, channelId: voice.id, sound: { id: sound.id, name: 'airhorn' } });
    await wm.waitEvent('VOICE_CHANNEL_EFFECT_SEND');
    await wout.expectNone((f) => f.t === 'VOICE_CHANNEL_EFFECT_SEND');
    // server mute blocks playing
    await api.req('PATCH', `/guilds/${guild.id}/voice-states/${m.id}`, owner.token, { mute: true });
    expect((await play(m)).status).toBe(403);
    await api.req('PATCH', `/guilds/${guild.id}/voice-states/${m.id}`, owner.token, { mute: false });
    // taking USE_SOUNDBOARD away from @everyone blocks it
    const everyone = (await api.req('GET', `/guilds/${guild.id}/roles`, owner.token)).body.find((r: any) => r.name === '@everyone');
    await api.req('PATCH', `/guilds/${guild.id}/roles/${everyone.id}`, owner.token, { permissions: String(BigInt(everyone.permissions) & ~Perm.USE_SOUNDBOARD) });
    expect((await play(m)).status).toBe(403);
    expect((await play(owner)).status).toBe(204);
    wo.close(); wm.close(); wout.close();
  });
});
