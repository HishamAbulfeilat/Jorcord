/**
 * Secret chats: the cryptography, on WebCrypto only (no dependencies). Protocol and threat model: docs/E2EE_DMS.md.
 *
 * - Each device has one long-term ECDH P-256 identity key; the private key is generated non-extractable and never leaves the device.
 * - A message is encrypted once with a random AES-256-GCM key. That key is wrapped separately for every recipient device (and the sender's own
 *   devices) under a key derived with HKDF-SHA-256 from TWO ECDH results: ephemeral(sender, this message) x recipient-device, and
 *   sender-device-identity x recipient-device. The second one authenticates the sender: only the holder of the sender device's private key (or of
 *   the recipient's) can produce a wrap that opens, so the server cannot forge or splice messages in someone's name.
 * - Everything that identifies a message (channel, author, devices, ephemeral key) is bound in as AAD / HKDF info.
 */
import { E2EE_MAX_PLAINTEXT_BYTES, E2EE_MAX_PLAINTEXT_CHARS, fromB64u, parseEnvelope, toB64u, encodeEnvelope, type E2eeEnvelope } from '@jorcord/shared';

const te = new TextEncoder();
const td = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SALT = te.encode('jorcord-e2ee-v1');
const PAD = 64;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available in this browser (secure context required)');
  return s;
};
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export interface Identity { privateKey: CryptoKey; publicRaw: Uint8Array }

/** New device identity. The private key is non-extractable: not even this page's own scripts can read it out. */
export async function generateIdentity(): Promise<Identity> {
  const kp = await subtle().generateKey(ECDH, false, ['deriveBits']);
  return { privateKey: kp.privateKey, publicRaw: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)) };
}
export const importPublic = (raw: Uint8Array) => subtle().importKey('raw', buf(raw), ECDH, true, []);

/** SHA-256 of the raw public key, lowercase hex. */
export async function fingerprint(publicRaw: Uint8Array): Promise<string> {
  return [...new Uint8Array(await subtle().digest('SHA-256', buf(publicRaw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function wrapKeyFor(dh1: ArrayBuffer, dh2: ArrayBuffer, info: string): Promise<CryptoKey> {
  const ikm = await subtle().importKey('raw', buf(concat(new Uint8Array(dh1), new Uint8Array(dh2))), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(SALT), info: buf(te.encode(info)) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const wrapInfo = (channelId: string, fromDevice: string, toDevice: string, epk: string) => `wrap|${channelId}|${fromDevice}|${toDevice}|${epk}`;
const contentAad = (channelId: string, authorId: string, fromDevice: string) => te.encode(`msg|${channelId}|${authorId}|${fromDevice}`);

function pad(plain: string): Uint8Array {
  const bytes = te.encode(plain);
  if (plain.length > E2EE_MAX_PLAINTEXT_CHARS || bytes.length > E2EE_MAX_PLAINTEXT_BYTES) throw new Error('Message is too long');
  const out = new Uint8Array(Math.ceil((4 + bytes.length) / PAD) * PAD);
  new DataView(out.buffer).setUint32(0, bytes.length); out.set(bytes, 4);
  return out;
}
function unpad(padded: Uint8Array): string {
  if (padded.length < 4) throw new Error('bad padding');
  const n = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (n > padded.length - 4) throw new Error('bad padding');
  return td.decode(padded.subarray(4, 4 + n));
}

export interface RecipientDevice { id: string; publicRaw: Uint8Array }
export interface SenderDevice { id: string; identity: Identity }

/** Encrypts `plaintext` for the given recipient devices (the sender's own devices must be in the list too, or they cannot read it back). Returns the message `content`. */
export async function encryptMessage(o: { channelId: string; authorId: string; sender: SenderDevice; recipients: RecipientDevice[]; plaintext: string }): Promise<string> {
  if (!o.recipients.length) throw new Error('no recipient devices');
  const padded = pad(o.plaintext);
  const eph = await subtle().generateKey(ECDH, false, ['deriveBits']);
  const epk = toB64u(new Uint8Array(await subtle().exportKey('raw', eph.publicKey)));
  const cek = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const cekRaw = new Uint8Array(await subtle().exportKey('raw', cek));
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(contentAad(o.channelId, o.authorId, o.sender.id)) }, cek, buf(padded)));
  const keys: E2eeEnvelope['keys'] = {};
  for (const r of o.recipients) {
    const rpub = await importPublic(r.publicRaw);
    const dh1 = await subtle().deriveBits({ name: 'ECDH', public: rpub }, eph.privateKey, 256);
    const dh2 = await subtle().deriveBits({ name: 'ECDH', public: rpub }, o.sender.identity.privateKey, 256);
    const wk = await wrapKeyFor(dh1, dh2, wrapInfo(o.channelId, o.sender.id, r.id, epk));
    const wiv = randomBytes(12);
    keys[r.id] = { iv: toB64u(wiv), wk: toB64u(new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(wiv) }, wk, buf(cekRaw)))) };
  }
  cekRaw.fill(0);
  return encodeEnvelope({ v: 1, from: o.sender.id, epk, iv: toB64u(iv), ct: toB64u(ct), keys });
}

export type DecryptFailure = 'malformed' | 'not_for_this_device' | 'unknown_sender_device' | 'authentication_failed';
export type DecryptResult = { ok: true; plaintext: string; fromDevice: string } | { ok: false; reason: DecryptFailure };

/**
 * Opens a message with this device's identity. `senderPublic` is the published key of the device named in the envelope (null when the server does not know it).
 * Fails closed: a tampered ciphertext, a wrap forged by anybody without the sender device's private key, or a message moved to another channel or author all fail authentication.
 */
export async function decryptMessage(o: { channelId: string; authorId: string; content: string; self: { id: string; identity: Identity }; senderPublic: Uint8Array | null }): Promise<DecryptResult> {
  const env = parseEnvelope(o.content);
  if (!env) return { ok: false, reason: 'malformed' };
  const wrap = env.keys[o.self.id];
  if (!wrap) return { ok: false, reason: 'not_for_this_device' };
  if (!o.senderPublic) return { ok: false, reason: 'unknown_sender_device' };
  try {
    const spub = await importPublic(o.senderPublic);
    const epub = await importPublic(fromB64u(env.epk));
    const dh1 = await subtle().deriveBits({ name: 'ECDH', public: epub }, o.self.identity.privateKey, 256);
    const dh2 = await subtle().deriveBits({ name: 'ECDH', public: spub }, o.self.identity.privateKey, 256);
    const wk = await wrapKeyFor(dh1, dh2, wrapInfo(o.channelId, env.from, o.self.id, env.epk));
    const cekRaw = await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromB64u(wrap.iv)) }, wk, buf(fromB64u(wrap.wk)));
    const cek = await subtle().importKey('raw', cekRaw, 'AES-GCM', false, ['decrypt']);
    const padded = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromB64u(env.iv)), additionalData: buf(contentAad(o.channelId, o.authorId, env.from)) }, cek, buf(fromB64u(env.ct))));
    return { ok: true, plaintext: unpad(padded), fromDevice: env.from };
  } catch { return { ok: false, reason: 'authentication_failed' }; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Safety numbers and key-change detection
// ---------------------------------------------------------------------------------------------------------------------

export interface DeviceFp { id: string; fp: string }

/** Order-independent 60 digit number that both people can read to each other. It covers every active device of both people. */
export async function safetyNumber(a: { userId: string; devices: DeviceFp[] }, b: { userId: string; devices: DeviceFp[] }): Promise<string> {
  const sha = async (s: string) => new Uint8Array(await subtle().digest('SHA-256', buf(te.encode(s))));
  const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('');
  const side = async (s: typeof a) => hex(await sha(`jorcord-safety-v1|${s.userId}|${s.devices.map((d) => d.fp).sort().join(',')}`));
  const [x, y] = [await side(a), await side(b)].sort();
  const h = concat(await sha(`${x}|${y}|0`), await sha(`${x}|${y}|1`)); // 64 bytes: four per group of five digits
  const dv = new DataView(h.buffer);
  let out = '';
  for (let i = 0; i < 12; i++) out += String(dv.getUint32(i * 4) % 100000).padStart(5, '0') + (i % 4 === 3 && i < 11 ? '\n' : i < 11 ? ' ' : '');
  return out;
}

export type TrustStatus = 'first_use' | 'ok' | 'changed';
export interface TrustDiff { status: TrustStatus; added: string[]; changed: string[]; removed: string[] }
/** Compares the devices a peer publishes now with what this client pinned earlier (trust on first use). Removed devices alone are not a warning; new or different keys are. */
export function diffTrust(pinned: Record<string, string> | null, current: DeviceFp[]): TrustDiff {
  if (!pinned) return { status: 'first_use', added: [], changed: [], removed: [] };
  const cur = new Map(current.map((d) => [d.id, d.fp]));
  const added = current.filter((d) => !(d.id in pinned)).map((d) => d.id);
  const changed = current.filter((d) => d.id in pinned && pinned[d.id] !== d.fp).map((d) => d.id);
  const removed = Object.keys(pinned).filter((id) => !cur.has(id));
  return { status: added.length || changed.length ? 'changed' : 'ok', added, changed, removed };
}

/** Groups a hex fingerprint for display: "ab12 cd34 ...". */
export const formatFingerprint = (hex: string) => hex.match(/.{1,4}/g)?.join(' ') ?? hex;
