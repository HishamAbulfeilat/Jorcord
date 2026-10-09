import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { SignJWT, jwtVerify } from 'jose';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// argon2id (the @node-rs/argon2 default algorithm), library defaults for cost.
export const hashPassword = (pw: string) => hash(pw);
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);
let dummy: string | null = null;
/** Burn equivalent time when the account does not exist (login timing equalisation). */
export async function dummyVerify(pw: string) { dummy ??= await hashPassword('dummy-password-value'); await verifyPassword(dummy, pw); }

export function encryptSecret(secret: string, key: string): string {
  const k = createHash('sha256').update(key).digest(); const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function decryptSecret(blob: string, key: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url')) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const enc = (s: string) => new TextEncoder().encode(s);
export const signAccess = (secret: string, userId: string, sessionId: string, ttlSec: number) =>
  new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setIssuer('jorcord').setExpirationTime(`${ttlSec}s`).sign(enc(secret));
export async function verifyAccess(secret: string, token: string): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), { algorithms: ['HS256'], issuer: 'jorcord' });
    if (!payload.sub || typeof payload.sid !== 'string') return null;
    return { userId: payload.sub, sessionId: payload.sid };
  } catch { return null; }
}
