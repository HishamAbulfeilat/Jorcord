import type { VoiceState } from '@jorcord/shared';

/**
 * Shared realtime state (voice + presence). In-memory for a single node; Redis-backed when REDIS_URL is set
 * so several server nodes agree on who is in which voice channel and who is online.
 */
export interface VoiceStore {
  get(userId: string): Promise<VoiceState | null>;
  set(state: VoiceState): Promise<void>;
  delete(userId: string): Promise<void>;
  /** All states currently in a channel. */
  inChannel(channelId: string): Promise<VoiceState[]>;
  all(): Promise<VoiceState[]>;
  close(): Promise<void>;
}

export interface PresenceStore {
  /** Registers a live gateway session; returns how many live sessions the user has (all nodes) afterwards. */
  add(userId: string, sessionId: string): Promise<number>;
  /** Removes a session; returns the remaining live sessions of the user (all nodes). */
  remove(userId: string, sessionId: string): Promise<number>;
  /** Extends the lease of locally attached sessions (call periodically). */
  refresh(entries: { userId: string; sessionId: string }[]): Promise<void>;
  /** Users with at least one live session on any node. */
  onlineUsers(): Promise<Set<string>>;
  /** Which of `userIds` are online right now (authoritative; used when building READY so it never misses a just-connected peer). */
  onlineAmong(userIds: string[]): Promise<Set<string>>;
  close(): Promise<void>;
}

export class MemoryVoiceStore implements VoiceStore {
  private m = new Map<string, VoiceState>();
  async get(u: string) { return this.m.get(u) ?? null; }
  async set(s: VoiceState) { this.m.set(s.userId, s); }
  async delete(u: string) { this.m.delete(u); }
  async inChannel(c: string) { return [...this.m.values()].filter((s) => s.channelId === c); }
  async all() { return [...this.m.values()]; }
  async close() { this.m.clear(); }
}

export class MemoryPresenceStore implements PresenceStore {
  private m = new Map<string, Set<string>>();
  async add(u: string, s: string) { const set = this.m.get(u) ?? new Set(); set.add(s); this.m.set(u, set); return set.size; }
  async remove(u: string, s: string) { const set = this.m.get(u); if (!set) return 0; set.delete(s); if (!set.size) this.m.delete(u); return set.size; }
  async refresh() { /* in-process: nothing expires */ }
  async onlineUsers() { return new Set(this.m.keys()); }
  async onlineAmong(ids: string[]) { return new Set(ids.filter((i) => this.m.has(i))); }
  async close() { this.m.clear(); }
}

const VOICE_TTL_SEC = 6 * 3600; // safety net: a node that dies without cleanup cannot leave ghosts forever
export const PRESENCE_LEASE_MS = 45_000;

type RedisLike = import('ioredis').Redis;

export class RedisVoiceStore implements VoiceStore {
  constructor(private r: RedisLike, private p = 'jorcord') {}
  private key = (u: string) => `${this.p}:voice:u:${u}`;
  async get(u: string) { const raw = await this.r.get(this.key(u)); return raw ? (JSON.parse(raw) as VoiceState) : null; }
  async set(s: VoiceState) {
    const p = this.r.multi().set(this.key(s.userId), JSON.stringify(s), 'EX', VOICE_TTL_SEC);
    if (s.channelId) p.sadd(`${this.p}:voice:ch:${s.channelId}`, s.userId);
    await p.exec();
  }
  async delete(u: string) {
    const prev = await this.get(u);
    const p = this.r.multi().del(this.key(u));
    if (prev?.channelId) p.srem(`${this.p}:voice:ch:${prev.channelId}`, u);
    await p.exec();
  }
  private async load(ids: string[]) {
    if (!ids.length) return [] as VoiceState[];
    const raws = await this.r.mget(ids.map(this.key));
    return raws.filter((x): x is string => !!x).map((x) => JSON.parse(x) as VoiceState);
  }
  async inChannel(c: string) {
    const ids = await this.r.smembers(`${this.p}:voice:ch:${c}`);
    const states = await this.load(ids);
    const live = states.filter((s) => s.channelId === c);
    const stale = ids.filter((id) => !live.some((s) => s.userId === id));
    if (stale.length) await this.r.srem(`${this.p}:voice:ch:${c}`, ...stale);
    return live;
  }
  async all() {
    const ids: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.r.scan(cursor, 'MATCH', `${this.p}:voice:u:*`, 'COUNT', 500);
      cursor = next; ids.push(...keys.map((k) => k.slice(`${this.p}:voice:u:`.length)));
    } while (cursor !== '0');
    return this.load(ids);
  }
  async close() { /* connection owned by caller */ }
}

/** Per-user sorted set of session ids scored by lease expiry; `jorcord:pres:users` indexes users that may be online. */
export class RedisPresenceStore implements PresenceStore {
  constructor(private r: RedisLike, private leaseMs = PRESENCE_LEASE_MS, private p = 'jorcord') {}
  private key = (u: string) => `${this.p}:pres:${u}`;
  private index = () => `${this.p}:pres:users`;
  private async count(u: string) {
    const now = Date.now();
    const res = await this.r.multi().zremrangebyscore(this.key(u), '-inf', now).zcard(this.key(u)).exec();
    return Number(res?.[1]?.[1] ?? 0);
  }
  async add(u: string, s: string) {
    await this.r.multi().zadd(this.key(u), Date.now() + this.leaseMs, s).sadd(this.index(), u).exec();
    return this.count(u);
  }
  async remove(u: string, s: string) {
    await this.r.zrem(this.key(u), s);
    const n = await this.count(u);
    if (n === 0) await this.r.srem(this.index(), u);
    return n;
  }
  async refresh(entries: { userId: string; sessionId: string }[]) {
    if (!entries.length) return;
    const p = this.r.multi(); const exp = Date.now() + this.leaseMs;
    for (const e of entries) p.zadd(this.key(e.userId), exp, e.sessionId).sadd(this.index(), e.userId);
    await p.exec();
  }
  async onlineAmong(userIds: string[]) {
    const out = new Set<string>(); const now = Date.now();
    for (let i = 0; i < userIds.length; i += 1000) {
      const chunk = userIds.slice(i, i + 1000);
      const p = this.r.multi(); for (const u of chunk) p.zcount(this.key(u), now, '+inf');
      const res = (await p.exec()) ?? [];
      chunk.forEach((u, j) => { if (Number(res[j]?.[1] ?? 0) > 0) out.add(u); });
    }
    return out;
  }
  async onlineUsers() {
    const ids = await this.r.smembers(this.index());
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const p = this.r.multi(); const now = Date.now();
      for (const u of chunk) p.zremrangebyscore(this.key(u), '-inf', now).zcard(this.key(u));
      const res = (await p.exec()) ?? [];
      const dead: string[] = [];
      chunk.forEach((u, j) => { if (Number(res[j * 2 + 1]?.[1] ?? 0) > 0) out.add(u); else dead.push(u); });
      if (dead.length) await this.r.srem(this.index(), ...dead);
    }
    return out;
  }
  async close() { /* connection owned by caller */ }
}

export async function createState(redisUrl: string | null, prefix = 'jorcord'): Promise<{ voice: VoiceStore; presence: PresenceStore; close(): Promise<void> }> {
  if (!redisUrl) return { voice: new MemoryVoiceStore(), presence: new MemoryPresenceStore(), close: async () => {} };
  const { default: Redis } = await import('ioredis');
  const r = new Redis(redisUrl);
  return { voice: new RedisVoiceStore(r, prefix), presence: new RedisPresenceStore(r, PRESENCE_LEASE_MS, prefix), close: async () => { r.disconnect(); } };
}
