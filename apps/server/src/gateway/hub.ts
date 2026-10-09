import type { Events, EventName, Presence, VoiceState } from '@jorcord/shared';
import { Op } from '@jorcord/shared';
import type { WebSocket } from 'ws';
import type { Ctx } from '../ctx';
import { viewersAmong, getChannelRow } from '../services/perms';

const TOPIC = 'jorcord:events';

type Envelope =
  | { kind: 'users'; ids: string[]; t: string; d: unknown }
  | { kind: 'guild'; guildId: string; channelId?: string; exclude?: string; t: string; d: unknown }
  | { kind: 'channel'; channelId: string; exclude?: string; t: string; d: unknown }
  | { kind: 'presence'; userId: string; t: string; d: unknown };

export interface GwSession {
  id: string; userId: string; authSessionId: string; seq: number;
  buffer: { s: number; t: string; d: unknown; at: number }[];
  socket: WebSocket | null; detachedAt: number | null;
}

/** Gateway session registry and event fan-out. Publishing goes through the EventBus so multiple nodes work. */
export class Hub {
  sessions = new Map<string, GwSession>();
  voice = new Map<string, VoiceState>();
  private ctx!: Ctx;
  private sweeper?: NodeJS.Timeout;

  async init(ctx: Ctx) {
    this.ctx = ctx;
    await ctx.bus.subscribe(TOPIC, (m) => { void this.deliver(m as Envelope).catch((e) => ctx.log.error({ err: e }, 'gateway deliver failed')); });
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) if (s.detachedAt && now - s.detachedAt > ctx.config.resumeWindowMs) this.sessions.delete(id);
    }, 15_000);
    this.sweeper.unref();
  }
  close() { if (this.sweeper) clearInterval(this.sweeper); for (const s of this.sessions.values()) s.socket?.close(1001); this.sessions.clear(); }

  // ---- publishing API (used by routes) ----
  private pub(e: Envelope) { return this.ctx.bus.publish(TOPIC, e); }
  toUsers<K extends EventName>(ids: string[], t: K, d: Events[K]) { return this.pub({ kind: 'users', ids, t, d }); }
  toUser<K extends EventName>(id: string, t: K, d: Events[K]) { return this.toUsers([id], t, d); }
  toGuild<K extends EventName>(guildId: string, t: K, d: Events[K], o: { channelId?: string; exclude?: string } = {}) { return this.pub({ kind: 'guild', guildId, t, d, ...o }); }
  toChannel<K extends EventName>(channelId: string, t: K, d: Events[K], o: { exclude?: string } = {}) { return this.pub({ kind: 'channel', channelId, t, d, ...o }); }
  toPresenceAudience<K extends EventName>(userId: string, t: K, d: Events[K]) { return this.pub({ kind: 'presence', userId, t, d }); }

  // ---- presence ----
  attachedCount(userId: string) { let n = 0; for (const s of this.sessions.values()) if (s.userId === userId && s.socket) n++; return n; }
  isOnline(userId: string) { return this.attachedCount(userId) > 0; }
  publicPresence(userId: string, pref: string | undefined): Presence {
    if (!this.isOnline(userId)) return 'offline';
    return pref === 'invisible' ? 'offline' : ((pref as Presence) || 'online');
  }
  async broadcastPresence(userId: string) {
    const [u] = await this.ctx.db.query('SELECT presence, custom_status FROM users WHERE id = $1', [userId]);
    if (!u) return;
    await this.toPresenceAudience(userId, 'PRESENCE_UPDATE', { userId, presence: this.publicPresence(userId, u.presence), customStatus: u.custom_status ?? null });
  }

  // ---- sessions ----
  disconnectAuthSession(authSessionId: string) {
    for (const [id, s] of this.sessions) if (s.authSessionId === authSessionId) { s.socket?.close(4004, 'session revoked'); this.sessions.delete(id); }
  }
  disconnectUser(userId: string) {
    for (const [id, s] of this.sessions) if (s.userId === userId) { s.socket?.close(4004, 'user removed'); this.sessions.delete(id); }
  }
  sendTo(s: GwSession, t: string, d: unknown) {
    const seq = ++s.seq; const now = Date.now();
    s.buffer.push({ s: seq, t, d, at: now });
    while (s.buffer.length && (s.buffer.length > 5000 || now - s.buffer[0]!.at > this.ctx.config.resumeWindowMs)) s.buffer.shift();
    if (s.socket && s.socket.readyState === 1) s.socket.send(JSON.stringify({ op: Op.DISPATCH, t, s: seq, d }));
  }

  // ---- delivery (runs on every node for every published event) ----
  private async deliver(e: Envelope) {
    const bySession = [...this.sessions.values()];
    if (!bySession.length) return;
    const localUsers = [...new Set(bySession.map((s) => s.userId))];
    let targets: string[];
    switch (e.kind) {
      case 'users': { const set = new Set(e.ids); targets = localUsers.filter((u) => set.has(u)); break; }
      case 'guild': {
        const rows = await this.ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])', [e.guildId, localUsers]);
        targets = rows.map((r) => r.user_id);
        if (e.channelId) { const ch = await getChannelRow(this.ctx, e.channelId); targets = ch ? await viewersAmong(this.ctx, ch, targets) : []; }
        break;
      }
      case 'channel': {
        const ch = await getChannelRow(this.ctx, e.channelId);
        targets = ch ? await viewersAmong(this.ctx, ch, localUsers) : [];
        break;
      }
      case 'presence': {
        const rows = await this.ctx.db.query(
          `SELECT m2.user_id AS u FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = $1 AND m2.user_id = ANY($2::text[])
           UNION SELECT other_id AS u FROM relationships WHERE user_id = $1 AND type = 'friend' AND other_id = ANY($2::text[])`, [e.userId, localUsers]);
        targets = [...new Set([...rows.map((r) => r.u as string), ...(localUsers.includes(e.userId) ? [e.userId] : [])])];
        break;
      }
    }
    const tset = new Set(targets);
    if ('exclude' in e && e.exclude) tset.delete(e.exclude);
    for (const s of bySession) if (tset.has(s.userId)) this.sendTo(s, e.t, e.d);
  }
}
