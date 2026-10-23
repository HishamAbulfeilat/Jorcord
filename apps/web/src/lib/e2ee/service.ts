/** Secret chats, client side: this device's identity, the peers' published keys, trust pins, and sending / opening messages. Protocol: docs/E2EE_DMS.md. */
import { fromB64u, parseEnvelope, toB64u, type Channel, type E2eeDevice, type Id, type Message } from '@jorcord/shared';
import { api } from '@/lib/api';
import { decryptMessage, diffTrust, encryptMessage, fingerprint, generateIdentity, safetyNumber, type DecryptResult, type DeviceFp, type Identity, type TrustDiff } from './crypto';
import { defaultKeyStore, type KeyStore } from './keystore';

export interface LocalDevice { deviceId: Id; identity: Identity }
export interface DeviceInfo extends E2eeDevice { fp: string; publicRaw: Uint8Array }
export interface ChannelCrypto {
  channelId: Id; peerId: Id; me: LocalDevice;
  /** every device of both people incl. revoked ones (revoked ones still verify old messages) */
  known: Map<Id, DeviceInfo>;
  mine: DeviceInfo[]; theirs: DeviceInfo[];
  safety: string; trust: TrustDiff; verified: boolean; persistent: boolean;
}

export class SecretChatError extends Error {
  constructor(public code: 'KEY_CHANGED' | 'PEER_NO_DEVICE' | 'NO_STORAGE' | 'UNSUPPORTED', message: string) { super(message); }
}

const deviceLabel = () => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
};

const devices = new Map<string, Promise<LocalDevice>>();
/**
 * This device's identity for `userId`. Created and published on first use. If the stored key is not (or no longer) an active device on the server
 * (revoked elsewhere), a fresh identity is made: history sent to the old key stays unreadable here, which is the documented price of revocation.
 */
export function ensureLocalDevice(userId: Id, store?: KeyStore): Promise<LocalDevice> {
  const k = userId;
  let p = devices.get(k);
  if (!p) { p = create(userId, store).catch((e) => { devices.delete(k); throw e; }); devices.set(k, p); }
  return p;
}
export const forgetLocalDevice = (userId?: Id) => { if (userId) devices.delete(userId); else devices.clear(); };
async function create(userId: Id, store?: KeyStore): Promise<LocalDevice> {
  const ks = store ?? await defaultKeyStore();
  const stored = await ks.getIdentity(userId);
  const published = await api.e2ee.devices();
  if (stored) {
    const pubB64 = toB64u(stored.publicRaw);
    if (published.some((d) => d.id === stored.deviceId && d.publicKey === pubB64)) return { deviceId: stored.deviceId, identity: { privateKey: stored.privateKey, publicRaw: stored.publicRaw } };
    await ks.deleteIdentity(userId);
  }
  const identity = await generateIdentity();
  const dev = await api.e2ee.register(toB64u(identity.publicRaw), deviceLabel());
  await ks.putIdentity(userId, { deviceId: dev.id, privateKey: identity.privateKey, publicRaw: identity.publicRaw });
  return { deviceId: dev.id, identity };
}

const pinKey = (me: Id, peer: Id) => `${me}:${peer}`;
async function toInfo(d: E2eeDevice): Promise<DeviceInfo> { const publicRaw = fromB64u(d.publicKey); return { ...d, publicRaw, fp: await fingerprint(publicRaw) }; }

/** Fetches both sides' device keys and evaluates trust. First contact is pinned automatically (trust on first use); later changes are NOT pinned until the user accepts them. */
export async function loadChannelCrypto(channel: Pick<Channel, 'id' | 'recipients'>, meId: Id, store?: KeyStore): Promise<ChannelCrypto> {
  const ks = store ?? await defaultKeyStore();
  const peerId = channel.recipients?.find((r) => r.id !== meId)?.id;
  if (!peerId) throw new SecretChatError('UNSUPPORTED', 'Not a 1:1 secret chat');
  const me = await ensureLocalDevice(meId, ks);
  const list = (await api.e2ee.channelDevices(channel.id)).devices;
  const infos = await Promise.all(list.map(toInfo));
  const known = new Map(infos.map((d) => [d.id, d]));
  const active = infos.filter((d) => !d.revokedAt);
  const mine = active.filter((d) => d.userId === meId), theirs = active.filter((d) => d.userId === peerId);
  const fps = (ds: DeviceInfo[]): DeviceFp[] => ds.map((d) => ({ id: d.id, fp: d.fp }));
  const pin = await ks.getPin(pinKey(meId, peerId));
  const trust = diffTrust(pin?.devices ?? null, fps(theirs));
  let verified = !!pin?.verified;
  if (trust.status === 'first_use' && theirs.length) await ks.putPin(pinKey(meId, peerId), { devices: Object.fromEntries(fps(theirs).map((d) => [d.id, d.fp])), verified: false, updatedAt: Date.now() });
  else if (trust.status === 'ok' && trust.removed.length && pin) await ks.putPin(pinKey(meId, peerId), { ...pin, devices: Object.fromEntries(fps(theirs).map((d) => [d.id, d.fp])), updatedAt: Date.now() });
  if (trust.status === 'changed') verified = false;
  const safety = await safetyNumber({ userId: meId, devices: fps(mine) }, { userId: peerId, devices: fps(theirs) });
  return { channelId: channel.id, peerId, me, known, mine, theirs, safety, trust, verified, persistent: ks.persistent };
}

/** The user reviewed a key change (or first contact) and accepts the peer's current devices. */
export async function acceptKeys(cc: ChannelCrypto, meId: Id, opts: { verified?: boolean } = {}, store?: KeyStore) {
  const ks = store ?? await defaultKeyStore();
  const prev = await ks.getPin(pinKey(meId, cc.peerId));
  await ks.putPin(pinKey(meId, cc.peerId), { devices: Object.fromEntries(cc.theirs.map((d) => [d.id, d.fp])), verified: opts.verified ?? (cc.trust.status === 'changed' ? false : !!prev?.verified), updatedAt: Date.now() });
}

/** Encrypts and sends. Refuses (before anything leaves the device) when the peer's keys changed and were not accepted, or when the peer has no device yet. */
export async function sendSecretMessage(channel: Pick<Channel, 'id' | 'recipients'>, me: { id: Id }, plaintext: string, replyTo?: Id | null, store?: KeyStore): Promise<Message> {
  const cc = await loadChannelCrypto(channel, me.id, store);
  if (!cc.theirs.length) throw new SecretChatError('PEER_NO_DEVICE', 'They have not set up secret chats on any device yet, so nothing can be encrypted for them.');
  if (cc.trust.status === 'changed') throw new SecretChatError('KEY_CHANGED', 'Their security keys changed. Review the safety number before sending.');
  const content = await encryptMessage({
    channelId: channel.id, authorId: me.id, sender: { id: cc.me.deviceId, identity: cc.me.identity },
    recipients: [...cc.theirs, ...cc.mine].map((d) => ({ id: d.id, publicRaw: d.publicRaw })), plaintext,
  });
  return api.messages.send(channel.id, { content, replyTo: replyTo ?? undefined });
}

/** Opens one message. A sender device the cached list does not know (it was added after the list was fetched) is looked up once more by the caller. */
export async function openMessage(cc: ChannelCrypto, m: Pick<Message, 'content' | 'channelId' | 'author'>): Promise<DecryptResult> {
  const env = parseEnvelope(m.content);
  const sender = env ? cc.known.get(env.from) : undefined;
  return decryptMessage({ channelId: m.channelId, authorId: m.author.id, content: m.content, self: { id: cc.me.deviceId, identity: cc.me.identity }, senderPublic: sender && sender.userId === m.author.id ? sender.publicRaw : null });
}

export type { Identity };
