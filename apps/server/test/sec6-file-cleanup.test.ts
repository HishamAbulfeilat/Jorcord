import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepUnattachedUploads } from '../src/services/files';
import { Api, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function upload(c: Client, name = 'a.png') {
  const b = 'XBOUNDARYX';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from(`\r\n--${b}--\r\n`)]);
  const r = await api.req('POST', '/uploads', c.token, payload as any, { 'content-type': `multipart/form-data; boundary=${b}` });
  expect(r.status).toBe(201);
  return { ...r.body, key: /files\/([a-f0-9]{48})\//.exec(r.body.url)![1]! };
}
const stored = async (key: string) => { try { return (await env.ctx.storage.head(key, 10)).length > 0; } catch { return false; } };
const rowExists = async (id: string) => (await env.ctx.db.query('SELECT 1 FROM files WHERE id = $1', [id])).length > 0;

async function setup() {
  const owner = await api.register('o');
  const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Files', template: 'community' })).body;
  const general = guild.channels.find((c: any) => c.type === 'text' && c.name === 'general');
  return { owner, guild, general };
}

describe('attachment file cleanup', () => {
  it('deleting a message deletes its files and stored objects', async () => {
    const { owner, general } = await setup();
    const f = await upload(owner);
    const m = (await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'pic', attachments: [f.id] })).body;
    expect(await rowExists(f.id)).toBe(true); expect(await stored(f.key)).toBe(true);
    expect((await api.req('DELETE', `/channels/${general.id}/messages/${m.id}`, owner.token)).status).toBe(204);
    expect(await rowExists(f.id)).toBe(false); expect(await stored(f.key)).toBe(false);
  });
  it('deleting a guild deletes the files of its messages', async () => {
    const { owner, guild, general } = await setup();
    const f = await upload(owner);
    await api.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'pic', attachments: [f.id] });
    expect((await api.req('DELETE', `/guilds/${guild.id}`, owner.token)).status).toBe(204);
    expect(await rowExists(f.id)).toBe(false); expect(await stored(f.key)).toBe(false);
  });
  it('sweeps unattached uploads older than 24h but keeps ones still used as images', async () => {
    const { owner } = await setup();
    const orphan = await upload(owner), avatar = await upload(owner), fresh = await upload(owner);
    expect((await api.req('PATCH', '/users/@me', owner.token, { avatar: avatar.url })).status).toBe(200);
    await env.ctx.db.query("UPDATE files SET created_at = now() - interval '25 hours' WHERE id = ANY($1::text[])", [[orphan.id, avatar.id]]);
    expect(await sweepUnattachedUploads(env.ctx, true)).toBeGreaterThanOrEqual(1);
    expect(await rowExists(orphan.id)).toBe(false); expect(await stored(orphan.key)).toBe(false);
    expect(await rowExists(avatar.id)).toBe(true); expect(await stored(avatar.key)).toBe(true);
    expect(await rowExists(fresh.id)).toBe(true);
  });
});
