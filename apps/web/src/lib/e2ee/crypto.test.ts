// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { E2EE_MAX_PLAINTEXT_CHARS, encodeEnvelope, parseEnvelope } from '@jorcord/shared';
import { decryptMessage, diffTrust, encryptMessage, fingerprint, formatFingerprint, generateIdentity, safetyNumber, type Identity } from './crypto';

interface Dev { id: string; identity: Identity }
const dev = async (id: string): Promise<Dev> => ({ id, identity: await generateIdentity() });
const pub = (d: Dev) => ({ id: d.id, publicRaw: d.identity.publicRaw });
const CH = '100', ALICE = '1', BOB = '2';

describe('secret chat encryption', () => {
  it('round-trips for every recipient device, including the sender\'s other devices', async () => {
    const a1 = await dev('11'), a2 = await dev('12'), b1 = await dev('21'), b2 = await dev('22');
    const content = await encryptMessage({ channelId: CH, authorId: ALICE, sender: a1, recipients: [pub(a1), pub(a2), pub(b1), pub(b2)], plaintext: 'hello \u{1F512} wörld' });
    expect(content.startsWith('jc-e2ee1:')).toBe(true);
    expect(content).not.toContain('hello');
    for (const d of [a1, a2, b1, b2]) {
      const r = await decryptMessage({ channelId: CH, authorId: ALICE, content, self: d, senderPublic: a1.identity.publicRaw });
      expect(r).toEqual({ ok: true, plaintext: 'hello \u{1F512} wörld', fromDevice: '11' });
    }
    expect(Object.keys(parseEnvelope(content)!.keys).sort()).toEqual(['11', '12', '21', '22']);
  });

  it('is probabilistic and hides the exact message length', async () => {
    const a = await dev('11'), b = await dev('21');
    const args = { channelId: CH, authorId: ALICE, sender: a, recipients: [pub(a), pub(b)] };
    const one = await encryptMessage({ ...args, plaintext: 'same' }), two = await encryptMessage({ ...args, plaintext: 'same' });
    expect(one).not.toBe(two);
    const short = parseEnvelope(await encryptMessage({ ...args, plaintext: 'a' }))!, little = parseEnvelope(await encryptMessage({ ...args, plaintext: 'a'.repeat(40) }))!;
    expect(short.ct.length).toBe(little.ct.length); // padded to 64-byte buckets
  });

  it('refuses a device that was not a recipient, and a sender key the server does not know', async () => {
    const a = await dev('11'), b = await dev('21'), late = await dev('23');
    const content = await encryptMessage({ channelId: CH, authorId: ALICE, sender: a, recipients: [pub(a), pub(b)], plaintext: 'secret' });
    expect(await decryptMessage({ channelId: CH, authorId: ALICE, content, self: late, senderPublic: a.identity.publicRaw })).toEqual({ ok: false, reason: 'not_for_this_device' });
    expect(await decryptMessage({ channelId: CH, authorId: ALICE, content, self: b, senderPublic: null })).toEqual({ ok: false, reason: 'unknown_sender_device' });
    expect(await decryptMessage({ channelId: CH, authorId: ALICE, content: 'jc-e2ee1:garbage', self: b, senderPublic: a.identity.publicRaw })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('detects tampering, replays into another channel, and re-attribution to another author', async () => {
    const a = await dev('11'), b = await dev('21');
    const content = await encryptMessage({ channelId: CH, authorId: ALICE, sender: a, recipients: [pub(a), pub(b)], plaintext: 'pay bob 5' });
    const open = (c: string, over: Partial<{ channelId: string; authorId: string }> = {}) => decryptMessage({ channelId: CH, authorId: ALICE, content: c, self: b, senderPublic: a.identity.publicRaw, ...over });
    expect((await open(content)).ok).toBe(true);
    expect(await open(content, { channelId: '101' })).toEqual({ ok: false, reason: 'authentication_failed' });
    expect(await open(content, { authorId: BOB })).toEqual({ ok: false, reason: 'authentication_failed' });
    const env = parseEnvelope(content)!;
    const flip = (s: string) => (s[5] === 'A' ? 'B' : 'A').padStart(1) + s.slice(1, 5) + s.slice(5).replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    expect(await open(encodeEnvelope({ ...env, ct: flip(env.ct) }))).toEqual({ ok: false, reason: 'authentication_failed' });
    expect(await open(encodeEnvelope({ ...env, epk: parseEnvelope(await encryptMessage({ channelId: CH, authorId: ALICE, sender: a, recipients: [pub(b)], plaintext: 'x' }))!.epk }))).toEqual({ ok: false, reason: 'authentication_failed' });
    const w = env.keys['21']!; expect((await open(encodeEnvelope({ ...env, keys: { '21': { ...w, wk: flip(w.wk) } } }))).ok).toBe(false);
  });

  it('cannot be forged by someone who only knows the public keys (the server)', async () => {
    const alice = await dev('11'), bob = await dev('21'), server = await generateIdentity();
    // the attacker claims to be alice's device 11, wrapping to bob's real public key with its own identity key instead of alice's private key
    const forged = await encryptMessage({ channelId: CH, authorId: ALICE, sender: { id: '11', identity: server }, recipients: [pub(bob)], plaintext: 'alice says: send me money' });
    expect(await decryptMessage({ channelId: CH, authorId: ALICE, content: forged, self: bob, senderPublic: alice.identity.publicRaw })).toEqual({ ok: false, reason: 'authentication_failed' });
  });

  it('enforces the size limits before encrypting', async () => {
    const a = await dev('11');
    const args = { channelId: CH, authorId: ALICE, sender: a, recipients: [pub(a)] };
    await expect(encryptMessage({ ...args, plaintext: 'x'.repeat(E2EE_MAX_PLAINTEXT_CHARS + 1) })).rejects.toThrow(/too long/);
    await expect(encryptMessage({ ...args, plaintext: '☃'.repeat(2500) })).rejects.toThrow(/too long/); // 7500 bytes
    const max = await encryptMessage({ ...args, plaintext: '☃'.repeat(1990) });
    expect(parseEnvelope(max)).not.toBeNull();
    await expect(encryptMessage({ ...args, recipients: [], plaintext: 'x' })).rejects.toThrow();
  });
});

describe('private keys', () => {
  it('are non-extractable', async () => {
    const id = await generateIdentity();
    expect(id.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', id.privateKey)).rejects.toThrow();
    expect(id.publicRaw.length).toBe(65);
  });
});

describe('safety numbers and key-change detection', () => {
  it('safety number is symmetric, 60 digits, and changes when any device key changes or is added', async () => {
    const a = await dev('11'), b = await dev('21'), b2 = await dev('22');
    const fp = async (d: Dev) => ({ id: d.id, fp: await fingerprint(d.identity.publicRaw) });
    const A = { userId: ALICE, devices: [await fp(a)] }, B = { userId: BOB, devices: [await fp(b)] };
    const n1 = await safetyNumber(A, B), n2 = await safetyNumber(B, A);
    expect(n1).toBe(n2);
    expect(n1.replace(/\s/g, '')).toMatch(/^\d{60}$/); expect(n1.split('\n').length).toBe(3);
    const more = await safetyNumber(A, { userId: BOB, devices: [await fp(b), await fp(b2)] });
    expect(more).not.toBe(n1);
    expect(await safetyNumber(A, { userId: BOB, devices: [await fp(b2)] })).not.toBe(n1);
    expect(await safetyNumber({ userId: '3', devices: A.devices }, B)).not.toBe(n1);
    expect(formatFingerprint('abcd1234ef')).toBe('abcd 1234 ef');
  });

  it('diffTrust: first use, unchanged, new device, replaced key, removed device', () => {
    const cur = [{ id: '21', fp: 'aa' }, { id: '22', fp: 'bb' }];
    expect(diffTrust(null, cur).status).toBe('first_use');
    expect(diffTrust({ '21': 'aa', '22': 'bb' }, cur)).toEqual({ status: 'ok', added: [], changed: [], removed: [] });
    expect(diffTrust({ '21': 'aa' }, cur)).toEqual({ status: 'changed', added: ['22'], changed: [], removed: [] });
    expect(diffTrust({ '21': 'aa', '22': 'XX' }, cur)).toEqual({ status: 'changed', added: [], changed: ['22'], removed: [] });
    expect(diffTrust({ '21': 'aa', '22': 'bb', '23': 'cc' }, cur)).toEqual({ status: 'ok', added: [], changed: [], removed: ['23'] }); // a revoked device is not alarming
  });
});
