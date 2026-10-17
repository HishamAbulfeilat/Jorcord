/**
 * Gateway fan-out load test.
 *
 *   pnpm --filter @jorcord/server loadtest                      # N=2000 sockets, embedded PGlite, in-memory bus
 *   DATABASE_URL=postgres://... REDIS_URL=redis://... N=2000 pnpm --filter @jorcord/server loadtest
 *   NO_CACHE=1 pnpm ... loadtest                                  # baseline: permission cache disabled (every event re-reads rows)
 *
 * Boots the real server in-process, seeds N users into one guild straight into the database, opens N gateway sockets and measures
 *   A) REST message -> MESSAGE_CREATE delivered to every socket   (latency p50/p95/p99/worst, total DB queries per message)
 *   B) pure fan-out of one hub event (no REST handler)             (latency, DB queries per event)
 *   C) gateway TYPING from one socket to the other N-1             (latency, DB queries per event)
 * Env: N (2000), MSGS (20), TYPING (20), CONNECT_BATCH (100), DATABASE_URL, REDIS_URL, NO_CACHE.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Op, snowflake } from '@jorcord/shared';
import { buildApp } from '../src/app';
import { signAccess } from '../src/lib/crypto';
import { createGuild } from '../src/services/guilds';

const N = Number(process.env.N ?? 2000), MSGS = Number(process.env.MSGS ?? 20), TYPING = Number(process.env.TYPING ?? 20), BATCH = Number(process.env.CONNECT_BATCH ?? 100);
const noCache = process.env.NO_CACHE === '1';
const now = () => Number(process.hrtime.bigint()) / 1e6;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN; };
const fmt = (x: number) => x.toFixed(1);

const dir = mkdtempSync(join(tmpdir(), 'jorcord-load-'));
const { app, ctx } = await buildApp({
  memoryDb: true,
  config: {
    logLevel: 'silent', rateLimit: false, dataDir: dir, jwtSecret: 'loadtest-secret-loadtest-secret-1', unfurlOnSend: false, heartbeatIntervalMs: 3_600_000, livekitControl: false,
    ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
    ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL, redisPrefix: `lt${Date.now()}` } : {}),
  } as any,
});
ctx.pcache.enabled = !noCache;
await app.listen({ port: 0, host: '127.0.0.1' });
const port = (app.server.address() as { port: number }).port;

// ---- query counter ----
let queries = 0;
const origQuery = ctx.db.query.bind(ctx.db);
ctx.db.query = ((sql: string, p?: unknown[]) => { queries++; return origQuery(sql, p); }) as typeof ctx.db.query;

// ---- seed ----
console.log(`seeding ${N} users (${ctx.db.kind}, bus=${ctx.config.redisUrl ? 'redis' : 'memory'}, permission cache ${noCache ? 'DISABLED' : 'enabled'})`);
const ids = Array.from({ length: N }, () => snowflake());
const sids = Array.from({ length: N }, () => snowflake());
const tag = Date.now().toString(36);
await ctx.db.query(`INSERT INTO users (id, username, display_name, verified) SELECT id, 'lt' || $2 || i::text, 'LT ' || i::text, true FROM unnest($1::text[]) WITH ORDINALITY AS t(id, i)`, [ids, tag]);
await ctx.db.query(`INSERT INTO sessions (id, user_id, refresh_hash, expires_at) SELECT s, u, 'x', now() + interval '1 day' FROM unnest($1::text[], $2::text[]) AS t(s, u)`, [sids, ids]);
const guildId = await createGuild(ctx, ids[0]!, { name: 'Load' });
await ctx.db.query(`INSERT INTO members (guild_id, user_id) SELECT $1, u FROM unnest($2::text[]) AS t(u) WHERE u <> $3`, [guildId, ids, ids[0]!]);
const [general] = await ctx.db.query(`SELECT id FROM channels WHERE guild_id = $1 AND name = 'general'`, [guildId]);
const channelId: string = general.id;
const tokens = await Promise.all(ids.map((id, i) => signAccess(ctx.config.jwtSecret, id, sids[i]!, 3600)));
ctx.pcache.clear(); // seeded behind the cache's back

// ---- connect ----
interface Cli { ws: WebSocket; id: string }
const clients: Cli[] = [];
let waiter: { match: (s: string) => boolean; seen: number; need: number; times: number[]; done: () => void } | null = null;
const connect = (i: number) => new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
  ws.on('message', (data: Buffer) => {
    const head = data.subarray(0, 48).toString(); // avoid parsing the large READY payloads
    if (head.startsWith('{"op":10')) { ws.send(JSON.stringify({ op: Op.IDENTIFY, d: { token: tokens[i] } })); return; }
    if (head.startsWith('{"op":0,"t":"READY"')) { resolve(); return; }
    if (waiter && head.startsWith('{"op":0,"t":"') && waiter.match(data.toString())) { waiter.times.push(now()); if (++waiter.seen >= waiter.need) waiter.done(); }
  });
  ws.on('error', reject);
  clients[i] = { ws, id: ids[i]! };
});
const tConnect = now();
for (let i = 0; i < N; i += BATCH) await Promise.all(Array.from({ length: Math.min(BATCH, N - i) }, (_, k) => connect(i + k)));
console.log(`connected ${clients.length} sockets in ${fmt(now() - tConnect)} ms`);
await new Promise((r) => setTimeout(r, 500));

// ---- measurement ----
interface Run { lat: number[]; max: number; q: number; ack: number }
async function measure(name: string, need: number, match: (s: string) => boolean, trigger: () => Promise<unknown>): Promise<Run> {
  const times: number[] = [];
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((res, rej) => {
    waiter = { match, seen: 0, need, times, done: res };
    timer = setTimeout(() => rej(new Error(`${name}: only ${times.length}/${need} deliveries`)), 60_000);
  });
  const q0 = queries, t0 = now();
  const ackP = trigger().then(() => now() - t0);
  await done; clearTimeout(timer);
  const ack = await ackP;
  await new Promise((r) => setTimeout(r, 25)); // trailing queries (audit, push bookkeeping) still count toward the event
  const lat = times.map((t) => t - t0); waiter = null;
  return { lat, max: Math.max(...lat), q: queries - q0, ack };
}
const poster = { id: ids[0]!, token: tokens[0]! };
const postMessage = (content: string) => app.inject({ method: 'POST', url: `/api/v1/channels/${channelId}/messages`, headers: { authorization: `Bearer ${poster.token}` }, payload: { content } });
const synthetic = (ts: number) => ctx.hub.toChannel(channelId, 'TYPING_START', { channelId, userId: poster.id, timestamp: ts });
const TS = 1_900_000_000_000;

// cold: first event after an empty cache
ctx.pcache.clear();
const cold = await measure('cold fan-out', N, (s) => s.includes(`"timestamp":${TS - 1}`), () => synthetic(TS - 1));
for (let k = 0; k < 3; k++) await postMessage(`warm ${k}`); // warm the REST path too

const A: Run[] = [], B: Run[] = [], C: Run[] = [];
for (let k = 0; k < MSGS; k++) A.push(await measure('rest', N, (s) => s.includes(`"content":"lt-${tag}-${k}"`), () => postMessage(`lt-${tag}-${k}`)));
for (let k = 0; k < MSGS; k++) B.push(await measure('fanout', N, (s) => s.includes(`"timestamp":${TS + k}`), () => synthetic(TS + k)));
const typist = clients[1]!;
for (let k = 0; k < TYPING; k++) {
  const t0 = Date.now();
  C.push(await measure('typing', N - 1, (s) => s.includes('"t":"TYPING_START"') && s.includes(`"userId":"${typist.id}"`) && Number(/"timestamp":(\d+)/.exec(s)?.[1]) >= t0,
    async () => typist.ws.send(JSON.stringify({ op: Op.TYPING, d: { channelId } }))));
}

const agg = (runs: Run[]) => { const all = runs.flatMap((r) => r.lat); return { p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), worst: Math.max(...runs.map((r) => r.max)), q: runs.reduce((a, r) => a + r.q, 0) / runs.length }; };
const row = (name: string, r: ReturnType<typeof agg>, extra = '') =>
  console.log(`${name.padEnd(34)} p50 ${fmt(r.p50).padStart(8)}  p95 ${fmt(r.p95).padStart(8)}  p99 ${fmt(r.p99).padStart(8)}  worst ${fmt(r.worst).padStart(8)} ms  ${r.q.toFixed(2).padStart(7)} queries/event ${extra}`);
console.log(`\n=== N=${N} sockets; ${MSGS} messages, ${MSGS} fan-out events, ${TYPING} typing events; ${ctx.db.kind}; bus=${ctx.config.redisUrl ? 'redis' : 'memory'}; cache ${noCache ? 'OFF' : 'ON'} ===`);
console.log(`cold first fan-out event (empty cache): ${fmt(cold.max)} ms until all ${N} sockets had it, ${cold.q} queries`);
row('A) REST message -> all sockets', agg(A), `(REST ack p50 ${fmt(pct(A.map((r) => r.ack), 50))} ms; queries include the handler's own)`);
row('B) hub event fan-out only', agg(B));
row('C) gateway TYPING -> N-1 sockets', agg(C));
console.log(`permission cache: ${JSON.stringify(ctx.pcache.stats)}  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);

for (const cl of clients) cl.ws.close();
await app.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
