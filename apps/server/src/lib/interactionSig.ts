import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { decryptSecret, encryptSecret } from './crypto';

/** Ed25519 keypair for an application. Public key is hex (raw 32 bytes); private key is stored AES-GCM encrypted (PKCS8 DER). */
export function generateAppKeys(serverSecret: string): { publicKey: string; privateKeyEnc: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { publicKey: raw, privateKeyEnc: encryptSecret(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'), serverSecret) };
}

/** Signs `timestamp + body` (Discord scheme: headers X-Signature-Ed25519 (hex) and X-Signature-Timestamp). */
export function signInteraction(privateKeyEnc: string, serverSecret: string, timestamp: string, body: string): string {
  const der = Buffer.from(decryptSecret(privateKeyEnc, serverSecret), 'base64url');
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(timestamp + body), key).toString('hex');
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** What an app does to authenticate a delivery (also used by tests). */
export function verifyInteractionSignature(publicKeyHex: string, timestamp: string, body: string, signatureHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}
