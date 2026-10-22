import { inflateRawSync } from 'node:zlib';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZipFileWriter } from '../src/lib/zip';
import { Api, eraseNow, startServer, type Client, type TestEnv } from './helpers';
import { SoftAuthenticator } from './softauthn';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });
const PW = 'correct horse battery';

/** Reads a zip through its central directory (independent of the writer's code path). */
function unzip(buf: Buffer): Record<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out: Record<string, Buffer> = {};
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28), start = off + 30 + lnl + lel;
    const data = inflateRawSync(buf.subarray(start, start + csize)); expect(data.length).toBe(usize);
    out[name] = data; p += 46 + nl + el + cl;
  }
  return out;
}
const until = async <T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('until: timeout'); await new Promise((r) => setTimeout(r, 40)); }
};
const download = (url: string) => env.app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search });

async function readyExport(u: Client) {
  const start = await api.req('POST', '/users/@me/exports', u.token);
  expect(start.status).toBe(202);
  return until(async () => { const j = (await api.req('GET', `/users/@me/exports/${start.body.id}`, u.token)).body; if (j.status === 'failed') throw new Error(j.error); return j.status === 'ready' ? j : false; });
}

describe('zip writer', () => {
  it('produces an archive a strict reader can parse, with unicode names and content intact', async () => {
    const p = join(env.dir, 'z.zip'); const w = await ZipFileWriter.create(p);
    await w.add('a/b.json', '{"x":"héllo ✓"}'); await w.add('empty.txt', ''); await w.add('big.bin', Buffer.alloc(200_000, 7));
    await expect(w.add('../evil', 'x')).rejects.toThrow(); await expect(w.add('a/b.json', 'dup')).rejects.toThrow();
    await w.finish();
    const { readFileSync } = await import('node:fs');
    const files = unzip(readFileSync(p));
    expect(files['a/b.json']!.toString()).toBe('{"x":"héllo ✓"}'); expect(files['empty.txt']!.length).toBe(0); expect(files['big.bin']!.length).toBe(200_000);
  });
});

describe('async data export', () => {
  it('builds a zip with everything the user owns and none of the secrets', async () => {
    const owner = await api.register('xo'); const u = await api.register('xu');
    const g = (await api.req('POST', '/guilds', owner.token, { name: 'Export Guild' })).body;
    const code = (await api.req('POST', `/guilds/${g.id}/invites`, owner.token, {})).body.code;
    await api.req('POST', `/invites/${code}`, u.token);
    const ch = g.channels.find((c: any) => c.name === 'general');
    for (let i = 0; i < 3; i++) await api.req('POST', `/channels/${ch.id}/messages`, u.token, { content: `mine ${i}` });
    await api.req('POST', `/channels/${ch.id}/messages`, owner.token, { content: 'not yours' });
    await api.req('POST', '/users/@me/relationships', u.token, { userId: owner.id }).catch(() => {});
    const s = (await api.req('POST', '/auth/mfa/setup', u.token)).body; // an unverified TOTP secret must not leak either
    const authn = new SoftAuthenticator(); const o = await api.req('POST', '/auth/passkeys/register/options', u.token, { password: PW });
    await api.req('POST', '/auth/passkeys/register/verify', u.token, { name: 'Export key', response: authn.register(o.body) });

    const job = await readyExport(u);
    expect(job.sizeBytes).toBeGreaterThan(100);
    expect(job.counts).toMatchObject({ messages: 3, guilds: 1, passkeys: 1 });
    const res = await download(job.downloadUrl);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip'); expect(res.headers['content-disposition']).toContain('attachment'); expect(res.headers['cache-control']).toBe('no-store');
    const files = unzip(res.rawPayload);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['manifest.json', 'README.txt', 'account/profile.json', 'account/relationships.json', 'guilds/memberships.json', 'messages/messages-0001.json', 'attachments/uploads.json', 'security/sessions.json', 'security/passkeys.json']));
    const msgs = JSON.parse(files['messages/messages-0001.json']!.toString());
    expect(msgs.map((m: any) => m.content)).toEqual(['mine 2', 'mine 1', 'mine 0']);
    expect(msgs[0].createdAt).toMatch(/^20\d\d-/);
    expect(JSON.parse(files['account/profile.json']!.toString())).toMatchObject({ id: u.id, email: u.user.email });
    expect(JSON.parse(files['guilds/memberships.json']!.toString())[0]).toMatchObject({ name: 'Export Guild', owner: false });
    expect(JSON.parse(files['security/passkeys.json']!.toString())).toEqual([expect.objectContaining({ name: 'Export key' })]);
    const sessions = JSON.parse(files['security/sessions.json']!.toString()); expect(sessions.length).toBeGreaterThan(0); expect(Object.keys(sessions[0])).not.toContain('refreshHash');
    // secrets and other people's content
    const all = Object.values(files).map((b) => b.toString()).join('\n');
    expect(all).not.toContain(s.secret); expect(all).not.toMatch(/argon2|password_hash|refresh_hash|mfa_secret/i); expect(all).not.toContain('not yours');
    expect(all).not.toContain(authn.credentialId.toString('base64url')); // passkey credential id / key stay server-side
    // emailed with a working link
    const mail = await until(async () => env.ctx.mailer.outbox.find((m) => m.to === u.user.email && m.subject.includes('export')));
    const link = /https?:\/\/\S+\/exports\/\S+/.exec(mail.text)![0];
    expect((await download(link)).statusCode).toBe(200);
  });

  it('pages through a large message history', async () => {
    const u = await api.register('xbig');
    const g = (await api.req('POST', '/guilds', u.token, { name: 'Big' })).body; const ch = g.channels.find((c: any) => c.name === 'general');
    await env.ctx.db.query(`INSERT INTO messages (id, channel_id, guild_id, author_id, content) SELECT (9000000000000000000 + n)::text, $1, $2, $3, 'bulk ' || n FROM generate_series(1, 5600) n`, [ch.id, g.id, u.id]);
    const job = await readyExport(u);
    expect(job.counts.messages).toBe(5600); expect(job.counts.messageFiles).toBe(2);
    const files = unzip((await download(job.downloadUrl)).rawPayload);
    expect(JSON.parse(files['messages/messages-0001.json']!.toString())).toHaveLength(5000);
    expect(JSON.parse(files['messages/messages-0002.json']!.toString())).toHaveLength(600);
  });

  it('allows one export per day, and deleting the archive does not reset that', async () => {
    const u = await api.register('xrl');
    const job = await readyExport(u);
    const again = await api.req('POST', '/users/@me/exports', u.token);
    expect(again.status).toBe(429); expect(again.body.code).toBe('EXPORT_RATE_LIMITED'); expect(Number(again.raw.headers['retry-after'])).toBeGreaterThan(80_000);
    expect((await api.req('DELETE', `/users/@me/exports/${job.id}`, u.token)).status).toBe(204);
    expect((await download(job.downloadUrl)).statusCode).toBe(410);
    expect((await api.req('POST', '/users/@me/exports', u.token)).status).toBe(429);
    await env.ctx.db.query(`UPDATE export_jobs SET created_at = now() - interval '25 hours' WHERE user_id = $1`, [u.id]);
    expect((await api.req('POST', '/users/@me/exports', u.token)).status).toBe(202);
  });

  it('a failed export does not burn the daily allowance', async () => {
    const u = await api.register('xfail');
    const start = await api.req('POST', '/users/@me/exports', u.token);
    await until(async () => (await env.ctx.db.query('SELECT 1 FROM export_jobs WHERE id = $1 AND status <> $2', [start.body.id, 'queued']))[0]);
    await until(async () => (await env.ctx.db.query('SELECT 1 FROM export_jobs WHERE id = $1 AND status = $2', [start.body.id, 'ready']))[0]);
    await env.ctx.db.query(`UPDATE export_jobs SET status = 'failed' WHERE id = $1`, [start.body.id]);
    expect((await api.req('POST', '/users/@me/exports', u.token)).status).toBe(202);
  });

  it('download links need a valid, unexpired signature and are bound to one job', async () => {
    const a = await api.register('xla'); const b = await api.register('xlb');
    const ja = await readyExport(a); const jb = await readyExport(b);
    const u = new URL(ja.downloadUrl);
    expect((await download(ja.downloadUrl)).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: `/api/v1/exports/${ja.id}/download` })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'GET', url: `/api/v1/exports/${ja.id}/download?exp=${u.searchParams.get('exp')}&sig=${'A'.repeat(43)}` })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: `/api/v1/exports/${ja.id}/download?exp=${Number(u.searchParams.get('exp')) + 100000}&sig=${u.searchParams.get('sig')}` })).statusCode).toBe(403); // extended expiry
    expect((await env.app.inject({ method: 'GET', url: `/api/v1/exports/${jb.id}/download?exp=${u.searchParams.get('exp')}&sig=${u.searchParams.get('sig')}` })).statusCode).toBe(403); // another job
    // owner-only status
    expect((await api.req('GET', `/users/@me/exports/${ja.id}`, b.token)).status).toBe(404);
    expect((await api.req('DELETE', `/users/@me/exports/${ja.id}`, b.token)).status).toBe(404);
    expect((await api.req('GET', `/users/@me/exports/${ja.id}`, null)).status).toBe(401);
    // an expired job's file is removed and the link dies with it
    await env.ctx.db.query(`UPDATE export_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ja.id]);
    expect((await download(ja.downloadUrl)).statusCode).toBe(410);
    expect((await api.req('GET', `/users/@me/exports/${ja.id}`, a.token)).body.status).toBe('expired');
    const [row] = await env.ctx.db.query('SELECT storage_key FROM export_jobs WHERE id = $1', [ja.id]); expect(row.storage_key).toBeNull();
  });

  it('account deletion removes personal data, export archives and owned bots', async () => {
    const u = await api.register('xdel');
    await readyExport(u);
    const [job] = await env.ctx.db.query('SELECT storage_key FROM export_jobs WHERE user_id = $1', [u.id]);
    expect(await env.ctx.storage.size(job.storage_key)).toBeGreaterThan(0);
    const app = await api.req('POST', '/applications', u.token, { name: 'Gone Bot' });
    await api.req('PUT', `/users/@me/notes/${(await api.register('xnote')).id}`, u.token, { note: 'secret note' }).catch(() => {});
    await env.ctx.db.query(`INSERT INTO gif_favorites (id, user_id, url) VALUES ('1', $1, 'https://x.test/a.gif')`, [u.id]).catch(() => {});
    expect((await api.req('DELETE', '/users/@me', u.token, { password: PW })).status).toBe(202);
    await eraseNow(env, u.id);
    expect(await env.ctx.storage.size(job.storage_key)).toBeNull();
    for (const t of ['export_jobs', 'user_notes', 'gif_favorites', 'push_devices', 'connections', 'reminders', 'saved_messages', 'sessions', 'user_passkeys'])
      expect((await env.ctx.db.query(`SELECT 1 FROM ${t} WHERE user_id = $1`, [u.id])).length, t).toBe(0);
    if (app.status === 201) expect((await env.ctx.db.query('SELECT 1 FROM applications WHERE id = $1', [app.body.id])).length).toBe(0);
    expect(existsSync(join(env.dir, 'tmp-export')) ? readdirSync(join(env.dir, 'tmp-export')) : []).toEqual([]); // temp files are cleaned up
  });

  it('deletion still demands password + TOTP', async () => {
    const u = await api.register('xdel2');
    const s = (await api.req('POST', '/auth/mfa/setup', u.token)).body;
    await api.req('POST', '/auth/mfa/enable', u.token, { code: authenticator.generate(s.secret) });
    expect((await api.req('DELETE', '/users/@me', u.token, { password: 'wrong password' })).status).toBe(401);
    expect((await api.req('DELETE', '/users/@me', u.token, { password: PW })).body.code).toBe('MFA_REQUIRED');
  });
});
