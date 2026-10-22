import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** Minimal CBOR encoder (maps, byte/text strings, ints) - enough for a "none" attestation. */
function cbor(v: any): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

/** A software FIDO2 authenticator (ES256, resident key, always user-verifying). */
export class SoftAuthenticator {
  private priv: KeyObject; private pub: KeyObject;
  credentialId = randomBytes(32); counter = 0;
  /** Set a fixed value to emulate authenticators that always report 0 (platform authenticators). */
  fixedCounter: number | null = null;
  constructor(public origin = 'http://localhost:3000', public rpId = 'localhost') {
    const k = generateKeyPairSync('ec', { namedCurve: 'P-256' }); this.priv = k.privateKey; this.pub = k.publicKey;
  }
  private clientData(type: string, challenge: string, origin = this.origin) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })); }
  private authData(flags: number, counter: number, attested?: Buffer) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    return Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([flags]), c, ...(attested ? [attested] : [])]);
  }
  private cose() {
    const jwk = this.pub.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  }
  register(options: { challenge: string }, opts: { uv?: boolean; origin?: string } = {}) {
    const id = this.credentialId;
    const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, id, this.cose()]);
    const flags = 0x01 | 0x40 | (opts.uv === false ? 0 : 0x04);
    const attestationObject = cbor(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(flags, this.fixedCounter ?? this.counter, attested)]]));
    return {
      id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key' as const, clientExtensionResults: {}, authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: this.clientData('webauthn.create', options.challenge, opts.origin).toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
    };
  }
  assert(options: { challenge: string }, opts: { userHandle?: string; uv?: boolean; origin?: string; counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04);
    const authData = this.authData(flags, this.fixedCounter ?? this.counter);
    const cd = this.clientData('webauthn.get', options.challenge, opts.origin);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), this.priv); // DER, as WebAuthn expects
    return {
      id: this.credentialId.toString('base64url'), rawId: this.credentialId.toString('base64url'), type: 'public-key' as const, clientExtensionResults: {}, authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: cd.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), ...(opts.userHandle ? { userHandle: opts.userHandle } : {}) },
    };
  }
}
