/** Pub/sub abstraction. In-memory by default; Redis when REDIS_URL is set (multi-node). */
export type BusHandler = (msg: unknown) => void;
export interface EventBus {
  publish(topic: string, msg: unknown): Promise<void>;
  subscribe(topic: string, handler: BusHandler): Promise<void>;
  close(): Promise<void>;
}

export class MemoryBus implements EventBus {
  private handlers = new Map<string, Set<BusHandler>>();
  async publish(topic: string, msg: unknown) {
    // JSON round trip so memory and redis behave identically
    const copy = JSON.parse(JSON.stringify(msg));
    for (const h of this.handlers.get(topic) ?? []) queueMicrotask(() => h(copy));
  }
  async subscribe(topic: string, h: BusHandler) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(h);
  }
  async close() { this.handlers.clear(); }
}

export async function createBus(redisUrl: string | null): Promise<EventBus> {
  if (!redisUrl) return new MemoryBus();
  const { default: Redis } = await import('ioredis');
  const pub = new Redis(redisUrl), sub = new Redis(redisUrl);
  const handlers = new Map<string, Set<BusHandler>>();
  sub.on('message', (topic, raw) => {
    let msg: unknown; try { msg = JSON.parse(raw); } catch { return; }
    for (const h of handlers.get(topic) ?? []) h(msg);
  });
  return {
    publish: async (t, m) => { await pub.publish(t, JSON.stringify(m)); },
    subscribe: async (t, h) => {
      if (!handlers.has(t)) { handlers.set(t, new Set()); await sub.subscribe(t); }
      handlers.get(t)!.add(h);
    },
    close: async () => { pub.disconnect(); sub.disconnect(); },
  };
}
