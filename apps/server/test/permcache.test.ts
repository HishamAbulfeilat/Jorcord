import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { Op, Perm, DEFAULT_EVERYONE } from '@jorcord/shared';
import { Api, WsClient, createTestDatabase, startServer, type TestEnv } from './helpers';

const PG = process.env.TEST_PG_URL, REDIS = process.env.TEST_REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

/** Counts queries issued through ctx.db while `fn` runs. */
async function countQueries<T>(env: TestEnv, fn: () => Promise<T>): Promise<{ result: T; queries: string[] }> {
  const queries: string[] = []; const orig = env.ctx.db.query.bind(env.ctx.db);
  env.ctx.db.query = (async (sql: string, p?: unknown[]) => { queries.push(sql); return orig(sql, p); }) as any;
  try { return { result: await fn(), queries }; } finally { env.ctx.db.query = orig as any; }
}

/** A guild with an owner (socket on `ownerEnv`) and a plain member `pleb` (socket on `plebEnv`); the two envs may be different nodes. */
async function world(ownerEnv: TestEnv, plebEnv: TestEnv = ownerEnv) {
  const oa = new Api(ownerEnv), pa = new Api(plebEnv);
  const owner = await oa.register('pco'), pleb = await oa.register('pcp');
  const guild = (await oa.req('POST', '/guilds', owner.token, { name: 'Cache' })).body;
  const invite = (await oa.req('POST', `/guilds/${guild.id}/invites`, owner.token, {})).body.code;
  await oa.req('POST', `/invites/${invite}`, pleb.token);
  const general = guild.channels.find((c: any) => c.name === 'general');
  const ow = await WsClient.connect(ownerEnv.port); await ow.identify(owner.token);
  const pw = await WsClient.connect(plebEnv.port); await pw.identify(pleb.token);
  const role = async (permissions: bigint) => (await oa.req('POST', `/guilds/${guild.id}/roles`, owner.token, { name: `r${++n}`, permissions: String(permissions) })).body;
  /** Owner posts a message; resolves true iff pleb's socket got it. */
  const plebSees = async (channelId = general.id) => {
    const content = `m${++n}`;
    await oa.req('POST', `/channels/${channelId}/messages`, owner.token, { content });
    await ow.waitEvent('MESSAGE_CREATE', (d) => d.content === content);
    if (await pw.waitEvent('MESSAGE_CREATE', (d) => d.content === content, 400).then(() => true, () => false)) return true;
    return false;
  };
  /** Pleb types over the gateway; resolves true iff the owner's socket got TYPING_START. */
  const typingReaches = async (channelId = general.id) => {
    const t0 = Date.now();
    pw.send({ op: Op.TYPING, d: { channelId } });
    await sleep(250);
    return ow.frames.some((f) => f.t === 'TYPING_START' && f.d.channelId === channelId && f.d.timestamp >= t0);
  };
  return { oa, pa, owner, pleb, guild, general, ow, pw, invite, role, plebSees, typingReaches };
}

describe('permission cache: no stale data after any mutation (single node)', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await startServer(); });
  afterAll(async () => { await env.close(); });

  it('typing needs zero DB queries on the hot path (gateway and REST), and fan-out needs none once warm', async () => {
    const w = await world(env);
    expect(await w.plebSees()).toBe(true); expect(await w.typingReaches()).toBe(true); // warm
    const gw = await countQueries(env, async () => { expect(await w.typingReaches()).toBe(true); });
    expect(gw.queries).toEqual([]);
    const rest = await countQueries(env, async () => {
      expect((await w.oa.req('POST', `/channels/${w.general.id}/typing`, w.pleb.token)).status).toBe(204);
      await w.ow.waitEvent('TYPING_START', (d) => d.userId === w.pleb.id);
    });
    expect(rest.queries.filter((q) => !/FROM sessions/.test(q))).toEqual([]); // only the auth session check remains
    // a hub event with no REST handler involved: pure fan-out cost
    const fan = await countQueries(env, async () => { await env.ctx.hub.toChannel(w.general.id, 'TYPING_START', { channelId: w.general.id, userId: w.owner.id, timestamp: 1 }); await w.pw.waitEvent('TYPING_START', (d) => d.timestamp === 1); });
    expect(fan.queries).toEqual([]);
  });

  it('@everyone permission edits apply immediately (view and send)', async () => {
    const w = await world(env);
    expect(await w.plebSees()).toBe(true); expect(await w.typingReaches()).toBe(true);
    const base = DEFAULT_EVERYONE;
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/roles/${w.guild.id}`, w.owner.token, { permissions: String(base & ~Perm.SEND_MESSAGES) });
    expect(await w.typingReaches()).toBe(false);
    expect(await w.plebSees()).toBe(true); // can still view
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/roles/${w.guild.id}`, w.owner.token, { permissions: String(base & ~Perm.VIEW_CHANNEL) });
    expect(await w.plebSees()).toBe(false);
    expect((await w.oa.req('GET', `/channels/${w.general.id}`, w.pleb.token)).status).toBe(404);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/roles/${w.guild.id}`, w.owner.token, { permissions: String(base) });
    expect(await w.plebSees()).toBe(true); expect(await w.typingReaches()).toBe(true);
  });

  it('channel overwrites (member and role) apply immediately, including deletion', async () => {
    const w = await world(env);
    expect(await w.plebSees()).toBe(true);
    await w.oa.req('PUT', `/channels/${w.general.id}/permissions/${w.pleb.id}`, w.owner.token, { type: 'member', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect(await w.plebSees()).toBe(false); expect(await w.typingReaches()).toBe(false);
    await w.oa.req('DELETE', `/channels/${w.general.id}/permissions/${w.pleb.id}`, w.owner.token);
    expect(await w.plebSees()).toBe(true); expect(await w.typingReaches()).toBe(true);
    await w.oa.req('PUT', `/channels/${w.general.id}/permissions/${w.guild.id}`, w.owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect(await w.plebSees()).toBe(false);
    await w.oa.req('PUT', `/channels/${w.general.id}/permissions/${w.guild.id}`, w.owner.token, { type: 'role', allow: '0', deny: '0' });
    expect(await w.plebSees()).toBe(true);
  });

  it('member role assignment/removal, role permission edits and role deletion apply immediately', async () => {
    const w = await world(env);
    const secret = (await w.oa.req('POST', `/guilds/${w.guild.id}/channels`, w.owner.token, { name: 'secret', type: 'text' })).body;
    await w.oa.req('PUT', `/channels/${secret.id}/permissions/${w.guild.id}`, w.owner.token, { type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    const vip = await w.role(0n);
    await w.oa.req('PUT', `/channels/${secret.id}/permissions/${vip.id}`, w.owner.token, { type: 'role', allow: String(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES), deny: '0' });
    expect(await w.plebSees(secret.id)).toBe(false);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/members/${w.pleb.id}`, w.owner.token, { roles: [vip.id] });
    expect(await w.plebSees(secret.id)).toBe(true); expect(await w.typingReaches(secret.id)).toBe(true);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/members/${w.pleb.id}`, w.owner.token, { roles: [] });
    expect(await w.plebSees(secret.id)).toBe(false); expect(await w.typingReaches(secret.id)).toBe(false);
    // role-level permission edit: grant VIEW via a role's own permissions (ADMINISTRATOR bypasses the deny)
    const adm = await w.role(0n);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/members/${w.pleb.id}`, w.owner.token, { roles: [adm.id] });
    expect(await w.plebSees(secret.id)).toBe(false);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/roles/${adm.id}`, w.owner.token, { permissions: String(Perm.ADMINISTRATOR) });
    expect(await w.plebSees(secret.id)).toBe(true);
    // deleting the role takes the access with it
    await w.oa.req('DELETE', `/guilds/${w.guild.id}/roles/${adm.id}`, w.owner.token);
    expect(await w.plebSees(secret.id)).toBe(false);
  });

  it('timeouts, kicks, bans, leaves and rejoins apply immediately', async () => {
    const w = await world(env);
    expect(await w.typingReaches()).toBe(true);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/members/${w.pleb.id}`, w.owner.token, { timeoutUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(await w.typingReaches()).toBe(false);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/members/${w.pleb.id}`, w.owner.token, { timeoutUntil: null });
    expect(await w.typingReaches()).toBe(true);

    expect((await w.oa.req('DELETE', `/guilds/${w.guild.id}/members/${w.pleb.id}`, w.owner.token)).status).toBe(204);
    expect(await w.plebSees()).toBe(false); expect(await w.typingReaches()).toBe(false);
    expect((await w.oa.req('POST', `/invites/${w.invite}`, w.pleb.token)).status).toBe(200);
    expect(await w.plebSees()).toBe(true); expect(await w.typingReaches()).toBe(true);

    expect((await w.oa.req('PUT', `/guilds/${w.guild.id}/bans/${w.pleb.id}`, w.owner.token, {})).status).toBe(204);
    expect(await w.plebSees()).toBe(false); expect(await w.typingReaches()).toBe(false);
    expect((await w.oa.req('POST', `/invites/${w.invite}`, w.pleb.token)).status).toBe(403);
    await w.oa.req('DELETE', `/guilds/${w.guild.id}/bans/${w.pleb.id}`, w.owner.token);
    await w.oa.req('POST', `/invites/${w.invite}`, w.pleb.token);
    expect(await w.plebSees()).toBe(true);

    expect((await w.oa.req('DELETE', `/users/@me/guilds/${w.guild.id}`, w.pleb.token)).status).toBe(204);
    expect(await w.plebSees()).toBe(false); expect(await w.typingReaches()).toBe(false);
  });

  it('channel deletion, channel moves and guild deletion apply immediately', async () => {
    const w = await world(env);
    const cat = (await w.oa.req('POST', `/guilds/${w.guild.id}/channels`, w.owner.token, { name: 'cat', type: 'category' })).body;
    const ch = (await w.oa.req('POST', `/guilds/${w.guild.id}/channels`, w.owner.token, { name: 'moved', type: 'text' })).body;
    expect(await w.typingReaches(ch.id)).toBe(true);
    const thread = (await w.oa.req('POST', `/channels/${ch.id}/threads`, w.owner.token, { name: 't' })).body;
    if (thread?.id) {
      await w.oa.req('PUT', `/channels/${ch.id}/permissions/${w.pleb.id}`, w.owner.token, { type: 'member', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
      expect(await w.typingReaches(thread.id)).toBe(false); // threads inherit the parent's overwrites
      await w.oa.req('DELETE', `/channels/${ch.id}/permissions/${w.pleb.id}`, w.owner.token);
      expect(await w.typingReaches(thread.id)).toBe(true);
    }
    expect((await w.oa.req('PATCH', `/channels/${ch.id}`, w.owner.token, { parentId: cat.id })).status).toBe(200);
    expect(await w.typingReaches(ch.id)).toBe(true);
    expect((await w.oa.req('DELETE', `/channels/${ch.id}`, w.owner.token)).status).toBe(204);
    expect((await w.oa.req('POST', `/channels/${ch.id}/typing`, w.pleb.token)).status).toBe(404);
    if (thread?.id) expect((await w.oa.req('POST', `/channels/${thread.id}/typing`, w.pleb.token)).status).toBe(404);
    expect((await w.oa.req('POST', `/channels/${w.general.id}/typing`, w.pleb.token)).status).toBe(204);
    expect((await w.oa.req('DELETE', `/guilds/${w.guild.id}`, w.owner.token)).status).toBe(204);
    expect((await w.oa.req('POST', `/channels/${w.general.id}/typing`, w.pleb.token)).status).toBe(404);
    expect(await w.typingReaches()).toBe(false);
  });

  it('DM participants: leaving a group DM stops events immediately', async () => {
    const oa = new Api(env);
    const a = await oa.register('dma'), b = await oa.register('dmb'), c = await oa.register('dmc');
    const g = (await oa.req('POST', '/guilds', a.token, { name: 'dmg' })).body;
    const code = (await oa.req('POST', `/guilds/${g.id}/invites`, a.token, {})).body.code;
    for (const u of [b, c]) await oa.req('POST', `/invites/${code}`, u.token);
    const dm = (await oa.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id, c.id] })).body;
    const wb = await WsClient.connect(env.port); await wb.identify(b.token);
    const wc = await WsClient.connect(env.port); await wc.identify(c.token);
    await oa.req('POST', `/channels/${dm.id}/messages`, a.token, { content: 'one' });
    await wb.waitEvent('MESSAGE_CREATE', (d) => d.content === 'one'); await wc.waitEvent('MESSAGE_CREATE', (d) => d.content === 'one');
    await oa.req('DELETE', `/channels/${dm.id}`, c.token); // c leaves
    await oa.req('POST', `/channels/${dm.id}/messages`, a.token, { content: 'two' });
    await wb.waitEvent('MESSAGE_CREATE', (d) => d.content === 'two'); await sleep(150);
    expect(wc.frames.some((f) => f.t === 'MESSAGE_CREATE' && f.d.content === 'two')).toBe(false);
  });
});

describe.skipIf(!PG || !REDIS)('permission cache across two nodes (Postgres + Redis)', () => {
  it('a mutation on node 1 is visible to node 2 fan-out and typing immediately', async () => {
    const db = (await createTestDatabase())!; const redisPrefix = `jcp${Date.now()}`;
    const n1 = await startServer({ databaseUrl: db.url, redisPrefix }), n2 = await startServer({ databaseUrl: db.url, redisPrefix });
    const w = await world(n1, n2); // owner socket on node 1, pleb socket on node 2; all REST goes through node 1
    expect(await w.plebSees()).toBe(true); expect(await w.typingReaches()).toBe(true); // node 2's cache is warm
    await w.oa.req('PUT', `/channels/${w.general.id}/permissions/${w.pleb.id}`, w.owner.token, { type: 'member', allow: '0', deny: String(Perm.VIEW_CHANNEL) });
    expect(await w.plebSees()).toBe(false); expect(await w.typingReaches()).toBe(false);
    await w.oa.req('DELETE', `/channels/${w.general.id}/permissions/${w.pleb.id}`, w.owner.token);
    expect(await w.plebSees()).toBe(true);
    const r = await w.role(Perm.VIEW_CHANNEL); void r;
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/roles/${w.guild.id}`, w.owner.token, { permissions: String(DEFAULT_EVERYONE & ~Perm.SEND_MESSAGES) });
    expect(await w.typingReaches()).toBe(false);
    await w.oa.req('PATCH', `/guilds/${w.guild.id}/roles/${w.guild.id}`, w.owner.token, { permissions: String(DEFAULT_EVERYONE) });
    expect(await w.typingReaches()).toBe(true);
    await w.oa.req('DELETE', `/guilds/${w.guild.id}/members/${w.pleb.id}`, w.owner.token);
    expect(await w.plebSees()).toBe(false); expect(await w.typingReaches()).toBe(false);
    await w.oa.req('POST', `/invites/${w.invite}`, w.pleb.token);
    expect(await w.plebSees()).toBe(true);
    // node 2 keeps serving fan-out from cache (no per-event queries) while node 1 mutates nothing
    const fan = await countQueries(n2, async () => { await n2.ctx.hub.toChannel(w.general.id, 'TYPING_START', { channelId: w.general.id, userId: w.owner.id, timestamp: 7 }); await w.pw.waitEvent('TYPING_START', (d) => d.timestamp === 7); });
    expect(fan.queries).toEqual([]);
    w.ow.close(); w.pw.close(); await n1.close(); await n2.close(); await db.drop();
  });
});

describe.skipIf(!PG)('migrations under concurrent boot', () => {
  it('two nodes starting at once both succeed and apply each migration exactly once', async () => {
    const db = (await createTestDatabase())!;
    const [n1, n2, n3] = await Promise.all([1, 2, 3].map(() => startServer({ databaseUrl: db.url })));
    const rows = await n1.ctx.db.query('SELECT name FROM schema_migrations');
    const files = readdirSync(n1.ctx.config.migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(rows.length).toBe(files.length);
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
    await Promise.all([n1.close(), n2.close(), n3.close()]); await db.drop();
  });
});
