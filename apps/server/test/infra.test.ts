import { describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { Perm } from '@jorcord/shared';
import { Api, WsClient, createTestDatabase, startServer } from './helpers';
import { S3Storage } from '../src/storage-s3';
import { MemoryPresenceStore, MemoryVoiceStore, RedisPresenceStore, RedisVoiceStore } from '../src/state';
import { emptyState } from '../src/services/voice';
import { buildSearchSql } from '../src/services/search';

const PG = process.env.TEST_PG_URL, REDIS = process.env.TEST_REDIS_URL;

describe('S3Storage (against a fake S3 client)', () => {
  // Minimal in-memory S3: just enough of Put/Get/Head/Delete + ranged reads.
  class Cmd { constructor(public input: any) {} }
  class GetObjectCommand extends Cmd {} class HeadObjectCommand extends Cmd {} class DeleteObjectCommand extends Cmd {}
  const objects = new Map<string, Buffer>();
  const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  const client = {
    async send(c: Cmd) {
      const { Key, Range } = c.input; const buf = objects.get(Key);
      if (c instanceof DeleteObjectCommand) { objects.delete(Key); return {}; }
      if (!buf) throw notFound();
      if (c instanceof HeadObjectCommand) return { ContentLength: buf.length };
      let out = buf;
      if (Range) { const m = /bytes=(\d+)-(\d+)/.exec(Range)!; out = buf.subarray(Number(m[1]), Number(m[2]) + 1); }
      return { Body: Readable.from([out]) };
    },
  };
  const upload = (_c: any, { params }: any) => {
    const done = async () => { const chunks: Buffer[] = []; for await (const ch of params.Body as Readable) chunks.push(ch as Buffer); objects.set(params.Key, Buffer.concat(chunks)); };
    return { done, abort: async () => {} };
  };
  const s3 = new S3Storage(client, { bucket: 'b', prefix: 'jorcord/' }, { GetObjectCommand, HeadObjectCommand, DeleteObjectCommand }, upload as any);
  const key = 'ab' + 'cd'.repeat(23);
  const read = async (s: Readable) => { const c: Buffer[] = []; for await (const x of s) c.push(x as Buffer); return Buffer.concat(c); };

  it('round-trips put/get/range/size/head/delete under a prefixed, sharded key', async () => {
    expect(await s3.put(key, Readable.from([Buffer.from('hello '), Buffer.from('world')]), 100)).toBe(11);
    expect([...objects.keys()]).toEqual([`jorcord/ab/${key}`]);
    expect(await s3.size(key)).toBe(11);
    expect((await read(s3.get(key))).toString()).toBe('hello world');
    expect((await read(s3.get(key, { start: 6, end: 10 }))).toString()).toBe('world');
    expect((await s3.head(key, 5)).toString()).toBe('hello');
    await s3.delete(key);
    expect(await s3.size(key)).toBeNull();
  });
  it('enforces the size cap and rejects unsafe keys', async () => {
    const k2 = 'ef' + '01'.repeat(23);
    await expect(s3.put(k2, Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), 100)).rejects.toThrow('FILE_TOO_LARGE');
    expect(await s3.size(k2)).toBeNull();
    await expect(s3.put('../etc/passwd', new PassThrough(), 10)).rejects.toThrow('invalid storage key');
    await expect(s3.size('../x')).rejects.toThrow('invalid storage key');
  });
  it('surfaces missing objects as stream errors', async () => {
    await expect(read(s3.get('aa' + 'bb'.repeat(23)))).rejects.toThrow();
  });
});

describe('createS3Storage (real AWS SDK against a tiny in-process S3 HTTP server)', () => {
  it('uploads, ranges, heads and deletes through path-style requests', async () => {
    const { createServer } = await import('node:http');
    const objects = new Map<string, Buffer>(); const seen: string[] = [];
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c)).on('end', () => {
        const key = decodeURIComponent((req.url ?? '').split('?')[0]!); seen.push(`${req.method} ${key}`);
        if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { etag: '"x"' }).end(); return; }
        if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
        const buf = objects.get(key);
        if (!buf) { res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
        const m = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ''));
        const body = m ? buf.subarray(Number(m[1]), Number(m[2]) + 1) : buf;
        res.writeHead(m ? 206 : 200, { 'content-length': body.length, 'accept-ranges': 'bytes' }).end(req.method === 'HEAD' ? undefined : body);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { createS3Storage } = await import('../src/storage-s3');
    const s3 = await createS3Storage({ bucket: 'jc', region: 'us-east-1', endpoint: `http://127.0.0.1:${(srv.address() as any).port}`, accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true, prefix: 'files/' });
    const key = 'ab' + 'cd'.repeat(23);
    expect(await s3.put(key, Readable.from([Buffer.from('0123456789'), Buffer.from('abcdef')]), 1000)).toBe(16);
    expect(seen).toContain(`PUT /jc/files/ab/${key}`);
    expect(await s3.size(key)).toBe(16);
    const read = async (st: Readable) => { const c: Buffer[] = []; for await (const x of st) c.push(x as Buffer); return Buffer.concat(c).toString(); };
    expect(await read(s3.get(key))).toBe('0123456789abcdef');
    expect(await read(s3.get(key, { start: 10, end: 12 }))).toBe('abc');
    expect((await s3.head(key, 4)).toString()).toBe('0123');
    await s3.delete(key);
    expect(await s3.size(key)).toBeNull();
    await expect(s3.put('cd' + 'ef'.repeat(23), Readable.from([Buffer.alloc(2000)]), 1000)).rejects.toThrow();
    await new Promise((r) => srv.close(r));
  });
});

describe('state stores', () => {
  const vs = (u: string, c: string | null) => ({ ...emptyState(u), channelId: c, guildId: 'g' });
  const contract = (name: string, make: () => Promise<{ voice: any; presence: any; done(): Promise<void> }>) => {
    it(`${name}: voice store`, async () => {
      const { voice, done } = await make();
      const a = `ua${Math.random()}`.replace('.', ''), b = `ub${Math.random()}`.replace('.', '');
      const ch = `ch${Math.random()}`.replace('.', ''), ch2 = `ch${Math.random()}`.replace('.', '');
      await voice.set(vs(a, ch)); await voice.set(vs(b, ch));
      expect((await voice.inChannel(ch)).map((s: any) => s.userId).sort()).toEqual([a, b].sort());
      expect((await voice.get(a)).channelId).toBe(ch);
      await voice.set(vs(a, ch2)); // moved
      expect((await voice.inChannel(ch)).map((s: any) => s.userId)).toEqual([b]);
      expect((await voice.all()).map((s: any) => s.userId)).toEqual(expect.arrayContaining([a, b]));
      await voice.delete(a); await voice.delete(b);
      expect(await voice.get(a)).toBeNull(); expect(await voice.inChannel(ch)).toEqual([]); expect(await voice.inChannel(ch2)).toEqual([]);
      await done();
    });
    it(`${name}: presence counts sessions per user`, async () => {
      const { presence, done } = await make();
      const u = `pu${Math.random()}`.replace('.', '');
      expect(await presence.add(u, 's1')).toBe(1);
      expect(await presence.add(u, 's2')).toBe(2);
      expect((await presence.onlineUsers()).has(u)).toBe(true);
      expect(await presence.remove(u, 's1')).toBe(1);
      expect((await presence.onlineUsers()).has(u)).toBe(true);
      expect(await presence.remove(u, 's2')).toBe(0);
      expect((await presence.onlineUsers()).has(u)).toBe(false);
      await done();
    });
  };
  contract('memory', async () => ({ voice: new MemoryVoiceStore(), presence: new MemoryPresenceStore(), done: async () => {} }));
  describe.skipIf(!REDIS)('redis', () => {
    contract('redis', async () => {
      const { default: Redis } = await import('ioredis'); const r = new Redis(REDIS!);
      return { voice: new RedisVoiceStore(r), presence: new RedisPresenceStore(r, 400), done: async () => { r.disconnect(); } };
    });
    it('redis presence leases expire when a node dies without cleanup', async () => {
      const { default: Redis } = await import('ioredis'); const r = new Redis(REDIS!);
      const p = new RedisPresenceStore(r, 150); const u = `lease${Date.now()}`;
      await p.add(u, 'dead-node-session');
      expect((await p.onlineUsers()).has(u)).toBe(true);
      await new Promise((res) => setTimeout(res, 250));
      expect((await p.onlineUsers()).has(u)).toBe(false);
      expect(await p.add(u, 'fresh')).toBe(1); // stale lease was purged, not counted
      await p.remove(u, 'fresh'); r.disconnect();
    });
  });
});

describe.skipIf(!PG)('real Postgres', () => {
  it('uses pg, the GIN full-text index, and the planner can use it', async () => {
    const env = await startServer(); const api = new Api(env);
    expect(env.ctx.db.kind).toBe('pg'); expect(env.ctx.search).toBe('fts');
    const idx = await env.ctx.db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_content_fts_idx'`);
    expect(idx[0]?.indexdef).toMatch(/USING gin/i);
    const u = await api.register('pgs'); const g = (await api.req('POST', '/guilds', u.token, { name: 'Pg' })).body;
    const ch = g.channels.find((c: any) => c.name === 'general');
    for (const w of ['alpha beta', 'gamma delta', 'epsilon zeta']) await api.req('POST', `/channels/${ch.id}/messages`, u.token, { content: w });
    expect((await api.req('GET', `/guilds/${g.id}/messages/search?q=gam`, u.token)).body.map((m: any) => m.content)).toEqual(['gamma delta']);
    await env.ctx.db.query(`INSERT INTO messages (id, channel_id, guild_id, author_id, content)
      SELECT (9000000000000 + g)::text, $1, $2, $3, 'filler lorem ipsum ' || g || ' dolor ' || (g % 97) FROM generate_series(1, 20000) g`, [ch.id, g.id, u.id]);
    await env.ctx.db.query('ANALYZE messages');
    const { sql, params } = buildSearchSql('fts', { channelIds: [ch.id], q: 'gam', limit: 5 });
    const pg = await import('pg'); const c = new pg.default.Client({ connectionString: (env.ctx.config.databaseUrl as string) }); await c.connect();
    // the planner may legitimately prefer walking messages(channel_id, id) for a tiny channel; prove the GIN index is *usable* for the predicate
    await c.query('SET enable_seqscan = off'); await c.query('SET enable_indexscan = off');
    const plan = (await c.query(`EXPLAIN ${sql}`, params as any[])).rows.map((r) => r['QUERY PLAN']).join('\n');
    await c.end();
    expect(plan).toMatch(/messages_content_fts_idx/);
    await env.close();
  });
});

describe.skipIf(!PG || !REDIS)('two nodes sharing Postgres + Redis', () => {
  it('fan out events, share presence and voice state', async () => {
    const db = (await createTestDatabase())!;
    const redisPrefix = `jcm${Date.now()}`; // both nodes join the same cluster namespace
    const n1 = await startServer({ databaseUrl: db.url, redisPrefix }); const n2 = await startServer({ databaseUrl: db.url, redisPrefix });
    const a1 = new Api(n1), a2 = new Api(n2);
    const owner = await a1.register('mn'); const bob = await a2.register('mn2'); // same database, either node
    const guild = (await a1.req('POST', '/guilds', owner.token, { name: 'Cluster' })).body;
    const code = (await a2.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
    await a2.req('POST', `/invites/${code}`, bob.token);
    const general = guild.channels.find((c: any) => c.name === 'general'); const voice = guild.channels.find((c: any) => c.type === 'voice');

    const w1 = await WsClient.connect(n1.port); await w1.identify(owner.token);
    const w2 = await WsClient.connect(n2.port); const ready = await w2.identify(bob.token);
    // presence learned across nodes (owner is on node 1, bob reads READY on node 2)
    expect(ready.d.presences.some((p: any) => p.userId === owner.id && p.presence === 'online')).toBe(true);
    // a message posted through node 2 reaches a socket on node 1, and vice versa
    await a2.req('POST', `/channels/${general.id}/messages`, bob.token, { content: 'from node 2' });
    await w1.waitEvent('MESSAGE_CREATE', (d) => d.content === 'from node 2');
    await a1.req('POST', `/channels/${general.id}/messages`, owner.token, { content: 'from node 1' });
    await w2.waitEvent('MESSAGE_CREATE', (d) => d.content === 'from node 1');
    // voice state set on node 2 is visible from node 1 (REST) and broadcast to node 1's socket
    w2.send({ op: 4, d: { guildId: guild.id, channelId: voice.id } });
    await w1.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.channelId === voice.id);
    expect((await a1.req('GET', `/guilds/${guild.id}/voice-states`, owner.token)).body.map((s: any) => s.userId)).toEqual([bob.id]);
    // moderation on node 1 disconnects a user whose socket lives on node 2
    expect((await a1.req('PATCH', `/guilds/${guild.id}/voice-states/${bob.id}`, owner.token, { mute: true })).body.voiceState.serverMute).toBe(true);
    await w2.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.serverMute === true);
    expect((await a1.req('DELETE', `/guilds/${guild.id}/voice-states/${bob.id}`, owner.token)).status).toBe(204);
    await w2.waitEvent('VOICE_STATE_UPDATE', (d) => d.userId === bob.id && d.channelId === null);
    expect((await a2.req('GET', `/guilds/${guild.id}/voice-states`, owner.token)).body).toEqual([]);

    // presence with two sockets on two nodes: dropping one does not make the user offline; dropping both does
    const w1b = await WsClient.connect(n1.port); await w1b.identify(bob.token);
    w2.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(w1.frames.some((f) => f.t === 'PRESENCE_UPDATE' && f.d.userId === bob.id && f.d.presence === 'offline')).toBe(false);
    w1b.close();
    await w1.waitEvent('PRESENCE_UPDATE', (d) => d.userId === bob.id && d.presence === 'offline');
    w1.close(); await n1.close(); await n2.close(); await db.drop();
  });
});
void Perm;
