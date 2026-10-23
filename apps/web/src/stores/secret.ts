/** UI state for secret chats: per-channel key/trust info and the decrypted text of messages (memory only, never persisted). */
import { create } from 'zustand';
import { parseEnvelope, type Channel, type Id, type Message } from '@jorcord/shared';
import { acceptKeys, forgetLocalDevice, loadChannelCrypto, openMessage, type ChannelCrypto } from '@/lib/e2ee/service';
import type { DecryptFailure } from '@/lib/e2ee/crypto';

export type Opened = { ok: true; text: string } | { ok: false; reason: DecryptFailure | 'error' };

interface SecretState {
  cc: Record<Id, ChannelCrypto | undefined>;
  error: Record<Id, string | undefined>;
  opened: Record<Id, Opened | undefined>;
  load(channel: Pick<Channel, 'id' | 'recipients'>, meId: Id, force?: boolean): Promise<ChannelCrypto | null>;
  open(channel: Pick<Channel, 'id' | 'recipients'>, meId: Id, m: Message): Promise<void>;
  accept(channel: Pick<Channel, 'id' | 'recipients'>, meId: Id, verified?: boolean): Promise<void>;
  /** A user's device list changed (E2EE_DEVICES_UPDATE): reload the chats they are in and retry messages that failed for lack of a key. */
  devicesChanged(userId: Id, meId: Id, channels: Record<Id, Channel>): void;
  reset(): void;
}

const inflight = new Map<string, Promise<ChannelCrypto | null>>();

export const useSecret = create<SecretState>((set, get) => ({
  cc: {}, error: {}, opened: {},
  async load(channel, meId, force = false) {
    const have = get().cc[channel.id];
    if (have && !force) return have;
    let p = inflight.get(channel.id);
    if (!p) {
      p = loadChannelCrypto(channel, meId)
        .then((cc) => { set((s) => ({ cc: { ...s.cc, [channel.id]: cc }, error: { ...s.error, [channel.id]: undefined } })); return cc; })
        .catch((e: Error) => { set((s) => ({ error: { ...s.error, [channel.id]: e.message || 'Could not load encryption keys' } })); return null; })
        .finally(() => { inflight.delete(channel.id); });
      inflight.set(channel.id, p);
    }
    return p;
  },
  async open(channel, meId, m) {
    if (get().opened[m.id]) return;
    let cc = await get().load(channel, meId);
    if (!cc) { set((s) => ({ opened: { ...s.opened, [m.id]: { ok: false, reason: 'error' } } })); return; }
    const env = parseEnvelope(m.content);
    if (env && !cc.known.has(env.from)) cc = (await get().load(channel, meId, true)) ?? cc; // the sender added a device after we last looked
    let r = await openMessage(cc, m);
    const out: Opened = r.ok ? { ok: true, text: r.plaintext } : { ok: false, reason: r.reason };
    set((s) => ({ opened: { ...s.opened, [m.id]: out } }));
  },
  async accept(channel, meId, verified) {
    const cc = await get().load(channel, meId, true);
    if (!cc) return;
    await acceptKeys(cc, meId, { verified });
    await get().load(channel, meId, true);
  },
  devicesChanged(userId, meId, channels) {
    for (const ch of Object.values(channels)) {
      if (!ch.encrypted) continue;
      if (userId !== meId && !ch.recipients?.some((r) => r.id === userId)) continue;
      void get().load(ch, meId, true).then(() => set((s) => ({ opened: Object.fromEntries(Object.entries(s.opened).filter(([, v]) => !(v && !v.ok && (v.reason === 'unknown_sender_device' || v.reason === 'not_for_this_device' || v.reason === 'error')))) })));
    }
  },
  reset() { inflight.clear(); forgetLocalDevice(); set({ cc: {}, error: {}, opened: {} }); },
}));
