import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { E2EE_ENVELOPE_PREFIX, encodeEnvelope, parseEnvelope } from '@jorcord/shared';
import { Api, WsClient, startServer, type Client, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

const befriend = async (x: Client, y: Client) => { await api.req('PUT', `/users/@me/relationships/${y.id}`, x.token, { type: 'friend' }); await api.req('PUT', `/users/@me/relationships/${x.id}`, y.token, { type: 'friend' }); };
const newKey = () => { const e = createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey().toString('base64url'); };
const rb = (n: number) => randomBytes(n).toString('base64url');
/** A structurally valid envelope. The server cannot tell real ciphertext from random bytes, which is exactly the point. */
const envelope = (from: string, to: string[]) => encodeEnvelope({ v: 1, from, epk: rb(65), iv: rb(12), ct: rb(40), keys: Object.fromEntries(to.map((d) => [d, { iv: rb(12), wk: rb(48) }])) });
const device = async (c: Client) => (await api.req('POST', '/users/@me/e2ee/devices', c.token, { publicKey: newKey(), label: 'test' })).body;

async function setup() {
  const a = await api.register('ea'), b = await api.register('eb');
  await befriend(a, b);
  const secret = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id], encrypted: true })).body;
  const da = await device(a), db = await device(b);
  return { a, b, secret, da, db };
}

describe('E2EE device keys', () => {
  it('validates, publishes, de-duplicates, lists and revokes device keys; pushes E2EE_DEVICES_UPDATE', async () => {
    const { a, b, secret } = await setup();
    const wsB = await WsClient.connect(env.port); await wsB.identify(b.token);
    expect((await api.req('POST', '/users/@me/e2ee/devices', a.token, { publicKey: 'x'.repeat(87) })).status).toBe(400);
    const off = Buffer.from(createECDH('prime256v1').generateKeys() && new Uint8Array(65).fill(7)); off[0] = 4; // not on the curve
    expect((await api.req('POST', '/users/@me/e2ee/devices', a.token, { publicKey: off.toString('base64url') })).status).toBe(400);
    const key = newKey();
    const first = await api.req('POST', '/users/@me/e2ee/devices', a.token, { publicKey: key, label: 'laptop' });
    expect(first.status).toBe(201); expect(first.body).toMatchObject({ userId: a.id, publicKey: key, label: 'laptop' });
    await wsB.waitEvent('E2EE_DEVICES_UPDATE', (d) => d.userId === a.id);
    const again = await api.req('POST', '/users/@me/e2ee/devices', a.token, { publicKey: key });
    expect(again.status).toBe(200); expect(again.body.id).toBe(first.body.id);
    expect((await api.req('GET', '/users/@me/e2ee/devices', a.token)).body.map((d: any) => d.id)).toContain(first.body.id);
    // the participants (and only they) can fetch both sides' keys for a secret chat
    const devs = (await api.req('GET', `/channels/${secret.id}/e2ee/devices`, b.token)).body;
    expect(devs.devices.some((d: any) => d.id === first.body.id)).toBe(true);
    const outsider = await api.register('eo');
    expect((await api.req('GET', `/channels/${secret.id}/e2ee/devices`, outsider.token)).status).toBe(404);
    expect((await api.req('DELETE', `/users/@me/e2ee/devices/${first.body.id}`, b.token)).status).toBe(404); // not b's
    expect((await api.req('DELETE', `/users/@me/e2ee/devices/${first.body.id}`, a.token)).status).toBe(204);
    expect((await api.req('POST', '/users/@me/e2ee/devices', a.token, { publicKey: key })).status).toBe(409); // a revoked key stays revoked
    expect((await api.req('GET', '/users/@me/e2ee/devices', a.token)).body.some((d: any) => d.id === first.body.id)).toBe(false);
    wsB.close();
  });

  it('caps active devices per account', async () => {
    const c = await api.register('ec');
    for (let i = 0; i < 10; i++) expect((await api.req('POST', '/users/@me/e2ee/devices', c.token, { publicKey: newKey() })).status).toBe(201);
    const over = await api.req('POST', '/users/@me/e2ee/devices', c.token, { publicKey: newKey() });
    expect(over.status).toBe(400); expect(over.body.code).toBe('E2EE_DEVICE_LIMIT');
  });
});

describe('secret chats', () => {
  it('are opt-in, 1:1, flagged on the channel, and live next to the normal DM with the same person', async () => {
    const a = await api.register('es'), b = await api.register('et'), c = await api.register('eu');
    await befriend(a, b); await befriend(a, c);
    const normal = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    expect(normal.encrypted).toBeUndefined();
    const secret = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id], encrypted: true })).body;
    expect(secret.id).not.toBe(normal.id); expect(secret.encrypted).toBe(true);
    expect((await api.req('POST', '/users/@me/channels', b.token, { recipientIds: [a.id], encrypted: true })).body.id).toBe(secret.id); // deduped from the other side
    expect((await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id, c.id], encrypted: true })).status).toBe(400); // no group E2EE
    const list = (await api.req('GET', '/users/@me/channels', b.token)).body;
    expect(list.find((x: any) => x.id === secret.id)?.encrypted).toBe(true);
  });

  it('accepts only well-formed envelopes from the sender\'s own device wrapped for every participant', async () => {
    const { a, b, secret, da, db } = await setup();
    const post = (token: string, content: string, extra: object = {}) => api.req('POST', `/channels/${secret.id}/messages`, token, { content, ...extra });
    expect((await post(a.token, 'hello in plaintext')).body.code).toBe('E2EE_REQUIRED');
    expect((await post(a.token, E2EE_ENVELOPE_PREFIX + 'not-json')).status).toBe(400);
    expect((await post(a.token, envelope(db.id, [da.id, db.id]))).body.code).toBe('E2EE_BAD_DEVICE'); // someone else's device as sender
    expect((await post(a.token, envelope(da.id, [da.id]))).body.code).toBe('E2EE_MISSING_RECIPIENT');
    expect((await post(a.token, envelope(da.id, [da.id, db.id, '999']))).body.code).toBe('E2EE_UNKNOWN_DEVICE');
    const ok = await post(a.token, envelope(da.id, [da.id, db.id]));
    expect(ok.status).toBe(201);
    expect(parseEnvelope(ok.body.content)?.from).toBe(da.id); // the server stored exactly what it was given
    // no plaintext-bearing extras
    expect((await post(a.token, envelope(da.id, [da.id, db.id]), { stickerIds: ['1'] })).status).toBe(400);
    expect((await post(a.token, envelope(da.id, [da.id, db.id]), { flags: 4 })).status).toBe(400);
    // the recipient gets the identical ciphertext
    const got = (await api.req('GET', `/channels/${secret.id}/messages`, b.token)).body;
    expect(got[0].content).toBe(ok.body.content);
    // a revoked sender device is refused
    await api.req('DELETE', `/users/@me/e2ee/devices/${da.id}`, a.token);
    expect((await post(a.token, envelope(da.id, [da.id, db.id]))).status).toBe(400);
  });

  it('never unfurls, searches, mention-parses, edits, saves, schedules or forwards, and push previews stay generic', async () => {
    const { a, b, secret, da, db } = await setup();
    const sent = (await api.req('POST', `/channels/${secret.id}/messages`, a.token, { content: envelope(da.id, [da.id, db.id]) })).body;
    const [row] = await env.ctx.db.query('SELECT has_link, mentions, embeds FROM messages WHERE id = $1', [sent.id]);
    expect(row.has_link).toBe(false); expect(row.mentions).toEqual([]); expect(row.embeds).toEqual([]);
    // search: neither the channel search, the cross-DM search nor a prefix of the stored text finds it
    const prefix = encodeURIComponent(sent.content.slice(0, 6));
    expect((await api.req('GET', `/channels/${secret.id}/messages/search?q=${prefix}`, a.token)).body).toEqual([]);
    expect((await api.req('GET', `/users/@me/messages/search?q=${prefix}`, a.token)).body).toEqual([]);
    expect((await api.req('PATCH', `/channels/${secret.id}/messages/${sent.id}`, a.token, { content: 'edited' })).status).toBe(400);
    expect((await api.req('PUT', `/users/@me/saved/${secret.id}/${sent.id}`, b.token)).body.code).toBe('E2EE_UNSUPPORTED');
    const soon = new Date(Date.now() + 3600_000).toISOString();
    expect((await api.req('POST', `/channels/${secret.id}/scheduled-messages`, a.token, { content: 'later', sendAt: soon })).status).toBe(400);
    const normal = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    expect((await api.req('POST', `/channels/${normal.id}/messages`, a.token, { forward: { channelId: secret.id, messageId: sent.id } })).status).toBe(400);
  });

  it('does not change normal DMs: plaintext, links, search and edits still work', async () => {
    const { a, b } = await setup();
    const normal = (await api.req('POST', '/users/@me/channels', a.token, { recipientIds: [b.id] })).body;
    const m = await api.req('POST', `/channels/${normal.id}/messages`, a.token, { content: 'plain pineapple https://example.com/x' });
    expect(m.status).toBe(201); expect(m.body.content).toContain('pineapple');
    expect((await api.req('GET', `/channels/${normal.id}/messages/search?q=pineapple`, b.token)).body.length).toBe(1);
    expect((await api.req('PATCH', `/channels/${normal.id}/messages/${m.body.id}`, a.token, { content: 'edited pineapple' })).status).toBe(200);
    // an envelope-looking string is just text in a normal DM
    expect((await api.req('POST', `/channels/${normal.id}/messages`, a.token, { content: `${E2EE_ENVELOPE_PREFIX}abc` })).status).toBe(201);
    expect((await api.req('GET', `/channels/${normal.id}/e2ee/devices`, a.token)).status).toBe(400);
  });
});
