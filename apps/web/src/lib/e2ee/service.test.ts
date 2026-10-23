// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toB64u, type E2eeDevice } from '@jorcord/shared';
import { generateIdentity, decryptMessage, type Identity } from './crypto';
import { memoryKeyStore } from './keystore';

/** A tiny in-memory stand-in for the server's device registry and message endpoint. */
const server = { devices: [] as E2eeDevice[], sent: [] as { channelId: string; content: string; replyTo?: string }[], n: 100 };
vi.mock('@/lib/api', () => ({
  api: {
    e2ee: {
      devices: async () => server.devices.filter((d) => d.userId === 'me' && !d.revokedAt),
      register: async (publicKey: string, label?: string) => { const d: E2eeDevice = { id: String(++server.n), userId: 'me', publicKey, label: label ?? null, createdAt: '', lastSeenAt: null }; server.devices.push(d); return d; },
      channelDevices: async () => ({ channelId: 'ch', devices: [...server.devices] }),
    },
    messages: { send: async (channelId: string, m: { content: string; replyTo?: string }) => { server.sent.push({ channelId, ...m }); return { id: String(++server.n), channelId, content: m.content, author: { id: 'me' }, type: 'default' }; } },
  },
}));

const { ensureLocalDevice, forgetLocalDevice, loadChannelCrypto, sendSecretMessage, acceptKeys, openMessage, SecretChatError } = await import('./service');
const channel = { id: 'ch', recipients: [{ id: 'me' }, { id: 'peer' }] } as any;

async function publishPeer(id: string): Promise<Identity> {
  const identity = await generateIdentity();
  server.devices.push({ id, userId: 'peer', publicKey: toB64u(identity.publicRaw), label: 'peer phone', createdAt: '', lastSeenAt: null });
  return identity;
}
beforeEach(() => { server.devices = []; server.sent = []; forgetLocalDevice(); });

describe('device identity', () => {
  it('creates and publishes a device once, reuses it, and replaces it when the server no longer lists it', async () => {
    const store = memoryKeyStore();
    const a = await ensureLocalDevice('me', store);
    expect(server.devices.length).toBe(1);
    expect(a.identity.privateKey.extractable).toBe(false);
    forgetLocalDevice();
    expect((await ensureLocalDevice('me', store)).deviceId).toBe(a.deviceId); // reloaded from the key store
    expect(server.devices.length).toBe(1);
    server.devices[0]!.revokedAt = 'now'; forgetLocalDevice(); // revoked from another device
    const b = await ensureLocalDevice('me', store);
    expect(b.deviceId).not.toBe(a.deviceId); expect(server.devices.length).toBe(2);
  });
});

describe('trust on first use, key changes and sending', () => {
  it('pins the peer on first contact, blocks sending after a key change until accepted, then sends something both devices can open', async () => {
    const store = memoryKeyStore();
    const peer1 = await publishPeer('201');
    const first = await loadChannelCrypto(channel, 'me', store);
    expect(first.trust.status).toBe('first_use'); expect(first.verified).toBe(false);
    expect(first.safety.replace(/\s/g, '')).toMatch(/^\d{60}$/);
    expect((await loadChannelCrypto(channel, 'me', store)).trust.status).toBe('ok');

    // the peer gains a second device: could be legitimate, could be the server adding a listener
    const peer2 = await publishPeer('202');
    const changed = await loadChannelCrypto(channel, 'me', store);
    expect(changed.trust).toMatchObject({ status: 'changed', added: ['202'] });
    expect(changed.safety).not.toBe(first.safety);
    await expect(sendSecretMessage(channel, { id: 'me' }, 'hi', null, store)).rejects.toMatchObject({ code: 'KEY_CHANGED' });
    expect(server.sent).toEqual([]); // nothing left the device

    await acceptKeys(changed, 'me', {}, store);
    const ok = await loadChannelCrypto(channel, 'me', store);
    expect(ok.trust.status).toBe('ok'); expect(ok.verified).toBe(false);
    const msg = await sendSecretMessage(channel, { id: 'me' }, 'meet at noon', 'r1', store);
    expect(server.sent).toHaveLength(1); expect(server.sent[0]).toMatchObject({ channelId: 'ch', replyTo: 'r1' });
    expect(server.sent[0]!.content).not.toContain('noon');
    // every active device of the peer and my own device can read it
    const mine = await ensureLocalDevice('me', store);
    const msgIn = { content: msg.content, channelId: 'ch', author: { id: 'me' } } as any;
    const asMe = await openMessage(await loadChannelCrypto(channel, 'me', store), msgIn);
    expect(asMe).toMatchObject({ ok: true, plaintext: 'meet at noon', fromDevice: mine.deviceId });
    for (const [id, identity] of [['201', peer1], ['202', peer2]] as const) {
      expect(await decryptMessage({ channelId: 'ch', authorId: 'me', content: msg.content, self: { id, identity }, senderPublic: mine.identity.publicRaw })).toMatchObject({ ok: true, plaintext: 'meet at noon' });
    }
  });

  it('treats a replaced key under a known device id as a change, and a revoked peer device as harmless', async () => {
    const store = memoryKeyStore();
    await publishPeer('201'); await publishPeer('202');
    await loadChannelCrypto(channel, 'me', store);
    server.devices.find((d) => d.id === '202')!.revokedAt = 'now'; // peer revoked a device
    expect((await loadChannelCrypto(channel, 'me', store)).trust.status).toBe('ok');
    const swapped = await generateIdentity();
    server.devices.find((d) => d.id === '201')!.publicKey = toB64u(swapped.publicRaw); // same id, different key: the server swapped it
    const c = await loadChannelCrypto(channel, 'me', store);
    expect(c.trust).toMatchObject({ status: 'changed', changed: ['201'] });
    await expect(sendSecretMessage(channel, { id: 'me' }, 'x', null, store)).rejects.toBeInstanceOf(SecretChatError);
  });

  it('refuses to send when the peer has no device yet', async () => {
    await expect(sendSecretMessage(channel, { id: 'me' }, 'hello?', null, memoryKeyStore())).rejects.toMatchObject({ code: 'PEER_NO_DEVICE' });
    expect(server.sent).toEqual([]);
  });

  it('still opens old messages from a device the sender has since revoked', async () => {
    const store = memoryKeyStore();
    const peer = await publishPeer('201');
    const cc = await loadChannelCrypto(channel, 'me', store);
    const { encryptMessage } = await import('./crypto');
    const content = await encryptMessage({ channelId: 'ch', authorId: 'peer', sender: { id: '201', identity: peer }, recipients: [{ id: cc.me.deviceId, publicRaw: cc.me.identity.publicRaw }], plaintext: 'old news' });
    server.devices.find((d) => d.id === '201')!.revokedAt = 'now';
    const after = await loadChannelCrypto(channel, 'me', store);
    expect(await openMessage(after, { content, channelId: 'ch', author: { id: 'peer' } } as any)).toMatchObject({ ok: true, plaintext: 'old news' });
    // ...but a device id that belongs to the other person cannot be used to speak as someone else
    expect(await openMessage(after, { content, channelId: 'ch', author: { id: 'me' } } as any)).toMatchObject({ ok: false, reason: 'unknown_sender_device' });
  });
});
